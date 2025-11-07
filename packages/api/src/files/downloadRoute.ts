import express from 'express';
import fs from 'fs';
import path from 'path';
import { validateFileToken } from './fileUrls';
import { logger } from '@librechat/data-schemas';

const router = express.Router();

/**
 * Download endpoint for temporary file access
 * GET /api/files/download/:fileId?token=xxx
 *
 * This endpoint serves files with temporary token-based authentication.
 * Supports both S3 (via presigned URLs) and local filesystem access.
 */
router.get('/download/:fileId', async (req, res) => {
  const { fileId } = req.params;
  const { token } = req.query;

  if (!fileId) {
    return res.status(400).json({ error: 'File ID is required' });
  }

  if (!token || typeof token !== 'string') {
    return res.status(401).json({ error: 'Access token is required' });
  }

  try {
    // Validate the token and get the user ID
    const userId = validateFileToken(token, fileId);

    logger.info('[downloadRoute] File download request', { fileId, userId });

    // Construct file path
    // Files are stored in: /app/client/public/images/{userId}/{filename}
    const imagesDir = process.env.IMAGES_DIR || '/app/client/public/images';
    const filePath = path.join(imagesDir, userId, fileId);

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      logger.error('[downloadRoute] File not found', { fileId, userId, filePath });
      return res.status(404).json({ error: 'File not found' });
    }

    // Security check: ensure the file is within the expected directory
    const resolvedPath = path.resolve(filePath);
    const resolvedImagesDir = path.resolve(imagesDir);
    if (!resolvedPath.startsWith(resolvedImagesDir)) {
      logger.error('[downloadRoute] Path traversal attempt detected', { fileId, userId, filePath });
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get file stats
    const stats = fs.statSync(filePath);
    const fileSize = stats.size;

    // Determine content type from file extension
    const ext = path.extname(fileId).toLowerCase();
    const contentTypeMap: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.heic': 'image/heic',
      '.pdf': 'application/pdf',
      '.txt': 'text/plain',
      '.json': 'application/json',
    };
    const contentType = contentTypeMap[ext] || 'application/octet-stream';

    // Set headers
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', fileSize);
    res.setHeader('Content-Disposition', `inline; filename="${path.basename(fileId)}"`);
    res.setHeader('Cache-Control', 'private, max-age=300'); // Cache for 5 minutes

    // Stream the file
    const readStream = fs.createReadStream(filePath);

    readStream.on('error', (error) => {
      logger.error('[downloadRoute] Error reading file', { fileId, userId, error });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error reading file' });
      }
    });

    readStream.pipe(res);

    logger.info('[downloadRoute] File download started', { fileId, userId, fileSize });

  } catch (error) {
    logger.error('[downloadRoute] File download failed', { fileId, error });

    if (error instanceof Error) {
      if (error.message.includes('expired')) {
        return res.status(401).json({ error: 'Access token expired' });
      }
      if (error.message.includes('Invalid')) {
        return res.status(403).json({ error: 'Invalid access token' });
      }
    }

    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

import crypto from 'crypto';
import { getS3Client } from './client';
import { logger } from '@librechat/data-schemas';

// conf for temporary file URLs
const FILE_URL_CONFIG = {
  DEFAULT_TTL_SECONDS: 900,
  SECRET_KEY: process.env.FILE_URL_SECRET_KEY || crypto.randomBytes(32).toString('hex'),
  BASE_URL: process.env.APP_URL || 'http://localhost:3080',
};

// File URL metadata
export interface FileUrlMetadata {
  fileId: string;
  url: string;
  expires: Date;
  storage: 'local' | 's3' | 'azure';
}

/**
 * Generates a temporary, signed URL for a file
 *
 * @param fileId - The unique file identifier
 * @param storage - Storage type ('local', 's3', 'azure')
 * @param userId - The user ID who owns the file (for access control)
 * @param ttlSeconds - Time-to-live in seconds (default: 15 minutes)
 * @returns File URL metadata including the temporary URL
 */
export async function generateFileUrl(
  fileId: string,
  storage: 'local' | 's3' | 'azure',
  userId: string,
  ttlSeconds: number = FILE_URL_CONFIG.DEFAULT_TTL_SECONDS
): Promise<FileUrlMetadata> {
  const expires = new Date(Date.now() + ttlSeconds * 1000);

  try {
    if (storage === 's3') {
      // Generate S3 presigned URL
      const url = await generateS3PresignedUrl(fileId, userId, ttlSeconds);
      return { fileId, url, expires, storage };
    } else if (storage === 'local') {
      // Generate signed token for local files
      const url = generateLocalFileUrl(fileId, userId, expires);
      return { fileId, url, expires, storage };
    } else if (storage === 'azure') {
      // TODO: Implement Azure Blob Storage SAS URLs
      throw new Error('Azure storage URLs not yet implemented');
    } else {
      throw new Error(`Unsupported storage type: ${storage}`);
    }
  } catch (error) {
    logger.error('[generateFileUrl] Error generating file URL', { fileId, storage, error });
    throw error;
  }
}

/**
 * Generates an S3 presigned URL for temporary file access
 */
async function generateS3PresignedUrl(
  fileId: string,
  userId: string,
  ttlSeconds: number
): Promise<string> {
  try {
    const s3 = getS3Client();
    const bucketName = process.env.AWS_BUCKET_NAME;

    if (!bucketName) {
      throw new Error('AWS_BUCKET_NAME not configured');
    }

    // S3 key format: images/{userId}/{filename}
    // We need to extract the key from fileId (assuming fileId is the full path or we have a mapping)
    const key = `images/${userId}/${fileId}`;

    // Import AWS SDK v3 GetObjectCommand
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
    });

    const url = await getSignedUrl(s3, command, { expiresIn: ttlSeconds });

    logger.info('[generateS3PresignedUrl] Generated presigned URL', { fileId, userId, ttl: ttlSeconds });
    return url;
  } catch (error) {
    logger.error('[generateS3PresignedUrl] Error generating S3 URL', { fileId, error });
    throw new Error(`Failed to generate S3 presigned URL: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Generates a signed URL for local filesystem files
 */
function generateLocalFileUrl(
  fileId: string,
  userId: string,
  expires: Date
): string {
  const expiresTs = Math.floor(expires.getTime() / 1000);

  // Create HMAC signature
  const payload = `${fileId}:${userId}:${expiresTs}`;
  const signature = crypto
    .createHmac('sha256', FILE_URL_CONFIG.SECRET_KEY)
    .update(payload)
    .digest('hex');

  // Build URL with token
  const token = Buffer.from(JSON.stringify({
    fileId,
    userId,
    expires: expiresTs,
    signature,
  })).toString('base64url');

  const url = `${FILE_URL_CONFIG.BASE_URL}/api/files/download/${fileId}?token=${token}`;

  logger.info('[generateLocalFileUrl] Generated signed URL', { fileId, userId, expires });
  return url;
}

/**
 * Validates a file access token for local files
 *
 * @param token - The base64url-encoded token
 * @param fileId - The requested file ID
 * @returns The user ID if valid, throws error if invalid
 */
export function validateFileToken(token: string, fileId: string): string {
  try {
    const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf-8'));

    const { fileId: tokenFileId, userId, expires, signature } = decoded;

    // Verify file ID matches
    if (tokenFileId !== fileId) {
      throw new Error('File ID mismatch');
    }

    // Verify not expired
    const now = Math.floor(Date.now() / 1000);
    if (now > expires) {
      throw new Error('Token expired');
    }

    // Verify signature
    const payload = `${fileId}:${userId}:${expires}`;
    const expectedSignature = crypto
      .createHmac('sha256', FILE_URL_CONFIG.SECRET_KEY)
      .update(payload)
      .digest('hex');

    if (signature !== expectedSignature) {
      throw new Error('Invalid signature');
    }

    logger.info('[validateFileToken] Token validated successfully', { fileId, userId });
    return userId;
  } catch (error) {
    logger.error('[validateFileToken] Token validation failed', { fileId, error });
    throw new Error(`Invalid file access token: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Batch generates URLs for multiple files
 *
 * @param files - Array of file metadata
 * @param storage - Storage type
 * @param userId - User ID
 * @returns Array of file URLs
 */
export async function generateFileUrls(
  files: Array<{ fileId: string }>,
  storage: 'local' | 's3' | 'azure',
  userId: string
): Promise<FileUrlMetadata[]> {
  const promises = files.map(file =>
    generateFileUrl(file.fileId, storage, userId)
  );

  return Promise.all(promises);
}

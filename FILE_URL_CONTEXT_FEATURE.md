# File URL Context for MCP Tools

## Overview

This feature enables MCP (Model Context Protocol) tools to access uploaded files through temporary, signed URLs. Files uploaded in LibreChat are now automatically made available to MCP tools via a secure URL mechanism.

## Architecture

### Components

1. **File URL Generator** (`/packages/api/src/files/fileUrls.ts`)
   - Generates temporary, signed URLs for files
   - Supports S3 presigned URLs (15-minute TTL)
   - Supports local filesystem with HMAC-signed tokens

2. **Download Endpoint** (`/packages/api/src/files/downloadRoute.ts`)
   - `GET /api/files/download/:fileId?token=xxx`
   - Validates tokens and serves files
   - Includes path traversal protection

3. **Placeholder System** (`/packages/api/src/utils/env.ts`)
   - Added `{{LIBRECHAT_BODY_FILEURLS}}` placeholder
   - Automatically replaced with JSON array of file URLs
   - Accessible in MCP server configurations

4. **MCP Integration** (`/packages/api/src/mcp/MCPManager.ts`)
   - Generates file URLs before calling MCP tools
   - Passes URLs via request body for placeholder substitution
   - Works with all MCP transport types (stdio, HTTP, SSE, WebSocket)

## Usage

### For End Users

When you upload an image or file in LibreChat and use an MCP tool:

1. Upload a file using the attachment button
2. Enable an MCP tool that needs file access
3. The system automatically generates temporary URLs
4. MCP tools receive URLs and can download files

### For MCP Server Developers

Configure your MCP server to receive file URLs via headers:

```yaml
# In librechat.yaml
mcpServers:
  your-mcp-server:
    type: http  # or stdio, sse, websocket
    url: "https://your-server.com"
    headers:
      X-File-Urls: "{{LIBRECHAT_BODY_FILEURLS}}"
```

Your MCP server will receive a header like:

```
X-File-Urls: ["https://librechat.com/api/files/download/image.png?token=xyz..."]
```

Then download the files:

```python
import requests
import json

# Extract URLs from header
file_urls_json = request.headers.get('X-File-Urls', '[]')
file_urls = json.loads(file_urls_json)

# Download each file
for url in file_urls:
    response = requests.get(url)
    image_data = response.content
    # Process the image...
```

## Security Features

### Token-Based Access

- **S3 Files**: Uses AWS presigned URLs with 15-minute expiration
- **Local Files**: Uses HMAC-SHA256 signed tokens with expiration

### Access Control

- User-scoped: Users can only access their own files
- Time-limited: URLs expire after 15 minutes
- Path traversal protection: Prevents directory traversal attacks
- Signature verification: All tokens are cryptographically signed

### Configuration

```bash
# .env file
FILE_URL_SECRET_KEY=your-secret-key-here  # For local file tokens
APP_URL=https://your-librechat-domain.com  # Base URL for file URLs
AWS_BUCKET_NAME=your-s3-bucket  # For S3 presigned URLs
```

## Implementation Details

### File URL Generation Flow

```
User uploads file
      ↓
File stored (S3 or local filesystem)
      ↓
When MCP tool is called:
  1. Generate temporary URLs for uploaded files
  2. Add URLs to request body as 'fileUrls' array
  3. Placeholder system replaces {{LIBRECHAT_BODY_FILEURLS}}
  4. MCP tool receives URLs in headers/context
      ↓
MCP tool downloads files using URLs
```

### Token Format (Local Files)

```json
{
  "fileId": "image.png",
  "userId": "user-id-123",
  "expires": 1234567890,
  "signature": "hmac-sha256-signature"
}
```

Base64url encoded and passed as query parameter.

### S3 Presigned URLs

Generated using AWS SDK v3:
- Bucket: `AWS_BUCKET_NAME` from env
- Key: `images/{userId}/{filename}`
- Expiration: 900 seconds (15 minutes)

## Example Use Cases

### 1. Medical Image Analysis

```yaml
mcpServers:
  medical-analysis:
    type: http
    url: "https://medical-lambda.aws.com/mcp"
    headers:
      X-File-Urls: "{{LIBRECHAT_BODY_FILEURLS}}"
```

User uploads chest X-ray → MCP tool receives URL → Downloads and analyzes image

### 2. Document Processing

```yaml
mcpServers:
  pdf-processor:
    type: stdio
    command: python
    args: ["process.py"]
    env:
      FILE_URLS: "{{LIBRECHAT_BODY_FILEURLS}}"
```

User uploads PDF → Tool receives URLs in environment → Extracts text

### 3. Image Upload to External Services

```yaml
mcpServers:
  temp-upload:
    type: stdio
    command: uv
    args: ["run", "upload_tool.py"]
    env:
      UPLOADED_FILES: "{{LIBRECHAT_BODY_FILEURLS}}"
```

Tool downloads from LibreChat URL → Uploads to temp.sh or other service

## API Reference

### `generateFileUrl(fileId, storage, userId, ttl?)`

Generates a temporary URL for a file.

**Parameters:**
- `fileId` (string): File identifier
- `storage` ('local' | 's3' | 'azure'): Storage type
- `userId` (string): User ID for access control
- `ttl` (number, optional): Time-to-live in seconds (default: 900)

**Returns:** `FileUrlMetadata`

```typescript
{
  fileId: string;
  url: string;
  expires: Date;
  storage: 'local' | 's3' | 'azure';
}
```

### `validateFileToken(token, fileId)`

Validates a file access token.

**Parameters:**
- `token` (string): Base64url-encoded token
- `fileId` (string): Expected file ID

**Returns:** `string` (userId) if valid, throws error if invalid

### `generateFileUrls(files, storage, userId)`

Batch generates URLs for multiple files.

**Parameters:**
- `files` (Array<{fileId: string}>): Array of file metadata
- `storage` ('local' | 's3' | 'azure'): Storage type
- `userId` (string): User ID

**Returns:** `Promise<FileUrlMetadata[]>`

## Troubleshooting

### Issue: "Invalid signature" errors

**Cause**: `FILE_URL_SECRET_KEY` changed or not set consistently

**Solution**: Set a fixed secret key in `.env`:
```bash
FILE_URL_SECRET_KEY=$(openssl rand -hex 32)
```

### Issue: "Token expired" errors

**Cause**: URLs expired (15-minute TTL)

**Solution**: MCP tools should download files immediately when called, not cache URLs

### Issue: S3 presigned URL errors

**Cause**: Missing AWS credentials or incorrect bucket configuration

**Solution**: Verify in `.env`:
```bash
AWS_ACCESS_KEY_ID=your-key
AWS_SECRET_ACCESS_KEY=your-secret
AWS_BUCKET_NAME=your-bucket
AWS_REGION=your-region
```

### Issue: "File not found" errors

**Cause**: File path doesn't match expected format

**Solution**: Ensure files are stored in `/app/client/public/images/{userId}/{filename}`

## Future Enhancements

- [ ] Azure Blob Storage support (currently placeholder)
- [ ] Single-use tokens (token invalidated after first download)
- [ ] IP whitelisting for MCP servers
- [ ] Configurable TTL per MCP server
- [ ] File URL caching to avoid regeneration
- [ ] Audit logging for file access
- [ ] Rate limiting per user/tool

## Contributing

To extend this feature:

1. **Add new storage backend**: Implement URL generation in `fileUrls.ts`
2. **Add new authentication method**: Extend token validation in `validateFileToken()`
3. **Add new placeholder types**: Modify `processBodyPlaceholders()` in `env.ts`

## References

- [Model Context Protocol Specification](https://modelcontextprotocol.io/)
- [LibreChat Issue #8060](https://github.com/danny-avila/LibreChat/issues/8060)
- [Closed PR #8300](https://github.com/danny-avila/LibreChat/pull/8300) (inspiration)

// Netlify function — download one shared-folder file's bytes (server-side, no login).
// Cloud equivalent of GET /api/drive/file/:id. The file id comes in as the last
// path segment (see the redirect in netlify.toml). Binary body is base64-encoded.
import { driveConfigured, driveStatusDetail, downloadFile } from '../../server/googleDrive.js'

const err = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj),
})

export const handler = async (event) => {
  if (!driveConfigured()) return err(503, { error: 'Google Drive not configured', detail: driveStatusDetail() })
  const id = (event.path || '').split('/').filter(Boolean).pop()
  if (!id) return err(400, { error: 'file id is required' })
  try {
    const { buffer, filename, contentType } = await downloadFile(id)
    return {
      statusCode: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
        'Cache-Control': 'no-store',
      },
      body: buffer.toString('base64'),
      isBase64Encoded: true,
    }
  } catch (e) {
    return err(502, { error: 'Google Drive download failed', detail: e.message })
  }
}

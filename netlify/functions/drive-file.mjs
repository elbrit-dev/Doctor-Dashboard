// Netlify function — download one shared-folder file's bytes (server-side, no login).
// Cloud equivalent of GET /api/drive/file/:id. The file id comes in as the last
// path segment (see the redirect in netlify.toml). Binary body is base64-encoded.
import { driveConfigured, driveStatusDetail, downloadFile } from '../../server/googleDrive.js'

const err = (obj, status = 200) => Response.json(obj, { status, headers: { 'Cache-Control': 'no-store' } })

export default async (req) => {
  if (!driveConfigured()) return err({ error: 'Google Drive not configured', detail: driveStatusDetail() }, 503)
  const id = new URL(req.url).pathname.split('/').filter(Boolean).pop()
  if (!id) return err({ error: 'file id is required' }, 400)
  try {
    const { buffer, filename, contentType } = await downloadFile(id)
    // v2 returns a real Response with the raw bytes — no base64/isBase64Encoded.
    return new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (e) {
    return err({ error: 'Google Drive download failed', detail: e.message }, 502)
  }
}

// Netlify function — batched CREATE of ERPNext UAT Leads (+ addresses) from an
// uploaded sheet. Ports the n8n "CND Doctor Upload" workflow (create path). The
// ERPNext token stays server-side. Reachable at /api/process via netlify.toml.
//
// POST { rows, offset?, batchSize? }
// The frontend drives the offset loop (calling with the returned nextOffset
// until done), so each invocation stays well under Netlify's timeout.

import { runProcess } from '../../server/process.js'

const BASE = (process.env.ERPNEXT_URL || 'https://uat.elbrit.org').replace(/\/+$/, '')
// Accept a single ERPNEXT_TOKEN ("key:secret") or separate key + secret.
const TOKEN = process.env.ERPNEXT_TOKEN || `${process.env.ERPNEXT_API_KEY || ''}:${process.env.ERPNEXT_API_SECRET || ''}`
const authHeaders = { Authorization: `token ${TOKEN}` }

const json = (obj, status = 200) => Response.json(obj, { status, headers: { 'Cache-Control': 'no-store' } })

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (!BASE || TOKEN === ':') return json({ error: 'ERPNext not configured' }, 503)

  let body = {}
  try { body = await req.json() } catch { /* ignore */ }
  const rows = Array.isArray(body.rows) ? body.rows : []
  if (rows.length === 0) return json({ error: 'rows[] is required' }, 400)

  try {
    const out = await runProcess({
      base: BASE,
      authHeaders,
      rows,
      offset: Number(body.offset) || 0,
      batchSize: Number(body.batchSize) || 50,
    })
    return json({ source: `ERPNext · ${BASE}`, action: 'create', ...out })
  } catch (err) {
    return json({ error: 'ERPNext request failed', detail: err.message }, 502)
  }
}

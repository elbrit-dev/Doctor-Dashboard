// Netlify function — rename+merge padded Leads into their clean twin: backfill
// the clean Lead's blank fields and role profiles, then run Frappe's native
// merge so every linked doc follows. Token stays server-side.
// Reachable at /api/merge-padded via netlify.toml.
//
// POST { pairs: [{padded, clean}], offset?, batchSize?, backfill? }
// The frontend drives the offset loop until { done: true }.

import { runMergePadded } from '../../server/mergePadded.js'

const BASE = (process.env.ERPNEXT_URL || 'https://uat.elbrit.org').replace(/\/+$/, '')
const TOKEN = process.env.ERPNEXT_TOKEN || `${process.env.ERPNEXT_API_KEY || ''}:${process.env.ERPNEXT_API_SECRET || ''}`
const authHeaders = { Authorization: `token ${TOKEN}` }

const json = (obj, status = 200) => Response.json(obj, { status, headers: { 'Cache-Control': 'no-store' } })

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (!BASE || TOKEN === ':') return json({ error: 'ERPNext not configured' }, 503)
  let body = {}
  try { body = await req.json() } catch { /* ignore */ }
  const pairs = Array.isArray(body.pairs) ? body.pairs : []
  if (pairs.length === 0) return json({ error: 'pairs[] is required' }, 400)
  try {
    const out = await runMergePadded({
      base: BASE,
      authHeaders,
      pairs,
      offset: Number(body.offset) || 0,
      batchSize: Number(body.batchSize) || 20,
      backfill: body.backfill !== false,
    })
    return json({ source: `ERPNext · ${BASE}`, action: 'merge-padded', ...out })
  } catch (err) {
    return json({ error: 'ERPNext request failed', detail: err.message }, 502)
  }
}

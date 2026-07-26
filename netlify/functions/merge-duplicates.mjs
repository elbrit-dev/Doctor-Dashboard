// Netlify function — merge padded duplicate Leads into their clean form and
// delete the padded ones (addresses moved, not lost). Token stays server-side.
// Reachable at /api/merge-duplicates via netlify.toml.
//
// POST { duplicates: [{code, keep, remove[]}], offset?, batchSize? }
// The frontend drives the offset loop until { done: true }.

import { runMerge } from '../../server/mergeDuplicates.js'

const BASE = (process.env.ERPNEXT_URL || 'https://uat.elbrit.org').replace(/\/+$/, '')
const TOKEN = process.env.ERPNEXT_TOKEN || `${process.env.ERPNEXT_API_KEY || ''}:${process.env.ERPNEXT_API_SECRET || ''}`
const authHeaders = { Authorization: `token ${TOKEN}` }

const json = (obj, status = 200) => Response.json(obj, { status, headers: { 'Cache-Control': 'no-store' } })

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (!BASE || TOKEN === ':') return json({ error: 'ERPNext not configured' }, 503)
  let body = {}
  try { body = await req.json() } catch { /* ignore */ }
  const duplicates = Array.isArray(body.duplicates) ? body.duplicates : []
  if (duplicates.length === 0) return json({ error: 'duplicates[] is required' }, 400)
  try {
    const out = await runMerge({
      base: BASE,
      authHeaders,
      duplicates,
      offset: Number(body.offset) || 0,
      batchSize: Number(body.batchSize) || 20,
    })
    return json({ source: `ERPNext · ${BASE}`, ...out })
  } catch (err) {
    return json({ error: 'ERPNext request failed', detail: err.message }, 502)
  }
}

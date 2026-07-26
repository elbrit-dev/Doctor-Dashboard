// Netlify function — batched UPDATE of EXISTING ERPNext UAT Leads from an
// uploaded sheet (scalar backfill + append role profile + append new address).
// Never creates a Lead. Token stays server-side. Reachable at /api/update.
//
// POST { rows, offset?, batchSize? }
// The frontend drives the offset loop (calling with the returned nextOffset
// until done), so each invocation stays well under Netlify's timeout.
//
// Uses Netlify's modern function format (export default → runtime v2), which
// runs natively as an ES module. The legacy `export const handler` format ran
// as v1, which wraps the code in a CommonJS shim and cannot load our ESM
// imports (../../server/*.js) — that was the "Cannot use import statement" /
// "require() of ES Module" 502.

import { runUpdate } from '../../server/updateLeads.js'

const BASE = (process.env.ERPNEXT_URL || 'https://uat.elbrit.org').replace(/\/+$/, '')
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
    const out = await runUpdate({
      base: BASE,
      authHeaders,
      rows,
      offset: Number(body.offset) || 0,
      batchSize: Number(body.batchSize) || 40,
    })
    return json({ source: `ERPNext · ${BASE}`, action: 'update', ...out })
  } catch (err) {
    return json({ error: 'ERPNext request failed', detail: err.message }, 502)
  }
}

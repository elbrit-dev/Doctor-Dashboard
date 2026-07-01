// Netlify function — batched UPDATE of EXISTING ERPNext UAT Leads from an
// uploaded sheet (scalar backfill + append role profile + append new address).
// Never creates a Lead. Token stays server-side. Reachable at /api/update.
//
// POST { rows, offset?, batchSize? }
// The frontend drives the offset loop (calling with the returned nextOffset
// until done), so each invocation stays well under Netlify's timeout.

import { runUpdate } from '../../server/updateLeads.js'

const BASE = (process.env.ERPNEXT_URL || 'https://uat.elbrit.org').replace(/\/+$/, '')
const TOKEN = process.env.ERPNEXT_TOKEN || `${process.env.ERPNEXT_API_KEY || ''}:${process.env.ERPNEXT_API_SECRET || ''}`
const authHeaders = { Authorization: `token ${TOKEN}` }

const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj),
})

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' })
  if (!BASE || TOKEN === ':') return json(503, { error: 'ERPNext not configured' })

  let body = {}
  try { body = JSON.parse(event.body || '{}') } catch { /* ignore */ }
  const rows = Array.isArray(body.rows) ? body.rows : []
  if (rows.length === 0) return json(400, { error: 'rows[] is required' })

  try {
    const out = await runUpdate({
      base: BASE,
      authHeaders,
      rows,
      offset: Number(body.offset) || 0,
      batchSize: Number(body.batchSize) || 40,
    })
    return json(200, { source: `ERPNext · ${BASE}`, action: 'update', ...out })
  } catch (err) {
    return json(502, { error: 'ERPNext request failed', detail: err.message })
  }
}

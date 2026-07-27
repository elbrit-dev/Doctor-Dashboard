// Netlify function — cascade-delete a batch of Leads by name (linked Contacts /
// Addresses first, then the Lead). Reachable at /api/delete-leads. Modern v2
// (native ESM) format. The frontend drives the offset loop.
//
// POST { names, offset?, batchSize? }

import { runDeleteLeads } from '../../server/deleteLeads.js'

const BASE = (process.env.ERPNEXT_URL || 'https://uat.elbrit.org').replace(/\/+$/, '')
const TOKEN = process.env.ERPNEXT_TOKEN || `${process.env.ERPNEXT_API_KEY || ''}:${process.env.ERPNEXT_API_SECRET || ''}`
const authHeaders = { Authorization: `token ${TOKEN}` }

const json = (obj, status = 200) => Response.json(obj, { status, headers: { 'Cache-Control': 'no-store' } })

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (!BASE || TOKEN === ':') return json({ error: 'ERPNext not configured' }, 503)
  let body = {}
  try { body = await req.json() } catch { /* ignore */ }
  const names = Array.isArray(body.names) ? body.names : []
  if (names.length === 0) return json({ error: 'names[] is required' }, 400)
  try {
    const out = await runDeleteLeads({ base: BASE, authHeaders, names, offset: Number(body.offset) || 0, batchSize: Number(body.batchSize) || 40 })
    return json({ source: `ERPNext · ${BASE}`, action: 'delete-leads', ...out })
  } catch (err) {
    return json({ error: 'ERPNext request failed', detail: err.message }, 502)
  }
}

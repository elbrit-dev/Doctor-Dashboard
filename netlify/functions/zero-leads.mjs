// Netlify function — list every zero-padded Lead (name starts with "DR-0").
// Read-only. Reachable at /api/zero-leads. Modern v2 (native ESM) format.

import { fetchZeroLeads } from '../../server/deleteLeads.js'

const BASE = (process.env.ERPNEXT_URL || 'https://uat.elbrit.org').replace(/\/+$/, '')
const TOKEN = process.env.ERPNEXT_TOKEN || `${process.env.ERPNEXT_API_KEY || ''}:${process.env.ERPNEXT_API_SECRET || ''}`
const authHeaders = { Authorization: `token ${TOKEN}` }

const json = (obj, status = 200) => Response.json(obj, { status, headers: { 'Cache-Control': 'no-store' } })

export default async (req) => {
  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405)
  if (!BASE || TOKEN === ':') return json({ error: 'ERPNext not configured' }, 503)
  try {
    const leads = await fetchZeroLeads({ base: BASE, authHeaders })
    return json({ source: `ERPNext · ${BASE}`, count: leads.length, leads })
  } catch (err) {
    return json({ error: 'ERPNext fetch failed', detail: err.message }, 502)
  }
}

// Netlify function — every doctor Lead as a compact [name, doctorCode, status]
// triple, so the browser can match a whole retirement sheet locally (tens of
// thousands of codes) instead of asking ERP per code. Read-only; token stays
// server-side. Reachable at /api/lead-index via netlify.toml.

import { fetchLeadStatusIndex } from '../../server/leadIndex.js'

const BASE = (process.env.ERPNEXT_URL || 'https://uat.elbrit.org').replace(/\/+$/, '')
const TOKEN = process.env.ERPNEXT_TOKEN || `${process.env.ERPNEXT_API_KEY || ''}:${process.env.ERPNEXT_API_SECRET || ''}`
const authHeaders = { Authorization: `token ${TOKEN}`, Accept: 'application/json' }

const json = (obj, status = 200) => Response.json(obj, { status, headers: { 'Cache-Control': 'no-store' } })

export default async () => {
  if (!BASE || TOKEN === ':') return json({ error: 'ERPNext not configured' }, 503)
  try {
    const leads = await fetchLeadStatusIndex(BASE, authHeaders)
    return json({ source: `ERPNext · ${BASE}`, fetchedAt: new Date().toISOString(), count: leads.length, leads })
  } catch (err) {
    return json({ error: 'ERPNext fetch failed', detail: err.message }, 502)
  }
}

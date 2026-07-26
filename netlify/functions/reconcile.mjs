// Netlify function — create/update/duplicate triage for an uploaded sheet.
// POST { rows } (the parsed sheet). Fetches all coded Leads from UAT once,
// groups them by normalized doctor code, and splits the sheet into:
//   - create:     codes not present in UAT
//   - update:     codes present in UAT
//   - duplicates: codes that exist as more than one Lead (padded / malformed)
// The ERPNext token stays server-side. Reachable at /api/reconcile via netlify.toml.

import { triage } from '../../server/triage.js'
import { fetchDoctorLeads } from '../../server/leadIndex.js'

const BASE = (process.env.ERPNEXT_URL || '').replace(/\/+$/, '')
// Accept a single ERPNEXT_TOKEN ("key:secret") or separate key + secret.
const TOKEN = process.env.ERPNEXT_TOKEN || `${process.env.ERPNEXT_API_KEY || ''}:${process.env.ERPNEXT_API_SECRET || ''}`
const authHeaders = { Authorization: `token ${TOKEN}`, Accept: 'application/json' }

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
    const uatLeads = await fetchDoctorLeads(BASE, authHeaders)
    return json(200, { source: `ERPNext · ${BASE}`, ...triage(rows, uatLeads) })
  } catch (err) {
    return json(502, { error: 'ERPNext fetch failed', detail: err.message })
  }
}

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

const json = (obj, status = 200) => Response.json(obj, { status, headers: { 'Cache-Control': 'no-store' } })

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (!BASE || TOKEN === ':') return json({ error: 'ERPNext not configured' }, 503)
  let body = {}
  try { body = await req.json() } catch { /* ignore */ }
  const rows = Array.isArray(body.rows) ? body.rows : []
  if (rows.length === 0) return json({ error: 'rows[] is required' }, 400)
  try {
    const uatLeads = await fetchDoctorLeads(BASE, authHeaders)
    return json({ source: `ERPNext · ${BASE}`, ...triage(rows, uatLeads) })
  } catch (err) {
    return json({ error: 'ERPNext fetch failed', detail: err.message }, 502)
  }
}

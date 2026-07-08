// Netlify function — read-only audit of EXISTING ERPNext UAT Leads: report the
// ones whose Role Profile ("Sales Team") child table lists the same department
// more than once. Never writes. Token stays server-side. Reachable at
// /api/audit-roles.
//
// POST { items, offset?, batchSize? }
// The frontend drives the offset loop (calling with the returned nextOffset
// until done), so each invocation stays well under Netlify's timeout.

import { runRoleAudit } from '../../server/auditRoles.js'

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
  const items = Array.isArray(body.items) ? body.items : []
  if (items.length === 0) return json(400, { error: 'items[] is required' })

  try {
    const out = await runRoleAudit({
      base: BASE,
      authHeaders,
      items,
      offset: Number(body.offset) || 0,
      batchSize: Number(body.batchSize) || 60,
    })
    return json(200, { source: `ERPNext · ${BASE}`, action: 'audit-roles', ...out })
  } catch (err) {
    return json(502, { error: 'ERPNext request failed', detail: err.message })
  }
}

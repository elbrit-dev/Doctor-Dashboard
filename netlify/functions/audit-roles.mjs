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

const json = (obj, status = 200) => Response.json(obj, { status, headers: { 'Cache-Control': 'no-store' } })

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (!BASE || TOKEN === ':') return json({ error: 'ERPNext not configured' }, 503)

  let body = {}
  try { body = await req.json() } catch { /* ignore */ }
  const items = Array.isArray(body.items) ? body.items : []
  if (items.length === 0) return json({ error: 'items[] is required' }, 400)

  try {
    const out = await runRoleAudit({
      base: BASE,
      authHeaders,
      items,
      offset: Number(body.offset) || 0,
      batchSize: Number(body.batchSize) || 60,
    })
    return json({ source: `ERPNext · ${BASE}`, action: 'audit-roles', ...out })
  } catch (err) {
    return json({ error: 'ERPNext request failed', detail: err.message }, 502)
  }
}

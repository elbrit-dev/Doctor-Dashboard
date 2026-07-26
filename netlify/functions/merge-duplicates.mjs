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
  const duplicates = Array.isArray(body.duplicates) ? body.duplicates : []
  if (duplicates.length === 0) return json(400, { error: 'duplicates[] is required' })
  try {
    const out = await runMerge({
      base: BASE,
      authHeaders,
      duplicates,
      offset: Number(body.offset) || 0,
      batchSize: Number(body.batchSize) || 20,
    })
    return json(200, { source: `ERPNext · ${BASE}`, ...out })
  } catch (err) {
    return json(502, { error: 'ERPNext request failed', detail: err.message })
  }
}

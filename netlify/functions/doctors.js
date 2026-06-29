// Netlify serverless function — the cloud equivalent of server/index.js.
// Holds the ERPNext credentials in Netlify environment variables (set them in
// Site settings → Environment variables), fetches the 39 Leads + linked
// Addresses, and returns the same JSON the local proxy does.
//
// Reachable at /api/doctors thanks to the redirect in netlify.toml.

import { DOCTOR_IDS } from '../../server/doctorIds.js'
import { mapLead } from '../../server/mapLead.js'

const BASE = (process.env.ERPNEXT_URL || '').replace(/\/+$/, '')
const KEY = process.env.ERPNEXT_API_KEY || ''
const SECRET = process.env.ERPNEXT_API_SECRET || ''
const CONCURRENCY = 10

const authHeaders = { Authorization: `token ${KEY}:${SECRET}`, Accept: 'application/json' }
const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj),
})

export const handler = async () => {
  if (!(BASE && KEY && SECRET)) {
    return json(503, {
      error: 'ERPNext not configured',
      detail: 'Set ERPNEXT_URL, ERPNEXT_API_KEY and ERPNEXT_API_SECRET in Netlify → Site settings → Environment variables, then redeploy.',
    })
  }
  try {
    const [docs, reviews] = await Promise.all([fetchAll(DOCTOR_IDS), fetchReviews(DOCTOR_IDS)])
    const withReview = docs.map((d) => ({ ...d, review: reviews[d.name] || null }))
    return json(200, {
      mode: 'live',
      source: `ERPNext · ${BASE}`,
      fetchedAt: new Date().toISOString(),
      count: withReview.length,
      doctors: withReview,
    })
  } catch (err) {
    return json(502, { error: 'Upstream ERPNext request failed', detail: err.message })
  }
}

const REVIEW_MARKER = 'CRM Review'

async function fetchLead(name) {
  const r = await fetch(`${BASE}/api/resource/Lead/${encodeURIComponent(name)}`, { headers: authHeaders })
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status} ${r.statusText}`)
  return (await r.json()).data
}

async function fetchAddresses(name) {
  const filters = JSON.stringify([
    ['Dynamic Link', 'link_name', '=', name],
    ['Dynamic Link', 'link_doctype', '=', 'Lead'],
  ])
  const url = `${BASE}/api/resource/Address?filters=${encodeURIComponent(filters)}&fields=${encodeURIComponent('["*"]')}&limit_page_length=50`
  const r = await fetch(url, { headers: authHeaders })
  if (!r.ok) return []
  const j = await r.json()
  return Array.isArray(j.data) ? j.data : []
}

async function fetchDoctor(name) {
  const [lead, addresses] = await Promise.all([fetchLead(name), fetchAddresses(name).catch(() => [])])
  return mapLead(lead, addresses)
}

async function fetchReviews(ids) {
  const filters = JSON.stringify([
    ['reference_doctype', '=', 'Lead'],
    ['reference_name', 'in', ids],
    ['content', 'like', `%${REVIEW_MARKER}%`],
  ])
  const fields = JSON.stringify(['reference_name', 'content', 'creation', 'comment_by'])
  const url = `${BASE}/api/resource/Comment?filters=${encodeURIComponent(filters)}&fields=${encodeURIComponent(fields)}&order_by=${encodeURIComponent('creation asc')}&limit_page_length=0`
  const r = await fetch(url, { headers: authHeaders })
  if (!r.ok) return {}
  const j = await r.json()
  const latest = {}
  for (const c of j.data || []) {
    const text = String(c.content || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    const decision = /READY/i.test(text) ? 'ready' : /ERROR/i.test(text) ? 'error' : null
    latest[c.reference_name] = { decision, text, at: (c.creation || '').slice(0, 19), by: c.comment_by || '' }
  }
  return latest
}

async function fetchAll(ids) {
  const out = []
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const batch = ids.slice(i, i + CONCURRENCY)
    out.push(...(await Promise.all(batch.map(fetchDoctor))))
  }
  return out
}

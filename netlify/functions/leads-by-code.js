// Netlify serverless equivalent of the local proxy's POST /api/leads-by-code.
// Bulk-fetches Leads by doctor code (zero-padding stripped) plus their linked
// addresses, for the Bulk Reconciliation mode. The frontend calls this in small
// chunks so each invocation stays under the function timeout.
// Reachable at /api/leads-by-code via the redirect in netlify.toml.

import { mapLead } from '../../server/mapLead.js'

const BASE = (process.env.ERPNEXT_URL || '').replace(/\/+$/, '')
const KEY = process.env.ERPNEXT_API_KEY || ''
const SECRET = process.env.ERPNEXT_API_SECRET || ''
const CONCURRENCY = 10
const LEAD_CHUNK = 100

const authHeaders = { Authorization: `token ${KEY}:${SECRET}`, Accept: 'application/json' }
const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj),
})

const BULK_FIELDS = [
  'name', 'custom_doctor_code', 'lead_name', 'first_name', 'salutation',
  'custom_speciality', 'custom_specialty', 'custom_qualification',
  'custom_category', 'custom_category1', 'custom_category2', 'custom_category3',
  'territory', 'state', 'city', 'country', 'mobile_no', 'phone', 'whatsapp_no',
  'custom_latitude', 'custom_longitude', 'custom_address_created',
]

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' })
  if (!(BASE && KEY && SECRET)) return json(503, { error: 'ERPNext not configured' })
  let body = {}
  try { body = JSON.parse(event.body || '{}') } catch { /* ignore */ }
  const codes = Array.isArray(body.codes) ? body.codes : []
  if (codes.length === 0) return json(400, { error: 'codes[] is required' })
  const withAddresses = body.addresses !== false

  const clean = [...new Set(codes.map(stripZeros).filter(Boolean))]
  const requested = new Set(clean)
  try {
    const leads = await fetchLeadsForCodes(clean)
    const groups = {}
    for (const lead of leads) {
      const key = leadCode(lead)
      if (key && requested.has(key)) (groups[key] = groups[key] || []).push(lead)
    }
    const primaries = Object.entries(groups).map(([key, list]) => ({
      key, list, lead: list.find((l) => l.name === `DR-${key}`) || list[0],
    }))
    const addrMap = {}
    if (withAddresses) {
      for (let i = 0; i < primaries.length; i += CONCURRENCY) {
        const batch = primaries.slice(i, i + CONCURRENCY)
        const results = await Promise.all(batch.map((p) => fetchAddresses(p.lead.name).catch(() => [])))
        batch.forEach((p, j) => { addrMap[p.lead.name] = results[j] })
      }
    }
    const byCode = {}
    for (const { key, list, lead } of primaries) {
      const doc = mapLead(lead, addrMap[lead.name] || [])
      doc._dup = list.map((l) => l.name)
      byCode[key] = doc
    }
    return json(200, { requested: clean.length, found: Object.keys(byCode).length, doctors: byCode })
  } catch (err) {
    return json(502, { error: 'Bulk ERPNext fetch failed', detail: err.message })
  }
}

const stripZeros = (c) => String(c ?? '').trim().replace(/^0+/, '')
const pad8 = (c) => stripZeros(c).padStart(8, '0')
const leadCode = (l) => stripZeros(l.custom_doctor_code || String(l.name || '').replace(/^DR-?/i, ''))

async function fetchLeadsForCodes(strippedCodes) {
  const dcodes = []
  for (const c of strippedCodes) dcodes.push(c, pad8(c))
  const seen = new Map()
  const collect = (rows) => { for (const l of rows || []) if (!seen.has(l.name)) seen.set(l.name, l) }
  await Promise.all([
    queryLeadsIn('custom_doctor_code', [...new Set(dcodes)]).then(collect),
    queryLeadsLike(strippedCodes).then(collect),
  ])
  return [...seen.values()]
}

async function queryLeadsIn(field, values) {
  const out = []
  const fields = encodeURIComponent(JSON.stringify(BULK_FIELDS))
  for (let i = 0; i < values.length; i += LEAD_CHUNK) {
    const filters = encodeURIComponent(JSON.stringify([[field, 'in', values.slice(i, i + LEAD_CHUNK)]]))
    const r = await fetch(`${BASE}/api/resource/Lead?filters=${filters}&fields=${fields}&limit_page_length=0`, { headers: authHeaders })
    if (!r.ok) throw new Error(`bulk ${field} chunk: HTTP ${r.status} ${r.statusText}`)
    const j = await r.json()
    if (Array.isArray(j.data)) out.push(...j.data)
  }
  return out
}

async function queryLeadsLike(strippedCodes) {
  const out = []
  const fields = encodeURIComponent(JSON.stringify(BULK_FIELDS))
  for (let i = 0; i < strippedCodes.length; i += 50) {
    const orf = encodeURIComponent(JSON.stringify(strippedCodes.slice(i, i + 50).map((c) => ['Lead', 'name', 'like', `%${c}%`])))
    const r = await fetch(`${BASE}/api/resource/Lead?or_filters=${orf}&fields=${fields}&limit_page_length=0`, { headers: authHeaders })
    if (!r.ok) throw new Error(`bulk like chunk: HTTP ${r.status} ${r.statusText}`)
    const j = await r.json()
    if (Array.isArray(j.data)) out.push(...j.data)
  }
  return out
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

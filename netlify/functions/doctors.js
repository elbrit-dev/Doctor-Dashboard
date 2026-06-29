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
    const docs = await fetchAll(DOCTOR_IDS)
    return json(200, {
      mode: 'live',
      source: `ERPNext · ${BASE}`,
      fetchedAt: new Date().toISOString(),
      count: docs.length,
      doctors: docs,
    })
  } catch (err) {
    return json(502, { error: 'Upstream ERPNext request failed', detail: err.message })
  }
}

async function fetchLead(name) {
  const r = await fetch(`${BASE}/api/resource/Lead/${encodeURIComponent(name)}`, { headers: authHeaders })
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status} ${r.statusText}`)
  return (await r.json()).data
}

async function fetchAddress(name) {
  const filters = JSON.stringify([
    ['Dynamic Link', 'link_name', '=', name],
    ['Dynamic Link', 'link_doctype', '=', 'Lead'],
  ])
  const url = `${BASE}/api/resource/Address?filters=${encodeURIComponent(filters)}&fields=${encodeURIComponent('["*"]')}&limit_page_length=1`
  const r = await fetch(url, { headers: authHeaders })
  if (!r.ok) return null
  const j = await r.json()
  return (j.data && j.data[0]) || null
}

async function fetchDoctor(name) {
  const [lead, address] = await Promise.all([fetchLead(name), fetchAddress(name).catch(() => null)])
  return mapLead(lead, address)
}

async function fetchAll(ids) {
  const out = []
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const batch = ids.slice(i, i + CONCURRENCY)
    out.push(...(await Promise.all(batch.map(fetchDoctor))))
  }
  return out
}

// Tiny proxy between the dashboard and ERPNext.
// Holds the API credentials server-side (never shipped to the browser) and
// exposes GET /api/doctors returning the live, mapped 39 doctor records.
//
// Configure via a .env file in the project root (see .env.example):
//   ERPNEXT_URL=https://your-uat-site.example.com
//   ERPNEXT_API_KEY=xxxxxxxxxxxxxxx
//   ERPNEXT_API_SECRET=xxxxxxxxxxxxxxx
//   PROXY_PORT=8787            (optional, default 8787)

import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { DOCTOR_IDS } from './doctorIds.js'
import { mapLead } from './mapLead.js'

const PORT = process.env.PROXY_PORT || 8787
const BASE = (process.env.ERPNEXT_URL || '').replace(/\/+$/, '')
const KEY = process.env.ERPNEXT_API_KEY || ''
const SECRET = process.env.ERPNEXT_API_SECRET || ''
const CONCURRENCY = 8

const app = express()
app.use(cors())

const configured = () => BASE && KEY && SECRET

app.get('/api/health', (req, res) => {
  res.json({ ok: true, configured: configured(), base: BASE || null, count: DOCTOR_IDS.length })
})

app.get('/api/doctors', async (req, res) => {
  if (!configured()) {
    return res.status(503).json({
      error: 'ERPNext not configured',
      detail: 'Set ERPNEXT_URL, ERPNEXT_API_KEY and ERPNEXT_API_SECRET in .env, then restart the proxy.',
    })
  }
  try {
    const docs = await fetchAll(DOCTOR_IDS)
    res.json({
      mode: 'live',
      source: `ERPNext · ${BASE}`,
      fetchedAt: new Date().toISOString(),
      count: docs.length,
      doctors: docs,
    })
  } catch (err) {
    console.error('[proxy] fetch failed:', err.message)
    res.status(502).json({ error: 'Upstream ERPNext request failed', detail: err.message })
  }
})

const authHeaders = { Authorization: `token ${KEY}:${SECRET}`, Accept: 'application/json' }

// Fetch a single Lead doc (full document, including child tables).
async function fetchLead(name) {
  const url = `${BASE}/api/resource/Lead/${encodeURIComponent(name)}`
  const r = await fetch(url, { headers: authHeaders })
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status} ${r.statusText}`)
  const json = await r.json()
  return json.data
}

// Fetch the Address doctype linked to a Lead via the Dynamic Link child table.
// Returns the first address or null (many doctors have no address yet).
async function fetchAddress(name) {
  const filters = JSON.stringify([
    ['Dynamic Link', 'link_name', '=', name],
    ['Dynamic Link', 'link_doctype', '=', 'Lead'],
  ])
  const url = `${BASE}/api/resource/Address?filters=${encodeURIComponent(filters)}&fields=${encodeURIComponent('["*"]')}&limit_page_length=1`
  const r = await fetch(url, { headers: authHeaders })
  if (!r.ok) return null
  const json = await r.json()
  return (json.data && json.data[0]) || null
}

// Fetch one doctor = its Lead + linked Address, mapped together.
async function fetchDoctor(name) {
  const [lead, address] = await Promise.all([
    fetchLead(name),
    fetchAddress(name).catch(() => null),
  ])
  return mapLead(lead, address)
}

// Fetch all ids with a small concurrency cap.
async function fetchAll(ids) {
  const out = []
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const batch = ids.slice(i, i + CONCURRENCY)
    const results = await Promise.all(batch.map(fetchDoctor))
    out.push(...results)
  }
  return out
}

app.listen(PORT, () => {
  console.log(`[proxy] listening on http://localhost:${PORT}`)
  console.log(`[proxy] ERPNext ${configured() ? 'configured → ' + BASE : 'NOT configured (set .env)'}`)
})

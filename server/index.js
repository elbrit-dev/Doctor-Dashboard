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
import { triage } from './triage.js'
import { runProcess } from './process.js'

const PORT = process.env.PROXY_PORT || 8787
const BASE = (process.env.ERPNEXT_URL || '').replace(/\/+$/, '')
const KEY = process.env.ERPNEXT_API_KEY || ''
const SECRET = process.env.ERPNEXT_API_SECRET || ''
const CONCURRENCY = 8

const app = express()
app.use(cors())
app.use(express.json())

// Marker prefix so dashboard-written review comments can be read back later.
const REVIEW_MARKER = 'CRM Review'

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
    const [docs, reviews] = await Promise.all([fetchAll(DOCTOR_IDS), fetchReviews(DOCTOR_IDS)])
    const withReview = docs.map((d) => ({ ...d, review: reviews[d.name] || null }))
    res.json({
      mode: 'live',
      source: `ERPNext · ${BASE}`,
      fetchedAt: new Date().toISOString(),
      count: withReview.length,
      doctors: withReview,
    })
  } catch (err) {
    console.error('[proxy] fetch failed:', err.message)
    res.status(502).json({ error: 'Upstream ERPNext request failed', detail: err.message })
  }
})

// CRM writes a review back to ERPNext as a comment on the Lead's timeline.
// Body: { id, decision: 'ready'|'error', issues?: string[], note?: string, by?: string }
app.post('/api/review', async (req, res) => {
  if (!configured()) return res.status(503).json({ error: 'ERPNext not configured' })
  const { id, decision, issues = [], note = '', by = 'dashboard' } = req.body || {}
  if (!id || !['ready', 'error'].includes(decision)) {
    return res.status(400).json({ error: 'id and decision (ready|error) are required' })
  }
  try {
    const content = buildReviewComment(decision, issues, note, by)
    const out = await addComment(id, content, by)
    res.json({ ok: true, id, decision, commentId: out?.name || null })
  } catch (err) {
    console.error('[proxy] review failed:', err.message)
    res.status(502).json({ error: 'Failed to post review to ERPNext', detail: err.message })
  }
})

const authHeaders = { Authorization: `token ${KEY}:${SECRET}`, Accept: 'application/json' }

// ---- Bulk reconciliation: fetch many Leads by doctor code in few requests ----
// Body: { codes: ["78031", "3194", ...] }  (leading zeros are stripped here too)
// Returns the same mapped shape as /api/doctors (minus addresses/role profiles),
// in ~1 request per 100 codes via the Lead list API.
const BULK_FIELDS = [
  'name', 'custom_doctor_code', 'lead_name', 'first_name', 'salutation',
  'custom_speciality', 'custom_specialty', 'custom_qualification',
  'custom_category', 'custom_category1', 'custom_category2', 'custom_category3',
  'territory', 'state', 'city', 'country', 'mobile_no', 'phone', 'whatsapp_no',
  'custom_latitude', 'custom_longitude', 'custom_address_created',
]
const CHUNK = 100

app.post('/api/leads-by-code', async (req, res) => {
  if (!configured()) return res.status(503).json({ error: 'ERPNext not configured' })
  const codes = Array.isArray(req.body?.codes) ? req.body.codes : []
  if (codes.length === 0) return res.status(400).json({ error: 'codes[] is required' })
  const clean = [...new Set(codes.map(stripZeros).filter(Boolean))]
  const requested = new Set(clean)
  const withAddresses = req.body?.addresses !== false // default: include addresses
  try {
    const leads = await fetchLeadsForCodes(clean)
    // One primary Lead per requested code (zero-padding tolerant). Prefer the
    // clean "DR-<code>" name. (Duplicate detection lives in the Create/Update tab.)
    const primaries = {}
    for (const lead of leads) {
      const key = leadCode(lead)
      if (!key || !requested.has(key)) continue
      if (!primaries[key] || lead.name === `DR-${key}`) primaries[key] = lead
    }
    const list = Object.values(primaries)
    // Addresses can't be bulk-mapped (Dynamic Link is 403); fetch per primary.
    const addrMap = {}
    if (withAddresses) {
      for (let i = 0; i < list.length; i += CONCURRENCY) {
        const batch = list.slice(i, i + CONCURRENCY)
        const results = await Promise.all(batch.map((l) => fetchAddresses(l.name).catch(() => [])))
        batch.forEach((l, j) => { addrMap[l.name] = results[j] })
      }
    }
    const byCode = {}
    for (const [key, lead] of Object.entries(primaries)) {
      byCode[key] = mapLead(lead, addrMap[lead.name] || [])
    }
    res.json({
      source: `ERPNext · ${BASE}`,
      fetchedAt: new Date().toISOString(),
      requested: clean.length,
      found: Object.keys(byCode).length,
      doctors: byCode, // keyed by stripped doctor code
    })
  } catch (err) {
    console.error('[proxy] bulk fetch failed:', err.message)
    res.status(502).json({ error: 'Bulk ERPNext fetch failed', detail: err.message })
  }
})

// Create/update/duplicate triage: POST { rows } (parsed sheet) → fetch all coded
// Leads once, then categorize the sheet locally.
app.post('/api/reconcile', async (req, res) => {
  if (!configured()) return res.status(503).json({ error: 'ERPNext not configured' })
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : []
  if (rows.length === 0) return res.status(400).json({ error: 'rows[] is required' })
  try {
    const fields = encodeURIComponent(JSON.stringify(['name', 'custom_doctor_code']))
    const filters = encodeURIComponent(JSON.stringify([['custom_doctor_code', 'is', 'set']]))
    const r = await fetch(`${BASE}/api/resource/Lead?fields=${fields}&filters=${filters}&limit_page_length=0`, { headers: authHeaders })
    if (!r.ok) throw new Error(`Lead list: HTTP ${r.status} ${r.statusText}`)
    const uatLeads = (await r.json()).data || []
    res.json({ source: `ERPNext · ${BASE}`, ...triage(rows, uatLeads) })
  } catch (err) {
    console.error('[proxy] reconcile failed:', err.message)
    res.status(502).json({ error: 'ERPNext fetch failed', detail: err.message })
  }
})

// Batched CREATE of Leads (+addresses) from an uploaded sheet (ports the n8n
// workflow's create path). POST { rows, offset?, batchSize? }. Stateless per
// batch — the frontend drives the offset loop.
app.post('/api/process', async (req, res) => {
  if (!configured()) return res.status(503).json({ error: 'ERPNext not configured' })
  const { rows, offset, batchSize } = req.body || {}
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'rows[] is required' })
  try {
    const out = await runProcess({
      base: BASE,
      authHeaders,
      rows,
      offset: Number(offset) || 0,
      batchSize: Number(batchSize) || 50,
    })
    res.json({ source: `ERPNext · ${BASE}`, action: 'create', ...out })
  } catch (err) {
    console.error('[proxy] process failed:', err.message)
    res.status(502).json({ error: 'ERPNext request failed', detail: err.message })
  }
})

const stripZeros = (c) => String(c ?? '').trim().replace(/^0+/, '')
const pad8 = (c) => stripZeros(c).padStart(8, '0')
// A Lead's canonical code: prefer custom_doctor_code, else the DR-xxxx name.
const leadCode = (l) => stripZeros(l.custom_doctor_code || String(l.name || '').replace(/^DR-?/i, ''))

// Find Leads for a set of stripped codes, matching BOTH "DR-4444" and
// "DR-00004444" name forms and both code forms — so zero-padding never hides a
// record. Fast, indexed IN queries.
async function fetchLeadsForCodes(strippedCodes) {
  const names = [], dcodes = []
  for (const c of strippedCodes) { names.push(`DR-${c}`, `DR-${pad8(c)}`); dcodes.push(c, pad8(c)) }
  const seen = new Map() // lead.name -> lead (dedupe across queries)
  const collect = (rows) => { for (const l of rows || []) if (!seen.has(l.name)) seen.set(l.name, l) }
  await Promise.all([
    queryLeadsIn('name', [...new Set(names)]).then(collect),
    queryLeadsIn('custom_doctor_code', [...new Set(dcodes)]).then(collect),
  ])
  return [...seen.values()]
}

async function queryLeadsIn(field, values) {
  const out = []
  const fields = encodeURIComponent(JSON.stringify(BULK_FIELDS))
  for (let i = 0; i < values.length; i += CHUNK) {
    const filters = encodeURIComponent(JSON.stringify([[field, 'in', values.slice(i, i + CHUNK)]]))
    const r = await fetch(`${BASE}/api/resource/Lead?filters=${filters}&fields=${fields}&limit_page_length=0`, { headers: authHeaders })
    if (!r.ok) throw new Error(`bulk ${field} chunk: HTTP ${r.status} ${r.statusText}`)
    const json = await r.json()
    if (Array.isArray(json.data)) out.push(...json.data)
  }
  return out
}

// Fetch a single Lead doc (full document, including child tables).
async function fetchLead(name) {
  const url = `${BASE}/api/resource/Lead/${encodeURIComponent(name)}`
  const r = await fetch(url, { headers: authHeaders })
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status} ${r.statusText}`)
  const json = await r.json()
  return json.data
}

// Fetch ALL Address doctypes linked to a Lead via the Dynamic Link child table.
// A Lead can have several addresses (e.g. a Doctor address + a Clinic address).
async function fetchAddresses(name) {
  const filters = JSON.stringify([
    ['Dynamic Link', 'link_name', '=', name],
    ['Dynamic Link', 'link_doctype', '=', 'Lead'],
  ])
  const url = `${BASE}/api/resource/Address?filters=${encodeURIComponent(filters)}&fields=${encodeURIComponent('["*"]')}&limit_page_length=50`
  const r = await fetch(url, { headers: authHeaders })
  if (!r.ok) return []
  const json = await r.json()
  return Array.isArray(json.data) ? json.data : []
}

// Fetch one doctor = its Lead + linked Address(es), mapped together.
async function fetchDoctor(name) {
  const [lead, addresses] = await Promise.all([
    fetchLead(name),
    fetchAddresses(name).catch(() => []),
  ])
  return mapLead(lead, addresses)
}

// Read back the latest dashboard-written review comment per Lead, in one query.
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
  const json = await r.json()
  const latest = {}
  for (const c of json.data || []) {
    // asc order => last write per doctor wins
    latest[c.reference_name] = parseReview(c)
  }
  return latest
}

function parseReview(c) {
  const text = stripHtml(c.content || '')
  const decision = /READY/i.test(text) ? 'ready' : /ERROR/i.test(text) ? 'error' : null
  return { decision, text, at: (c.creation || '').slice(0, 19), by: c.comment_by || '' }
}

// Build the timeline comment body the CRM review writes to ERPNext.
function buildReviewComment(decision, issues, note, by) {
  if (decision === 'ready') {
    return `<b>${REVIEW_MARKER}: ✅ READY</b> — data verified correct.` + (note ? `<br>Note: ${esc(note)}` : '') + `<br><i>by ${esc(by)} via dashboard</i>`
  }
  const list = (issues || []).filter(Boolean).map(esc)
  const issuesHtml = list.length ? `<br>Issues: ${list.join(', ')}` : ''
  return `<b>${REVIEW_MARKER}: ⚠️ ERROR</b>${issuesHtml}` + (note ? `<br>Note: ${esc(note)}` : '') + `<br><i>by ${esc(by)} via dashboard</i>`
}

// Post a comment to a Lead's timeline (the section at the bottom of the form).
async function addComment(name, content, by) {
  const url = `${BASE}/api/method/frappe.desk.form.utils.add_comment`
  const r = await fetch(url, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reference_doctype: 'Lead',
      reference_name: name,
      content,
      comment_email: by || 'dashboard',
      comment_by: by || 'dashboard',
    }),
  })
  if (!r.ok) throw new Error(`add_comment ${name}: HTTP ${r.status} ${r.statusText}`)
  return (await r.json()).message
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const stripHtml = (s) => String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

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

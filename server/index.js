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

// Merge a zero-padded Lead INTO its clean twin using Frappe's NATIVE rename+merge
// — the exact operation the desk "Rename" dialog performs when you type the clean
// id and tick "Merge with existing". Nothing is deleted outright: every document
// that pointed at DR-00013218 (Contacts, Addresses, Comments, ToDos, any Link /
// Dynamic Link field) is re-pointed at DR-13218, and only then does the padded
// row disappear.
//
// Frappe's merge moves LINKS, not FIELD VALUES — the surviving doc keeps its own
// scalars and its own child rows, and the source's are dropped with it. So before
// the rename we run a two-part backfill onto the clean Lead:
//   1. scalars — fill only the fields the clean Lead leaves BLANK (never
//      overwrite a value it already has), reusing the rules in mergeDuplicates.js
//   2. custom_role_profile — union the padded Lead's role-profile rows in, keyed
//      on role_profile_list (same identity rule updateLeads.js uses), so the
//      padded side's department/HQ assignments survive the merge
// Backfill-then-rename is safely re-runnable: if the rename fails the clean Lead
// simply already holds the data and the next attempt backfills nothing new.
//
// Batched + concurrent; the frontend drives the offset loop. All ops retry on
// transient 5xx.

import { MERGE_FIELDS, computeBackfill } from './mergeDuplicates.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The stripped numeric code embedded in a padded Lead name (DR-00072078 → 72078).
export const codeOf = (n) => (String(n ?? '').replace(/^DR-?/i, '').replace(/^0+/, '') || '0')

async function fetchRetry(url, opts, tries = 4) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, opts)
      if (r.status < 500) return r
      last = new Error(`HTTP ${r.status}`)
    } catch (e) { last = e }
    if (i < tries - 1) await sleep(600 * (i + 1))
  }
  throw last || new Error('request failed')
}

const clean1 = (s) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

async function getJSON(url, headers, label) {
  const r = await fetchRetry(url, { headers })
  if (r.ok) return r.json()
  let body = ''
  try { body = await r.text() } catch { /* ignore */ }
  throw new Error(`${label}: HTTP ${r.status}${body ? ` — ${clean1(body).slice(0, 160)}` : ''}`)
}

async function send(method, url, headers, body) {
  let r
  try { r = await fetchRetry(url, { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }) }
  catch (e) { return { ok: false, status: 0, error: e.message } }
  if (r.ok) return { ok: true, status: r.status }
  let detail = ''
  try { const j = await r.json(); detail = j.exception || j._server_messages || j.message || '' } catch { try { detail = await r.text() } catch { detail = r.statusText } }
  return { ok: false, status: r.status, error: clean1(detail).slice(0, 300) }
}

async function mapLimit(items, limit, fn) {
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) { const idx = i++; if (idx >= items.length) break; await fn(items[idx], idx) }
  })
  await Promise.all(workers)
}

// ── Pair listing ────────────────────────────────────────────────────────────
// Every DR-0* Lead beside the clean DR-<code> twin it would merge into, so the
// tab can show both sides of each merge before anything is written.
const PAIR_FIELDS = ['name', 'custom_doctor_code', 'lead_name', 'territory', 'status']

async function listLeads(base, headers, filters, label) {
  const f = encodeURIComponent(JSON.stringify(PAIR_FIELDS))
  const q = encodeURIComponent(JSON.stringify(filters))
  const j = await getJSON(`${base}/api/resource/Lead?fields=${f}&filters=${q}&limit_page_length=0&order_by=${encodeURIComponent('name asc')}`, headers, label)
  return j.data || []
}

export async function fetchPaddedPairs({ base, authHeaders }) {
  const headers = { ...authHeaders, Accept: 'application/json' }
  const padded = await listLeads(base, headers, [['name', 'like', 'DR-0%']], 'Padded lead list')

  // Which clean twins actually exist — bulk, chunked so the IN(...) URL stays short.
  // There are ~6k padded ids, so this is ~70 chunk queries; running them SEQUENTIALLY
  // took 10–15s and blew past the serverless time limit (502 on /api/padded-pairs).
  // The chunks are independent, so fetch them CONCURRENTLY (bounded) — a couple of
  // seconds instead of a couple of minutes, without hammering ERP.
  const wanted = [...new Set(padded.map((l) => `DR-${codeOf(l.name)}`))]
  const cleanByName = {}
  const CH = 90
  const chunks = []
  for (let i = 0; i < wanted.length; i += CH) chunks.push(wanted.slice(i, i + CH))
  await mapLimit(chunks, 8, async (names) => {
    const found = await listLeads(base, headers, [['name', 'in', names]], 'Clean twin lookup')
    for (const l of found) cleanByName[l.name] = l
  })

  return padded.map((l) => {
    const code = codeOf(l.name)
    const clean = `DR-${code}`
    const twin = clean === l.name ? null : cleanByName[clean]
    return {
      padded: l.name,
      paddedDoctor: l.lead_name || '',
      paddedTerritory: l.territory || '',
      paddedStatus: l.status || '',
      paddedCode: String(l.custom_doctor_code ?? '').trim(),
      code,
      clean,
      cleanDoctor: twin ? (twin.lead_name || '') : '',
      cleanTerritory: twin ? (twin.territory || '') : '',
      cleanStatus: twin ? (twin.status || '') : '',
      hasClean: Boolean(twin),
    }
  })
}

// ── Merge ───────────────────────────────────────────────────────────────────
const fullDoc = (base, headers, name) =>
  getJSON(`${base}/api/resource/Lead/${encodeURIComponent(name)}`, headers, `Lead ${name}`).then((j) => j.data)

// Union the padded Lead's role-profile rows into the clean Lead's, keyed on
// role_profile_list (updateLeads.js treats that as the row's identity). Existing
// rows keep their child `name` so ERPNext updates them in place instead of
// recreating the table. Returns null when nothing new would be added.
function mergeRoleRows(keepDoc, remDoc) {
  const keepRows = Array.isArray(keepDoc.custom_role_profile) ? keepDoc.custom_role_profile : []
  const remRows = Array.isArray(remDoc.custom_role_profile) ? remDoc.custom_role_profile : []
  const seen = new Set(keepRows.map((x) => (x.role_profile_list || '').trim()).filter(Boolean))
  const added = []
  for (const x of remRows) {
    const k = (x.role_profile_list || '').trim()
    if (!k || seen.has(k)) continue
    seen.add(k)
    added.push({ role_profile_list: k, department: x.department || undefined, hq: x.hq || undefined })
  }
  if (added.length === 0) return null
  const rows = keepRows
    .map((x) => ({ name: x.name, role_profile_list: (x.role_profile_list || '').trim(), department: x.department || undefined, hq: x.hq || undefined }))
    .filter((x) => x.role_profile_list)
  return { rows: [...rows, ...added], added: added.length }
}

// Rename the padded Lead onto the clean one with merge=1. Frappe's whitelisted
// entry point and its argument names have moved between versions, so try the
// desk dialog's method first and fall back only when the METHOD or its SIGNATURE
// is what failed — never when ERPNext rejected the operation itself.
const RENAME_ATTEMPTS = [
  ['frappe.model.rename_doc.update_document_title', (o, n) => ({ doctype: 'Lead', docname: o, name: n, merge: 1 })],
  ['frappe.client.rename_doc', (o, n) => ({ doctype: 'Lead', old: o, new: n, merge: 1 })],
  ['frappe.client.rename_doc', (o, n) => ({ doctype: 'Lead', old_name: o, new_name: n, merge: 1 })],
]

const isSignatureMiss = (r) =>
  r.status === 404 ||
  /unexpected keyword argument|missing \d+ required|required positional|takes no arguments|not a valid method|Method Not Found|InvalidRequest/i.test(r.error || '')

async function renameMerge(base, headers, padded, clean) {
  let last = { ok: false, status: 0, error: 'no attempt made' }
  for (const [method, args] of RENAME_ATTEMPTS) {
    // eslint-disable-next-line no-await-in-loop
    const r = await send('POST', `${base}/api/method/${method}`, headers, args(padded, clean))
    if (r.ok) return { ok: true, via: method }
    last = r
    if (!isSignatureMiss(r)) break
  }
  return { ok: false, status: last.status, error: last.error }
}

// Merge one pair: backfill the clean Lead, then rename+merge the padded one into
// it, then confirm the padded id is really gone.
async function mergeOne(base, headers, pair, backfill) {
  const { padded, clean } = pair
  const out = { padded, clean, code: codeOf(padded), filled: [], rolesAdded: 0 }

  // Read the padded Lead first. If it 404s, the padded id is ALREADY gone — a
  // previous merge (or a timed-out batch that actually landed) handled it. The
  // whole point of the merge is that the padded id stops existing, so that goal
  // is already met: report success ("already merged"), never a red failure.
  let remDoc
  try {
    remDoc = await fullDoc(base, headers, padded)
  } catch (e) {
    if (/HTTP 404/.test(e.message)) return { ...out, ok: true, alreadyGone: true, verified: true }
    return { ...out, ok: false, stage: 'read', error: e.message }
  }

  // The clean twin must exist to merge into. If the list was stale and it's gone,
  // say so plainly rather than as a generic read error.
  let keepDoc
  try {
    keepDoc = await fullDoc(base, headers, clean)
  } catch (e) {
    const missing = /HTTP 404/.test(e.message)
    return { ...out, ok: false, stage: 'read', error: missing ? `clean twin ${clean} not found — Refresh the list` : e.message }
  }

  if (backfill) {
    const { patch = {} } = computeBackfill({ code: out.code, keep: clean, remove: [padded] }, { [clean]: keepDoc, [padded]: remDoc })
    const roles = mergeRoleRows(keepDoc, remDoc)
    if (roles) patch.custom_role_profile = roles.rows
    const keys = Object.keys(patch)
    if (keys.length) {
      const r = await send('PUT', `${base}/api/resource/Lead/${encodeURIComponent(clean)}`, headers, patch)
      if (!r.ok) return { ...out, ok: false, stage: 'backfill', error: r.error, status: r.status }
      out.filled = keys.filter((k) => k !== 'custom_role_profile')
      out.rolesAdded = roles ? roles.added : 0
    }
  }

  const r = await renameMerge(base, headers, padded, clean)
  if (!r.ok) return { ...out, ok: false, stage: 'merge', error: r.error, status: r.status }
  out.via = r.via

  // The padded id must no longer resolve — proof the merge landed rather than
  // silently no-op'ing.
  let gone = null
  try {
    const chk = await fetchRetry(`${base}/api/resource/Lead/${encodeURIComponent(padded)}`, { headers }, 2)
    gone = chk.status === 404
  } catch { /* verification is best-effort */ }
  return { ...out, ok: true, verified: gone }
}

// { base, authHeaders, pairs:[{padded,clean}], offset, batchSize, concurrency, backfill }
export async function runMergePadded({ base, authHeaders, pairs, offset = 0, batchSize = 5, concurrency = 5, backfill = true }) {
  if (!Array.isArray(pairs) || pairs.length === 0) throw new Error('pairs[] is required')
  const headers = { ...authHeaders, Accept: 'application/json' }
  const batch = pairs.slice(offset, offset + batchSize)

  const counts = { merged: 0, alreadyGone: 0, errors: 0, fieldsFilled: 0, rolesAdded: 0, unverified: 0 }
  const results = []

  await mapLimit(batch, concurrency, async (pair) => {
    if (!pair?.padded || !pair?.clean) {
      counts.errors++; results.push({ ...pair, ok: false, stage: 'input', error: 'padded and clean are required' }); return
    }
    const r = await mergeOne(base, headers, pair, backfill !== false)
    if (r.ok) {
      if (r.alreadyGone) counts.alreadyGone++
      else {
        counts.merged++
        counts.fieldsFilled += (r.filled || []).length
        counts.rolesAdded += r.rolesAdded || 0
      }
      if (r.verified === false) counts.unverified++
    } else counts.errors++
    results.push(r)
  })

  const done = offset + batchSize >= pairs.length
  return { processed: batch.length, nextOffset: done ? null : offset + batchSize, done, total: pairs.length, counts, results }
}

export { MERGE_FIELDS }

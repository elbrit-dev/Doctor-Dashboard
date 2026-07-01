// Data loader. Tries the live proxy (/api/doctors) first; if it's not running or
// not configured, falls back to the bundled snapshot so the dashboard always works.
import { doctors as snapshot, SNAPSHOT_DATE, SOURCE } from './doctors.js'

export async function loadDoctors() {
  try {
    const res = await fetch('/api/doctors', { headers: { Accept: 'application/json' } })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.detail || body.error || `HTTP ${res.status}`)
    }
    const json = await res.json()
    if (!Array.isArray(json.doctors) || json.doctors.length === 0) throw new Error('No records returned')
    return {
      doctors: json.doctors,
      mode: 'live',
      fetchedAt: json.fetchedAt ? json.fetchedAt.slice(0, 19).replace('T', ' ') : null,
      source: json.source || SOURCE,
    }
  } catch (err) {
    return {
      doctors: snapshot,
      mode: 'snapshot',
      fetchedAt: SNAPSHOT_DATE,
      source: SOURCE,
      reason: err.message,
    }
  }
}

// Bulk fetch ERPNext records for doctor codes, in chunks so large sheets stay
// under serverless timeouts. onProgress(done, total) fires after each chunk.
// Returns { doctors: { strippedCode -> mapped doctor }, found, requested }.
export async function fetchLeadsByCode(codes, { addresses = true, onProgress } = {}) {
  // Address lookups are 1 request per doctor (ERPNext blocks bulk address
  // mapping), so use small chunks when addresses are on, big chunks when off.
  const chunk = addresses ? 60 : 200
  const doctors = {}
  let found = 0
  for (let i = 0; i < codes.length; i += chunk) {
    const slice = codes.slice(i, i + chunk)
    const res = await fetch('/api/leads-by-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ codes: slice, addresses }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.detail || body.error || `HTTP ${res.status}`)
    Object.assign(doctors, body.doctors || {})
    found += body.found || 0
    if (onProgress) onProgress(Math.min(i + chunk, codes.length), codes.length)
  }
  return { doctors, found, requested: codes.length }
}

// Create/update/duplicate triage: send the parsed sheet rows, get back which
// codes need creating, which exist (update), and the duplicate sets.
// Only 4 fields are needed to categorize a row (see server/triage.js). Big
// sheets (7k+ rows × 40 columns) would blow past the serverless request-body
// limit (~6 MB → HTTP 500), so we send just those fields. The full rows stay in
// the browser for the batched create/update calls.
export async function reconcileSheet(rows) {
  const slim = rows.map((r) => ({
    'Dr. Code': r['Dr. Code'],
    'Dr. Name': r['Dr. Name'],
    'Emp Code': r['Emp Code'],
    HQ: r['HQ'],
  }))
  const res = await fetch('/api/reconcile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ rows: slim }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.detail || body.error || `HTTP ${res.status}`)
  return body
}

// Process one batch of an uploaded sheet: create new Leads (+ addresses) in
// ERPNext UAT for codes not already there. Stateless per call — the caller
// drives the offset loop until the response says { done: true }.
export async function processBatch({ rows, offset = 0, batchSize = 50 }) {
  const res = await fetch('/api/process', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ rows, offset, batchSize }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.detail || body.error || `HTTP ${res.status}`)
  return body
}

// Update one batch of EXISTING Leads (codes already in UAT): scalar backfill on
// change, append the employee's role profile if missing, and append the sheet's
// address if it isn't already on the Lead. Never creates. Stateless per call —
// the caller drives the offset loop until the response says { done: true }.
export async function updateBatch({ rows, offset = 0, batchSize = 40 }) {
  const res = await fetch('/api/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ rows, offset, batchSize }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.detail || body.error || `HTTP ${res.status}`)
  return body
}

// Merge padded duplicate Leads into their clean form (moving addresses) and
// delete the padded ones. Stateless per call — caller drives the offset loop.
export async function mergeDuplicatesBatch({ duplicates, offset = 0, batchSize = 20 }) {
  const res = await fetch('/api/merge-duplicates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ duplicates, offset, batchSize }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.detail || body.error || `HTTP ${res.status}`)
  return body
}

// CRM writes a review decision back to ERPNext (posts a comment on the Lead).
// payload: { id, decision: 'ready'|'error', issues?: string[], note?: string, by?: string }
export async function submitReview(payload) {
  const res = await fetch('/api/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.detail || body.error || `HTTP ${res.status}`)
  return body
}

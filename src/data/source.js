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

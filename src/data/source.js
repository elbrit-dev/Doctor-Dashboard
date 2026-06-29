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

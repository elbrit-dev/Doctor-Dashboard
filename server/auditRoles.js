// Read-only audit of EXISTING UAT Leads: find the ones whose Role Profile
// ("Sales Team") child table lists the SAME department on more than one row —
// e.g. two rows both "CND Coimbatore - ELPL". Nothing is written; this only
// reports, so the CRM owner can clean up the duplicates by hand.
//
// The child table (doctype "Role Profile Multiselect", field custom_role_profile)
// can't be bulk-read — querying the child doctype directly is 403, and a Lead
// list query never returns child rows — so we GET one Lead doc per code, run
// concurrently with 5xx retries. The frontend drives the offset loop, so no
// single call risks the serverless timeout.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Departments compared case-insensitively with whitespace collapsed, so
// "CND Coimbatore - ELPL" and "cnd coimbatore  -  elpl" count as the same.
const norm = (v) => String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase()

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

async function getJSON(url, headers, label) {
  const r = await fetchRetry(url, { headers })
  if (r.ok) return r.json()
  let body = ''
  try { body = await r.text() } catch { /* ignore */ }
  let detail = ''
  try { const j = JSON.parse(body); detail = j.exception || j.message || j._server_messages || '' } catch { detail = body }
  throw new Error(`${label}: HTTP ${r.status}${detail ? ` — ${String(detail).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}` : ''}`)
}

async function mapLimit(items, limit, fn) {
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) { const idx = i++; if (idx >= items.length) break; await fn(items[idx], idx) }
  })
  await Promise.all(workers)
}

// Group a Lead's role-profile rows by normalized department; return only the
// departments that appear more than once, with the role-profile codes that
// carry each (so the report shows WHICH rows collide).
function duplicateDepartments(roles) {
  const byDept = new Map()
  for (const r of roles) {
    const dept = String(r.department ?? '').trim()
    if (!dept) continue
    const key = norm(dept)
    const g = byDept.get(key) || { department: dept, roleProfiles: [] }
    g.roleProfiles.push(String(r.role_profile_list ?? '').trim())
    byDept.set(key, g)
  }
  return [...byDept.values()]
    .filter((g) => g.roleProfiles.length > 1)
    .map((g) => ({ department: g.department, count: g.roleProfiles.length, roleProfiles: g.roleProfiles }))
}

// { base, authHeaders, items:[{code,name,hq,leadName}], offset, batchSize, concurrency }
// Stateless per batch — the caller sends the full items[] and owns the offset.
export async function runRoleAudit({ base, authHeaders, items, offset = 0, batchSize = 60, concurrency = 8 }) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('items[] is required')
  const headers = { ...authHeaders, Accept: 'application/json' }
  const batch = items.slice(offset, offset + batchSize)

  const counts = { scanned: 0, flagged: 0, errors: 0 }
  const flagged = []

  await mapLimit(batch, concurrency, async (it) => {
    const code = String(it.code ?? '').trim()
    const leadName = String(it.leadName ?? '').trim() || (code ? `DR-${code}` : '')
    if (!leadName) return
    let doc
    try {
      const j = await getJSON(`${base}/api/resource/Lead/${encodeURIComponent(leadName)}`, headers, `Lead ${leadName}`)
      doc = j.data
    } catch { counts.errors++; return }
    counts.scanned++
    const roles = Array.isArray(doc.custom_role_profile) ? doc.custom_role_profile : []
    const dups = duplicateDepartments(roles)
    if (dups.length) {
      counts.flagged++
      flagged.push({
        code,
        name: it.name || doc.first_name || '',
        leadName,
        hq: it.hq || doc.territory || '',
        duplicates: dups,
      })
    }
  })

  const done = offset + batchSize >= items.length
  return { processed: batch.length, nextOffset: done ? null : offset + batchSize, done, total: items.length, counts, flagged }
}

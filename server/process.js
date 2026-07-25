// Stateless batch engine shared by the Netlify function (netlify/functions/process.js)
// and the local dev proxy (server/index.js). The FRONTEND owns the offset loop;
// each call processes exactly one slice and reports `nextOffset`, so no single
// invocation risks the serverless timeout.
//
// On every call it re-fetches fresh from ERPNext (employees for this batch +
// ALL existing coded Leads) so re-running a batch never double-creates: a code
// created on the previous pass now shows up as `skip`.

import { transformRow, extractEmpId, invalidLinkFields } from './transform.js'
import { fetchDoctorLeads, leadCode } from './leadIndex.js'
import { fetchTerritories, makeTerritoryResolver, fetchDoctypeNames, ensureLinkValues } from './territory.js'
import { makeTokenResolver } from './hqMatch.js'

// ---- ERPNext reads ----------------------------------------------------------
// GET that surfaces the ERPNext error body (Frappe returns the real reason —
// e.g. a PermissionError on Employee — in the response, not just the status).
async function getJSON(url, headers, label) {
  const r = await fetch(url, { headers })
  if (r.ok) return r.json()
  let body = ''
  try { body = await r.text() } catch { /* ignore */ }
  let detail = ''
  try { const j = JSON.parse(body); detail = j.exception || j.message || (j._server_messages || '') } catch { detail = body }
  detail = String(detail).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)
  throw new Error(`${label}: HTTP ${r.status} ${r.statusText}${detail ? ` — ${detail}` : ''}`)
}

async function fetchEmployees(base, headers, empCodes) {
  if (empCodes.length === 0) return {}
  const fields = encodeURIComponent(JSON.stringify(['name', 'role_id', 'custom_role_profile', 'department', 'fsl_hq']))
  const filters = encodeURIComponent(JSON.stringify([['name', 'in', empCodes]]))
  const j = await getJSON(`${base}/api/resource/Employee?fields=${fields}&filters=${filters}&limit_page_length=0`, headers, 'Employee fetch')
  const map = {}
  for (const e of (j.data || [])) map[e.name] = e
  return map
}

async function fetchExistingCodes(base, headers) {
  const leads = await fetchDoctorLeads(base, headers)
  const set = new Set(); const clean = new Set(); const names = new Map() // normalized code -> [Lead names]
  for (const l of leads) {
    const c = leadCode(l)
    if (!c) continue
    set.add(c)
    // A CLEAN Lead is one NAMED exactly DR-<code>. Only its presence blocks a
    // create — a padded-only DR-000<code> should still get its clean twin made.
    if (l.name === `DR-${c}`) clean.add(c)
    if (!names.has(c)) names.set(c, [])
    names.get(c).push(l.name)
  }
  return { set, clean, names }
}

// ---- ERPNext writes ---------------------------------------------------------
async function send(method, url, headers, body) {
  const r = await fetch(url, { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (r.ok) return { ok: true, status: r.status }
  let detail = ''
  try { const j = await r.json(); detail = j.exception || j._server_messages || j.message || JSON.stringify(j) } catch { detail = r.statusText }
  return { ok: false, status: r.status, error: String(detail).slice(0, 500) }
}

// Run `fn` over items with at most `limit` in flight at once.
async function mapLimit(items, limit, fn) {
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++
      if (idx >= items.length) break
      await fn(items[idx], idx)
    }
  })
  await Promise.all(workers)
}

// ---- One batch (CREATE only) ------------------------------------------------
// { base, authHeaders, rows, offset, batchSize }
// Creates a new Lead (+ Address when present) for every code not already in UAT.
// Codes already in UAT are skipped; rows with no employee / role profile are
// reported as exceptions. Re-running is safe — a just-created code is now a skip.
export async function runProcess({ base, authHeaders, rows, offset = 0, batchSize = 50 }) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('rows[] is required')

  const headers = { ...authHeaders, Accept: 'application/json' }
  const batch = rows.slice(offset, offset + batchSize)
  // Fetch employees by Emp Code AND by the id embedded in the Emp Name, so a
  // vacant code (V01869 → "…(E01198)") resolves to the real employee.
  const empCodes = [...new Set(batch.flatMap((r) => {
    const out = []
    const ec = String(r['Emp Code'] ?? '').trim(); if (ec) out.push(ec)
    const alt = extractEmpId(r['Emp Name']); if (alt) out.push(alt)
    return out
  }))]

  const [empMap, existing, territories, specialties, qualifications] = await Promise.all([
    fetchEmployees(base, headers, empCodes),
    fetchExistingCodes(base, headers),
    fetchTerritories(base, headers),
    fetchDoctypeNames(base, headers, 'Specialty'),
    fetchDoctypeNames(base, headers, 'Doctor Qualification'),
  ])
  const resolveTerritory = makeTerritoryResolver(territories)
  const resolveSpecialty = makeTokenResolver(specialties)
  // Qualification goes in AS-IS (DGO ≠ MD.DGO ≠ MBBS.DGO): create any missing
  // value, then look it up exactly — no fuzzy/containment guessing.
  const rawQuals = [...new Set(batch.map((r) => String(r['Qualification'] ?? '').trim()).filter(Boolean))]
  const qualMap = await ensureLinkValues(base, headers, 'Doctor Qualification', 'qualification', rawQuals, qualifications)
  const resolveQualification = (v) => qualMap[String(v ?? '').trim()] || null

  // Pass the CLEAN-form set (not every code): a code is skipped only when the
  // clean DR-<code> already exists, so a padded-only code creates its clean twin.
  const transformed = batch.map((r) => transformRow(r, empMap, existing.clean, resolveTerritory, resolveSpecialty, resolveQualification))

  const counts = { created: 0, renamed: 0, skipped: 0, exceptions: 0, errors: 0 }
  const results = []
  const exceptions = []
  const toCreate = []

  for (const t of transformed) {
    if (t.kind === 'exception') { counts.exceptions++; exceptions.push(t); continue }
    if (t.kind === 'skip') { counts.skipped++; continue } // already in UAT
    toCreate.push(t) // kind 'create'
  }

  // The padded twin (DR-000<code>) of a create target, if one exists — prefer the
  // zero-padded "DR-0…" form, else any non-clean Lead sharing the code.
  const paddedFor = (code) => {
    const all = existing.names.get(code) || []
    return all.find((n) => /^DR-?0\d/i.test(n)) || all.find((n) => n !== `DR-${code}`) || null
  }

  await mapLimit(toCreate, 5, async (t) => {
    let res = await send('POST', `${base}/api/resource/Lead`, headers, t.lead)
    // Invalid link value (Specialty/Qualification/Category)? Drop just those and
    // retry so the Lead is still created. Territory is left in — an unmatched HQ
    // stays a visible error so it can be added as an alias.
    if (!res.ok && /could not find/i.test(res.error || '')) {
      const bad = invalidLinkFields(res.error).filter((f) => f !== 'territory' && f in t.lead)
      if (bad.length) {
        const reduced = { ...t.lead }; bad.forEach((f) => delete reduced[f])
        res = await send('POST', `${base}/api/resource/Lead`, headers, reduced)
        if (res.ok) res.droppedLinks = bad
      }
    }
    // Doctor already has a Contact (created by the padded twin), so creating a
    // second Lead 409s on the unique Contact name — the clean twin can't be made.
    // Instead RENAME the padded Lead to the clean DR-<code>: same record, same
    // Contact/addresses/history, now with the clean id and no leftover to delete.
    // The sheet's field values are applied afterwards by the normal update pass.
    if (!res.ok && (res.status === 409 || /duplicate/i.test(res.error || ''))) {
      const padded = paddedFor(t.code)
      if (padded) {
        const rn = await send('POST', `${base}/api/method/frappe.client.rename_doc`, headers,
          { doctype: 'Lead', old_name: padded, new_name: t.name })
        if (rn.ok) {
          counts.renamed++
          results.push({ code: t.code, op: 'rename_lead', ok: true, status: rn.status, from: padded, to: t.name })
          return
        }
        results.push({ code: t.code, op: 'rename_lead', ok: false, status: rn.status, from: padded, to: t.name, error: rn.error })
        counts.errors++
        return
      }
    }
    results.push({ code: t.code, op: 'create_lead', ok: res.ok, status: res.status, error: res.error, droppedLinks: res.droppedLinks })
    if (res.ok) {
      counts.created++
      if (t.hasAddress && t.address) {
        const ar = await send('POST', `${base}/api/resource/Address`, headers, t.address)
        // Duplicate address auto-name = an equivalent address already exists.
        if (!ar.ok && /duplicate entry/i.test(ar.error || '')) { /* skip, not an error */ }
        else {
          results.push({ code: t.code, op: 'create_address', ok: ar.ok, status: ar.status, error: ar.error })
          if (!ar.ok) counts.errors++
        }
      }
    } else {
      counts.errors++
    }
  })

  const done = offset + batchSize >= rows.length
  return {
    processed: batch.length,
    nextOffset: done ? null : offset + batchSize,
    done,
    total: rows.length,
    counts,
    results,
    exceptions,
  }
}

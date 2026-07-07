// Resolve a sheet's HQ to an EXISTING UAT Territory.
//
// Lead.territory is a Link to the Territory doctype: any value that isn't an
// exact existing territory name is rejected by ERPNext with a
// LinkValidationError ("Could not find Territory (HQ): HQ-<x>"). The sheets carry
// HQ names with spelling mistakes and inconsistent prefixes/spacing (e.g. the
// sheet says "Rajamhundry" but UAT has "HQ-Rajamundry"; UAT also has "HQ- Lucknow"
// with a stray space). So we map the sheet HQ onto a real territory instead of
// blindly sending "HQ-<HQ>".
//
// Matching is deliberately conservative: exact/normalized first, then a
// spelling-tolerant match only when there is a SINGLE closest territory within a
// tight edit-distance. Anything we can't confidently match is left as the raw
// "HQ-<HQ>" so it surfaces as a per-row error (now exportable) rather than being
// silently mapped to the wrong HQ.

import { normHq as norm, lev, soundex } from './hqMatch.js'

// Fetch all the `name` values of a doctype (a link field's allowed values).
export async function fetchDoctypeNames(base, headers, doctype) {
  const url = `${base}/api/resource/${encodeURIComponent(doctype)}?fields=${encodeURIComponent('["name"]')}&limit_page_length=0`
  try {
    const r = await fetch(url, { headers })
    if (!r.ok) return []
    const j = await r.json()
    return (j.data || []).map((t) => t.name).filter(Boolean)
  } catch { return [] }
}

export const fetchTerritories = (base, headers) => fetchDoctypeNames(base, headers, 'Territory')

// Ensure each value exists in `doctype` AS-IS, creating any that are missing, and
// return a map { rawValue -> exact link name }. Used for Qualification, where the
// sheet's value must go in verbatim (DGO ≠ MD.DGO ≠ MBBS.DGO). The doctype
// auto-names new rows with a random code, so we create then rename to the value.
export async function ensureLinkValues(base, headers, doctype, fieldname, values, existing) {
  const byLower = new Map((existing || []).map((n) => [String(n).toLowerCase(), n]))
  const map = {}
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  for (const raw of values) {
    const v = String(raw || '').trim()
    if (!v || !/[a-z]/i.test(v)) continue // skip empty / non-alphabetic junk
    const lower = v.toLowerCase()
    if (byLower.has(lower)) { map[v] = byLower.get(lower); continue }
    try {
      const cr = await post(`/api/resource/${encodeURIComponent(doctype)}`, { [fieldname]: v })
      if (!cr.ok) continue
      const hash = (await cr.json())?.data?.name
      if (!hash) continue
      if (hash !== v) {
        // rename the random-code doc to the exact value so the Link name is clean
        await post('/api/method/frappe.client.rename_doc', { doctype, old_name: hash, new_name: v }).catch(() => {})
      }
      byLower.set(lower, v)
      map[v] = v
    } catch { /* leave unmapped → row skips this field */ }
  }
  return map
}

// Build a resolver over the existing territory names. resolve(hq) → an existing
// territory name, or null when nothing matches confidently. Order of confidence:
//   1. exact after normalization (prefix / spacing / case / known alias)
//   2. near spelling — the single closest territory within a tight edit distance
//   3. same pronunciation — the single closest territory sharing a Soundex code
export function makeTerritoryResolver(names) {
  const byNorm = new Map()  // normalized key -> preferred actual name
  const phonetic = new Map() // soundex code -> Set(normalized keys)
  for (const name of names) {
    const k = norm(name)
    if (!k) continue
    const cur = byNorm.get(k)
    // On collision (e.g. "HQ-Rajamundry" and "Rajamundry") prefer the HQ- form.
    if (!cur || (/^hq/i.test(name) && !/^hq/i.test(cur))) byNorm.set(k, name)
    const sx = soundex(k)
    if (sx) { if (!phonetic.has(sx)) phonetic.set(sx, new Set()); phonetic.get(sx).add(k) }
  }
  const keys = [...byNorm.keys()]

  // Among a set of candidate keys, the single one closest to k (unique min lev).
  const closest = (k, candidateKeys, thresh) => {
    let best = null, bestD = Infinity, tie = false
    for (const key of candidateKeys) {
      const d = lev(k, key)
      if (d < bestD) { bestD = d; best = key; tie = false }
      else if (d === bestD && key !== best) tie = true
    }
    if (best && bestD <= thresh && !tie) return best
    return null
  }

  return function resolve(hq) {
    const k = norm(hq)
    if (!k) return null
    if (byNorm.has(k)) return byNorm.get(k) // (1) exact / normalized / alias

    // (2) near spelling
    const spellHit = closest(k, keys, Math.max(1, Math.floor(k.length * 0.2)))
    if (spellHit) return byNorm.get(spellHit)

    // (3) same pronunciation — but ALSO within a reasonable edit distance, so
    // unrelated names that merely share a Soundex code (Tumkur vs Tanjore, both
    // T526) don't get falsely matched. Bengaluru↔Bangalore (lev 3) still passes.
    const cands = phonetic.get(soundex(k))
    if (cands && cands.size) {
      const phonHit = closest(k, cands, Math.max(2, Math.floor(k.length * 0.4)))
      if (phonHit) return byNorm.get(phonHit)
    }
    return null
  }
}

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

export async function fetchTerritories(base, headers) {
  const url = `${base}/api/resource/Territory?fields=${encodeURIComponent('["name"]')}&limit_page_length=0`
  try {
    const r = await fetch(url, { headers })
    if (!r.ok) return []
    const j = await r.json()
    return (j.data || []).map((t) => t.name).filter(Boolean)
  } catch { return [] }
}

// lowercase, drop a leading "HQ" + separators, keep only alphanumerics.
//   "HQ-Rajamundry" → "rajamundry"   "HQ- Lucknow" → "lucknow"
//   "Rajamundry"    → "rajamundry"   sheet "Rajamhundry" → "rajamhundry"
const norm = (s) => String(s || '').toLowerCase().replace(/^\s*hq[-\s]*/, '').replace(/[^a-z0-9]/g, '')

function lev(a, b) {
  const m = a.length, n = b.length
  if (!m) return n
  if (!n) return m
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1])
    }
    prev = cur
  }
  return prev[n]
}

// Build a resolver over the existing territory names. resolve(hq) → an existing
// territory name, or null when nothing matches confidently.
export function makeTerritoryResolver(names) {
  const byNorm = new Map() // normalized key -> preferred actual name
  for (const name of names) {
    const k = norm(name)
    if (!k) continue
    const cur = byNorm.get(k)
    // On collision (e.g. "HQ-Rajamundry" and "Rajamundry") prefer the HQ- form,
    // since that's the shape the create path intends.
    if (!cur || (/^hq/i.test(name) && !/^hq/i.test(cur))) byNorm.set(k, name)
  }
  const keys = [...byNorm.keys()]

  return function resolve(hq) {
    const raw = String(hq || '').trim()
    const k = norm(raw)
    if (!k) return null
    if (byNorm.has(k)) return byNorm.get(k) // exact / normalized (prefix, spacing, case)

    // Spelling-tolerant: the single closest territory within a tight distance.
    let best = null, bestD = Infinity, tie = false
    for (const key of keys) {
      const d = lev(k, key)
      if (d < bestD) { bestD = d; best = key; tie = false }
      else if (d === bestD) tie = true
    }
    const thresh = Math.max(1, Math.floor(k.length * 0.15))
    if (best && bestD <= thresh && !tie) return byNorm.get(best)
    return null
  }
}

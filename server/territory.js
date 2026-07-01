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

// Well-known Indian city renames / aliases the sheets may use interchangeably.
// Each group's FIRST entry is the canonical key everything in the group folds to,
// so "Bengaluru" and "Bangalore" (and their misspellings) resolve to the same
// territory. Soundex (below) already catches same-sounding pairs like
// Bengaluru↔Bangalore or Mysuru↔Mysore; this table covers true renames that
// don't sound alike (Cochin↔Kochi, Pondicherry↔Puducherry, …).
const ALIAS_GROUPS = [
  ['bangalore', 'bengaluru'],
  ['cochin', 'kochi'],
  ['pondicherry', 'puducherry', 'pondy'],
  ['chennai', 'madras'],
  ['mumbai', 'bombay'],
  ['kolkata', 'calcutta'],
  ['trivandrum', 'thiruvananthapuram'],
  ['mysore', 'mysuru'],
  ['calicut', 'kozhikode'],
  ['allahabad', 'prayagraj'],
  ['baroda', 'vadodara'],
  ['gurgaon', 'gurugram'],
  ['vizag', 'visakhapatnam', 'vishakhapatnam', 'vizagapatnam'],
  ['varanasi', 'banaras', 'benares'],
  ['tirunelveli', 'nellai'],
]
const ALIAS = new Map()
for (const grp of ALIAS_GROUPS) for (const v of grp) ALIAS.set(v, grp[0])

// lowercase, drop a leading "HQ" + separators, keep only alphanumerics, then fold
// known aliases to their canonical form.
//   "HQ-Rajamundry" → "rajamundry"   "HQ- Lucknow" → "lucknow"
//   "Bengaluru" → "bengaluru" → alias → "bangalore"
const normBase = (s) => String(s || '').toLowerCase().replace(/^\s*hq[-\s]*/, '').replace(/[^a-z0-9]/g, '')
const norm = (s) => { const b = normBase(s); return ALIAS.get(b) || b }

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

// Soundex: a phonetic code so same-SOUNDING names collide (Bengaluru↔Bangalore →
// B524). Catches spelling variants that edit-distance alone misses.
const SX = { B: '1', F: '1', P: '1', V: '1', C: '2', G: '2', J: '2', K: '2', Q: '2', S: '2', X: '2', Z: '2', D: '3', T: '3', L: '4', M: '5', N: '5', R: '6' }
function soundex(s) {
  const u = String(s || '').toUpperCase().replace(/[^A-Z]/g, '')
  if (!u) return ''
  let out = u[0], prev = SX[u[0]] || ''
  for (let i = 1; i < u.length && out.length < 4; i++) {
    const c = SX[u[i]] || ''
    if (c && c !== prev) out += c
    if (u[i] !== 'H' && u[i] !== 'W') prev = c
  }
  return (out + '000').slice(0, 4)
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

    // (3) same pronunciation — unique Soundex match, tie-broken by edit distance
    const cands = phonetic.get(soundex(k))
    if (cands && cands.size) {
      if (cands.size === 1) return byNorm.get([...cands][0])
      const phonHit = closest(k, cands, Infinity) // pick the closest same-sounding one
      if (phonHit) return byNorm.get(phonHit)
    }
    return null
  }
}

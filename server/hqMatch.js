// Shared HQ / Territory matching primitives — PURE (no I/O), so the exact same
// "is this the same HQ?" logic runs both server-side (mapping the sheet HQ onto a
// real Territory before writing) and in the browser validation (so it doesn't
// flag "Nellur" vs "HQ-Nellore" as a mismatch). Keeping one source of truth here
// prevents the writer and the validator from ever disagreeing.

// Well-known Indian city renames / aliases the sheets may use interchangeably.
// Each group's FIRST entry is the canonical key everything folds to. Soundex
// (below) already catches same-sounding pairs (Bengaluru↔Bangalore); this covers
// true renames that don't sound alike (Cochin↔Kochi, Madras↔Chennai, …).
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
  ['noida', 'greaternoida', 'grnoida'],
]
const ALIAS = new Map()
for (const grp of ALIAS_GROUPS) for (const v of grp) ALIAS.set(v, grp[0])

// lowercase, drop a leading "HQ" + separators, keep only alphanumerics, then fold
// known aliases to their canonical form.
//   "HQ-Rajamundry" → "rajamundry"   "HQ- Lucknow" → "lucknow"   "Bengaluru" → "bangalore"
export const normHq = (s) => {
  const b = String(s || '').toLowerCase().replace(/^\s*hq[-\s]*/, '').replace(/[^a-z0-9]/g, '')
  return ALIAS.get(b) || b
}

export function lev(a, b) {
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
// B524; Nellur↔Nellore → N460). Catches variants edit-distance alone misses.
const SX = { B: '1', F: '1', P: '1', V: '1', C: '2', G: '2', J: '2', K: '2', Q: '2', S: '2', X: '2', Z: '2', D: '3', T: '3', L: '4', M: '5', N: '5', R: '6' }
export function soundex(s) {
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

// ── Generic coded-value matching (Specialty, Qualification) ──────────────────
// Like the HQ match but without the HQ-prefix/alias handling: exact → unique
// containment (e.g. "DGO" ⊂ "MD.DGO", "GYNAE" ⊂ "GYNAEC") → pronunciation →
// near spelling.
export const normToken = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')

export function sameToken(a, b) {
  const ka = normToken(a), kb = normToken(b)
  if (!ka || !kb) return false
  if (ka === kb) return true
  if (ka.length >= 3 && kb.length >= 3 && (ka.includes(kb) || kb.includes(ka))) return true
  if (soundex(ka) === soundex(kb)) return true
  return lev(ka, kb) <= Math.max(1, Math.floor(Math.max(ka.length, kb.length) * 0.2))
}

// Resolve a sheet value to the best entry in `names` (a link doctype's values),
// or null when nothing matches confidently. Used to turn "GYNAEC" → "GYNAE" and
// "DGO" → "MD.DGO" before writing, so Link fields don't reject the value.
export function makeTokenResolver(names) {
  const list = (names || []).filter(Boolean)
  return (v) => {
    const kv = normToken(v)
    if (!kv) return null
    for (const n of list) if (normToken(n) === kv) return n // exact / normalized
    // containment — the sheet token is part of (or contains) a valid value, e.g.
    // "DGO" ⊂ "MD.DGO"/"MBBS.DGO", "GYNAE" ⊂ "GYNAEC". When several match, pick the
    // SHORTEST (closest to the token) so it's deterministic (DGO → MD.DGO).
    const contains = list
      .filter((n) => { const kn = normToken(n); return kn.length >= 3 && kv.length >= 3 && (kn.includes(kv) || kv.includes(kn)) })
      .sort((a, b) => normToken(a).length - normToken(b).length)
    if (contains.length) return contains[0]
    // unique closest by pronunciation / spelling
    let best = null, bestD = Infinity, tie = false
    for (const n of list) {
      const kn = normToken(n)
      let d = lev(kv, kn)
      if (soundex(kv) === soundex(kn)) d = Math.min(d, 1)
      if (d < bestD) { bestD = d; best = n; tie = false } else if (d === bestD) tie = true
    }
    if (best && bestD <= Math.max(1, Math.floor(kv.length * 0.34)) && !tie) return best
    return null
  }
}

// Are two HQ / territory values the same place? exact/alias → pronunciation →
// tight spelling. Used by the validation to avoid false mismatches.
export function sameHq(a, b) {
  const ka = normHq(a), kb = normHq(b)
  if (!ka || !kb) return false
  if (ka === kb) return true
  const maxlen = Math.max(ka.length, kb.length)
  // Same pronunciation only counts when also spelling-close, so Tumkur↔Tanjore
  // (same Soundex) doesn't falsely match while Bengaluru↔Bangalore still does.
  if (soundex(ka) === soundex(kb) && lev(ka, kb) <= Math.max(2, Math.floor(maxlen * 0.4))) return true
  return lev(ka, kb) <= Math.max(1, Math.floor(maxlen * 0.2))
}

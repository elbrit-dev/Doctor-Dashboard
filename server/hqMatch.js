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

// Are two HQ / territory values the same place? exact/alias → pronunciation →
// tight spelling. Used by the validation to avoid false mismatches.
export function sameHq(a, b) {
  const ka = normHq(a), kb = normHq(b)
  if (!ka || !kb) return false
  if (ka === kb) return true
  if (soundex(ka) === soundex(kb)) return true
  const thresh = Math.max(1, Math.floor(Math.max(ka.length, kb.length) * 0.2))
  return lev(ka, kb) <= thresh
}

// Bulk-merge ALL duplicate doctor Leads in UAT, straight from Node — no browser,
// no Netlify function timeout. Discovers every code that exists as both a clean
// DR-<code> and a padded DR-000<code>, moves the padded Lead's addresses onto
// the clean one, then deletes the padded Lead. Idempotent + retry-on-5xx, so
// it's safe to re-run and safe to Ctrl-C and resume.
//
// Usage (from the project root, with .env configured):
//   node scripts/merge-all-duplicates.mjs --dry            # discover + count only, no writes
//   node scripts/merge-all-duplicates.mjs --limit 20       # process only the first 20 (timed sample)
//   node scripts/merge-all-duplicates.mjs                  # process ALL
//   node scripts/merge-all-duplicates.mjs --concurrency 4  # tune parallelism (default 3)

import 'dotenv/config'
import { runMerge } from '../server/mergeDuplicates.js'

const arg = (name, def) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : def
}
const DRY = !!arg('--dry', false)
const LIMIT = Number(arg('--limit', 0)) || 0
const CONCURRENCY = Number(arg('--concurrency', 3)) || 3
const BATCH = Number(arg('--batch', 50)) || 50

const BASE = (process.env.ERPNEXT_URL || '').replace(/\/+$/, '')
const authHeaders = { Authorization: `token ${process.env.ERPNEXT_API_KEY || ''}:${process.env.ERPNEXT_API_SECRET || ''}` }
const strip = (c) => String(c || '').replace(/\D/g, '').replace(/^0+/, '')

if (!BASE || !process.env.ERPNEXT_API_KEY) { console.error('Set ERPNEXT_URL / ERPNEXT_API_KEY / ERPNEXT_API_SECRET in .env'); process.exit(1) }

async function discover() {
  const fields = encodeURIComponent(JSON.stringify(['name', 'custom_doctor_code']))
  const filters = encodeURIComponent(JSON.stringify([['name', 'like', 'DR-%']]))
  const r = await fetch(`${BASE}/api/resource/Lead?fields=${fields}&filters=${filters}&limit_page_length=0`, { headers: { ...authHeaders, Accept: 'application/json' } })
  if (!r.ok) throw new Error(`Lead list: HTTP ${r.status}`)
  const leads = (await r.json()).data || []
  const groups = {}
  for (const l of leads) { const code = strip(String(l.name).replace(/^DR-?/i, '')); if (code) (groups[code] = groups[code] || []).push(l.name) }
  const mergeable = []
  let noClean = 0
  for (const [code, names] of Object.entries(groups)) {
    if (names.length < 2) continue
    const clean = names.find((n) => n === `DR-${code}`)
    if (!clean) { noClean++; continue } // no clean form → needs manual review, skip
    mergeable.push({ code, keep: clean, remove: names.filter((n) => n !== clean) })
  }
  return { totalLeads: leads.length, mergeable, noClean }
}

const t0 = Date.now()
const { totalLeads, mergeable, noClean } = await discover()
let dups = mergeable
if (LIMIT > 0) dups = dups.slice(0, LIMIT)
console.log(`DR- leads: ${totalLeads} | mergeable duplicate sets: ${mergeable.length} | no-clean-form (skipped): ${noClean}`)
console.log(`processing: ${dups.length}${LIMIT ? ` (--limit ${LIMIT})` : ''} | concurrency ${CONCURRENCY} | batch ${BATCH} | field-merge (backfill clean blanks, no delete)${DRY ? ' | DRY RUN (no writes)' : ''}`)
if (DRY || dups.length === 0) { console.log('done (dry).'); process.exit(0) }

const counts = { merged: 0, fieldsFilled: 0, skipped: 0, errors: 0 }
let offset = 0
while (offset < dups.length) {
  const out = await runMerge({ base: BASE, authHeaders, duplicates: dups, offset, batchSize: BATCH, concurrency: CONCURRENCY })
  for (const k in counts) counts[k] += out.counts?.[k] || 0
  for (const rr of out.results) if (!rr.ok) console.log(`  ! ${rr.code}: ${rr.error}`)
  offset = out.nextOffset == null ? dups.length : out.nextOffset
  const el = (Date.now() - t0) / 1000
  const rate = offset / el // sets/sec
  const eta = rate > 0 ? Math.round((dups.length - offset) / rate) : 0
  console.log(`  ${Math.min(offset, dups.length)}/${dups.length} sets | merged ${counts.merged} | fields ${counts.fieldsFilled} | skipped ${counts.skipped} | errors ${counts.errors} | ${el.toFixed(0)}s${offset < dups.length ? ` | ~${eta}s left` : ''}`)
}
console.log(`DONE in ${((Date.now() - t0) / 1000).toFixed(0)}s →`, JSON.stringify(counts))

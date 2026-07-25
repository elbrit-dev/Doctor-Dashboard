// Shared create/update/duplicate triage, used by both the local proxy and the
// Netlify function. Given the sheet rows and all coded UAT Leads, it:
//   - normalizes every code (strip "DR-", non-digits, leading zeros),
//   - groups UAT leads by normalized code into { clean, padded[], all[] },
//   - splits sheet rows into create (code absent) and update (code present),
//   - lists duplicate sets { code, keep: "DR-<code>", remove[], kind }.

export const normCode = (v) => String(v ?? '').replace(/\D/g, '').replace(/^0+/, '')

export function groupLeads(uatLeads) {
  const groups = {} // code -> { all, clean, padded }
  for (const lead of uatLeads) {
    const code = normCode(lead.custom_doctor_code || lead.name)
    if (!code) continue
    const g = groups[code] || (groups[code] = { all: [], clean: null, padded: [] })
    g.all.push(lead.name)
    if (lead.name === `DR-${code}`) g.clean = lead.name
    else g.padded.push(lead.name)
  }
  return groups
}

export function triage(rows, uatLeads) {
  const groups = groupLeads(uatLeads)
  const create = []
  const update = []
  const dupMap = {}

  for (const r of rows) {
    const code = normCode(r['Dr. Code'])
    if (!code) continue
    const info = {
      code,
      name: String(r['Dr. Name'] ?? '').trim(),
      empCode: String(r['Emp Code'] ?? '').trim(),
      hq: String(r['HQ'] ?? '').trim(),
    }
    const g = groups[code]
    if (!g) {
      create.push(info) // no Lead at all → create the clean DR-<code>
      continue
    }
    if (!g.clean) {
      // Only padded DR-000<code> form(s) exist — no clean DR-<code> yet. Create the
      // clean Lead from the sheet. It stays OUT of the update bucket (nothing clean
      // to update) and is NOT flagged as a duplicate yet: once the clean Lead is
      // created, the next reconcile sees clean+padded and lists it as a duplicate
      // (has_clean_form) to merge and then delete the padded ones.
      create.push(info)
      continue
    }
    // Clean form exists → update it (and flag any padded twins as duplicates).
    update.push({ ...info, uatId: g.clean })
    if (g.all.length > 1 && !dupMap[code]) {
      dupMap[code] = {
        code,
        keep: g.clean,
        remove: g.all.filter((n) => n !== g.clean),
        kind: 'has_clean_form',
        all: g.all,
      }
    }
  }

  const duplicates = Object.values(dupMap)
  return {
    counts: {
      sheetRows: rows.length,
      uatCodedLeads: uatLeads.length,
      create: create.length,
      update: update.length,
      duplicates: duplicates.length,
    },
    create,
    update,
    duplicates,
  }
}

import * as XLSX from 'xlsx'

// Doctor-code header spellings, most specific first.
const CODE_HEADERS = [
  /^dr\.?\s*code$/i,
  /^doctor\s*code$/i,
  /^(dr|doctor)[\s._-]*code$/i,
  /doctor.*code/i,
  /^code$/i,
]

// Parse an uploaded .xlsx/.csv into rows keyed by doctor code.
// Expects a "Dr. Code" column (zero-padded codes are fine — stripped downstream).
export async function parseSheet(file) {
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const json = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false })
  if (json.length === 0) throw new Error('Sheet is empty')

  // Header spellings differ per sheet ("Dr. Code", "Doctor Code", …). Try the
  // exact doctor-code forms in order of confidence before falling back to any
  // "…code…" column — and never fall back to Employee Code, which some sheets
  // list to the LEFT of the doctor's.
  const cols = Object.keys(json[0])
  const codeKey =
    CODE_HEADERS.reduce((hit, re) => hit || cols.find((c) => re.test(c.trim())), null) ||
    cols.find((c) => /code/i.test(c) && !/emp|employee|source|division/i.test(c))
  if (!codeKey) throw new Error('No "Dr. Code" / "Doctor Code" column found in the sheet')

  const rows = json
    .map((raw) => ({ code: String(raw[codeKey] ?? '').trim(), raw }))
    .filter((r) => r.code)

  return { rows, columns: cols, codeKey, total: json.length }
}

// Strip leading zeros for the API/join key.
export const cleanCodes = (rows) =>
  [...new Set(rows.map((r) => r.code.replace(/^0+/, '')).filter(Boolean))]

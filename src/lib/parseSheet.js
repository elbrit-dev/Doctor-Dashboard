import * as XLSX from 'xlsx'

// Parse an uploaded .xlsx/.csv into rows keyed by doctor code.
// Expects a "Dr. Code" column (zero-padded codes are fine — stripped downstream).
export async function parseSheet(file) {
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const json = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false })
  if (json.length === 0) throw new Error('Sheet is empty')

  const cols = Object.keys(json[0])
  const codeKey = cols.find((c) => /^dr\.?\s*code$/i.test(c.trim())) || cols.find((c) => /code/i.test(c))
  if (!codeKey) throw new Error('No "Dr. Code" column found in the sheet')

  const rows = json
    .map((raw) => ({ code: String(raw[codeKey] ?? '').trim(), raw }))
    .filter((r) => r.code)

  return { rows, columns: cols, codeKey, total: json.length }
}

// Strip leading zeros for the API/join key.
export const cleanCodes = (rows) =>
  [...new Set(rows.map((r) => r.code.replace(/^0+/, '')).filter(Boolean))]

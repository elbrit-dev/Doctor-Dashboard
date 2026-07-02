// Netlify serverless function — the cloud equivalent of the local proxy's
// POST /api/review. CRM writes a review back to ERPNext as a comment on the
// Lead's timeline. Reachable at /api/review via the redirect in netlify.toml.

const BASE = (process.env.ERPNEXT_URL || '').replace(/\/+$/, '')
const KEY = process.env.ERPNEXT_API_KEY || ''
const SECRET = process.env.ERPNEXT_API_SECRET || ''
const REVIEW_MARKER = 'CRM Review'

const authHeaders = { Authorization: `token ${KEY}:${SECRET}`, Accept: 'application/json' }
const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj),
})

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' })
  if (!(BASE && KEY && SECRET)) return json(503, { error: 'ERPNext not configured' })
  let body = {}
  try { body = JSON.parse(event.body || '{}') } catch { /* ignore */ }
  const { id, decision, issues = [], note = '', by = 'dashboard' } = body
  if (!id || !['ready', 'error'].includes(decision)) {
    return json(400, { error: 'id and decision (ready|error) are required' })
  }
  try {
    const content = buildReviewComment(decision, issues, note, by)
    const out = await addComment(id, content, by)
    return json(200, { ok: true, id, decision, commentId: out?.name || null })
  } catch (err) {
    return json(502, { error: 'Failed to post review to ERPNext', detail: err.message })
  }
}

function buildReviewComment(decision, issues, note, by) {
  if (decision === 'ready') {
    return `<b>${REVIEW_MARKER}: ✅ COMPLETED</b> — validation done.` + (note ? `<br>Note: ${esc(note)}` : '') + `<br><i>by ${esc(by)} via dashboard</i>`
  }
  const list = (issues || []).filter(Boolean).map(esc)
  const issuesHtml = list.length ? `<br>Issues: ${list.join(', ')}` : ''
  return `<b>${REVIEW_MARKER}: ⚠️ ERROR</b>${issuesHtml}` + (note ? `<br>Note: ${esc(note)}` : '') + `<br><i>by ${esc(by)} via dashboard</i>`
}

async function addComment(name, content, by) {
  const r = await fetch(`${BASE}/api/method/frappe.desk.form.utils.add_comment`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reference_doctype: 'Lead',
      reference_name: name,
      content,
      comment_email: by || 'dashboard',
      comment_by: by || 'dashboard',
    }),
  })
  if (!r.ok) throw new Error(`add_comment ${name}: HTTP ${r.status} ${r.statusText}`)
  return (await r.json()).message
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Netlify serverless function — the cloud equivalent of the local proxy's
// POST /api/review. CRM writes a review back to ERPNext as a comment on the
// Lead's timeline. Reachable at /api/review via the redirect in netlify.toml.

const BASE = (process.env.ERPNEXT_URL || '').replace(/\/+$/, '')
const KEY = process.env.ERPNEXT_API_KEY || ''
const SECRET = process.env.ERPNEXT_API_SECRET || ''
const REVIEW_MARKER = 'CRM Review'

const authHeaders = { Authorization: `token ${KEY}:${SECRET}`, Accept: 'application/json' }
const json = (obj, status = 200) => Response.json(obj, { status, headers: { 'Cache-Control': 'no-store' } })

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (!(BASE && KEY && SECRET)) return json({ error: 'ERPNext not configured' }, 503)
  let body = {}
  try { body = await req.json() } catch { /* ignore */ }
  const { id, decision, issues = [], note = '', by = 'dashboard' } = body
  if (!id || !['ready', 'error'].includes(decision)) {
    return json({ error: 'id and decision (ready|error) are required' }, 400)
  }
  try {
    const content = buildReviewComment(decision, issues, note, by)
    const out = await addComment(id, content, by)
    return json({ ok: true, id, decision, commentId: out?.name || null })
  } catch (err) {
    return json({ error: 'Failed to post review to ERPNext', detail: err.message }, 502)
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

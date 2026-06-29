import { IconAlert, IconInfo } from './icons.jsx'

// Per-rule rollup. Clicking a rule filters the doctor table to affected records.
export default function IssuesPanel({ byRule, activeRule, onSelectRule }) {
  return (
    <div className="card">
      <div className="card__head">
        <h3 className="card__title">Validation checks</h3>
        <p className="card__hint">{byRule.length} checks triggered · click to filter the table</p>
      </div>
      <div className="issue-list">
        {byRule.map((r) => (
          <button
            key={r.id}
            className={`issue-row ${activeRule === r.id ? 'active' : ''}`}
            onClick={() => onSelectRule(activeRule === r.id ? null : r.id)}
          >
            <span className={`issue-row__bar bar-${r.severity}`} />
            <span className="issue-row__body">
              <span className="issue-row__label">
                {r.label}
                <span className={`sev-badge ${r.severity}`}><span className="d" />{r.severity}</span>
              </span>
              <span className="issue-row__desc">{r.description}</span>
            </span>
            <span className={`issue-row__count sev-${r.severity}`}>{r.count}</span>
          </button>
        ))}
        {byRule.length === 0 && (
          <div className="empty">No issues found — every record passed all checks. 🎉</div>
        )}
      </div>
    </div>
  )
}

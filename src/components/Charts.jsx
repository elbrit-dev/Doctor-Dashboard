// Lightweight charts built from divs/SVG — no chart library needed.

export function SeveritySplit({ totals }) {
  return (
    <div className="card">
      <div className="card__head"><h3 className="card__title">Issues by severity</h3></div>
      <div className="sevsplit">
        <Seg cls="error" n={totals.error} l="Errors" />
        <Seg cls="warning" n={totals.warning} l="Warnings" />
        <Seg cls="info" n={totals.info} l="Info" />
      </div>
    </div>
  )
}
function Seg({ cls, n, l }) {
  return (
    <div className={`sevsplit__seg ${cls}`}>
      <div className={`sevsplit__n sev-${cls}`}>{n}</div>
      <div className={`sevsplit__l sev-${cls}`}>{l}</div>
    </div>
  )
}

export function Distribution({ title, hint, data }) {
  const max = Math.max(1, ...data.map((d) => d.value))
  return (
    <div className="card">
      <div className="card__head">
        <h3 className="card__title">{title}</h3>
        {hint && <p className="card__hint">{hint}</p>}
      </div>
      <div className="chart">
        <div className="bars">
          {data.map((d) => (
            <div className="bar-item" key={d.label}>
              <div className="bar-item__name" title={d.label}>{d.label}</div>
              <div className="bar-track"><div className="bar-fill" style={{ width: `${(d.value / max) * 100}%` }} /></div>
              <div className="bar-item__val">{d.value}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

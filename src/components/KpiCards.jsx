import ScoreRing from './ScoreRing.jsx'

export default function KpiCards({ totals }) {
  return (
    <div className="kpis">
      <div className="card kpi kpi--score">
        <ScoreRing value={totals.score} />
        <div>
          <div className="kpi__label">Data quality score</div>
          <div className="kpi__foot" style={{ marginTop: 6, maxWidth: 150 }}>
            Weighted across all {totals.doctors} records and {RULE_LABEL(totals)}.
          </div>
        </div>
      </div>

      <Kpi label="Total doctors" value={totals.doctors} foot="records in this batch" />
      <Kpi label="Ready for handoff" value={totals.ready} tone="ok" foot="no errors or warnings" />
      <Kpi label="With errors" value={totals.withErrors} tone={totals.withErrors ? 'error' : 'ok'} foot="must fix before handoff" />
      <Kpi label="Total issues" value={totals.issues} tone={totals.issues ? 'warning' : 'ok'}
        foot={`${totals.error} err · ${totals.warning} warn · ${totals.info} info`} />
    </div>
  )
}

function Kpi({ label, value, foot, tone }) {
  return (
    <div className="card kpi">
      <div className="kpi__label">{label}</div>
      <div className={`kpi__value ${tone || ''}`}>{value}</div>
      <div className="kpi__foot">{foot}</div>
    </div>
  )
}

function RULE_LABEL(totals) {
  return `${totals.issues} issue${totals.issues === 1 ? '' : 's'}`
}

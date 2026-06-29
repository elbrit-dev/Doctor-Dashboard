# Doctor Data Validation Dashboard

A data-validation dashboard that reviews doctor records (stored as ERPNext **Lead**
documents with the `DR-` naming series) before they are handed to the CRM team.
Built with **Vite + React**.

It runs a set of validation checks against each record and surfaces a data-quality
score, per-severity issue breakdown, distribution charts, a filterable doctor table,
and a per-doctor drilldown showing the full field set and every check's pass/fail
result.

## Quick start

```bash
npm install
npm run dev      # http://localhost:5180
npm run build    # production build into dist/
```

## What it validates

| Severity | Check |
|----------|-------|
| 🔴 Error   | Missing geo-coordinates (lat/long = 0) |
| 🔴 Error   | Missing territory |
| 🟠 Warning | Missing category |
| 🟠 Warning | No usable contact number (blank or placeholder `"0"`) |
| 🟠 Warning | Name has stray whitespace |
| 🟠 Warning | Possible duplicate name |
| 🟠 Warning | Territory ≠ role-profile HQ |
| 🟠 Warning | Non-standard state value (e.g. `Tn-Chennai`) |
| 🔵 Info    | Address record not created |
| 🔵 Info    | Legacy speciality field still set |

## Project structure

```
src/
  data/doctors.js        # snapshot of the doctor records (swap for a live fetch later)
  validation/rules.js    # the validation engine — add a rule and it flows everywhere
  components/            # KPI cards, charts, issues panel, table, drilldown drawer
  App.jsx                # state: filters, search, selection
```

## Filtering

- Status tabs: All / Errors / Warnings / Ready
- Dropdowns: Speciality, Category, Territory, "Check failed"
- Free-text search across name, code, speciality, territory, qualification
- All filters combine; a live result count and Reset button track active filters

## Going live against ERPNext

The app currently validates a snapshot in `src/data/doctors.js`. To validate live
data, replace that module with a fetch through a small server-side proxy (a browser
app should not call ERPNext directly — CORS + credentials). The validation engine
and UI need no changes. A commented proxy stub is in `vite.config.js`.

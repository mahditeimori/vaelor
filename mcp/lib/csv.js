/**
 * Minimal quote-aware CSV row splitter.
 * CFTC "newcot" files are comma-delimited with quoted fields
 * (market names contain commas), so a naive split(',') is not safe.
 */

export function splitCsvRow(line) {
  const cols = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      cur += ch;
    } else if (ch === ',' && !inQuotes) {
      cols.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cols.push(cur);
  return cols;
}

/** Trim + parse a numeric CSV cell; empty or '.' becomes null. */
export function parseNum(value) {
  if (!value) return null;
  const t = String(value).trim();
  if (t === '' || t === '.') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Trim a CSV cell; undefined-safe. */
export function cell(cells, idx) {
  return cells[idx]?.trim();
}

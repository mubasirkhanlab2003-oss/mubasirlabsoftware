// Westgard multi-rule QC on the runs of one control material (oldest first).
// Returns the rules broken by the LAST run. 1-2s = warning; the others reject.
export function zScores(runs, mean, sd) {
  return runs.map((r) => (Number(r.value) - Number(mean)) / Number(sd));
}

export function westgard(runs, mean, sd) {
  const z = zScores(runs, mean, sd);
  const n = z.length;
  if (!n) return { status: 'ok', rules: [] };
  const last = z[n - 1];
  const rules = [];
  if (Math.abs(last) > 3) rules.push('1-3s');
  if (n >= 2) {
    const a = z[n - 2];
    if ((last > 2 && a > 2) || (last < -2 && a < -2)) rules.push('2-2s');
    if ((last > 2 && a < -2) || (last < -2 && a > 2)) rules.push('R-4s');
  }
  if (n >= 4) {
    const w = z.slice(-4);
    if (w.every((x) => x > 1) || w.every((x) => x < -1)) rules.push('4-1s');
  }
  if (n >= 10) {
    const w = z.slice(-10);
    if (w.every((x) => x > 0) || w.every((x) => x < 0)) rules.push('10x');
  }
  if (rules.length) return { status: 'reject', rules };
  if (Math.abs(last) > 2) return { status: 'warning', rules: ['1-2s'] };
  return { status: 'ok', rules: [] };
}

export const RULE_TEXT = {
  '1-2s': 'One value beyond ±2 SD — warning, check the next runs',
  '1-3s': 'One value beyond ±3 SD — random error, reject the run',
  '2-2s': 'Two values in a row beyond the same ±2 SD — systematic error',
  'R-4s': 'Range of two values exceeds 4 SD — random error',
  '4-1s': 'Four values in a row beyond the same ±1 SD — systematic shift',
  '10x': 'Ten values in a row on the same side of the mean — systematic shift',
};

export function stats(values) {
  const v = values.map(Number).filter(Number.isFinite);
  if (!v.length) return { n: 0, mean: null, sd: null, cv: null };
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  const sd = v.length > 1 ? Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / (v.length - 1)) : 0;
  return { n: v.length, mean, sd, cv: mean ? (sd / mean) * 100 : null };
}

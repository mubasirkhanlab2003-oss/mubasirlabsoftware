// Result rules: reference ranges, flags, critical values, calculated
// parameters, delta check (change from the last result), reflex suggestions
// and auto-verification. Pure functions — no database access.
import { ageDays } from './format.js';

export const TEST_STATUS_LABEL = {
  pending: 'Sample pending', collected: 'In lab', entered: 'Result entered', verified: 'Verified', cancelled: 'Cancelled',
};
export const FLAG_LABEL = { normal: 'Normal', high: 'High', low: 'Low', abnormal: 'Abnormal' };

// The configured range that applies to this patient. Gender-specific beats
// "any"; the narrowest age band wins. Unknown age matches all-age ranges only.
export function findRange(ranges, patient, at = new Date()) {
  const days = ageDays(patient?.dob, at);
  const g = patient?.gender;
  const fits = ranges.filter((r) => {
    if (r.active === false) return false;
    if (r.gender !== 'any' && r.gender !== g) return false;
    if (days == null) return (r.age_min_days || 0) === 0 && r.age_max_days == null;
    return days >= (r.age_min_days || 0) && (r.age_max_days == null || days < r.age_max_days);
  });
  fits.sort((a, b) => {
    const ga = a.gender === 'any' ? 1 : 0, gb = b.gender === 'any' ? 1 : 0;
    if (ga !== gb) return ga - gb;
    const wa = (a.age_max_days ?? 99999) - (a.age_min_days || 0);
    const wb = (b.age_max_days ?? 99999) - (b.age_min_days || 0);
    return wa - wb;
  });
  return fits[0] || null;
}

export function rangeText(r) {
  if (!r) return '';
  if (r.display_text) return r.display_text;
  const lo = r.low ?? r.ref_low, hi = r.high ?? r.ref_high;
  if (lo != null && hi != null) return `${lo} – ${hi}`;
  if (lo != null) return `≥ ${lo}`;
  if (hi != null) return `≤ ${hi}`;
  return '';
}

export const toNum = (v) => {
  if (v === '' || v == null) return NaN;
  return Number(String(v).replace(',', '.').trim());
};
export const numericValid = (v) => v === '' || v == null || Number.isFinite(toNum(v));
const isNumeric = (p) => p.result_type === 'numeric' || p.result_type === 'calculated';

// Compares a value with the configured range only. It never interprets.
export function flagFor(param, value, range) {
  if (value === '' || value == null) return null;
  if (isNumeric(param)) {
    const v = toNum(value);
    if (!Number.isFinite(v) || !range) return null;
    if (range.low == null && range.high == null) return null;
    if (range.low != null && v < Number(range.low)) return 'low';
    if (range.high != null && v > Number(range.high)) return 'high';
    return 'normal';
  }
  if (range?.display_text && (param.result_type === 'option' || param.result_type === 'text')) {
    const want = range.display_text.trim().toLowerCase();
    const got = String(value).trim().toLowerCase();
    if (param.result_type === 'option') return got === want ? 'normal' : 'abnormal';
    return null; // free text is never flagged automatically
  }
  return null;
}

export function criticalFor(param, value) {
  if (!isNumeric(param)) return null;
  const v = toNum(value);
  if (!Number.isFinite(v)) return null;
  if (param.critical_low != null && v < Number(param.critical_low)) return 'low';
  if (param.critical_high != null && v > Number(param.critical_high)) return 'high';
  return null;
}

// ---- calculated parameters ----------------------------------------------
// Formula language: numbers, + - * / ( ), {CODE} for other parameters of the
// same test, AGE (years), FEMALE (1/0), MALE (1/0), condition ? a : b, and
// the functions min max pow sqrt abs log round.
const FUNCS = ['min', 'max', 'pow', 'sqrt', 'abs', 'log', 'round', 'AGE', 'FEMALE', 'MALE'];
export function evalFormula(formula, values, ctx = {}) {
  if (!formula) return null;
  let missing = false;
  let expr = formula.replace(/\{([A-Za-z0-9_]+)\}/g, (_, code) => {
    const v = toNum(values[code]);
    if (!Number.isFinite(v)) { missing = true; return '0'; }
    return `(${v})`;
  });
  if (missing) return null;
  const words = expr.match(/[A-Za-z_]+/g) || [];
  if (words.some((w) => !FUNCS.includes(w))) return null;
  if (/[^0-9+\-*/().,?:<>=!&| A-Za-z_]/.test(expr)) return null;
  expr = expr.replace(/\b(min|max|pow|sqrt|abs|log|round)\(/g, 'Math.$1(');
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('AGE', 'FEMALE', 'MALE', `"use strict"; return (${expr});`);
    const out = fn(Number(ctx.age ?? 0), ctx.female ? 1 : 0, ctx.female ? 0 : 1);
    return Number.isFinite(out) ? out : null;
  } catch {
    return null;
  }
}

export function formatValue(v, decimals = 1) {
  if (v == null || !Number.isFinite(v)) return '';
  return String(Math.round(v * 10 ** decimals) / 10 ** decimals);
}

export function ageYears(patient, at = new Date()) {
  const d = ageDays(patient?.dob, at);
  return d == null ? null : d / 365.25;
}

// Builds the stored result rows for a parameter test. `values` is keyed by
// parameter id. Calculated parameters are filled in from the others.
export function buildResults(params, values, rangesByParam, patient, at = new Date()) {
  const active = params.filter((p) => p.active !== false).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  const byCode = {};
  for (const p of active) if (p.code && p.result_type !== 'calculated') byCode[p.code] = values[p.id];
  const ctx = { age: ageYears(patient, at), female: patient?.gender === 'female' };
  const out = [];
  for (const p of active) {
    let value = values[p.id] ?? '';
    if (p.result_type === 'calculated') {
      value = formatValue(evalFormula(p.formula, byCode, ctx), p.decimals ?? 1);
      if (p.code) byCode[p.code] = value;
    }
    const r = findRange(rangesByParam[p.id] || [], patient, at);
    out.push({
      parameter_id: p.id, name: p.name, code: p.code || null, section: p.section || null,
      value: value === null ? '' : String(value), unit: p.unit || '',
      ref_low: r?.low ?? null, ref_high: r?.high ?? null, ref_text: rangeText(r),
      flag: flagFor(p, value, r), critical: criticalFor(p, value),
      calculated: p.result_type === 'calculated' || undefined,
    });
  }
  return out;
}

// Change from this patient's previous result of the same parameter.
export function deltaChecks(params, results, previous) {
  const warn = [];
  for (const r of results) {
    const p = params.find((x) => x.id === r.parameter_id);
    if (!p || p.delta_pct == null) continue;
    const prev = previous[r.parameter_id];
    if (!prev) continue;
    const a = toNum(prev.value), b = toNum(r.value);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) continue;
    const pct = Math.abs((b - a) / a) * 100;
    if (pct > Number(p.delta_pct)) warn.push({ parameter_id: p.id, name: p.name, from: prev.value, to: r.value, pct: Math.round(pct), on: prev.on });
  }
  return warn;
}

// Reflex: a result in a given state suggests another test (by code).
export function reflexSuggestions(params, results) {
  const out = [];
  for (const r of results) {
    const p = params.find((x) => x.id === r.parameter_id);
    const rx = p?.reflex;
    if (!rx || !rx.test || !r.flag) continue;
    const hit = rx.when === 'abnormal' ? r.flag !== 'normal'
      : rx.when === 'high' ? r.flag === 'high' : rx.when === 'low' ? r.flag === 'low' : false;
    if (hit) out.push({ code: rx.test, because: `${r.name} ${r.flag === 'abnormal' ? 'abnormal' : r.flag}` });
  }
  return out;
}

// A result may verify itself only when every value is present and normal,
// nothing is critical and nothing jumped since last time.
export function autoVerifyReason(test, results, deltas, settingOn) {
  if (!settingOn) return 'Auto-verification is off in Settings';
  if (test && test.auto_verify === false) return 'This test always needs manual verification';
  if (!results.length) return 'No results';
  if (results.some((r) => r.value === '' || r.value == null)) return 'Some values are empty';
  if (results.some((r) => r.critical)) return 'Critical value';
  if (results.some((r) => r.flag && r.flag !== 'normal')) return 'Abnormal value';
  if (deltas.length) return 'Big change from the last result';
  return null; // OK to auto-verify
}

// ---- culture ---------------------------------------------------------------
export const SIR = [['S', 'Sensitive'], ['I', 'Intermediate'], ['R', 'Resistant']];
export const ORGANISMS = [
  'Escherichia coli', 'Klebsiella pneumoniae', 'Klebsiella oxytoca', 'Proteus mirabilis', 'Proteus vulgaris',
  'Pseudomonas aeruginosa', 'Acinetobacter baumannii', 'Enterobacter cloacae', 'Citrobacter freundii',
  'Serratia marcescens', 'Morganella morganii', 'Salmonella Typhi', 'Salmonella Paratyphi A', 'Shigella species',
  'Staphylococcus aureus', 'Staphylococcus aureus (MRSA)', 'Coagulase-negative Staphylococcus',
  'Enterococcus faecalis', 'Enterococcus faecium', 'Streptococcus pyogenes', 'Streptococcus agalactiae',
  'Streptococcus pneumoniae', 'Viridans streptococci', 'Haemophilus influenzae', 'Candida albicans',
  'Candida species (non-albicans)', 'Vibrio cholerae', 'Campylobacter species',
];
export const CULTURE_GROWTH = ['No growth after 48 hours of incubation', 'No growth after 5 days of incubation',
  'Growth of normal flora only', 'Mixed growth — probable contamination, repeat sample advised', 'Growth isolated'];

export function cultureSummary(c) {
  if (!c) return '';
  if (!c.isolates?.length) return c.growth || '';
  return c.isolates.map((i) => i.organism).filter(Boolean).join(', ');
}
export function cultureComplete(c) {
  if (!c || !c.growth) return false;
  if (c.growth === 'Growth isolated') return (c.isolates || []).length > 0 && c.isolates.every((i) => i.organism);
  return true;
}

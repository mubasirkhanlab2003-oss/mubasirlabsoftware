// Pure money rules: test price, bill totals, referring-doctor commission.
// Used by the screens, the reports and the tests — one place, one answer.
import { round2 } from './format.js';

export const PAYMENT_METHODS = [
  ['cash', 'Cash'], ['card', 'Card'], ['bank_transfer', 'Bank transfer'],
  ['jazzcash', 'JazzCash'], ['easypaisa', 'Easypaisa'], ['cheque', 'Cheque'], ['other', 'Other'],
];
export const methodLabel = (m) => (PAYMENT_METHODS.find((x) => x[0] === m) || [m, m])[1];

// Price of one test for this bill: the panel's own rate if it has one,
// otherwise the list price less the panel discount.
export function unitPrice(test, panel = null, panelRates = []) {
  const list = Number(test?.price || 0);
  if (!panel) return round2(list);
  const r = panelRates.find((x) => x.panel_id === panel.id && x.test_id === test.id);
  if (r) return round2(Number(r.price));
  return round2(list * (1 - Number(panel.discount_pct || 0) / 100));
}

// Split a package price over its component tests in proportion to their
// list prices (so each test, department and doctor gets its fair share).
export function splitPackage(pkgPrice, components) {
  const list = components.map((c) => Number(c.price || 0));
  const total = list.reduce((s, x) => s + x, 0);
  if (pkgPrice == null) return list.map(round2);
  if (!components.length) return [];
  let left = round2(pkgPrice);
  return components.map((c, i) => {
    if (i === components.length - 1) return round2(left);
    const share = total > 0 ? round2(pkgPrice * (list[i] / total)) : round2(pkgPrice / components.length);
    left = round2(left - share);
    return share;
  });
}

// Bill of one accession. `tests` = all its tests (cancelled ones are ignored).
export function billTotals(acc, tests = [], payments = []) {
  const active = tests.filter((t) => t.status !== 'cancelled');
  const subtotal = round2(active.reduce((s, t) => s + Number(t.price || 0), 0));
  const home = round2(Number(acc?.home_charge || 0));
  const gross = round2(subtotal + home);
  const discount = round2(Math.min(Number(acc?.discount || 0), gross));
  const total = round2(gross - discount);
  const live = payments.filter((p) => !p.deleted_at);
  const received = round2(live.filter((p) => p.kind === 'payment').reduce((s, p) => s + Number(p.amount), 0));
  const refunded = round2(-live.filter((p) => p.kind === 'refund').reduce((s, p) => s + Number(p.amount), 0));
  const paid = round2(received - refunded);
  const panelBill = acc?.bill_to === 'panel';
  const balance = round2(total - paid);
  return {
    subtotal, home, gross, discount, total, received, refunded, paid,
    due: panelBill ? 0 : Math.max(balance, 0),
    panel_due: panelBill ? Math.max(balance, 0) : 0,
    overpaid: Math.max(-balance, 0),
    tests: active.length,
  };
}

// Which commission rate applies to this test for this doctor.
// Most specific wins: single-test rule → department rule → doctor default.
export function resolveRate(doctor, rules, test) {
  if (!doctor) return null;
  const mine = rules.filter((r) => r.doctor_id === doctor.id && r.active !== false);
  const byTest = mine.find((r) => r.scope === 'test' && r.test_id === test.test_id);
  if (byTest) return { type: byTest.rate_type, value: Number(byTest.rate_value), from: 'test' };
  const dept = test.department || '';
  const byDept = mine.find((r) => r.scope === 'department' && (r.department || '') === dept);
  if (byDept) return { type: byDept.rate_type, value: Number(byDept.rate_value), from: 'department' };
  return { type: doctor.rate_type || 'percent', value: Number(doctor.rate_value || 0), from: 'default' };
}

export function rateLabel(rate) {
  if (!rate) return '';
  return rate.type === 'fixed' ? `Rs ${rate.value} fixed` : `${rate.value}%`;
}

// Commission per test of one accession. Basis "net" shares the bill
// discount over the tests (in proportion to price) before the % is applied;
// "gross" uses the full price. Fixed amounts are never more than the price.
export function computeCommissions(acc, tests, doctor, rules, basis = 'net') {
  const active = tests.filter((t) => t.status !== 'cancelled');
  const out = {};
  for (const t of tests) out[t.id] = { commission: 0, note: null };
  if (!doctor) return out;
  const sub = active.reduce((s, t) => s + Number(t.price || 0), 0);
  const gross = sub + Number(acc?.home_charge || 0);
  const disc = Math.min(Number(acc?.discount || 0), gross);
  // the discount is shared over tests only (home charge never earns commission)
  const testDisc = gross > 0 ? Math.min(disc, sub) : 0;
  for (const t of active) {
    const price = Number(t.price || 0);
    const base = basis === 'net' && sub > 0 ? price - testDisc * (price / sub) : price;
    const rate = resolveRate(doctor, rules, t);
    let c = rate.type === 'fixed' ? Math.min(rate.value, Math.max(base, 0)) : Math.max(base, 0) * rate.value / 100;
    c = round2(c);
    out[t.id] = { commission: c, note: c ? rateLabel(rate) : null };
  }
  return out;
}

// All money and work figures come from here, so every screen, report and
// statement agrees. Deleted cases/payments are always left out.
// Rule: revenue belongs to the day the case was registered; money belongs to
// the day it counts in (a refund for a cancelled test counts on the case's
// own day, so that day's figures go down).
import { db } from './db.js';
import { billTotals } from './pricing.js';
import { groupBy, hoursBetween, round2, sum, todayISO } from './format.js';

const inRange = (d, from, to) => d && d >= from && d <= to;

// Cases registered between two dates, with their tests, payments and totals.
export async function loadCases(from, to, { includeDeleted = false } = {}) {
  const accs = (await db().accessions.where('reg_date').between(from, to, true, true).toArray())
    .filter((a) => includeDeleted || !a.deleted_at);
  return attach(accs);
}

export async function attach(accs) {
  if (!accs.length) return [];
  const ids = accs.map((a) => a.id);
  const [tests, pays, patients] = await Promise.all([
    db().accession_tests.where('accession_id').anyOf(ids).toArray(),
    db().bill_payments.where('accession_id').anyOf(ids).toArray(),
    db().patients.bulkGet([...new Set(accs.map((a) => a.patient_id))]),
  ]);
  const bt = groupBy(tests, (t) => t.accession_id), bp = groupBy(pays, (p) => p.accession_id);
  const pm = Object.fromEntries(patients.filter(Boolean).map((p) => [p.id, p]));
  return accs.map((a) => {
    const t = bt.get(a.id) || [], p = bp.get(a.id) || [];
    return { ...a, tests: t, payments: p, patient: pm[a.patient_id] || null, bill: billTotals(a, t, p), progress: progress(t) };
  });
}

// Where a case stands, from its tests.
export function progress(tests) {
  const act = tests.filter((t) => t.status !== 'cancelled');
  const c = (s) => act.filter((t) => t.status === s).length;
  const out = { total: act.length, pending: c('pending'), collected: c('collected'), entered: c('entered'), verified: c('verified') };
  out.state = !act.length ? 'cancelled'
    : out.verified === act.length ? 'ready'
      : out.pending === act.length ? 'sample'
        : out.verified > 0 ? 'partial'
          : out.entered > 0 ? 'verify' : 'lab';
  return out;
}
export const STATE_LABEL = {
  sample: 'Sample pending', lab: 'In lab', verify: 'To verify', partial: 'Partly ready', ready: 'Report ready', cancelled: 'Cancelled',
};
export const STATE_COLOR = { sample: 'amber', lab: 'blue', verify: 'violet', partial: 'teal', ready: 'green', cancelled: '' };

// Payments/refunds that count between two dates (by business date).
export async function loadMoney(from, to) {
  const pays = (await db().bill_payments.where('business_date').between(from, to, true, true).toArray()).filter((p) => !p.deleted_at);
  if (!pays.length) return [];
  const accs = await db().accessions.bulkGet([...new Set(pays.map((p) => p.accession_id))]);
  const live = new Set(accs.filter((a) => a && !a.deleted_at).map((a) => a.id));
  return pays.filter((p) => live.has(p.accession_id));
}

// Commission counts when the case is live and the test is not cancelled
// (and, if Settings says so, only once the bill is fully paid).
export function commissionOf(c, needsPayment) {
  if (c.deleted_at) return 0;
  if (needsPayment && c.bill_to !== 'panel' && c.bill.due > 0.009) return 0;
  return sum(c.tests.filter((t) => t.status !== 'cancelled'), (t) => t.commission);
}
export function pendingCommissionOf(c, needsPayment) {
  if (c.deleted_at || !needsPayment || c.bill_to === 'panel' || c.bill.due <= 0.009) return 0;
  return sum(c.tests.filter((t) => t.status !== 'cancelled'), (t) => t.commission);
}

// ---------------------------------------------------------------- summaries
export async function summary(from, to) {
  const settings = (await db().lab_settings.get(1)) || {};
  const [cases, money, expenses, payouts] = await Promise.all([
    loadCases(from, to), loadMoney(from, to),
    db().expenses.where('exp_date').between(from, to, true, true).toArray(),
    db().doctor_payouts.where('paid_on').between(from, to, true, true).toArray(),
  ]);
  const exp = expenses.filter((e) => !e.deleted_at);
  const pay = payouts.filter((p) => !p.deleted_at);
  const revenue = sum(cases, (c) => c.bill.total);
  const commission = sum(cases, (c) => commissionOf(c, settings.commission_needs_payment));
  const outsource = sum(cases.flatMap((c) => c.tests.filter((t) => t.status !== 'cancelled')), (t) => t.outsource_cost);
  const received = sum(money.filter((p) => p.kind === 'payment'), (p) => p.amount);
  const refunds = -sum(money.filter((p) => p.kind === 'refund'), (p) => p.amount);
  const tests = cases.flatMap((c) => c.tests.filter((t) => t.status !== 'cancelled'));
  return {
    from, to, cases, money, expenses: exp, payouts: pay,
    patients: new Set(cases.map((c) => c.patient_id)).size,
    caseCount: cases.length, testCount: tests.length,
    gross: sum(cases, (c) => c.bill.gross), discount: sum(cases, (c) => c.bill.discount), revenue,
    received, refunds, netCash: round2(received - refunds),
    due: sum(cases, (c) => c.bill.due), panelDue: sum(cases, (c) => c.bill.panel_due),
    commission, outsource, expenseTotal: sum(exp, (e) => e.amount), payoutTotal: sum(pay, (p) => p.amount),
    profit: round2(revenue - commission - outsource - sum(exp, (e) => e.amount)),
    byMethod: [...groupBy(money, (p) => p.method)].map(([m, l]) => ({ method: m, amount: sum(l, (p) => p.amount) })),
    lateAdjustments: money.filter((p) => p.late_adjustment),
  };
}

export function byTest(cases) {
  const rows = new Map();
  for (const c of cases) for (const t of c.tests) {
    if (t.status === 'cancelled') continue;
    const r = rows.get(t.test_id) || { test_id: t.test_id, name: t.test_name, department: t.department, count: 0, amount: 0 };
    r.count += 1; r.amount = round2(r.amount + Number(t.price || 0));
    rows.set(t.test_id, r);
  }
  return [...rows.values()].sort((a, b) => b.count - a.count || b.amount - a.amount);
}

export function byDepartment(cases) {
  const rows = new Map();
  for (const c of cases) for (const t of c.tests) {
    if (t.status === 'cancelled') continue;
    const k = t.department || 'General';
    const r = rows.get(k) || { department: k, count: 0, amount: 0, verified: 0 };
    r.count += 1; r.amount = round2(r.amount + Number(t.price || 0)); if (t.status === 'verified') r.verified += 1;
    rows.set(k, r);
  }
  return [...rows.values()].sort((a, b) => b.amount - a.amount);
}

export async function byDoctor(cases) {
  const settings = (await db().lab_settings.get(1)) || {};
  const docs = Object.fromEntries((await db().ref_doctors.toArray()).map((d) => [d.id, d]));
  const rows = new Map();
  for (const c of cases) {
    const k = c.doctor_id || (c.doctor_text ? 'text:' + c.doctor_text : 'self');
    const r = rows.get(k) || {
      key: k, doctor_id: c.doctor_id || null, name: c.doctor_id ? docs[c.doctor_id]?.full_name : (c.doctor_text || 'Self / walk-in'),
      patients: new Set(), cases: 0, tests: 0, revenue: 0, commission: 0, pending: 0,
    };
    r.patients.add(c.patient_id); r.cases += 1;
    r.tests += c.tests.filter((t) => t.status !== 'cancelled').length;
    r.revenue = round2(r.revenue + c.bill.total);
    r.commission = round2(r.commission + commissionOf(c, settings.commission_needs_payment));
    r.pending = round2(r.pending + pendingCommissionOf(c, settings.commission_needs_payment));
    rows.set(k, r);
  }
  return [...rows.values()].map((r) => ({ ...r, patients: r.patients.size })).sort((a, b) => b.revenue - a.revenue);
}

// One doctor's account. Period figures + all-time balance.
export async function doctorLedger(doctorId, from, to) {
  const settings = (await db().lab_settings.get(1)) || {};
  const allAccs = (await db().accessions.where('doctor_id').equals(doctorId).toArray()).filter((a) => !a.deleted_at);
  const all = await attach(allAccs);
  const payouts = (await db().doctor_payouts.where('doctor_id').equals(doctorId).toArray()).filter((p) => !p.deleted_at);
  const earnedAll = sum(all, (c) => commissionOf(c, settings.commission_needs_payment));
  const paidAll = sum(payouts, (p) => p.amount);
  const period = all.filter((c) => inRange(c.reg_date, from, to)).sort((a, b) => a.registered_at.localeCompare(b.registered_at));
  const periodPayouts = payouts.filter((p) => inRange(p.paid_on, from, to)).sort((a, b) => a.paid_on.localeCompare(b.paid_on));
  const lines = period.flatMap((c) => c.tests.filter((t) => t.status !== 'cancelled').map((t) => ({
    date: c.reg_date, acc_number: c.acc_number, accession_id: c.id, patient: c.patient?.full_name, mr: c.patient?.mr_number,
    test: t.test_name, department: t.department, price: t.price, rate: t.commission_note,
    commission: commissionOf(c, settings.commission_needs_payment) ? Number(t.commission || 0) : 0,
    pending: pendingCommissionOf(c, settings.commission_needs_payment) ? Number(t.commission || 0) : 0,
  })));
  const opening = round2(sum(all.filter((c) => c.reg_date < from), (c) => commissionOf(c, settings.commission_needs_payment))
    - sum(payouts.filter((p) => p.paid_on < from), (p) => p.amount));
  const earned = sum(period, (c) => commissionOf(c, settings.commission_needs_payment));
  const paid = sum(periodPayouts, (p) => p.amount);
  return {
    cases: period, lines, payouts: periodPayouts, allPayouts: payouts,
    patients: new Set(period.map((c) => c.patient_id)).size, caseCount: period.length, testCount: lines.length,
    revenue: sum(period, (c) => c.bill.total), earned, paid, pending: sum(period, (c) => pendingCommissionOf(c, settings.commission_needs_payment)),
    opening, closing: round2(opening + earned - paid), earnedAll, paidAll, balance: round2(earnedAll - paidAll),
    byDepartment: byDepartment(period), byTest: byTest(period),
  };
}

export async function panelLedger(panelId, from, to) {
  const accs = (await db().accessions.toArray()).filter((a) => a.panel_id === panelId && !a.deleted_at);
  const all = await attach(accs);
  const pays = (await db().panel_payments.where('panel_id').equals(panelId).toArray()).filter((p) => !p.deleted_at);
  const credit = all.filter((c) => c.bill_to === 'panel');
  const billedAll = sum(credit, (c) => c.bill.panel_due + 0) + 0;
  const period = all.filter((c) => inRange(c.reg_date, from, to));
  return {
    cases: period, payments: pays.filter((p) => inRange(p.paid_on, from, to)),
    billed: sum(period.filter((c) => c.bill_to === 'panel'), (c) => c.bill.panel_due),
    revenue: sum(period, (c) => c.bill.total),
    balance: round2(billedAll - sum(pays, (p) => p.amount)),
  };
}

export async function outsourceLedger(labId) {
  const tests = (await db().accession_tests.toArray()).filter((t) => t.outsource_lab_id === labId && t.status !== 'cancelled');
  const accs = Object.fromEntries((await db().accessions.bulkGet([...new Set(tests.map((t) => t.accession_id))])).filter(Boolean).map((a) => [a.id, a]));
  const live = tests.filter((t) => accs[t.accession_id] && !accs[t.accession_id].deleted_at);
  const pays = (await db().outsource_payments.where('lab_id').equals(labId).toArray()).filter((p) => !p.deleted_at);
  const owed = sum(live, (t) => t.outsource_cost);
  return { tests: live.map((t) => ({ ...t, acc: accs[t.accession_id] })), payments: pays, owed, paid: sum(pays, (p) => p.amount), balance: round2(owed - sum(pays, (p) => p.amount)) };
}

// Turnaround: registration → verification, against each test's promised time.
export function tat(cases) {
  const rows = [];
  for (const c of cases) for (const t of c.tests) {
    if (t.status !== 'verified') continue;
    const h = hoursBetween(c.registered_at, t.verified_at);
    const late = t.due_at ? t.verified_at > t.due_at : false;
    rows.push({ test: t.test_name, department: t.department, hours: h, late, acc: c.acc_number });
  }
  const byDept = [...groupBy(rows, (r) => r.department || 'General')].map(([department, l]) => ({
    department, count: l.length, avg: l.reduce((s, r) => s + r.hours, 0) / l.length,
    late: l.filter((r) => r.late).length,
  }));
  return { rows, byDept, onTime: rows.length ? Math.round((rows.filter((r) => !r.late).length / rows.length) * 100) : null };
}

// Tests still open past their promised time (live list).
export async function overdueTests() {
  const now = new Date().toISOString();
  const tests = (await db().accession_tests.where('status').anyOf(['pending', 'collected', 'entered']).toArray())
    .filter((t) => t.due_at && t.due_at < now);
  const accs = Object.fromEntries((await db().accessions.bulkGet([...new Set(tests.map((t) => t.accession_id))])).filter(Boolean).map((a) => [a.id, a]));
  return tests.filter((t) => accs[t.accession_id] && !accs[t.accession_id].deleted_at);
}

// Every live case with something still owed by the patient.
export async function dues() {
  const accs = (await db().accessions.toArray()).filter((a) => !a.deleted_at && a.bill_to !== 'panel');
  const cases = await attach(accs);
  return cases.filter((c) => c.bill.due > 0.009).sort((a, b) => a.reg_date.localeCompare(b.reg_date));
}

export async function patientAccount(patientId) {
  const accs = (await db().accessions.where('patient_id').equals(patientId).toArray()).filter((a) => !a.deleted_at);
  const cases = await attach(accs);
  return { cases, total: sum(cases, (c) => c.bill.total), paid: sum(cases, (c) => c.bill.paid), due: sum(cases, (c) => c.bill.due) };
}

// Business analysis: this period vs the one before, busiest hours.
export function heatmap(cases) {
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const c of cases) {
    const d = new Date(c.registered_at);
    grid[(d.getDay() + 6) % 7][d.getHours()] += 1;
  }
  return grid;
}

export function dailySeries(cases, from, to) {
  const out = [];
  const byDay = groupBy(cases, (c) => c.reg_date);
  let d = from;
  while (d <= to) {
    const l = byDay.get(d) || [];
    out.push({ date: d, revenue: sum(l, (c) => c.bill.total), cases: l.length });
    const [y, m, dd] = d.split('-').map(Number);
    const x = new Date(y, m - 1, dd + 1);
    d = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    if (out.length > 400) break;
  }
  return out;
}

export async function stockLevels() {
  const [items, lots, moves] = await Promise.all([db().inv_items.toArray(), db().inv_lots.toArray(), db().inv_moves.toArray()]);
  const today = todayISO();
  return items.map((it) => {
    const myLots = lots.filter((l) => l.item_id === it.id && l.active !== false);
    const myMoves = moves.filter((m) => m.item_id === it.id);
    const lotRows = myLots.map((l) => ({
      ...l, left: round2(Number(l.qty_received || 0) + myMoves.filter((m) => m.lot_id === l.id).reduce((s, m) => s + Number(m.qty), 0)),
      expired: !!(l.expiry && l.expiry < today),
    }));
    const stock = round2(myLots.reduce((s, l) => s + Number(l.qty_received || 0), 0) + myMoves.reduce((s, m) => s + Number(m.qty), 0));
    const soon = lotRows.filter((l) => l.left > 0 && l.expiry && l.expiry >= today && l.expiry <= addDaysISO(today, 30));
    return { ...it, stock, lots: lotRows, low: it.active !== false && stock <= Number(it.reorder_level || 0), expiringSoon: soon, expired: lotRows.filter((l) => l.expired && l.left > 0) };
  });
}
function addDaysISO(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const x = new Date(y, m - 1, d + n);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

export async function equipmentDue() {
  const [eq, logs] = await Promise.all([db().equipment.toArray(), db().equipment_logs.toArray()]);
  const today = todayISO();
  return eq.filter((e) => e.active !== false).map((e) => {
    const mine = logs.filter((l) => l.equipment_id === e.id).sort((a, b) => b.log_date.localeCompare(a.log_date));
    const lastOf = (k) => mine.find((l) => l.kind === k);
    const next = (k, days) => {
      const l = lastOf(k);
      if (l?.next_due) return l.next_due;
      if (l && days) return addDaysISO(l.log_date, Number(days));
      return null;
    };
    const nc = next('calibration', e.calib_interval_days), nm = next('maintenance', e.maint_interval_days);
    return { ...e, logs: mine, nextCalibration: nc, nextMaintenance: nm, overdue: [nc, nm].some((d) => d && d < today), dueSoon: [nc, nm].some((d) => d && d >= today && d <= addDaysISO(today, 7)) };
  });
}

import { describe, it, expect, beforeAll } from 'vitest';
import { openUserDb, db } from '../src/lib/db.js';
import { initSync, syncNow, getSyncState } from '../src/lib/sync.js';
import * as A from '../src/lib/actions.js';
import * as R from '../src/lib/reports.js';
import { buildResults } from '../src/lib/results.js';
import { todayISO, addDays } from '../src/lib/format.js';
import { createMockServer } from './mockServer.js';

const server = createMockServer();
const put = (t, r) => db()[t].put({ ...r, _dirty: 0, _base: r, row_version: 1 });
const today = todayISO();

async function seed() {
  await put('lab_settings', { id: 1, lab_name: 'City Lab', commission_basis: 'net', home_charge: 300, sample_keep_days: 7, auto_verify: true });
  await put('lab_tests', { id: 't-cbc', code: 'CBC', name: 'CBC', category: 'Haematology', sample_type: 'Whole blood', container: 'EDTA', price: 800, tat_hours: 4, kind: 'test', auto_verify: true });
  await put('lab_tests', { id: 't-esr', code: 'ESR', name: 'ESR', category: 'Haematology', sample_type: 'Whole blood', container: 'EDTA', price: 300, tat_hours: 2, kind: 'test' });
  await put('lab_tests', { id: 't-lft', code: 'LFT', name: 'LFT', category: 'Clinical Chemistry', sample_type: 'Serum', container: 'Gel', price: 1500, tat_hours: 6, kind: 'test' });
  await put('lab_tests', { id: 't-tsh', code: 'TSH', name: 'TSH', category: 'Hormones', sample_type: 'Serum', container: 'Gel', price: 1000, tat_hours: 6, kind: 'test' });
  await put('lab_tests', { id: 't-pkg', code: 'PKG', name: 'Basic package', category: 'Packages', kind: 'package', price: 2000, components: ['t-cbc', 't-lft', 't-tsh'] });
  await put('lab_parameters', { id: 'p-hb', test_id: 't-cbc', name: 'Haemoglobin', code: 'HB', result_type: 'numeric', unit: 'g/dL', sort_order: 1, critical_low: 7, delta_pct: 20 });
  await put('lab_reference_ranges', { id: 'r-hb', parameter_id: 'p-hb', gender: 'male', age_min_days: 0, low: 13, high: 17 });
  await put('ref_doctors', { id: 'd-ahmed', full_name: 'Dr. Ahmed', rate_type: 'percent', rate_value: 30, active: true });
  await put('ref_doctors', { id: 'd-sara', full_name: 'Dr. Sara', rate_type: 'percent', rate_value: 20, active: true });
  await put('commission_rules', { id: 'cr1', doctor_id: 'd-ahmed', scope: 'department', department: 'Hormones', rate_type: 'percent', rate_value: 15, active: true });
  await put('panels', { id: 'pan', name: 'ABC Company', discount_pct: 10, credit: true, active: true });
  await put('inv_items', { id: 'i-reag', name: 'Hb reagent', unit: 'test', reorder_level: 5 });
  await put('test_consumption', { id: 'tc1', test_id: 't-cbc', item_id: 'i-reag', qty: 1 });
}

describe('lab workflow end-to-end', () => {
  let ali, acc;

  beforeAll(async () => {
    openUserDb('admin-1');
    initSync(server.makeClient('u-admin'));
    await syncNow();
    await seed();
    await A.receiveStock('i-reag', { lot_number: 'LOT-A', expiry: addDays(today, 200), qty: 10 });
    await A.receiveStock('i-reag', { lot_number: 'LOT-B', expiry: addDays(today, 20), qty: 10 });
  });

  it('registers a master profile with MR number and portal PIN', async () => {
    ali = await A.registerPatient({ full_name: 'Ali Khan', phone: '0300-1234567', gender: 'male', dob: '1985-03-10' });
    expect(ali.mr_number).toBe('MR1-00001');
    expect(ali.portal_token).toHaveLength(24);
    expect(ali.portal_pin).toMatch(/^\d{4}$/);
    const dup = await A.findPossibleDuplicates({ full_name: 'Someone', phone: '03001234567' });
    expect(dup.map((p) => p.id)).toContain(ali.id);
  });

  it('one case = one bill made automatically, with commission per test', async () => {
    acc = await A.createAccession({ patient: ali, testIds: ['t-cbc', 't-esr', 't-tsh'], doctorId: 'd-ahmed', discount: 210, payment: { amount: 1000, method: 'cash' } });
    expect(acc.acc_number).toBe('L1-00001');
    const bill = await A.accessionBill(acc.id);
    expect(bill).toMatchObject({ subtotal: 2100, total: 1890, paid: 1000, due: 890 });
    const tests = await db().accession_tests.where('accession_id').equals(acc.id).toArray();
    const c = Object.fromEntries(tests.map((t) => [t.test_code, t.commission]));
    // net basis: 10 % discount shared → CBC 720×30 %, ESR 270×30 %, TSH 900×15 % (department rule)
    expect(c).toEqual({ CBC: 216, ESR: 81, TSH: 135 });
    expect(acc.report_due_at).toBeTruthy();
  });

  it('adding a test later updates the same bill', async () => {
    await A.addTests(acc, ['t-lft']);
    const bill = await A.accessionBill(acc.id);
    expect(bill.subtotal).toBe(3600);
    expect(await db().accessions.count()).toBe(1);
  });

  it('pay in full, then cancel a test: refund is made on the case day and the doctor commission drops', async () => {
    const bill = await A.accessionBill(acc.id);
    await A.addPayment(acc, { amount: bill.due, method: 'jazzcash' });
    const esr = (await db().accession_tests.where('accession_id').equals(acc.id).toArray()).find((t) => t.test_code === 'ESR');
    const { refunded } = await A.cancelTest(esr, 'Doctor removed it');
    expect(refunded).toBeGreaterThan(0);
    const after = await A.accessionBill(acc.id);
    expect(after.due).toBe(0); expect(after.overpaid).toBe(0);
    const ref = (await db().bill_payments.toArray()).find((p) => p.kind === 'refund');
    expect(ref.business_date).toBe(acc.reg_date);
    const led = await R.doctorLedger('d-ahmed', today, today);
    expect(led.lines.find((l) => l.test === 'ESR')).toBeUndefined();
  });

  it('day summary: revenue, cash by method, commission and profit agree', async () => {
    const s = await R.summary(today, today);
    const bill = await A.accessionBill(acc.id);
    expect(s.revenue).toBe(bill.total);
    expect(s.netCash).toBe(bill.paid);
    expect(s.byMethod.map((m) => m.method).sort()).toEqual(['cash', 'jazzcash']);
    expect(s.commission).toBeGreaterThan(0);
    expect(s.profit).toBe(Math.round((s.revenue - s.commission) * 100) / 100);
  });

  it('changing the doctor moves the commission to the right doctor', async () => {
    acc = await db().accessions.get(acc.id);
    await A.updateAccession(acc, { doctor_id: 'd-sara' });
    expect((await R.doctorLedger('d-ahmed', today, today)).earned).toBe(0);
    expect((await R.doctorLedger('d-sara', today, today)).earned).toBeGreaterThan(0);
    await A.updateAccession(await db().accessions.get(acc.id), { doctor_id: 'd-ahmed' });
  });

  it('deleting the patient removes the bill, payments and commission from every figure; restore brings them back', async () => {
    const before = await R.summary(today, today);
    ali = await db().patients.get(ali.id);
    await A.deletePatient(ali, 'Test entry');
    const gone = await R.summary(today, today);
    expect(gone.revenue).toBe(0); expect(gone.netCash).toBe(0); expect(gone.commission).toBe(0);
    expect((await R.doctorLedger('d-ahmed', today, today)).earned).toBe(0);
    await A.restorePatient(await db().patients.get(ali.id));
    const back = await R.summary(today, today);
    expect(back.revenue).toBe(before.revenue); expect(back.netCash).toBe(before.netCash);
  });

  it('collects one tube per sample type (shared barcode)', async () => {
    acc = await db().accessions.get(acc.id);
    const made = await A.collectSamples(acc);
    expect(made.map((s) => s.sample_type).sort()).toEqual(['Serum', 'Whole blood']);
    expect(made[0].specimen_number).toMatch(/^S1-/);
    const tests = await db().accession_tests.where('accession_id').equals(acc.id).toArray();
    expect(tests.filter((t) => t.status === 'collected')).toHaveLength(3);
  });

  it('results: flags, critical value, stock taken first-expiry-first, then amend keeps history', async () => {
    const cbc = (await db().accession_tests.where('accession_id').equals(acc.id).toArray()).find((t) => t.test_code === 'CBC');
    const params = await db().lab_parameters.where('test_id').equals('t-cbc').toArray();
    const ranges = { 'p-hb': await db().lab_reference_ranges.toArray() };
    const results = buildResults(params, { 'p-hb': '6.5' }, ranges, ali);
    expect(results[0]).toMatchObject({ flag: 'low', critical: 'low' });
    await A.saveResult(cbc, { results }, { verify: true, userId: 'u-admin' });
    const saved = await db().accession_tests.get(cbc.id);
    expect(saved.status).toBe('verified');
    expect(saved.lots[0].lot).toBe('LOT-B'); // expires first
    const stock = (await R.stockLevels()).find((i) => i.id === 'i-reag');
    expect(stock.stock).toBe(19);
    await A.logCriticalCall({ testRow: saved, parameter: 'Haemoglobin', value: '6.5', informedTo: 'Dr. Ahmed (0300…)' });
    await expect(A.saveResult(saved, { results })).rejects.toThrow(/Amend/);
    await A.amendResult(saved, { results: buildResults(params, { 'p-hb': '7.5' }, ranges, ali) }, 'Typing mistake');
    const am = await db().accession_tests.get(cbc.id);
    expect(am.amend_count).toBe(1); expect(am.results[0].value).toBe('7.5');
    expect(await db().result_amendments.count()).toBe(1);
  });

  it('packages split their price over the tests; panel price applies', async () => {
    const sara = await A.registerPatient({ full_name: 'Sara Bibi', gender: 'female' });
    const a2 = await A.createAccession({ patient: sara, testIds: ['t-pkg'], panelId: 'pan', billTo: 'panel' });
    const tests = await db().accession_tests.where('accession_id').equals(a2.id).toArray();
    expect(tests).toHaveLength(3);
    const bill = await A.accessionBill(a2.id);
    expect(bill.total).toBe(1800); // package 2000 less 10 % panel discount
    expect(bill.due).toBe(0); expect(bill.panel_due).toBe(1800);
    const led = await R.panelLedger('pan', today, today);
    expect(led.balance).toBe(1800);
  });

  it('home collection adds the home charge to the bill', async () => {
    const p = await A.registerPatient({ full_name: 'Home Patient', gender: 'male' });
    const a3 = await A.createAccession({ patient: p, testIds: ['t-esr'], home: { address: 'House 1', time: null } });
    expect((await A.accessionBill(a3.id)).total).toBe(600);
  });

  it('a payment cannot be more than the due; delete + restore of a payment', async () => {
    const p = await A.registerPatient({ full_name: 'Payer', gender: 'male' });
    const a4 = await A.createAccession({ patient: p, testIds: ['t-esr'] });
    await expect(A.addPayment(a4, { amount: 400 })).rejects.toThrow(/due/);
    const pay = await A.addPayment(a4, { amount: 300 });
    await A.softDelete('bill_payments', pay, 'Wrong entry');
    expect((await A.accessionBill(a4.id)).due).toBe(300);
    await A.restore('bill_payments', await db().bill_payments.get(pay.id));
    expect((await A.accessionBill(a4.id)).due).toBe(0);
  });

  it('everything syncs to the server', async () => {
    await syncNow();
    expect(getSyncState().pending).toBe(0);
    expect(server.T('accessions').size).toBe(4);
    expect(server.T('bill_payments').size).toBeGreaterThan(3);
    expect(server.T('patients').size).toBe(4);
  });

  it('merge moves all cases to the kept profile', async () => {
    const d1 = await A.registerPatient({ full_name: 'Bilal', phone: '03111111111', gender: 'male' });
    const d2 = await A.registerPatient({ full_name: 'Bilal Ahmed', phone: '03111111111', gender: 'male' });
    await A.createAccession({ patient: d2, testIds: ['t-esr'] });
    await A.mergePatients(d1, d2);
    expect((await db().accessions.where('patient_id').equals(d1.id).toArray())).toHaveLength(1);
    expect((await db().patients.get(d2.id)).merged_into).toBe(d1.id);
  });
});

// Everything that changes data goes through here. Each action writes to the
// device first (works offline) and the sync engine sends it to the server.
// The rules that tie modules together live here: one accession = one bill,
// commission follows the bill, cancelling or deleting flows through to
// revenue, cash, the doctor's account and the reports automatically.
import { db } from './db.js';
import { insertRow, updateRow, nextNumber, tx, uuid } from './repo.js';
import { addDays, nowIso, randomCode, randomPin, randomToken, round2, todayISO } from './format.js';
import { billTotals, computeCommissions, splitPackage, unitPrice } from './pricing.js';

export const getSettings = async () => (await db().lab_settings.get(1)) || {};

// ===================================================================== patients
export async function registerPatient(data) {
  if (!data.full_name?.trim()) throw new Error('Enter the patient name.');
  const mr_number = await nextNumber('MR');
  return insertRow('patients', {
    ...data, full_name: data.full_name.trim(), mr_number,
    portal_token: randomToken(24), portal_pin: randomPin(4),
  });
}

export const updatePatient = (id, patch) => updateRow('patients', id, patch);

// Possible duplicates: same phone, same CNIC, or the same name.
export async function findPossibleDuplicates({ full_name, phone, cnic }, exceptId = null) {
  const digits = (s) => String(s || '').replace(/\D/g, '');
  const ph = digits(phone), cn = digits(cnic), nm = (full_name || '').trim().toLowerCase();
  return db().patients.filter((p) => !p.deleted_at && p.id !== exceptId && (
    (ph.length >= 7 && digits(p.phone) === ph)
    || (cn.length >= 10 && digits(p.cnic) === cn)
    || (nm && p.full_name.trim().toLowerCase() === nm))).toArray();
}

export function searchPatients(all, q) {
  const s = (q || '').trim().toLowerCase();
  const d = s.replace(/\D/g, '');
  return all.filter((p) => {
    if (p.deleted_at) return false;
    if (!s) return true;
    return p.full_name.toLowerCase().includes(s) || (p.mr_number || '').toLowerCase().includes(s)
      || (d.length >= 3 && (String(p.phone || '').replace(/\D/g, '').includes(d) || String(p.cnic || '').replace(/\D/g, '').includes(d)));
  });
}

// Moves every case of `dup` to `keep`, then retires `dup`.
export async function mergePatients(keep, dup) {
  if (keep.id === dup.id) throw new Error('Choose two different patients.');
  await tx(['patients', 'accessions', 'accession_tests', 'bill_payments'], async () => {
    const accs = await db().accessions.where('patient_id').equals(dup.id).toArray();
    for (const a of accs) await updateRow('accessions', a.id, { patient_id: keep.id });
    const tests = await db().accession_tests.where('patient_id').equals(dup.id).toArray();
    for (const t of tests) await updateRow('accession_tests', t.id, { patient_id: keep.id });
    const pays = await db().bill_payments.where('patient_id').equals(dup.id).toArray();
    for (const p of pays) await updateRow('bill_payments', p.id, { patient_id: keep.id });
    const fill = {};
    for (const k of ['phone', 'cnic', 'email', 'address', 'dob', 'gender', 'guardian']) if (!keep[k] && dup[k]) fill[k] = dup[k];
    if (Object.keys(fill).length) await updateRow('patients', keep.id, fill);
    await updateRow('patients', dup.id, {
      merged_into: keep.id, deleted_at: nowIso(), delete_reason: `Merged into ${keep.mr_number}`,
    });
  });
}

// Deleting a patient deletes all their cases in one batch: their bills,
// payments and doctor commission drop out of every report automatically.
export async function deletePatient(patient, reason) {
  const batch = uuid();
  const at = nowIso();
  await tx(['patients', 'accessions'], async () => {
    const accs = (await db().accessions.where('patient_id').equals(patient.id).toArray()).filter((a) => !a.deleted_at);
    for (const a of accs) await updateRow('accessions', a.id, { deleted_at: at, delete_reason: `Patient deleted: ${reason}`, deleted_batch: batch });
    await updateRow('patients', patient.id, { deleted_at: at, delete_reason: reason, deleted_batch: batch });
  });
}

export async function restorePatient(patient) {
  await tx(['patients', 'accessions'], async () => {
    if (patient.deleted_batch) {
      const accs = await db().accessions.where('patient_id').equals(patient.id).toArray();
      for (const a of accs.filter((x) => x.deleted_batch === patient.deleted_batch)) {
        await updateRow('accessions', a.id, { deleted_at: null, delete_reason: null, deleted_batch: null });
      }
    }
    await updateRow('patients', patient.id, { deleted_at: null, delete_reason: null, deleted_batch: null, merged_into: null });
  });
}

export async function resetPortalPin(patient) {
  return updateRow('patients', patient.id, { portal_token: patient.portal_token || randomToken(24), portal_pin: randomPin(4) });
}

// ===================================================================== tests on a bill
// Turns chosen catalogue ids (tests and packages) into bill lines, priced
// for the panel (if any). Tests already on the bill are skipped.
export async function expandSelection(testIds, panelId, existingTestIds = []) {
  const [catalog, panel, rates] = await Promise.all([
    db().lab_tests.toArray(),
    panelId ? db().panels.get(panelId) : null,
    panelId ? db().panel_rates.where('panel_id').equals(panelId).toArray() : [],
  ]);
  const byId = Object.fromEntries(catalog.map((t) => [t.id, t]));
  const have = new Set(existingTestIds);
  const lines = [];
  for (const id of testIds) {
    const t = byId[id];
    if (!t) continue;
    if (t.kind === 'package') {
      const comps = (t.components || []).map((c) => byId[c]).filter((c) => c && !have.has(c.id));
      const pkgPrice = t.price == null ? null : unitPrice(t, panel, rates);
      // when some components are already on the bill, only the rest is charged at list price
      const prices = comps.length === (t.components || []).length
        ? splitPackage(pkgPrice, comps.map((c) => ({ price: unitPrice(c, panel, rates) })))
        : comps.map((c) => unitPrice(c, panel, rates));
      comps.forEach((c, i) => { have.add(c.id); lines.push({ test: c, price: prices[i], package_id: t.id }); });
    } else if (!have.has(t.id)) {
      have.add(t.id);
      lines.push({ test: t, price: unitPrice(t, panel, rates), package_id: null });
    }
  }
  return lines;
}

function testRow(acc, line, i) {
  const t = line.test;
  const tat = Number(t.tat_hours || 0);
  const hours = acc.priority === 'urgent' ? Math.max(1, tat / 2) : tat;
  return {
    accession_id: acc.id, patient_id: acc.patient_id, test_id: t.id, test_code: t.code, test_name: t.name,
    department: t.category || 'General', sample_type: t.sample_type, package_id: line.package_id || null,
    list_price: Number(t.price || 0), price: round2(line.price || 0), commission: 0, status: 'pending',
    results: [], culture: null, text_result: null, sort_order: (t.sort_order || 0) * 100 + i,
    due_at: tat ? new Date(new Date(acc.registered_at).getTime() + hours * 3600000).toISOString() : null,
    outsource_lab_id: t.outsourced ? (t.outsource_lab_id || null) : null,
  };
}

// Recalculates commission (and the report-ready time) for one accession.
export async function recompute(accId) {
  const acc = await db().accessions.get(accId);
  if (!acc) return;
  const [tests, settings] = await Promise.all([db().accession_tests.where('accession_id').equals(accId).toArray(), getSettings()]);
  const doctor = acc.doctor_id ? await db().ref_doctors.get(acc.doctor_id) : null;
  const rules = doctor ? await db().commission_rules.where('doctor_id').equals(doctor.id).toArray() : [];
  const c = computeCommissions(acc, tests, doctor, rules, settings.commission_basis || 'net');
  for (const t of tests) {
    const want = c[t.id] || { commission: 0, note: null };
    if (Number(t.commission || 0) !== want.commission || (t.commission_note || null) !== want.note) {
      await updateRow('accession_tests', t.id, { commission: want.commission, commission_note: want.note });
    }
  }
  const due = tests.filter((t) => t.status !== 'cancelled' && t.due_at).map((t) => t.due_at).sort().pop() || null;
  if ((acc.report_due_at || null) !== due) await updateRow('accessions', acc.id, { report_due_at: due });
}

export async function accessionBill(accId) {
  const [acc, tests, pays] = await Promise.all([
    db().accessions.get(accId),
    db().accession_tests.where('accession_id').equals(accId).toArray(),
    db().bill_payments.where('accession_id').equals(accId).toArray(),
  ]);
  return billTotals(acc, tests, pays);
}

// New case (= new bill) for a patient.
export async function createAccession({
  patient, testIds, doctorId = null, doctorText = null, panelId = null, billTo = 'patient', priority = 'routine',
  home = null, discount = 0, discountReason = null, clinicalNotes = null, payment = null,
}) {
  if (!patient?.id) throw new Error('Choose the patient first.');
  if (!testIds?.length) throw new Error('Choose at least one test.');
  const settings = await getSettings();
  const lines = await expandSelection(testIds, panelId);
  if (!lines.length) throw new Error('Choose at least one test.');
  const unpriced = lines.filter((l) => l.test.price == null && !panelId);
  if (unpriced.length) throw new Error(`No price set for: ${unpriced.map((l) => l.test.name).join(', ')}. Set it in Settings → Tests & prices.`);
  const acc_number = await nextNumber('L');
  const now = nowIso();
  const acc = {
    id: uuid(), acc_number, patient_id: patient.id, reg_date: todayISO(), registered_at: now,
    doctor_id: doctorId || null, doctor_text: doctorId ? null : (doctorText || null),
    panel_id: panelId || null, bill_to: panelId ? billTo : 'patient', priority,
    home_collection: !!home, home_address: home?.address || null, home_time: home?.time || null,
    home_status: home ? 'scheduled' : null,
    home_charge: home ? Number(home.charge ?? settings.home_charge ?? 0) : 0,
    discount: round2(Number(discount || 0)), discount_reason: discountReason || null,
    clinical_notes: clinicalNotes || null, verify_code: randomCode(10),
  };
  const tests = lines.map((l, i) => ({ id: uuid(), ...testRow(acc, l, i) }));
  const gross = tests.reduce((s, t) => s + t.price, 0) + acc.home_charge;
  if (acc.discount > gross) throw new Error('Discount is more than the bill.');
  await tx(['accessions', 'accession_tests'], async () => {
    await insertRow('accessions', acc);
    for (const t of tests) await insertRow('accession_tests', t);
  });
  await recompute(acc.id);
  if (payment && Number(payment.amount) > 0) await addPayment(acc, payment);
  return db().accessions.get(acc.id);
}

export async function addTests(acc, testIds) {
  if (acc.deleted_at) throw new Error('This case is deleted. Restore it first.');
  const existing = (await db().accession_tests.where('accession_id').equals(acc.id).toArray()).filter((t) => t.status !== 'cancelled');
  const lines = await expandSelection(testIds, acc.panel_id, existing.map((t) => t.test_id));
  if (!lines.length) throw new Error('These tests are already on this bill.');
  const unpriced = lines.filter((l) => l.test.price == null && !acc.panel_id);
  if (unpriced.length) throw new Error(`No price set for: ${unpriced.map((l) => l.test.name).join(', ')}.`);
  await tx(['accession_tests'], async () => {
    for (const [i, l] of lines.entries()) await insertRow('accession_tests', testRow(acc, l, existing.length + i));
  });
  await recompute(acc.id);
  return lines.length;
}

// Money that must go back to the patient after a bill became smaller.
// Counted on the day of the case (that day's revenue and cash go down).
async function settleOverpayment(acc, why) {
  const bill = await accessionBill(acc.id);
  if (bill.overpaid <= 0) return 0;
  await insertRow('bill_payments', {
    payment_number: await nextNumber('R'), accession_id: acc.id, patient_id: acc.patient_id,
    kind: 'refund', amount: -bill.overpaid, method: 'cash', business_date: acc.reg_date, received_at: nowIso(),
    note: why, late_adjustment: acc.reg_date < todayISO(),
  });
  return bill.overpaid;
}

export async function cancelTest(test, reason) {
  if (test.status === 'verified') throw new Error('A verified result cannot be cancelled. Amend it instead.');
  if (!reason?.trim()) throw new Error('Give a reason.');
  const acc = await db().accessions.get(test.accession_id);
  await updateRow('accession_tests', test.id, { status: 'cancelled', cancelled_at: nowIso(), cancel_reason: reason.trim(), commission: 0, commission_note: null });
  await recompute(acc.id);
  const refunded = await settleOverpayment(acc, `Refund: ${test.test_name} cancelled — ${reason.trim()}`);
  return { refunded };
}

// Doctor, panel, discount, home collection, priority, notes.
export async function updateAccession(acc, patch) {
  const next = { ...acc, ...patch };
  if (patch.doctor_id !== undefined && patch.doctor_id) next.doctor_text = null;
  if (patch.panel_id !== undefined) {
    next.bill_to = patch.panel_id ? (patch.bill_to || acc.bill_to || 'patient') : 'patient';
    // re-price the open tests for the new panel
    const [tests, panel, rates] = await Promise.all([
      db().accession_tests.where('accession_id').equals(acc.id).toArray(),
      patch.panel_id ? db().panels.get(patch.panel_id) : null,
      patch.panel_id ? db().panel_rates.where('panel_id').equals(patch.panel_id).toArray() : [],
    ]);
    const catalog = Object.fromEntries((await db().lab_tests.bulkGet(tests.map((t) => t.test_id))).filter(Boolean).map((t) => [t.id, t]));
    for (const t of tests.filter((x) => x.status !== 'cancelled' && !x.package_id)) {
      const p = unitPrice(catalog[t.test_id] || { price: t.list_price, id: t.test_id }, panel, rates);
      if (p !== Number(t.price)) await updateRow('accession_tests', t.id, { price: p });
    }
  }
  const bill = await accessionBill(acc.id);
  if (next.discount != null && Number(next.discount) > bill.subtotal + Number(next.home_charge || 0)) {
    throw new Error('Discount is more than the bill.');
  }
  const keys = ['doctor_id', 'doctor_text', 'panel_id', 'bill_to', 'priority', 'discount', 'discount_reason', 'home_collection',
    'home_address', 'home_time', 'home_status', 'home_charge', 'clinical_notes'];
  const out = {};
  for (const k of keys) if (next[k] !== acc[k]) out[k] = next[k] ?? null;
  if (Object.keys(out).length) await updateRow('accessions', acc.id, out);
  await recompute(acc.id);
  const refunded = await settleOverpayment(await db().accessions.get(acc.id), 'Refund: bill reduced');
  return { refunded };
}

export async function deleteAccession(acc, reason) {
  if (!reason?.trim()) throw new Error('Give a reason.');
  return updateRow('accessions', acc.id, { deleted_at: nowIso(), delete_reason: reason.trim(), deleted_batch: null });
}
export async function restoreAccession(acc) {
  const p = await db().patients.get(acc.patient_id);
  if (p?.deleted_at) throw new Error('The patient of this case is deleted. Restore the patient first.');
  return updateRow('accessions', acc.id, { deleted_at: null, delete_reason: null, deleted_batch: null });
}

// ===================================================================== samples
// Tests needing the same sample type share one tube (one barcode).
export async function collectSamples(acc, onlyTestIds = null) {
  const settings = await getSettings();
  const tests = (await db().accession_tests.where('accession_id').equals(acc.id).toArray())
    .filter((t) => t.status === 'pending' && (!onlyTestIds || onlyTestIds.includes(t.id)));
  if (!tests.length) return [];
  const catalog = Object.fromEntries((await db().lab_tests.bulkGet(tests.map((t) => t.test_id))).filter(Boolean).map((t) => [t.id, t]));
  const groups = new Map();
  for (const t of tests) {
    const c = catalog[t.test_id];
    const key = `${t.sample_type || 'Sample'}|${c?.container || ''}`;
    if (!groups.has(key)) groups.set(key, { sample_type: t.sample_type || 'Sample', container: c?.container || null, tests: [] });
    groups.get(key).tests.push(t);
  }
  const made = [];
  const now = nowIso();
  for (const g of groups.values()) {
    const s = await insertRow('specimens', {
      specimen_number: await nextNumber('S'), accession_id: acc.id, sample_type: g.sample_type, container: g.container,
      status: 'collected', collected_at: now, discard_after: addDays(todayISO(), Number(settings.sample_keep_days || 7)),
    });
    for (const t of g.tests) await updateRow('accession_tests', t.id, { status: 'collected', specimen_id: s.id });
    made.push(s);
  }
  if (acc.home_collection && acc.home_status === 'scheduled') await updateRow('accessions', acc.id, { home_status: 'collected' });
  return made;
}

export async function rejectSpecimen(spec, reason) {
  if (!reason?.trim()) throw new Error('Give the reason (e.g. haemolysed, clotted, wrong tube).');
  const tests = await db().accession_tests.where('accession_id').equals(spec.accession_id).toArray();
  if (tests.some((t) => t.specimen_id === spec.id && t.status === 'verified')) throw new Error('A verified result uses this sample.');
  await updateRow('specimens', spec.id, { status: 'rejected', reject_reason: reason.trim(), rejected_at: nowIso() });
  for (const t of tests.filter((x) => x.specimen_id === spec.id && x.status !== 'cancelled')) {
    await updateRow('accession_tests', t.id, { status: 'pending', specimen_id: null });
  }
  return true;
}

export const storeSpecimen = (spec, storage) => updateRow('specimens', spec.id, { storage: storage || null });
export const discardSpecimen = (spec) => updateRow('specimens', spec.id, { status: 'discarded', discarded_at: nowIso() });

export async function sendOutsource(test, labId, cost) {
  return updateRow('accession_tests', test.id, {
    outsource_lab_id: labId || null, outsource_cost: cost === '' || cost == null ? null : Number(cost),
    outsource_sent_at: labId ? nowIso() : null,
  });
}

// ===================================================================== results
// Last verified value of each parameter for this patient (for delta check
// and for showing "previous" next to the new value).
export async function previousResults(patientId, testId, excludeRowId) {
  const rows = (await db().accession_tests.where('patient_id').equals(patientId).toArray())
    .filter((t) => t.id !== excludeRowId && t.status === 'verified' && (t.results || []).length);
  rows.sort((a, b) => (a.verified_at || '').localeCompare(b.verified_at || ''));
  const out = {};
  const accs = new Map();
  for (const r of rows) {
    if (!accs.has(r.accession_id)) accs.set(r.accession_id, await db().accessions.get(r.accession_id));
    if (accs.get(r.accession_id)?.deleted_at) continue;
    for (const x of r.results) {
      if (!x.value) continue;
      if (r.test_id === testId || x.code) {
        const key = x.parameter_id;
        out[key] = { value: x.value, on: r.verified_at, unit: x.unit };
        if (x.code) out['code:' + x.code] = out[key];
      }
    }
  }
  return out;
}

// Takes reagents/consumables for one test out of stock (first-expiry-first-out).
export async function consumeForTest(testRow) {
  const rules = (await db().test_consumption.where('test_id').equals(testRow.test_id).toArray()).filter((r) => r.active !== false);
  if (!rules.length) return null;
  const used = [];
  const today = todayISO();
  for (const r of rules) {
    const lots = (await db().inv_lots.where('item_id').equals(r.item_id).toArray())
      .filter((l) => l.active !== false && (!l.expiry || l.expiry >= today));
    const moves = await db().inv_moves.where('item_id').equals(r.item_id).toArray();
    const left = (l) => Number(l.qty_received || 0) + moves.filter((m) => m.lot_id === l.id).reduce((s, m) => s + Number(m.qty), 0);
    lots.sort((a, b) => (a.expiry || '9999').localeCompare(b.expiry || '9999'));
    const lot = lots.find((l) => left(l) >= Number(r.qty)) || lots.find((l) => left(l) > 0) || null;
    await insertRow('inv_moves', {
      item_id: r.item_id, lot_id: lot?.id || null, qty: -Number(r.qty), kind: 'consume',
      accession_test_id: testRow.id, moved_at: nowIso(), note: testRow.test_name,
    });
    const item = await db().inv_items.get(r.item_id);
    used.push({ item: item?.name || '', lot: lot?.lot_number || null, expiry: lot?.expiry || null });
  }
  return used;
}

// Save results. verify=true makes them final (report ready).
export async function saveResult(testRow, payload, { verify = false, autoVerified = false, pathologistId = null, userId = null } = {}) {
  if (testRow.status === 'verified') throw new Error('Already verified. Use Amend to correct it.');
  if (testRow.status === 'cancelled') throw new Error('This test is cancelled.');
  const acc = await db().accessions.get(testRow.accession_id);
  if (testRow.status === 'pending') await collectSamples(acc, [testRow.id]);
  const fresh = await db().accession_tests.get(testRow.id);
  const patch = {
    results: payload.results ?? fresh.results ?? [], culture: payload.culture ?? fresh.culture ?? null,
    text_result: payload.text_result ?? fresh.text_result ?? null, remarks: payload.remarks ?? fresh.remarks ?? null,
    entered_at: fresh.entered_at || nowIso(), entered_by: fresh.entered_by || userId,
    status: verify ? 'verified' : 'entered',
  };
  if (verify) Object.assign(patch, { verified_at: nowIso(), verified_by: userId, pathologist_id: pathologistId, auto_verified: !!autoVerified });
  const first = !fresh.entered_at && !(fresh.lots || null);
  if (first) {
    const lots = await consumeForTest(fresh);
    if (lots) patch.lots = lots;
  }
  return updateRow('accession_tests', fresh.id, patch);
}

export async function verifyTests(rows, { pathologistId = null, userId = null } = {}) {
  let n = 0;
  for (const r of rows) {
    if (r.status !== 'entered') continue;
    await updateRow('accession_tests', r.id, { status: 'verified', verified_at: nowIso(), verified_by: userId, pathologist_id: pathologistId, auto_verified: false });
    n++;
  }
  return n;
}

// Send a result back from "entered" for more work (before verification).
export const reopenResult = (row) => updateRow('accession_tests', row.id, { status: 'collected' });

export async function amendResult(testRow, payload, reason, { userId = null, pathologistId = null } = {}) {
  if (testRow.status !== 'verified') throw new Error('Only a verified result needs an amendment.');
  if (!reason?.trim()) throw new Error('Give the reason for the amendment.');
  const old = { results: testRow.results, culture: testRow.culture, text_result: testRow.text_result, remarks: testRow.remarks };
  const neu = {
    results: payload.results ?? testRow.results, culture: payload.culture ?? testRow.culture,
    text_result: payload.text_result ?? testRow.text_result, remarks: payload.remarks ?? testRow.remarks,
  };
  await insertRow('result_amendments', { accession_test_id: testRow.id, reason: reason.trim(), old_data: old, new_data: neu, amended_at: nowIso() });
  return updateRow('accession_tests', testRow.id, {
    ...neu, amend_count: (testRow.amend_count || 0) + 1, verified_at: nowIso(), verified_by: userId,
    pathologist_id: pathologistId || testRow.pathologist_id,
  });
}

export async function logCriticalCall({ testRow, parameter, value, informedTo, note }) {
  if (!informedTo?.trim()) throw new Error('Write who was informed (name / phone).');
  return insertRow('critical_calls', {
    accession_test_id: testRow.id, accession_id: testRow.accession_id, parameter, value: String(value ?? ''),
    informed_to: informedTo.trim(), informed_at: nowIso(), note: note || null,
  });
}

// ===================================================================== payments
export async function addPayment(acc, { amount, method = 'cash', reference = null, note = null }) {
  const amt = round2(Number(amount));
  if (!(amt > 0)) throw new Error('Enter an amount.');
  const bill = await accessionBill(acc.id);
  const open = acc.bill_to === 'panel' ? bill.panel_due : bill.due;
  if (amt > open + 0.001) throw new Error(`Only ${open} is due on this bill.`);
  return insertRow('bill_payments', {
    payment_number: await nextNumber('R'), accession_id: acc.id, patient_id: acc.patient_id, kind: 'payment',
    amount: amt, method, reference: reference || null, note: note || null,
    business_date: todayISO(), received_at: nowIso(), late_adjustment: false,
  });
}

export async function editPayment(p, patch) {
  if (p.deleted_at) throw new Error('This payment is deleted.');
  const next = { ...p, ...patch };
  if (patch.amount != null) {
    const amt = round2(Number(patch.amount));
    if (p.kind === 'payment' && !(amt > 0)) throw new Error('Enter an amount.');
    next.amount = p.kind === 'refund' ? -Math.abs(amt) : amt;
    if (p.kind === 'payment') {
      const bill = await accessionBill(p.accession_id);
      if (bill.paid - Number(p.amount) + amt > bill.total + 0.001) throw new Error('That is more than the bill total.');
    }
  }
  return updateRow('bill_payments', p.id, { amount: next.amount, method: next.method, reference: next.reference || null, note: next.note || null });
}

export async function refund(acc, { amount, method = 'cash', reason }) {
  const amt = round2(Number(amount));
  if (!(amt > 0)) throw new Error('Enter an amount.');
  if (!reason?.trim()) throw new Error('Give a reason.');
  const bill = await accessionBill(acc.id);
  if (amt > bill.paid + 0.001) throw new Error(`Only ${bill.paid} has been paid on this bill.`);
  return insertRow('bill_payments', {
    payment_number: await nextNumber('R'), accession_id: acc.id, patient_id: acc.patient_id, kind: 'refund',
    amount: -amt, method, note: reason.trim(), business_date: todayISO(), received_at: nowIso(), late_adjustment: false,
  });
}

// ===================================================================== generic soft delete / restore
export async function softDelete(table, row, reason) {
  if (!reason?.trim()) throw new Error('Give a reason.');
  return updateRow(table, row.id, { deleted_at: nowIso(), delete_reason: reason.trim() });
}
export async function restore(table, row) {
  if (table === 'patients') return restorePatient(row);
  if (table === 'accessions') return restoreAccession(row);
  if (table === 'bill_payments') {
    const acc = await db().accessions.get(row.accession_id);
    if (row.kind === 'payment') {
      const bill = await accessionBill(row.accession_id);
      if (bill.paid + Number(row.amount) > bill.total + 0.001) throw new Error('Restoring this payment would make the bill over-paid.');
    }
    if (acc?.deleted_at) throw new Error('The case of this payment is deleted. Restore the case first.');
  }
  return updateRow(table, row.id, { deleted_at: null, delete_reason: null });
}

// ===================================================================== doctors, panels, outsourcing
export async function addPayout(doctorId, { amount, method = 'cash', paid_on, reference, note }) {
  const amt = round2(Number(amount));
  if (!(amt > 0)) throw new Error('Enter an amount.');
  return insertRow('doctor_payouts', {
    payout_number: await nextNumber('DP'), doctor_id: doctorId, amount: amt, method,
    paid_on: paid_on || todayISO(), reference: reference || null, note: note || null,
  });
}

export async function ensureDoctorPortal(doctor) {
  return updateRow('ref_doctors', doctor.id, {
    portal_enabled: true, portal_token: doctor.portal_token || randomToken(24), portal_pin: doctor.portal_pin || randomPin(4),
  });
}
export const resetDoctorPin = (doctor) => updateRow('ref_doctors', doctor.id, { portal_pin: randomPin(4) });

// ===================================================================== stock
export async function receiveStock(itemId, { lot_number, expiry, qty, cost, supplier, received_on }) {
  const q = Number(qty);
  if (!(q > 0)) throw new Error('Enter the quantity received.');
  return insertRow('inv_lots', {
    item_id: itemId, lot_number: lot_number || null, expiry: expiry || null, qty_received: q,
    cost: cost === '' || cost == null ? null : Number(cost), supplier: supplier || null, received_on: received_on || todayISO(),
  });
}
export async function adjustStock(itemId, { qty, kind = 'adjust', lot_id = null, note }) {
  const q = Number(qty);
  if (!q) throw new Error('Enter a quantity (minus for stock going out).');
  return insertRow('inv_moves', { item_id: itemId, lot_id, qty: q, kind, moved_at: nowIso(), note: note || null });
}

export async function logPrint(accId, docType, via = 'print') {
  try { await insertRow('print_log', { accession_id: accId, doc_type: docType, via, printed_at: nowIso() }); } catch { /* never block printing */ }
}

export async function closeDay({ date, expected, counted, note }) {
  const existing = await db().day_closings.where('close_date').equals(date).first();
  const row = { close_date: date, expected_cash: round2(expected), counted_cash: counted === '' || counted == null ? null : round2(counted), note: note || null, closed_at: nowIso() };
  return existing ? updateRow('day_closings', existing.id, row) : insertRow('day_closings', row);
}

export { billTotals };

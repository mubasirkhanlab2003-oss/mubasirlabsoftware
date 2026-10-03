import Dexie from 'dexie';

// Tables mirrored on this device for offline work. Order = safe push order
// (parents before children, so foreign keys always exist on the server).
export const TABLES = [
  'profiles', 'lab_settings', 'pathologists', 'lab_tests', 'lab_parameters', 'lab_reference_ranges',
  'antibiotics', 'report_templates', 'memberships', 'ref_doctors', 'commission_rules', 'doctor_payouts',
  'panels', 'panel_rates', 'panel_payments', 'outsource_labs', 'outsource_rates', 'outsource_payments',
  'patients', 'accessions', 'specimens', 'accession_tests', 'result_amendments', 'critical_calls',
  'bill_payments', 'print_log', 'expenses', 'day_closings', 'inv_items', 'inv_lots', 'inv_moves',
  'test_consumption', 'qc_materials', 'qc_runs', 'equipment', 'equipment_logs',
];

// Fields the server manages; never sent from the device.
export const SERVER_FIELDS = ['updated_at', 'row_version', 'created_by', 'updated_by'];

const SCHEMA = {
  meta: 'key',
  profiles: 'id, _dirty',
  lab_settings: 'id, _dirty',
  pathologists: 'id, _dirty',
  lab_tests: 'id, code, _dirty',
  lab_parameters: 'id, test_id, _dirty',
  lab_reference_ranges: 'id, parameter_id, _dirty',
  antibiotics: 'id, _dirty',
  report_templates: 'id, _dirty',
  memberships: 'id, _dirty',
  ref_doctors: 'id, _dirty',
  commission_rules: 'id, doctor_id, _dirty',
  doctor_payouts: 'id, doctor_id, paid_on, _dirty',
  panels: 'id, _dirty',
  panel_rates: 'id, panel_id, _dirty',
  panel_payments: 'id, panel_id, _dirty',
  outsource_labs: 'id, _dirty',
  outsource_rates: 'id, lab_id, _dirty',
  outsource_payments: 'id, lab_id, _dirty',
  patients: 'id, mr_number, phone, cnic, _dirty',
  accessions: 'id, acc_number, patient_id, reg_date, doctor_id, panel_id, verify_code, _dirty',
  specimens: 'id, specimen_number, accession_id, _dirty',
  accession_tests: 'id, accession_id, patient_id, test_id, status, _dirty',
  result_amendments: 'id, accession_test_id, _dirty',
  critical_calls: 'id, accession_id, accession_test_id, _dirty',
  bill_payments: 'id, accession_id, patient_id, business_date, _dirty',
  print_log: 'id, accession_id, _dirty',
  expenses: 'id, exp_date, _dirty',
  day_closings: 'id, close_date, _dirty',
  inv_items: 'id, _dirty',
  inv_lots: 'id, item_id, _dirty',
  inv_moves: 'id, item_id, lot_id, accession_test_id, _dirty',
  test_consumption: 'id, test_id, item_id, _dirty',
  qc_materials: 'id, _dirty',
  qc_runs: 'id, material_id, _dirty',
  equipment: 'id, _dirty',
  equipment_logs: 'id, equipment_id, _dirty',
};

let current = null;

// One local database per signed-in user.
export function openUserDb(userId) {
  const name = `lis_${userId}`;
  if (current && current.name === name) return current;
  if (current) current.close();
  const d = new Dexie(name);
  d.version(1).stores(SCHEMA);
  current = d;
  return d;
}

export function db() {
  if (!current) throw new Error('Local database not open');
  return current;
}

export async function deleteUserDb(userId) {
  if (current && current.name === `lis_${userId}`) { current.close(); current = null; }
  await Dexie.delete(`lis_${userId}`);
}

export async function getMeta(key, fallback = null) {
  const r = await db().meta.get(key);
  return r ? r.value : fallback;
}
export async function setMeta(key, value) {
  await db().meta.put({ key, value });
}

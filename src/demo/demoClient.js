// DEVELOPMENT ONLY (VITE_DEMO=1): an in-browser imitation of Supabase with a
// seeded catalogue, used to click through the app and take screenshots
// without a real server. Never included in a normal build.
import { TESTS, PACKAGES, ANTIBIOTICS, TEMPLATES } from '../../sql/catalogue.mjs';

// Deterministic ids, so reloading the page does not duplicate the seed.
let seq = 0;
const uid = () => { seq += 1; return `00000000-0000-4000-9000-${String(seq).padStart(12, '0')}`; };
const freshId = () => crypto.randomUUID();
const ADMIN = '00000000-0000-4000-8000-000000000001';

function seed(T) {
  const put = (t, r) => T(t).set(r.id, { created_at: new Date().toISOString(), ...r, updated_at: new Date().toISOString(), row_version: 1 });
  put('profiles', { id: ADMIN, email: 'owner@lab.pk', full_name: 'Lab Owner', role: 'admin', active: true });
  put('lab_settings', { id: 1, lab_name: 'Al-Shifa Diagnostic Laboratory', tagline: 'Pathology & Diagnostic Services', address: 'Main Bazar Road, Mardan', phone: '0937-123456', whatsapp: '0300-1234567', currency: 'Rs', phone_country_code: '92', report_mode: 'full', receipt_format: 'a4', label_width_mm: 50, label_height_mm: 25, commission_basis: 'net', commission_needs_payment: false, report_needs_payment: false, auto_verify: true, home_charge: 300, sample_keep_days: 7, backup_reminder_days: 7, expense_categories: ['Rent', 'Electricity', 'Salaries', 'Reagents & kits', 'Other'], letterhead_top_mm: 45, letterhead_bottom_mm: 25, report_footer: 'Results relate only to the sample tested. Please correlate clinically.' });
  put('pathologists', { id: uid(), full_name: 'Dr. Ayesha Rahman', qualification: 'MBBS, FCPS (Chemical Pathology)', designation: 'Consultant Pathologist', is_default: true, active: true, sort_order: 1 });
  const PRICES = { CBC: 800, ESR: 300, LFT: 1500, RFT: 1500, BSF: 200, BSR: 200, HBA1C: 1500, LIPID: 1600, TSH: 1200, URE: 400, VITD: 3500, B12: 2800, CRP: 900, TYPHI: 900, MP: 300, HBSAG: 600, HCV: 600, UCS: 1800, ELEC: 1200, FERR: 2200, 'PKG-FULL': 9500, 'PKG-FEVER': 2900 };
  const byCode = {};
  let order = 0;
  for (const t of TESTS) {
    const id = uid(); byCode[t.code] = id;
    put('lab_tests', { id, code: t.code, name: t.name, category: t.dept, sample_type: t.sample, container: t.container, tat_hours: t.tat, instructions: t.prep || null, result_kind: t.kind || 'parameters', method: t.method || null, report_note: t.note || null, price: PRICES[t.code] ?? null, active: true, sort_order: (order += 10), kind: 'test', components: [], auto_verify: t.auto !== false, is_starter: true, ranges_reviewed: false });
    t.params.forEach((p, i) => {
      const pid = uid();
      put('lab_parameters', { id: pid, test_id: id, name: p.n, code: p.c || null, unit: p.u || null, result_type: p.t || 'numeric', options: p.o || null, decimals: p.d ?? 1, sort_order: i + 1, formula: p.f || null, critical_low: p.cl ?? null, critical_high: p.ch ?? null, delta_pct: p.dp ?? null, reflex: p.rx || null, section: p.s || null, active: true });
      for (const r of p.r || []) put('lab_reference_ranges', { id: uid(), parameter_id: pid, gender: r.g || 'any', age_min_days: r.a0 || 0, age_max_days: r.a1 ?? null, low: r.lo ?? null, high: r.hi ?? null, display_text: r.x || null, active: true });
    });
  }
  PACKAGES.forEach(([code, name, codes], i) => put('lab_tests', { id: uid(), code, name, category: 'Packages', sample_type: 'Multiple', kind: 'package', components: codes.map((c) => byCode[c]).filter(Boolean), price: PRICES[code] ?? null, active: true, sort_order: i }));
  ANTIBIOTICS.forEach(([name, cls], i) => put('antibiotics', { id: uid(), name, class: cls, sort_order: i, active: true }));
  TEMPLATES.forEach(([name, body]) => put('report_templates', { id: uid(), name, body, active: true }));
  const d1 = uid();
  put('ref_doctors', { id: d1, full_name: 'Dr. Ahmed Khan', qualification: 'MBBS, FCPS (Medicine)', hospital: 'City Hospital', phone: '03001112233', rate_type: 'percent', rate_value: 30, active: true, portal_enabled: true, portal_token: 'demodoctortoken12345678', portal_pin: '1234', portal_show_commission: true });
  put('ref_doctors', { id: uid(), full_name: 'Dr. Sana Iqbal', qualification: 'MBBS, MCPS (Gynae)', hospital: 'Mother Care Clinic', phone: '03004445566', rate_type: 'percent', rate_value: 25, active: true });
  put('commission_rules', { id: uid(), doctor_id: d1, scope: 'department', department: 'Hormones', rate_type: 'percent', rate_value: 15, active: true });
  put('panels', { id: uid(), name: 'Sarhad Textile Mills', kind: 'corporate', discount_pct: 15, credit: true, active: true });
  put('memberships', { id: uid(), name: 'Family card', discount_pct: 10, active: true });
}

export function createDemoClient() {
  const tables = {};
  const T = (n) => (tables[n] ||= new Map());
  let clock = Date.now() - 1000000;
  const tick = () => new Date((clock += 1000)).toISOString();
  seed(T);
  let session = null;
  try { session = JSON.parse(localStorage.getItem('demo_session')); } catch { /* none */ }
  const listeners = new Set();
  const devices = new Map();

  function builder(table) {
    const st = { op: 'select', filters: [], gt: null, range: null, single: false, payload: null, isNull: [] };
    const b = {
      insert(p) { st.op = 'insert'; st.payload = p; return b; },
      update(p) { st.op = 'update'; st.payload = p; return b; },
      select() { return b; }, order() { return b; }, limit() { return b; },
      eq(k, v) { st.filters.push([k, v]); return b; },
      is(k) { st.isNull.push(k); return b; },
      gt(k, v) { st.gt = [k, v]; return b; },
      range(a, z) { st.range = [a, z]; return b; },
      maybeSingle() { st.single = true; return b; }, single() { st.single = true; return b; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    const match = (r) => st.filters.every(([k, v]) => r[k] === v) && st.isNull.every((k) => r[k] == null);
    function run() {
      const tbl = T(table);
      if (st.op === 'insert') {
        const r = { ...st.payload };
        if (tbl.has(r.id)) return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint "${table}_pkey"` } };
        const row = { ...r, updated_at: tick(), row_version: 1 };
        tbl.set(r.id ?? freshId(), row);
        return { data: { ...row }, error: null };
      }
      if (st.op === 'update') {
        const out = [];
        for (const row of tbl.values()) { if (!match(row)) continue; Object.assign(row, st.payload, { updated_at: tick(), row_version: row.row_version + 1 }); out.push({ ...row }); }
        return { data: out, error: null };
      }
      let rows = [...tbl.values()].filter(match);
      if (st.gt) rows = rows.filter((r) => r[st.gt[0]] > st.gt[1]);
      rows.sort((a, c) => (a.updated_at < c.updated_at ? -1 : 1));
      if (st.range) rows = rows.slice(st.range[0], st.range[1] + 1);
      if (st.single) return { data: rows[0] ? { ...rows[0] } : null, error: null };
      return { data: rows.map((r) => ({ ...r })), error: null };
    }
    return b;
  }

  const client = {
    auth: {
      getSession: async () => ({ data: { session } }),
      signInWithPassword: async ({ email }) => {
        session = { user: { id: ADMIN, email } };
        localStorage.setItem('demo_session', JSON.stringify(session));
        listeners.forEach((f) => f('SIGNED_IN', session));
        return { data: { user: session.user, session }, error: null };
      },
      signOut: async () => { session = null; localStorage.removeItem('demo_session'); listeners.forEach((f) => f('SIGNED_OUT', null)); return { error: null }; },
      onAuthStateChange: (f) => { listeners.add(f); return { data: { subscription: { unsubscribe: () => listeners.delete(f) } } }; },
    },
    rpc: async (name, args) => {
      if (name === 'register_device') { if (!devices.has(args.p_id)) devices.set(args.p_id, devices.size + 1); return { data: devices.get(args.p_id), error: null }; }
      if (name === 'device_max_numbers') return { data: {}, error: null };
      // read-only portal functions (same shape as the SQL versions)
      const lab = () => ({ ...T('lab_settings').get(1), pathologists: [...T('pathologists').values()] });
      const caseOf = (a, show) => {
        const tests = [...T('accession_tests').values()].filter((t) => t.accession_id === a.id && t.status !== 'cancelled');
        const d = a.doctor_id ? T('ref_doctors').get(a.doctor_id) : null;
        return { ...a, doctor: d?.full_name || a.doctor_text, tests: tests.map((t) => ({ ...t, results: show && t.status === 'verified' ? t.results : null, amended: t.amend_count > 0 })),
          commission: tests.reduce((x, t) => x + Number(t.commission || 0), 0) };
      };
      if (name === 'portal_patient') {
        const p = [...T('patients').values()].find((x) => x.portal_token === args.p_token);
        if (!p || p.portal_pin !== args.p_pin) return { data: { error: 'invalid' }, error: null };
        const cases = [...T('accessions').values()].filter((a) => a.patient_id === p.id && !a.deleted_at).map((a) => caseOf(a, true));
        return { data: { lab: lab(), patient: p, cases }, error: null };
      }
      if (name === 'portal_doctor') {
        const d = [...T('ref_doctors').values()].find((x) => x.portal_token === args.p_token);
        if (!d || d.portal_pin !== args.p_pin) return { data: { error: 'invalid' }, error: null };
        const cases = [...T('accessions').values()].filter((a) => a.doctor_id === d.id && !a.deleted_at && a.reg_date >= args.p_from && a.reg_date <= args.p_to)
          .map((a) => ({ ...caseOf(a, true), patient: T('patients').get(a.patient_id) }));
        const earned = cases.reduce((x, c) => x + c.commission, 0);
        return { data: { lab: lab(), doctor: d, from: args.p_from, to: args.p_to, cases, account: { earned_all_time: earned, paid_all_time: 0, balance: earned, payouts: [] } }, error: null };
      }
      if (name === 'verify_report') {
        const a = [...T('accessions').values()].find((x) => x.verify_code === args.p_code);
        if (!a) return { data: { valid: false }, error: null };
        const p = T('patients').get(a.patient_id);
        return { data: { valid: true, lab_name: T('lab_settings').get(1).lab_name, acc_number: a.acc_number, reg_date: a.reg_date, patient: p.full_name.split(' ').map((w) => w[0] + '***').join(' '), mr_number: p.mr_number,
          tests: [...T('accession_tests').values()].filter((t) => t.accession_id === a.id && t.status === 'verified').map((t) => ({ name: t.test_name, verified_at: t.verified_at })) }, error: null };
      }
      return { data: { error: 'invalid' }, error: null };
    },
    from: (table) => builder(table),
  };
  return client;
}

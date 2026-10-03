// Runs final_supabase.sql on a real PostgreSQL (PGlite) with a small stub of
// Supabase's auth schema, twice (idempotent), on top of the OLD clinic schema
// (upgrade path), then checks the business rules.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const NEW = readFileSync(new URL('../../final_supabase.sql', import.meta.url), 'utf8');
let OLD = '';
try { OLD = execSync('git show HEAD~0:final_supabase.sql 2>/dev/null || true', { cwd: new URL('../..', import.meta.url).pathname }).toString(); } catch { /* none */ }
const ORIGINAL = process.env.OLD_SQL ? readFileSync(process.env.OLD_SQL, 'utf8') : OLD;

const STUB = `
create role anon nologin; create role authenticated nologin;
create schema auth;
create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
`;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };

async function asUser(db, uid, fn) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false);`);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`); }
}
async function blocked(db, uid, sql, label) {
  try { await asUser(db, uid, () => db.exec(sql)); ok(false, 'should be blocked: ' + label); }
  catch { ok(true); }
}

async function main(withOld) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(STUB);
  if (withOld && ORIGINAL) {
    await db.exec(ORIGINAL.replace(/create extension if not exists pg_cron;/g, 'select 1;'));
    // some old data: a patient + lab order + invoice + payment
    await db.exec(`
      insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000aa', 'old@x.pk');
      insert into public.devices (id) values ('00000000-0000-0000-0000-0000000000d1');
      insert into public.patients (id, mr_number, full_name, gender) values ('00000000-0000-0000-0000-000000000011','MR1-00001','Old Patient','male');
      insert into public.lab_orders (id, order_number, patient_id, source, referred_by) values ('00000000-0000-0000-0000-000000000021','LO1-00001','00000000-0000-0000-0000-000000000011','lab','Dr Old');
      update public.lab_tests set price = 500 where code = 'CBC';
      insert into public.lab_order_items (order_id, test_id, test_name, price, status)
        select '00000000-0000-0000-0000-000000000021', id, name, 500, 'ordered' from public.lab_tests where code = 'CBC';
      insert into public.invoices (id, invoice_number, patient_id, lab_order_id, category) values ('00000000-0000-0000-0000-000000000031','INV1-00001','00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000021','lab');
      insert into public.invoice_items (invoice_id, description, unit_price) values ('00000000-0000-0000-0000-000000000031','CBC',500);
      insert into public.payments (payment_number, invoice_id, patient_id, amount, method) values ('PAY1-00001','00000000-0000-0000-0000-000000000031','00000000-0000-0000-0000-000000000011',300,'cash');
    `);
  }
  await db.exec(NEW);
  await db.exec(NEW); // second run must be clean
  ok(true);

  const one = async (sql) => (await db.query(sql)).rows[0];
  const tests = await one(`select count(*)::int n from lab_tests where kind = 'test'`);
  ok(tests.n >= 150, 'catalogue has 150+ tests, got ' + tests.n);
  const pk = await one(`select jsonb_array_length(components) n from lab_tests where code = 'PKG-FULL'`);
  ok(pk.n === 11, 'full body package has 11 components, got ' + pk?.n);
  const calc = await one(`select count(*)::int n from lab_parameters where result_type = 'calculated'`);
  ok(calc.n >= 15, 'calculated parameters seeded');
  const ab = await one(`select count(*)::int n from antibiotics`);
  ok(ab.n >= 40, 'antibiotics seeded');

  if (withOld) {
    const acc = await one(`select a.acc_number, public.acc_total(a.id) tot, public.acc_paid(a.id) paid, a.doctor_text,
                           (select status from accession_tests where accession_id = a.id) st
                           from accessions a where acc_number = 'LO1-00001'`);
    ok(acc && Number(acc.tot) === 500 && Number(acc.paid) === 300 && acc.st === 'pending' && acc.doctor_text === 'Dr Old',
      'old order migrated: ' + JSON.stringify(acc));
  }

  // users: first = admin active, second = reception inactive
  const A = '00000000-0000-0000-0000-00000000a001', B = '00000000-0000-0000-0000-00000000b002';
  await db.exec(`delete from public.profiles; insert into auth.users (id, email) values ('${A}','admin@lab.pk'),('${B}','rec@lab.pk')
                 on conflict do nothing;`);
  // trigger ran on insert; if old data existed the old admin may exist: make A admin explicitly for the checks
  await db.exec(`insert into public.profiles (id, email, role, active) values ('${A}','admin@lab.pk','admin',true)
                 on conflict (id) do update set role='admin', active=true;
                 insert into public.profiles (id, email, role, active) values ('${B}','rec@lab.pk','reception',false)
                 on conflict (id) do update set role='reception', active=false;`);

  // inactive user can't read patients
  const r0 = await asUser(db, B, () => db.query('select count(*)::int n from patients'));
  ok(r0.rows[0].n === 0, 'inactive user sees no patients');

  await db.exec(`update public.profiles set active = true where id = '${B}'`);
  const P = '00000000-0000-0000-0000-0000000000p1'.replace('p', 'e'), ACC = '00000000-0000-0000-0000-0000000000c1';
  const D = '00000000-0000-0000-0000-0000000000d9';
  await asUser(db, A, () => db.exec(`
    update lab_tests set price = 1000 where code = 'CBC';
    update lab_tests set price = 500 where code = 'ESR';
    insert into ref_doctors (id, full_name, rate_type, rate_value, portal_enabled, portal_token, portal_pin)
      values ('${D}', 'Dr Ahmed', 'percent', 30, true, 'doctortoken123456789', '1234');
  `));
  await asUser(db, B, () => db.exec(`
    insert into patients (id, mr_number, full_name, gender, portal_token, portal_pin) values ('${P}', 'MR9-00001', 'Ali Khan', 'male', 'patienttoken12345678', '5555');
    insert into accessions (id, acc_number, patient_id, doctor_id, verify_code, discount) values ('${ACC}', 'L9-00001', '${P}', '${D}', 'abc123', 100);
    insert into accession_tests (accession_id, test_id, test_name, price, commission)
      select '${ACC}', id, name, price, price * 0.3 from lab_tests where code in ('CBC','ESR');
  `));
  const tot = await one(`select public.acc_total('${ACC}') t`);
  ok(Number(tot.t) === 1400, 'bill total = 1000 + 500 − 100 = 1400, got ' + tot.t);
  const pid = await one(`select count(*)::int n from accession_tests where accession_id = '${ACC}' and patient_id = '${P}'`);
  ok(pid.n === 2, 'tests get the patient id automatically');

  await asUser(db, B, () => db.exec(`update lab_tests set price = 1 where code = 'CBC'; update lab_settings set lab_name = 'hacked' where id = 1;`));
  const pr = await one(`select price from lab_tests where code = 'CBC'`);
  ok(Number(pr.price) === 1000, 'price unchanged after blocked update');
  ok((await one(`select lab_name from lab_settings`)).lab_name !== 'hacked', 'reception cannot change settings');

  // payments: cannot overpay
  await asUser(db, B, () => db.exec(`insert into bill_payments (payment_number, accession_id, amount, method) values ('R9-00001', '${ACC}', 1000, 'cash')`));
  await blocked(db, B, `insert into bill_payments (payment_number, accession_id, amount, method) values ('R9-00002', '${ACC}', 500, 'cash')`, 'overpayment');
  await asUser(db, B, () => db.exec(`insert into bill_payments (payment_number, accession_id, amount, method) values ('R9-00003', '${ACC}', 400, 'cash')`));
  ok(Number((await one(`select public.acc_paid('${ACC}') p`)).p) === 1400, 'fully paid');

  // no hard delete
  await blocked(db, A, `delete from bill_payments where payment_number = 'R9-00001'`, 'hard delete of a payment');
  await blocked(db, A, `delete from patients where id = '${P}'`, 'hard delete of a patient');

  // verified lock
  await asUser(db, B, () => db.exec(`update accession_tests set status = 'verified', results = '[{"name":"Hb","value":"13"}]' where accession_id = '${ACC}' and test_name like 'Complete%'`));
  await blocked(db, B, `update accession_tests set results = '[{"name":"Hb","value":"9"}]' where accession_id = '${ACC}' and test_name like 'Complete%'`, 'changing a verified result');
  await asUser(db, B, () => db.exec(`update accession_tests set results = '[{"name":"Hb","value":"12.5"}]', amend_count = amend_count + 1 where accession_id = '${ACC}' and test_name like 'Complete%'`));
  ok((await one(`select results->0->>'value' v from accession_tests where accession_id = '${ACC}' and test_name like 'Complete%'`)).v === '12.5', 'amendment allowed');

  // audit
  ok((await one(`select count(*)::int n from audit_log where table_name = 'accession_tests'`)).n >= 3, 'audit log written');

  // portals (anon)
  await db.exec(`set role anon`);
  const pp = (await db.query(`select public.portal_patient('patienttoken12345678', '5555') j`)).rows[0].j;
  ok(pp.patient?.full_name === 'Ali Khan' && pp.cases.length === 1, 'patient portal works');
  const cbc = pp.cases[0].tests.find((t) => t.test_name.startsWith('Complete'));
  ok(cbc?.results?.[0]?.value === '12.5', 'portal shows verified result');
  const esr = pp.cases[0].tests.find((t) => t.test_name.startsWith('ESR'));
  ok(esr && esr.results === null, 'portal hides unverified result');
  const bad = (await db.query(`select public.portal_patient('patienttoken12345678', '0000') j`)).rows[0].j;
  ok(bad.error === 'invalid', 'wrong PIN rejected');
  const dp = (await db.query(`select public.portal_doctor('doctortoken123456789', '1234', current_date - 30, current_date) j`)).rows[0].j;
  ok(dp.cases?.length === 1 && Number(dp.account.earned_all_time) === 450, 'doctor portal + commission: ' + JSON.stringify(dp.account));
  const vr = (await db.query(`select public.verify_report('abc123') j`)).rows[0].j;
  ok(vr.valid && vr.patient === 'A*** K***' && vr.tests.length === 1, 'report verification masks name: ' + JSON.stringify(vr));
  let anonBlocked = false;
  try { await db.query('select * from patients'); } catch { anonBlocked = true; }
  ok(anonBlocked, 'anon cannot read tables');
  await db.exec('reset role');

  // deleted accession leaves portal + doctor account
  await asUser(db, B, () => db.exec(`update accessions set deleted_at = now(), delete_reason = 'test' where id = '${ACC}'`));
  await db.exec(`set role anon`);
  const dp2 = (await db.query(`select public.portal_doctor('doctortoken123456789', '1234', current_date - 30, current_date) j`)).rows[0].j;
  ok(dp2.cases.length === 0 && Number(dp2.account.earned_all_time) === 0, 'deleted case removed from doctor account');
  await db.exec('reset role');
  await db.close();
}

await main(false);
console.log('fresh database: done');
await main(true);
console.log('upgrade from old version: done');
console.log(`${pass} checks passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

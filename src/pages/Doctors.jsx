import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db.js';
import * as A from '../lib/actions.js';
import { insertRow, updateRow } from '../lib/repo.js';
import { byDoctor, doctorLedger, loadCases } from '../lib/reports.js';
import { useAuth } from '../lib/auth.jsx';
import { useDepartments, useDoctors, useSettings, useTests } from '../lib/hooks.js';
import { methodLabel, PAYMENT_METHODS } from '../lib/pricing.js';
import { csvDownload, fmtDate, todayISO, waNumber } from '../lib/format.js';
import { ConfirmButton, DeleteButton, Empty, Field, Figures, Modal, Money, Tabs, useAction, useMoney } from '../components/ui.jsx';
import { PeriodPicker, usePeriod } from '../components/period.jsx';
import { Bars } from '../components/charts.jsx';

export function doctorPortalLink(settings, d) {
  const base = (settings?.public_url || location.origin).replace(/\/$/, '');
  return d?.portal_token ? `${base}/d/${d.portal_token}` : '';
}

export default function Doctors() {
  const period = usePeriod('month');
  const doctors = useDoctors(true).filter((d) => !d.deleted_at);
  const { isAdmin, can } = useAuth();
  const m = useMoney();
  const nav = useNavigate();
  const [edit, setEdit] = useState(null);
  const [q, setQ] = useState('');
  const rows = useLiveQuery(async () => byDoctor(await loadCases(period.from, period.to)), [period.from, period.to], []);
  const balances = useLiveQuery(async () => {
    const out = {};
    for (const d of await db().ref_doctors.toArray()) out[d.id] = (await doctorLedger(d.id, period.from, period.to)).balance;
    return out;
  }, [period.from, period.to, doctors.length], {});
  const manage = isAdmin || can('doctors');
  const byId = Object.fromEntries(rows.filter((r) => r.doctor_id).map((r) => [r.doctor_id, r]));
  const list = doctors.filter((d) => !q || d.full_name.toLowerCase().includes(q.toLowerCase()) || (d.hospital || '').toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (byId[b.id]?.revenue || 0) - (byId[a.id]?.revenue || 0) || a.full_name.localeCompare(b.full_name));
  const others = rows.filter((r) => !r.doctor_id);
  const tot = rows.reduce((s, r) => ({ cases: s.cases + r.cases, revenue: s.revenue + r.revenue, commission: s.commission + r.commission }), { cases: 0, revenue: 0, commission: 0 });

  return (
    <>
      <div className="page-head">
        <div><h1>Doctors and commission</h1><div className="sub">Every doctor's patients, tests and commission are kept separately.</div></div>
        <div className="grow" />
        {manage && <button className="btn primary" onClick={() => setEdit({ rate_type: 'percent', rate_value: 0, active: true })}>Add doctor</button>}
      </div>
      <div className="panel"><PeriodPicker period={period} /></div>
      <Figures items={[
        { label: `Referred cases · ${period.label}`, value: rows.filter((r) => r.doctor_id).reduce((s, r) => s + r.cases, 0), hint: `of ${tot.cases} total` },
        { label: 'Revenue from referrals', value: m(rows.filter((r) => r.doctor_id).reduce((s, r) => s + r.revenue, 0)) },
        { label: 'Commission earned', value: m(tot.commission) },
        { label: 'Commission still to pay (all time)', value: m(Object.values(balances).reduce((s, v) => s + v, 0)), tone: 'warn' },
      ]} />
      <div className="panel flush">
        <div className="panel-head"><h2>Doctors</h2><div className="grow" />
          <input style={{ maxWidth: 240 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find doctor" />
          <button className="btn small" onClick={() => csvDownload(`doctors-${period.from}-${period.to}.csv`, [
            ['Doctor', 'Patients', 'Cases', 'Tests', 'Revenue', 'Commission', 'Balance to pay'],
            ...list.map((d) => [d.full_name, byId[d.id]?.patients || 0, byId[d.id]?.cases || 0, byId[d.id]?.tests || 0, byId[d.id]?.revenue || 0, byId[d.id]?.commission || 0, balances[d.id] || 0])])}>Export</button>
        </div>
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>Doctor</th><th>Rate</th><th className="r">Patients</th><th className="r">Tests</th><th className="r">Revenue</th><th className="r">Commission</th><th className="r">To pay (all time)</th></tr></thead>
            <tbody>
              {list.map((d) => {
                const r = byId[d.id];
                return (
                  <tr key={d.id} className="click" onClick={() => nav(`/doctors/${d.id}?${new URLSearchParams(location.search)}`)}>
                    <td><b>{d.full_name}</b>{d.active === false && <span className="badge" style={{ marginLeft: 6 }}>Inactive</span>}<div className="faint">{[d.qualification, d.hospital, d.phone].filter(Boolean).join(' · ')}</div></td>
                    <td className="faint">{d.rate_type === 'fixed' ? `Rs ${d.rate_value}/test` : `${d.rate_value}%`}</td>
                    <td className="r">{r?.patients || 0}</td><td className="r">{r?.tests || 0}</td>
                    <td className="r"><Money v={r?.revenue || 0} /></td><td className="r"><Money v={r?.commission || 0} /></td>
                    <td className="r"><b><Money v={balances[d.id] || 0} /></b></td>
                  </tr>
                );
              })}
              {others.map((r) => (
                <tr key={r.key} className="muted-row" style={{ textDecoration: 'none' }}>
                  <td style={{ textDecoration: 'none' }}>{r.name} <span className="faint">(no commission)</span></td><td />
                  <td className="r">{r.patients}</td><td className="r">{r.tests}</td><td className="r"><Money v={r.revenue} /></td><td /><td />
                </tr>
              ))}
            </tbody>
          </table>
          {!list.length && <Empty><b>No doctors yet.</b>Add the doctors who send you patients, with their commission.</Empty>}
        </div>
      </div>
      {edit && <DoctorModal d={edit} onClose={() => setEdit(null)} />}
    </>
  );
}

export function DoctorModal({ d, onClose }) {
  const [f, setF] = useState({ full_name: '', qualification: '', hospital: '', phone: '', notes: '', rate_type: 'percent', rate_value: 0, active: true, portal_show_commission: true, ...d });
  const run = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const fields = ['full_name', 'qualification', 'hospital', 'phone', 'notes', 'rate_type', 'rate_value', 'active', 'portal_show_commission'];
  const out = Object.fromEntries(fields.map((k) => [k, k === 'rate_value' ? Number(f[k] || 0) : f[k] === '' ? null : f[k]]));
  return (
    <Modal wide title={d.id ? `Edit ${d.full_name}` : 'Add doctor'} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={!f.full_name?.trim()} onClick={async () => {
        const ok = await run(async () => {
          const row = d.id ? await updateRow('ref_doctors', d.id, out) : await insertRow('ref_doctors', out);
          // re-calculate commission of this doctor's cases when the rate changed
          if (d.id && (Number(d.rate_value) !== out.rate_value || d.rate_type !== out.rate_type)) {
            for (const a of await db().accessions.where('doctor_id').equals(d.id).toArray()) await A.recompute(a.id);
          }
          return row;
        }, 'Doctor saved');
        if (ok) onClose();
      }}>Save</button>
    </>}>
      <div className="grid2">
        <Field label="Name" required><input autoFocus value={f.full_name || ''} onChange={set('full_name')} /></Field>
        <Field label="Phone / WhatsApp"><input value={f.phone || ''} onChange={set('phone')} /></Field>
        <Field label="Qualification"><input value={f.qualification || ''} onChange={set('qualification')} /></Field>
        <Field label="Hospital / clinic"><input value={f.hospital || ''} onChange={set('hospital')} /></Field>
        <Field label="Normal commission (all tests)" hint="Department or single-test rates override this — set them on the doctor's page.">
          <div className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
            <input type="number" min="0" value={f.rate_value} onChange={set('rate_value')} />
            <div className="seg"><button type="button" className={f.rate_type === 'percent' ? 'on' : ''} onClick={() => setF({ ...f, rate_type: 'percent' })}>%</button><button type="button" className={f.rate_type === 'fixed' ? 'on' : ''} onClick={() => setF({ ...f, rate_type: 'fixed' })}>Rs per test</button></div>
          </div>
        </Field>
        <Field label="Notes"><input value={f.notes || ''} onChange={set('notes')} /></Field>
        <label className="check"><input type="checkbox" checked={f.active !== false} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active (shows in the doctor list)</label>
      </div>
      {d.id && <p className="faint">Changing the rate re-calculates this doctor's commission on all their cases.</p>}
    </Modal>
  );
}

export function DoctorPage() {
  const { id } = useParams();
  const period = usePeriod('month');
  const settings = useSettings();
  const doctor = useLiveQuery(() => db().ref_doctors.get(id), [id]);
  const led = useLiveQuery(() => doctorLedger(id, period.from, period.to), [id, period.from, period.to], null);
  const rules = useLiveQuery(() => db().commission_rules.where('doctor_id').equals(id).toArray(), [id], []);
  const { isAdmin, can } = useAuth();
  const manage = isAdmin || can('doctors');
  const run = useAction();
  const m = useMoney();
  const nav = useNavigate();
  const [tab, setTab] = useState('patients');
  const [pay, setPay] = useState(false);
  const [edit, setEdit] = useState(false);
  if (!doctor || !led) return null;
  const link = doctorPortalLink(settings, doctor);
  const qs = `from=${period.from}&to=${period.to}`;

  function sendStatement() {
    const t = `Assalam o Alaikum ${doctor.full_name},\n${settings?.lab_name || 'Lab'} — statement ${fmtDate(period.from)} to ${fmtDate(period.to)}\nPatients: ${led.patients} · Tests: ${led.testCount}\nCommission: ${m(led.earned)}\nPaid: ${m(led.paid)}\nBalance: ${m(led.balance)}${doctor.portal_enabled && link ? `\nFull details: ${link} (PIN ${doctor.portal_pin})` : ''}`;
    window.open(`https://wa.me/${waNumber(doctor.phone, settings?.phone_country_code || '92')}?text=${encodeURIComponent(t)}`, '_blank', 'noopener');
  }

  return (
    <>
      {doctor.deleted_at && <div className="note bad" style={{ marginBottom: 12 }}>This doctor is in the Recycle Bin. <button className="btn small" onClick={() => run(() => A.restore('ref_doctors', doctor), 'Restored')}>Restore</button></div>}
      <div className="page-head">
        <div>
          <h1>{doctor.full_name}</h1>
          <div className="sub">{[doctor.qualification, doctor.hospital, doctor.phone].filter(Boolean).join(' · ')} · normal rate {doctor.rate_type === 'fixed' ? `Rs ${doctor.rate_value}/test` : `${doctor.rate_value}%`}</div>
        </div>
        <div className="grow" />
        <div className="row">
          {manage && <button className="btn primary" onClick={() => setPay(true)}>Pay commission</button>}
          <Link className="btn" to={`/print/doctor/${id}?${qs}`}>Print statement</Link>
          {doctor.phone && <button className="btn" onClick={sendStatement}>WhatsApp statement</button>}
          {manage && <button className="btn" onClick={() => setEdit(true)}>Edit</button>}
        </div>
      </div>
      <div className="panel"><PeriodPicker period={period} /></div>
      <Figures items={[
        { label: 'Patients', value: led.patients, hint: `${led.caseCount} visits · ${led.testCount} tests` },
        { label: 'Revenue', value: m(led.revenue) },
        { label: 'Commission earned', value: m(led.earned), hint: led.pending ? `${m(led.pending)} waiting for payment` : null },
        { label: 'Paid to doctor', value: m(led.paid) },
        { label: 'Balance to pay (all time)', value: m(led.balance), tone: led.balance > 0 ? 'warn' : 'good' },
      ]} />
      <Tabs value={tab} onChange={setTab} tabs={[['patients', 'Patients and tests'], ['payouts', 'Payments to doctor'], ['summary', 'By department / test'], ['rates', 'Commission rates'], ['portal', 'Doctor portal']]} />

      {tab === 'patients' && (
        <div className="panel flush">
          <div className="panel-head"><h2>{led.lines.length} test(s) in {period.label.toLowerCase()}</h2><div className="grow" />
            <button className="btn small" onClick={() => csvDownload(`${doctor.full_name}-${period.from}-${period.to}.csv`, [['Date', 'Case', 'Patient', 'MR', 'Test', 'Price', 'Rate', 'Commission'], ...led.lines.map((l) => [l.date, l.acc_number, l.patient, l.mr, l.test, l.price, l.rate, l.commission || l.pending])])}>Export</button></div>
          <div className="table-wrap">
            <table className="t compact">
              <thead><tr><th>Date</th><th>Patient</th><th>Test</th><th className="r">Price</th><th>Rate</th><th className="r">Commission</th></tr></thead>
              <tbody>
                {led.lines.map((l, i) => (
                  <tr key={i} className="click" onClick={() => nav(`/cases/${l.accession_id}`)}>
                    <td className="nowrap">{fmtDate(l.date)}</td>
                    <td>{l.patient} <span className="faint">{l.acc_number}</span></td>
                    <td>{l.test}</td><td className="r"><Money v={l.price} /></td><td className="faint">{l.rate}</td>
                    <td className="r">{l.pending ? <span className="faint" title="Counts when the bill is paid"><Money v={l.pending} /> (unpaid)</span> : <Money v={l.commission} />}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><td colSpan={5}>Total</td><td className="r"><Money v={led.earned} /></td></tr></tfoot>
            </table>
            {!led.lines.length && <Empty>No patients from this doctor in this period.</Empty>}
          </div>
        </div>
      )}

      {tab === 'payouts' && (
        <div className="panel flush">
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Date</th><th>No.</th><th>Method</th><th>Note</th><th className="r">Amount</th><th /></tr></thead>
              <tbody>
                {led.allPayouts.sort((a, b) => b.paid_on.localeCompare(a.paid_on)).map((p) => (
                  <tr key={p.id}>
                    <td>{fmtDate(p.paid_on)}</td><td>{p.payout_number}</td><td>{methodLabel(p.method)}{p.reference ? ` · ${p.reference}` : ''}</td><td className="faint">{p.note}</td>
                    <td className="r"><Money v={p.amount} /></td>
                    <td className="right">{manage && <DeleteButton className="btn small ghost danger" title="Delete payment to doctor" message={`Delete ${p.payout_number} (${m(p.amount)})? The doctor's balance goes up again.`}
                      onConfirm={(r) => run(() => A.softDelete('doctor_payouts', p, r), 'Deleted').then((x) => x !== undefined)} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!led.allPayouts.length && <Empty>No commission paid yet.</Empty>}
          </div>
        </div>
      )}

      {tab === 'summary' && (
        <div className="grid2">
          <div className="panel"><h2>By department</h2><Bars rows={led.byDepartment} label={(r) => r.department} value={(r) => r.amount} fmt={m} /></div>
          <div className="panel"><h2>Top tests</h2><Bars rows={led.byTest.slice(0, 12)} label={(r) => r.name} value={(r) => r.count} /></div>
        </div>
      )}

      {tab === 'rates' && <RatesEditor doctor={doctor} rules={rules} manage={manage} />}

      {tab === 'portal' && (
        <div className="panel">
          <h2>Doctor portal</h2>
          <p className="muted">The doctor opens the link on his phone and types the PIN. He sees only the patients he sent, their reports{doctor.portal_show_commission ? ' and his commission account' : ''}. He cannot change anything.</p>
          {!doctor.portal_enabled ? (manage && <button className="btn primary" onClick={() => run(() => A.ensureDoctorPortal(doctor), 'Portal turned on')}>Turn on portal for this doctor</button>) : (
            <div className="stack" style={{ maxWidth: 560 }}>
              <input readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Doctor link" />
              <div className="row">PIN: <b>{doctor.portal_pin}</b><span className="spacer" />
                {manage && <button className="btn small" onClick={() => run(() => A.resetDoctorPin(doctor), 'New PIN made')}>New PIN</button>}</div>
              <label className="check"><input type="checkbox" checked={doctor.portal_show_commission !== false} disabled={!manage}
                onChange={(e) => run(() => updateRow('ref_doctors', doctor.id, { portal_show_commission: e.target.checked }))} /> Show his commission and balance in the portal</label>
              <div className="row">
                {doctor.phone && <button className="btn" onClick={() => {
                  const t = `Assalam o Alaikum ${doctor.full_name},\nYour patients' reports and account at ${settings?.lab_name || 'our lab'}:\n${link}\nPIN: ${doctor.portal_pin}`;
                  window.open(`https://wa.me/${waNumber(doctor.phone, settings?.phone_country_code || '92')}?text=${encodeURIComponent(t)}`, '_blank', 'noopener');
                }}>Send on WhatsApp</button>}
                {manage && <button className="btn danger" onClick={() => run(() => updateRow('ref_doctors', doctor.id, { portal_enabled: false }), 'Portal turned off')}>Turn off</button>}
              </div>
            </div>
          )}
        </div>
      )}

      {manage && !doctor.deleted_at && (
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
          <DeleteButton label="Delete doctor" className="btn danger" title={`Delete ${doctor.full_name}`}
            message="The doctor is removed from the lists. Old cases keep his name and commission." onConfirm={async (r) => { const ok = await run(() => A.softDelete('ref_doctors', doctor, r), 'Doctor deleted'); if (ok) nav('/doctors'); return !!ok; }} />
        </div>
      )}
      {pay && <PayoutModal doctor={doctor} balance={led.balance} onClose={() => setPay(false)} />}
      {edit && <DoctorModal d={doctor} onClose={() => setEdit(false)} />}
    </>
  );
}

function RatesEditor({ doctor, rules, manage }) {
  const depts = useDepartments().filter((d) => d !== 'Packages');
  const tests = useTests().filter((t) => t.kind !== 'package');
  const run = useAction();
  const [f, setF] = useState({ scope: 'department', department: depts[0] || '', test_id: '', rate_type: 'percent', rate_value: '' });
  const live = rules.filter((r) => r.active !== false);
  async function recalcAll() {
    for (const a of await db().accessions.where('doctor_id').equals(doctor.id).toArray()) await A.recompute(a.id);
  }
  return (
    <div className="panel">
      <h2>Commission rates</h2>
      <p className="muted">Normal rate: <b>{doctor.rate_type === 'fixed' ? `Rs ${doctor.rate_value} per test` : `${doctor.rate_value}%`}</b>. A single-test rate wins over a department rate, which wins over the normal rate.</p>
      <table className="t compact"><tbody>
        {live.map((r) => (
          <tr key={r.id}>
            <td>{r.scope === 'department' ? <>Department: <b>{r.department}</b></> : <>Test: <b>{tests.find((t) => t.id === r.test_id)?.name || 'Test'}</b></>}</td>
            <td>{r.rate_type === 'fixed' ? `Rs ${r.rate_value} per test` : `${r.rate_value}%`}</td>
            <td className="right">{manage && <ConfirmButton label="Remove" className="btn small ghost" title="Remove rate" message="Commission on this doctor's cases is re-calculated." confirmLabel="Remove"
              onConfirm={() => run(async () => { await updateRow('commission_rules', r.id, { active: false }); await recalcAll(); }, 'Rate removed')} />}</td>
          </tr>
        ))}
      </tbody></table>
      {!live.length && <p className="faint">No special rates.</p>}
      {manage && (
        <div className="grid4" style={{ marginTop: 12, alignItems: 'end' }}>
          <Field label="For"><select value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })}><option value="department">A department</option><option value="test">One test</option></select></Field>
          {f.scope === 'department'
            ? <Field label="Department"><select value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })}>{depts.map((d) => <option key={d}>{d}</option>)}</select></Field>
            : <Field label="Test"><select value={f.test_id} onChange={(e) => setF({ ...f, test_id: e.target.value })}><option value="">Choose…</option>{tests.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>}
          <Field label="Rate">
            <div className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
              <input type="number" min="0" value={f.rate_value} onChange={(e) => setF({ ...f, rate_value: e.target.value })} />
              <div className="seg"><button type="button" className={f.rate_type === 'percent' ? 'on' : ''} onClick={() => setF({ ...f, rate_type: 'percent' })}>%</button><button type="button" className={f.rate_type === 'fixed' ? 'on' : ''} onClick={() => setF({ ...f, rate_type: 'fixed' })}>Rs</button></div>
            </div>
          </Field>
          <button className="btn primary" disabled={f.rate_value === '' || (f.scope === 'test' && !f.test_id)} onClick={() => run(async () => {
            // one active rule per department/test
            for (const r of live.filter((x) => x.scope === f.scope && (f.scope === 'department' ? x.department === f.department : x.test_id === f.test_id))) await updateRow('commission_rules', r.id, { active: false });
            await insertRow('commission_rules', { doctor_id: doctor.id, scope: f.scope, department: f.scope === 'department' ? f.department : null, test_id: f.scope === 'test' ? f.test_id : null, rate_type: f.rate_type, rate_value: Number(f.rate_value), active: true });
            await recalcAll();
            setF({ ...f, rate_value: '' });
          }, 'Rate saved — commission re-calculated')}>Add rate</button>
        </div>
      )}
    </div>
  );
}

function PayoutModal({ doctor, balance, onClose }) {
  const [f, setF] = useState({ amount: balance > 0 ? String(balance) : '', method: 'cash', paid_on: todayISO(), reference: '', note: '' });
  const run = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title={`Pay ${doctor.full_name}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" onClick={async () => { const ok = await run(() => A.addPayout(doctor.id, f), 'Payment to doctor saved'); if (ok) onClose(); }}>Save payment</button>
    </>}>
      <p className="muted" style={{ marginTop: 0 }}>Balance to pay: <b><Money v={balance} /></b></p>
      <div className="grid2">
        <Field label="Amount" required><input autoFocus type="number" value={f.amount} onChange={set('amount')} /></Field>
        <Field label="Date"><input type="date" value={f.paid_on} onChange={set('paid_on')} /></Field>
        <Field label="Method"><select value={f.method} onChange={set('method')}>{PAYMENT_METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Reference"><input value={f.reference} onChange={set('reference')} /></Field>
        <div className="span2"><Field label="Note"><input value={f.note} onChange={set('note')} placeholder="e.g. September commission" /></Field></div>
      </div>
    </Modal>
  );
}

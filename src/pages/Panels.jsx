import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db.js';
import * as A from '../lib/actions.js';
import { insertRow, updateRow } from '../lib/repo.js';
import { panelLedger } from '../lib/reports.js';
import { useAuth } from '../lib/auth.jsx';
import { usePanels, useTests } from '../lib/hooks.js';
import { methodLabel, PAYMENT_METHODS } from '../lib/pricing.js';
import { csvDownload, fmtDate, todayISO } from '../lib/format.js';
import { DeleteButton, DueBadge, Empty, Field, Figures, Modal, Money, Tabs, useAction, useMoney } from '../components/ui.jsx';
import { PeriodPicker, usePeriod } from '../components/period.jsx';

export default function Panels() {
  const panels = usePanels(true);
  const nav = useNavigate();
  const [edit, setEdit] = useState(null);
  const { isAdmin, can } = useAuth();
  const bal = useLiveQuery(async () => {
    const o = {};
    for (const p of await db().panels.toArray()) o[p.id] = (await panelLedger(p.id, todayISO(), todayISO())).balance;
    return o;
  }, [panels.length], {});
  return (
    <>
      <div className="page-head">
        <div><h1>Panels and companies</h1><div className="sub">Companies and insurers with their own rates. Credit bills are collected from the company monthly.</div></div>
        <div className="grow" />
        {(isAdmin || can('panels')) && <button className="btn primary" onClick={() => setEdit({ kind: 'corporate', discount_pct: 0, credit: true, active: true })}>Add panel</button>}
      </div>
      <div className="panel flush">
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>Name</th><th>Type</th><th>Pricing</th><th>Billing</th><th className="r">Company owes</th></tr></thead>
            <tbody>
              {panels.map((p) => (
                <tr key={p.id} className="click" onClick={() => nav(`/panels/${p.id}`)}>
                  <td><b>{p.name}</b>{p.active === false && <span className="badge" style={{ marginLeft: 6 }}>Inactive</span>}<div className="faint">{[p.contact, p.phone].filter(Boolean).join(' · ')}</div></td>
                  <td>{p.kind}</td>
                  <td>{p.discount_pct ? `${p.discount_pct}% off list` : 'List price'} + own rates</td>
                  <td>{p.credit ? <span className="badge blue">Credit (monthly)</span> : 'Patient pays'}</td>
                  <td className="r"><b><Money v={bal[p.id] || 0} /></b></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!panels.length && <Empty><b>No panels yet.</b>Add companies or insurers that send their employees.</Empty>}
        </div>
      </div>
      {edit && <PanelModal p={edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function PanelModal({ p, onClose }) {
  const [f, setF] = useState({ name: '', kind: 'corporate', contact: '', phone: '', discount_pct: 0, credit: true, notes: '', active: true, ...p });
  const run = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const out = { name: f.name.trim(), kind: f.kind, contact: f.contact || null, phone: f.phone || null, discount_pct: Number(f.discount_pct || 0), credit: !!f.credit, notes: f.notes || null, active: f.active !== false };
  return (
    <Modal wide title={p.id ? `Edit ${p.name}` : 'Add panel / company'} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={!f.name.trim()} onClick={async () => { const ok = await run(() => (p.id ? updateRow('panels', p.id, out) : insertRow('panels', out)), 'Saved'); if (ok) onClose(); }}>Save</button>
    </>}>
      <div className="grid2">
        <Field label="Name" required><input autoFocus value={f.name} onChange={set('name')} /></Field>
        <Field label="Type"><select value={f.kind} onChange={set('kind')}><option value="corporate">Company</option><option value="insurance">Insurance</option><option value="other">Other</option></select></Field>
        <Field label="Contact person"><input value={f.contact || ''} onChange={set('contact')} /></Field>
        <Field label="Phone"><input value={f.phone || ''} onChange={set('phone')} /></Field>
        <Field label="Discount on list price (%)" hint="Used for tests without their own panel rate."><input type="number" min="0" max="100" value={f.discount_pct} onChange={set('discount_pct')} /></Field>
        <Field label="Billing"><select value={f.credit ? '1' : ''} onChange={(e) => setF({ ...f, credit: !!e.target.value })}><option value="1">Credit — company pays monthly</option><option value="">Patient pays at the lab</option></select></Field>
        <div className="span2"><Field label="Notes"><input value={f.notes || ''} onChange={set('notes')} /></Field></div>
        <label className="check"><input type="checkbox" checked={f.active !== false} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active</label>
      </div>
    </Modal>
  );
}

export function PanelPage() {
  const { id } = useParams();
  const period = usePeriod('month');
  const panel = useLiveQuery(() => db().panels.get(id), [id]);
  const led = useLiveQuery(() => panelLedger(id, period.from, period.to), [id, period.from, period.to], null);
  const rates = useLiveQuery(() => db().panel_rates.where('panel_id').equals(id).toArray(), [id], []);
  const tests = useTests().filter((t) => t.active !== false);
  const { isAdmin, can } = useAuth();
  const manage = isAdmin || can('panels');
  const run = useAction();
  const m = useMoney();
  const nav = useNavigate();
  const [tab, setTab] = useState('cases');
  const [edit, setEdit] = useState(false);
  const [pay, setPay] = useState(false);
  const [q, setQ] = useState('');
  if (!panel || !led) return null;
  const rateOf = (tid) => rates.find((r) => r.test_id === tid);
  return (
    <>
      <div className="page-head">
        <div><h1>{panel.name}</h1><div className="sub">{panel.credit ? 'Credit — billed monthly' : 'Patient pays'} · {panel.discount_pct}% off list price where no own rate</div></div>
        <div className="grow" />
        {manage && <button className="btn primary" onClick={() => setPay(true)}>Payment received from company</button>}
        <Link className="btn" to={`/print/panel/${id}?from=${period.from}&to=${period.to}`}>Print statement</Link>
        {manage && <button className="btn" onClick={() => setEdit(true)}>Edit</button>}
      </div>
      <div className="panel"><PeriodPicker period={period} /></div>
      <Figures items={[
        { label: 'Patients', value: new Set(led.cases.map((c) => c.patient_id)).size, hint: `${led.cases.length} visits` },
        { label: 'Revenue', value: m(led.revenue) },
        { label: 'Billed to company', value: m(led.billed) },
        { label: 'Company owes (all time)', value: m(led.balance), tone: led.balance > 0 ? 'warn' : 'good' },
      ]} />
      <Tabs value={tab} onChange={setTab} tabs={[['cases', 'Patients'], ['payments', 'Payments received'], ['rates', 'Panel rates']]} />
      {tab === 'cases' && (
        <div className="panel flush"><div className="table-wrap">
          <table className="t compact">
            <thead><tr><th>Date</th><th>Patient</th><th>Tests</th><th className="r">Total</th><th /></tr></thead>
            <tbody>{led.cases.map((c) => <tr key={c.id} className="click" onClick={() => nav(`/cases/${c.id}`)}><td>{fmtDate(c.reg_date)}</td><td>{c.patient?.full_name} <span className="faint">{c.acc_number}</span></td><td className="faint">{c.tests.filter((t) => t.status !== 'cancelled').map((t) => t.test_code).join(', ')}</td><td className="r"><Money v={c.bill.total} /></td><td><DueBadge bill={c.bill} /></td></tr>)}</tbody>
          </table>
          {!led.cases.length && <Empty>No patients from this panel in this period.</Empty>}
        </div></div>
      )}
      {tab === 'payments' && (
        <div className="panel flush"><div className="table-wrap">
          <table className="t"><tbody>
            {led.payments.map((p) => <tr key={p.id}><td>{fmtDate(p.paid_on)}</td><td>{methodLabel(p.method)} {p.reference}</td><td className="faint">{p.note}</td><td className="r"><Money v={p.amount} /></td>
              <td className="right">{manage && <DeleteButton className="btn small ghost danger" title="Delete payment" message="The company's balance goes up again." onConfirm={(r) => run(() => A.softDelete('panel_payments', p, r), 'Deleted').then((x) => x !== undefined)} />}</td></tr>)}
          </tbody></table>
          {!led.payments.length && <Empty>No payments in this period.</Empty>}
        </div></div>
      )}
      {tab === 'rates' && (
        <div className="panel flush">
          <div className="panel-head"><input style={{ maxWidth: 260 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find test" /><div className="grow" />
            <button className="btn small" onClick={() => csvDownload(`${panel.name}-rates.csv`, [['Code', 'Test', 'List price', 'Panel price'], ...tests.map((t) => [t.code, t.name, t.price ?? '', rateOf(t.id)?.price ?? ''])])}>Export</button></div>
          <div className="table-wrap">
            <table className="t compact">
              <thead><tr><th>Test</th><th className="r">List price</th><th className="r">Panel price</th></tr></thead>
              <tbody>
                {tests.filter((t) => !q || t.name.toLowerCase().includes(q.toLowerCase()) || (t.code || '').toLowerCase().includes(q.toLowerCase())).map((t) => {
                  const r = rateOf(t.id);
                  return (
                    <tr key={t.id}><td>{t.name} <span className="faint">{t.code}</span></td><td className="r">{t.price == null ? '—' : <Money v={t.price} />}</td>
                      <td className="r" style={{ width: 160 }}>
                        <input type="number" min="0" disabled={!manage} defaultValue={r?.price ?? ''} placeholder={t.price != null ? String(Math.round(t.price * (1 - panel.discount_pct / 100))) : ''}
                          onBlur={(e) => {
                            const v = e.target.value;
                            if (v !== '' && Number(v) !== Number(r?.price)) run(() => (r ? updateRow('panel_rates', r.id, { price: Number(v) }) : insertRow('panel_rates', { panel_id: id, test_id: t.id, price: Number(v) })), 'Panel rate saved');
                          }} />
                      </td></tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {edit && <PanelModal p={panel} onClose={() => setEdit(false)} />}
      {pay && <PanelPaymentModal panel={panel} balance={led.balance} onClose={() => setPay(false)} />}
    </>
  );
}

function PanelPaymentModal({ panel, balance, onClose }) {
  const [f, setF] = useState({ amount: balance > 0 ? String(balance) : '', method: 'bank_transfer', paid_on: todayISO(), reference: '', note: '' });
  const run = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title={`Payment from ${panel.name}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" onClick={async () => {
        const ok = await run(() => { if (!(Number(f.amount) > 0)) throw new Error('Enter an amount.'); return insertRow('panel_payments', { panel_id: panel.id, amount: Number(f.amount), method: f.method, paid_on: f.paid_on, reference: f.reference || null, note: f.note || null }); }, 'Payment saved');
        if (ok) onClose();
      }}>Save</button>
    </>}>
      <div className="grid2">
        <Field label="Amount" required><input autoFocus type="number" value={f.amount} onChange={set('amount')} /></Field>
        <Field label="Date"><input type="date" value={f.paid_on} onChange={set('paid_on')} /></Field>
        <Field label="Method"><select value={f.method} onChange={set('method')}>{PAYMENT_METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Reference / cheque no."><input value={f.reference} onChange={set('reference')} /></Field>
        <div className="span2"><Field label="Note"><input value={f.note} onChange={set('note')} /></Field></div>
      </div>
    </Modal>
  );
}

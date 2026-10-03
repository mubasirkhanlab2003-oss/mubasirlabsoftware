// Expenses, home collection, outsourced tests, stock, QC and equipment.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db.js';
import * as A from '../lib/actions.js';
import { insertRow, updateRow } from '../lib/repo.js';
import { attach, equipmentDue, outsourceLedger, stockLevels } from '../lib/reports.js';
import { useAuth } from '../lib/auth.jsx';
import { useOutsourceLabs, useSettings, useTests } from '../lib/hooks.js';
import { methodLabel, PAYMENT_METHODS } from '../lib/pricing.js';
import { westgard, RULE_TEXT, stats } from '../lib/qc.js';
import { addDays, csvDownload, fmtDate, fmtDateTime, nowIso, sum, todayISO, waNumber } from '../lib/format.js';
import { ConfirmButton, DeleteButton, Empty, Field, Figures, Modal, Money, Tabs, useAction, useMoney } from '../components/ui.jsx';
import { PeriodPicker, usePeriod } from '../components/period.jsx';
import { LJChart, Bars } from '../components/charts.jsx';

// ===================================================================== expenses
export function Expenses() {
  const period = usePeriod('month');
  const settings = useSettings();
  const run = useAction();
  const m = useMoney();
  const [edit, setEdit] = useState(null);
  const rows = useLiveQuery(async () => (await db().expenses.where('exp_date').between(period.from, period.to, true, true).toArray()).filter((e) => !e.deleted_at)
    .sort((a, b) => b.exp_date.localeCompare(a.exp_date)), [period.from, period.to], []);
  const cats = settings?.expense_categories || [];
  const byCat = [...new Set(rows.map((r) => r.category))].map((c) => ({ c, v: sum(rows.filter((r) => r.category === c), (r) => r.amount) })).sort((a, b) => b.v - a.v);
  return (
    <>
      <div className="page-head"><div><h1>Expenses</h1><div className="sub">Rent, salaries, reagents, bills — everything the lab spends. Used for profit.</div></div><div className="grow" />
        <button className="btn primary" onClick={() => setEdit({ exp_date: todayISO(), category: cats[0] || 'Other', method: 'cash' })}>Add expense</button></div>
      <div className="panel"><PeriodPicker period={period} /></div>
      <Figures items={[{ label: `Expenses · ${period.label}`, value: m(sum(rows, (r) => r.amount)) }, { label: 'Entries', value: rows.length }]} />
      <div className="split">
        <div className="panel flush"><div className="table-wrap">
          <table className="t">
            <thead><tr><th>Date</th><th>Category</th><th>Paid to / note</th><th>Method</th><th className="r">Amount</th><th /></tr></thead>
            <tbody>{rows.map((e) => (
              <tr key={e.id}><td className="nowrap">{fmtDate(e.exp_date)}</td><td>{e.category}</td><td>{e.paid_to}<div className="faint">{e.note}</div></td><td>{methodLabel(e.method)}</td><td className="r"><Money v={e.amount} /></td>
                <td className="right nowrap"><button className="btn small ghost" onClick={() => setEdit(e)}>Edit</button>
                  <DeleteButton className="btn small ghost danger" title="Delete expense" message={`Delete this expense of ${m(e.amount)}?`} onConfirm={(r) => run(() => A.softDelete('expenses', e, r), 'Deleted').then((x) => x !== undefined)} /></td></tr>
            ))}</tbody>
          </table>
          {!rows.length && <Empty>No expenses in this period.</Empty>}
        </div></div>
        <div className="panel"><h2>By category</h2><Bars rows={byCat} label={(r) => r.c} value={(r) => r.v} fmt={m} />
          <div style={{ marginTop: 12 }}><button className="btn small" onClick={() => csvDownload(`expenses-${period.from}-${period.to}.csv`, [['Date', 'Category', 'Paid to', 'Note', 'Method', 'Amount'], ...rows.map((e) => [e.exp_date, e.category, e.paid_to, e.note, e.method, e.amount])])}>Export</button></div></div>
      </div>
      {edit && <ExpenseModal e={edit} cats={cats} onClose={() => setEdit(null)} />}
    </>
  );
}

function ExpenseModal({ e, cats, onClose }) {
  const [f, setF] = useState({ exp_date: todayISO(), category: '', amount: '', method: 'cash', paid_to: '', note: '', ...e });
  const run = useAction();
  const set = (k) => (ev) => setF({ ...f, [k]: ev.target.value });
  const out = { exp_date: f.exp_date, category: f.category || 'Other', amount: Number(f.amount), method: f.method, paid_to: f.paid_to || null, note: f.note || null };
  return (
    <Modal title={e.id ? 'Edit expense' : 'Add expense'} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" onClick={async () => { const ok = await run(() => { if (!(out.amount > 0)) throw new Error('Enter an amount.'); return e.id ? updateRow('expenses', e.id, out) : insertRow('expenses', out); }, 'Expense saved'); if (ok) onClose(); }}>Save</button>
    </>}>
      <div className="grid2">
        <Field label="Date"><input type="date" value={f.exp_date} onChange={set('exp_date')} /></Field>
        <Field label="Amount" required><input autoFocus type="number" value={f.amount} onChange={set('amount')} /></Field>
        <Field label="Category"><input list="exp-cats" value={f.category} onChange={set('category')} /><datalist id="exp-cats">{cats.map((c) => <option key={c} value={c} />)}</datalist></Field>
        <Field label="Method"><select value={f.method} onChange={set('method')}>{PAYMENT_METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Paid to"><input value={f.paid_to || ''} onChange={set('paid_to')} /></Field>
        <Field label="Note"><input value={f.note || ''} onChange={set('note')} /></Field>
      </div>
    </Modal>
  );
}

// ===================================================================== home collection
export function HomeCollection() {
  const settings = useSettings();
  const run = useAction();
  const nav = useNavigate();
  const [show, setShow] = useState('scheduled');
  const cases = useLiveQuery(async () => {
    const accs = (await db().accessions.where('reg_date').between(addDays(todayISO(), -30), addDays(todayISO(), 30), true, true).toArray())
      .filter((a) => a.home_collection && !a.deleted_at && (show === 'all' || a.home_status === show));
    return (await attach(accs)).sort((a, b) => (a.home_time || a.registered_at).localeCompare(b.home_time || b.registered_at));
  }, [show], null);
  if (!cases) return null;
  return (
    <>
      <div className="page-head"><div><h1>Home collection</h1><div className="sub">Book from New patient / test → tick "Sample from patient's home".</div></div><div className="grow" />
        <Link className="btn primary" to="/register">Book home collection</Link></div>
      <div className="tabs">{[['scheduled', 'To collect'], ['collected', 'Collected'], ['all', 'All (60 days)']].map(([k, l]) => <button key={k} className={show === k ? 'on' : ''} onClick={() => setShow(k)}>{l}</button>)}</div>
      <div className="panel flush"><div className="table-wrap">
        <table className="t">
          <thead><tr><th>When</th><th>Patient</th><th>Address</th><th>Tests</th><th className="r">To collect</th><th /></tr></thead>
          <tbody>{cases.map((c) => (
            <tr key={c.id}>
              <td className="nowrap">{c.home_time ? fmtDateTime(c.home_time) : fmtDate(c.reg_date)}</td>
              <td><Link to={`/cases/${c.id}`}><b>{c.patient?.full_name}</b></Link><div className="faint">{c.patient?.phone}</div></td>
              <td>{c.home_address}</td>
              <td className="faint">{c.tests.filter((t) => t.status !== 'cancelled').map((t) => t.test_code).join(', ')}</td>
              <td className="r"><Money v={c.bill.due} /></td>
              <td className="right nowrap">
                {c.home_status === 'scheduled' && <button className="btn small primary" onClick={() => run(() => A.collectSamples(c), 'Sample collected')}>Collected</button>}
                {c.patient?.phone && <button className="btn small" style={{ marginLeft: 4 }} onClick={() => {
                  const t = `Assalam o Alaikum ${c.patient.full_name},\n${settings?.lab_name || 'Lab'}: our staff will come for your sample${c.home_time ? ' on ' + fmtDateTime(c.home_time) : ''}.\n${[...new Set(c.tests.map((x) => x.test_name))].join(', ')}`;
                  window.open(`https://wa.me/${waNumber(c.patient.phone, settings?.phone_country_code || '92')}?text=${encodeURIComponent(t)}`, '_blank', 'noopener');
                }}>WhatsApp</button>}
                <button className="btn small ghost" onClick={() => nav(`/cases/${c.id}`)}>Open</button>
              </td>
            </tr>
          ))}</tbody>
        </table>
        {!cases.length && <Empty>No home collections here.</Empty>}
      </div></div>
    </>
  );
}

// ===================================================================== outsourcing
export function Outsource() {
  const labs = useOutsourceLabs();
  const [cur, setCur] = useState('');
  const [edit, setEdit] = useState(null);
  const [pay, setPay] = useState(false);
  const run = useAction();
  const m = useMoney();
  const lab = labs.find((l) => l.id === cur) || labs[0];
  const led = useLiveQuery(() => (lab ? outsourceLedger(lab.id) : null), [lab?.id], null);
  const tests = useTests();
  const rates = useLiveQuery(() => (lab ? db().outsource_rates.where('lab_id').equals(lab.id).toArray() : []), [lab?.id], []);
  return (
    <>
      <div className="page-head"><div><h1>Outsourced tests</h1><div className="sub">Tests sent to another lab: what they charge us, and what we have paid them.</div></div><div className="grow" />
        <button className="btn primary" onClick={() => setEdit({})}>Add outside lab</button></div>
      {!labs.length ? <Empty><b>No outside labs yet.</b>Add the labs you send samples to. On a case, use ⋯ next to a test to mark it as sent out.</Empty> : (
        <>
          <div className="chips" style={{ marginBottom: 12 }}>{labs.map((l) => <button key={l.id} className={`chip ${lab?.id === l.id ? 'on' : ''}`} onClick={() => setCur(l.id)}>{l.name}</button>)}</div>
          {led && <>
            <Figures items={[{ label: 'Tests sent', value: led.tests.length }, { label: 'Their charges', value: m(led.owed) }, { label: 'Paid to them', value: m(led.paid) }, { label: 'We owe', value: m(led.balance), tone: led.balance > 0 ? 'warn' : 'good' }]} />
            <div className="row" style={{ marginBottom: 12 }}><button className="btn primary" onClick={() => setPay(true)}>Pay {lab.name}</button><button className="btn" onClick={() => setEdit(lab)}>Edit lab</button></div>
            <div className="split">
              <div className="panel flush"><div className="panel-head"><h2>Tests sent</h2></div><div className="table-wrap">
                <table className="t compact"><tbody>{led.tests.sort((a, b) => (b.outsource_sent_at || '').localeCompare(a.outsource_sent_at || '')).map((t) => (
                  <tr key={t.id}><td className="nowrap">{fmtDate(t.outsource_sent_at)}</td><td><Link to={`/cases/${t.accession_id}`}>{t.acc?.acc_number}</Link> {t.test_name}</td><td>{t.status === 'verified' ? <span className="badge green">Result in</span> : <span className="badge amber">Waiting</span>}</td><td className="r"><Money v={t.outsource_cost || 0} /></td></tr>
                ))}</tbody></table>
                {!led.tests.length && <Empty>Nothing sent to this lab yet.</Empty>}
              </div></div>
              <div>
                <div className="panel"><h2>Payments to {lab.name}</h2>
                  <table className="t compact"><tbody>{led.payments.map((p) => <tr key={p.id}><td>{fmtDate(p.paid_on)}</td><td>{methodLabel(p.method)}</td><td className="r"><Money v={p.amount} /></td>
                    <td className="right"><DeleteButton className="btn small ghost danger" title="Delete payment" message="Delete this payment?" onConfirm={(r) => run(() => A.softDelete('outsource_payments', p, r), 'Deleted').then((x) => x !== undefined)} /></td></tr>)}</tbody></table>
                  {!led.payments.length && <p className="faint">None yet.</p>}
                </div>
                <div className="panel"><h2>Their rates</h2>
                  <p className="faint">Filled in automatically when you send a test.</p>
                  <table className="t compact"><tbody>{tests.filter((t) => t.kind !== 'package').filter((t) => rates.some((r) => r.test_id === t.id) || t.outsourced).map((t) => {
                    const r = rates.find((x) => x.test_id === t.id);
                    return <tr key={t.id}><td>{t.name}</td><td style={{ width: 120 }}><input type="number" defaultValue={r?.cost ?? ''} onBlur={(e) => {
                      const v = e.target.value; if (v === '') return;
                      run(() => (r ? updateRow('outsource_rates', r.id, { cost: Number(v) }) : insertRow('outsource_rates', { lab_id: lab.id, test_id: t.id, cost: Number(v) })), 'Rate saved');
                    }} /></td></tr>;
                  })}</tbody></table>
                  <RateAdder lab={lab} tests={tests} rates={rates} />
                </div>
              </div>
            </div>
          </>}
        </>
      )}
      {edit && <SimpleModal title={edit.id ? 'Edit outside lab' : 'Add outside lab'} table="outsource_labs" row={edit} fields={[['name', 'Name', true], ['phone', 'Phone'], ['address', 'Address']]} onClose={() => setEdit(null)} />}
      {pay && lab && <SimpleModal title={`Pay ${lab.name}`} table="outsource_payments" row={{ lab_id: lab.id, paid_on: todayISO(), method: 'cash' }} fields={[['amount', 'Amount', true, 'number'], ['paid_on', 'Date', true, 'date'], ['method', 'Method', false, 'method'], ['note', 'Note']]} onClose={() => setPay(false)} />}
    </>
  );
}

function RateAdder({ lab, tests, rates }) {
  const [t, setT] = useState('');
  const [c, setC] = useState('');
  const run = useAction();
  return (
    <div className="row" style={{ marginTop: 8, flexWrap: 'nowrap' }}>
      <select value={t} onChange={(e) => setT(e.target.value)}><option value="">Add a test…</option>{tests.filter((x) => x.kind !== 'package' && !rates.some((r) => r.test_id === x.id)).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
      <input type="number" placeholder="Cost" value={c} onChange={(e) => setC(e.target.value)} style={{ width: 100 }} />
      <button className="btn small" disabled={!t || c === ''} onClick={() => run(() => insertRow('outsource_rates', { lab_id: lab.id, test_id: t, cost: Number(c) }), 'Rate saved').then(() => { setT(''); setC(''); })}>Add</button>
    </div>
  );
}

// Generic small add/edit form.
export function SimpleModal({ title, table, row, fields, onClose, onSaved }) {
  const [f, setF] = useState(row);
  const run = useAction();
  return (
    <Modal title={title} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" onClick={async () => {
        const out = { ...f };
        for (const [k, , req, type] of fields) {
          if (type === 'number') out[k] = out[k] === '' || out[k] == null ? null : Number(out[k]);
          if (req && (out[k] == null || out[k] === '')) { run(async () => { throw new Error(`Fill "${fields.find((x) => x[0] === k)[1]}".`); }); return; }
        }
        const ok = await run(() => (row.id ? updateRow(table, row.id, out) : insertRow(table, out)), 'Saved');
        if (ok) { onSaved?.(ok); onClose(); }
      }}>Save</button>
    </>}>
      <div className="grid2">
        {fields.map(([k, label, req, type]) => (
          <Field key={k} label={label} required={req}>
            {type === 'method' ? <select value={f[k] || 'cash'} onChange={(e) => setF({ ...f, [k]: e.target.value })}>{PAYMENT_METHODS.map(([a, b]) => <option key={a} value={a}>{b}</option>)}</select>
              : type === 'textarea' ? <textarea value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
                : type?.startsWith?.('select:') ? <select value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })}>{type.slice(7).split('|').map((o) => <option key={o} value={o}>{o}</option>)}</select>
                  : <input type={type || 'text'} value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} />}
          </Field>
        ))}
      </div>
    </Modal>
  );
}

// ===================================================================== stock
export function Stock() {
  const items = useLiveQuery(() => stockLevels(), [], null);
  const tests = useTests().filter((t) => t.kind !== 'package');
  const usage = (useLiveQuery(() => db().test_consumption.toArray(), [], []) || []).filter((u) => u.active !== false);
  const run = useAction();
  const [edit, setEdit] = useState(null);
  const [recv, setRecv] = useState(null);
  const [adj, setAdj] = useState(null);
  const [link, setLink] = useState(null);
  if (!items) return null;
  const list = items.filter((i) => i.active !== false).sort((a, b) => (b.low - a.low) || a.name.localeCompare(b.name));
  return (
    <>
      <div className="page-head"><div><h1>Stock and reagents</h1><div className="sub">Stock goes down by itself when a result is saved (set "used per test" below). First-expiry lot is used first.</div></div><div className="grow" />
        <button className="btn primary" onClick={() => setEdit({ unit: 'tests', reorder_level: 0, active: true })}>Add item</button></div>
      <Figures items={[
        { label: 'Items', value: list.length },
        { label: 'Low stock', value: list.filter((i) => i.low).length, tone: list.some((i) => i.low) ? 'bad' : 'good' },
        { label: 'Expiring in 30 days', value: list.filter((i) => i.expiringSoon.length).length, tone: list.some((i) => i.expiringSoon.length) ? 'warn' : '' },
        { label: 'Expired lots in stock', value: list.filter((i) => i.expired.length).length, tone: list.some((i) => i.expired.length) ? 'bad' : '' },
      ]} />
      <div className="panel flush"><div className="table-wrap">
        <table className="t">
          <thead><tr><th>Item</th><th className="r">In stock</th><th>Lots (left · expiry)</th><th>Used by tests</th><th /></tr></thead>
          <tbody>{list.map((i) => (
            <tr key={i.id}>
              <td><b>{i.name}</b> <span className="faint">{i.category}</span>{i.low && <span className="badge red" style={{ marginLeft: 6 }}>Low</span>}</td>
              <td className="r"><b>{i.stock}</b> {i.unit}<div className="faint">reorder at {i.reorder_level}</div></td>
              <td className="faint">{i.lots.filter((l) => l.left > 0).map((l) => <div key={l.id} className={l.expired ? 'flag-high' : ''}>{l.lot_number || 'no lot'} · {l.left} · {l.expiry ? fmtDate(l.expiry) : 'no expiry'}{l.expired ? ' (expired)' : ''}</div>)}</td>
              <td className="faint">{usage.filter((u) => u.item_id === i.id).map((u) => `${tests.find((t) => t.id === u.test_id)?.code || '?'} ×${u.qty}`).join(', ')}</td>
              <td className="right nowrap">
                <button className="btn small primary" onClick={() => setRecv(i)}>Receive</button>
                <button className="btn small" style={{ marginLeft: 4 }} onClick={() => setAdj(i)}>Adjust</button>
                <button className="btn small ghost" onClick={() => setLink(i)}>Used per test</button>
                <button className="btn small ghost" onClick={() => setEdit(i)}>Edit</button>
              </td>
            </tr>
          ))}</tbody>
        </table>
        {!list.length && <Empty><b>No stock items yet.</b>Add reagents, kits and consumables (tubes, syringes, strips).</Empty>}
      </div></div>
      {edit && <SimpleModal title={edit.id ? 'Edit item' : 'Add stock item'} table="inv_items" row={edit}
        fields={[['name', 'Name', true], ['unit', 'Unit (tests, ml, pcs)', true], ['category', 'Category (reagent, kit, consumable)'], ['reorder_level', 'Warn when stock is at or below', false, 'number'], ['notes', 'Notes']]} onClose={() => setEdit(null)} />}
      {recv && <ReceiveModal item={recv} onClose={() => setRecv(null)} />}
      {adj && <AdjustModal item={adj} onClose={() => setAdj(null)} />}
      {link && <UsageModal item={link} tests={tests} usage={usage.filter((u) => u.item_id === link.id)} onClose={() => setLink(null)} run={run} />}
    </>
  );
}

function ReceiveModal({ item, onClose }) {
  const [f, setF] = useState({ lot_number: '', expiry: '', qty: '', cost: '', supplier: '', received_on: todayISO() });
  const run = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title={`Receive ${item.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" onClick={async () => { const ok = await run(() => A.receiveStock(item.id, f), 'Stock received'); if (ok) onClose(); }}>Save</button></>}>
      <div className="grid2">
        <Field label={`Quantity (${item.unit})`} required><input autoFocus type="number" value={f.qty} onChange={set('qty')} /></Field>
        <Field label="Lot / batch number"><input value={f.lot_number} onChange={set('lot_number')} /></Field>
        <Field label="Expiry date"><input type="date" value={f.expiry} onChange={set('expiry')} /></Field>
        <Field label="Received on"><input type="date" value={f.received_on} onChange={set('received_on')} /></Field>
        <Field label="Cost (total)"><input type="number" value={f.cost} onChange={set('cost')} /></Field>
        <Field label="Supplier"><input value={f.supplier} onChange={set('supplier')} /></Field>
      </div>
    </Modal>
  );
}

function AdjustModal({ item, onClose }) {
  const [f, setF] = useState({ qty: '', kind: 'waste', lot_id: '', note: '' });
  const run = useAction();
  return (
    <Modal title={`Adjust ${item.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" onClick={async () => {
        const q = Number(f.qty); const signed = f.kind === 'return' ? Math.abs(q) : f.kind === 'adjust' ? q : -Math.abs(q);
        const ok = await run(() => A.adjustStock(item.id, { qty: signed, kind: f.kind, lot_id: f.lot_id || null, note: f.note }), 'Stock adjusted'); if (ok) onClose();
      }}>Save</button></>}>
      <div className="grid2">
        <Field label="What happened"><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="waste">Wasted / expired / broken (out)</option><option value="consume">Used outside tests, e.g. QC (out)</option><option value="return">Returned to stock (in)</option><option value="adjust">Count correction (+ or −)</option></select></Field>
        <Field label="Quantity"><input autoFocus type="number" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></Field>
        <Field label="Lot"><select value={f.lot_id} onChange={(e) => setF({ ...f, lot_id: e.target.value })}><option value="">—</option>{item.lots.map((l) => <option key={l.id} value={l.id}>{l.lot_number || 'no lot'} ({l.left})</option>)}</select></Field>
        <Field label="Note"><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function UsageModal({ item, tests, usage, onClose, run }) {
  const [t, setT] = useState('');
  const [q, setQ] = useState('1');
  return (
    <Modal title={`${item.name} — used per test`} onClose={onClose} footer={<button className="btn" onClick={onClose}>Done</button>}>
      <p className="muted" style={{ marginTop: 0 }}>When a result of these tests is saved, this much {item.unit} is taken from stock.</p>
      <table className="t compact"><tbody>{usage.map((u) => <tr key={u.id}><td>{tests.find((x) => x.id === u.test_id)?.name}</td><td>{u.qty} {item.unit}</td>
        <td className="right"><button className="btn small ghost" onClick={() => run(() => updateRow('test_consumption', u.id, { active: false }), 'Removed')}>Remove</button></td></tr>)}</tbody></table>
      <div className="row" style={{ marginTop: 10, flexWrap: 'nowrap' }}>
        <select value={t} onChange={(e) => setT(e.target.value)}><option value="">Choose test…</option>{tests.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
        <input type="number" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 90 }} />
        <button className="btn" disabled={!t || !(Number(q) > 0)} onClick={() => run(() => insertRow('test_consumption', { test_id: t, item_id: item.id, qty: Number(q) }), 'Linked').then(() => setT(''))}>Add</button>
      </div>
    </Modal>
  );
}

// ===================================================================== QC
export function QC() {
  const mats = (useLiveQuery(() => db().qc_materials.toArray(), [], []) || []).filter((x) => x.active !== false);
  const [cur, setCur] = useState('');
  const mat = mats.find((x) => x.id === cur) || mats[0];
  const runs = useLiveQuery(async () => (mat ? (await db().qc_runs.where('material_id').equals(mat.id).toArray()).filter((r) => !r.deleted_at).sort((a, b) => a.run_at.localeCompare(b.run_at)) : []), [mat?.id], []);
  const params = useLiveQuery(() => db().lab_parameters.toArray(), [], []);
  const tests = useTests();
  const [edit, setEdit] = useState(null);
  const [val, setVal] = useState('');
  const [action, setAction] = useState('');
  const run = useAction();
  const st = stats(runs.map((r) => r.value));
  async function addRun() {
    const v = Number(val);
    if (!Number.isFinite(v) || val === '') return;
    const res = westgard([...runs, { value: v }], mat.mean, mat.sd);
    await run(() => insertRow('qc_runs', { material_id: mat.id, value: v, run_at: nowIso(), status: res.status, rules: res.rules.join(', ') || null, action: action || null }),
      res.status === 'ok' ? 'QC in control' : res.status === 'warning' ? 'QC warning (1-2s) — check next run' : `QC rejected: ${res.rules.join(', ')} — do not report patients until fixed`);
    setVal(''); setAction('');
  }
  const pname = (id) => { const p = params.find((x) => x.id === id); const t = p && tests.find((x) => x.id === p.test_id); return p ? `${p.name}${t ? ` (${t.code})` : ''}` : ''; };
  const last = runs[runs.length - 1];
  return (
    <>
      <div className="page-head"><div><h1>Quality control</h1><div className="sub">Run controls daily. Westgard rules are checked automatically and shown on the Levey-Jennings chart.</div></div><div className="grow" />
        <button className="btn primary" onClick={() => setEdit({ level: 'Level 1', active: true })}>Add control material</button></div>
      {!mats.length ? <Empty><b>No QC material yet.</b>Add each control (e.g. Glucose Level 1) with its target mean and SD from the insert.</Empty> : (
        <>
          <div className="chips" style={{ marginBottom: 12 }}>{mats.map((x) => <button key={x.id} className={`chip ${mat?.id === x.id ? 'on' : ''}`} onClick={() => setCur(x.id)}>{x.name} {x.level}</button>)}</div>
          <div className="split">
            <div className="panel">
              <div className="panel-head"><h2>{mat.name} · {mat.level}</h2><div className="grow" /><span className="faint">{pname(mat.parameter_id)} · target {mat.mean} ± {mat.sd} {mat.unit}</span></div>
              {runs.length ? <LJChart runs={runs.slice(-30)} mean={mat.mean} sd={mat.sd} /> : <p className="muted">No runs yet.</p>}
              {last && last.status !== 'ok' && <div className={`note ${last.status === 'reject' ? 'bad' : 'warn'}`} style={{ marginTop: 10 }}>{(last.rules || '').split(', ').map((r) => <div key={r}><b>{r}</b>: {RULE_TEXT[r]}</div>)}</div>}
            </div>
            <div>
              <div className="panel">
                <h2>Enter today's control value</h2>
                <div className="grid2">
                  <Field label={mat.unit ? `Value (${mat.unit})` : 'Value'}><input autoFocus type="number" value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addRun()} /></Field>
                  <Field label="Action taken (if out)"><input value={action} onChange={(e) => setAction(e.target.value)} /></Field>
                </div>
                <button className="btn primary" style={{ marginTop: 10 }} disabled={val === ''} onClick={addRun}>Save QC run</button>
              </div>
              <div className="panel">
                <h2>This material</h2>
                <table className="t compact"><tbody>
                  <tr><td>Runs</td><td className="r">{st.n}</td></tr>
                  <tr><td>Observed mean</td><td className="r">{st.mean == null ? '—' : st.mean.toFixed(2)}</td></tr>
                  <tr><td>Observed SD</td><td className="r">{st.sd == null ? '—' : st.sd.toFixed(2)}</td></tr>
                  <tr><td>CV %</td><td className="r">{st.cv == null ? '—' : st.cv.toFixed(1)}</td></tr>
                  <tr><td>Lot / expiry</td><td className="r">{mat.lot_number || '—'} · {mat.expiry ? fmtDate(mat.expiry) : '—'}</td></tr>
                </tbody></table>
                <div className="row" style={{ marginTop: 10 }}><button className="btn small" onClick={() => setEdit(mat)}>Edit</button>
                  <ConfirmButton label="Retire" className="btn small ghost" title="Retire material" message="Hide this control material (its history is kept)." confirmLabel="Retire" onConfirm={() => run(() => updateRow('qc_materials', mat.id, { active: false }), 'Retired')} /></div>
              </div>
            </div>
          </div>
          <div className="panel flush"><div className="panel-head"><h2>Runs</h2></div><div className="table-wrap">
            <table className="t compact"><tbody>{[...runs].reverse().slice(0, 60).map((r) => (
              <tr key={r.id}><td className="nowrap">{fmtDateTime(r.run_at)}</td><td className="r">{r.value}</td><td className="r faint">{((r.value - mat.mean) / mat.sd).toFixed(2)} SD</td>
                <td>{r.status === 'ok' ? <span className="badge green">In control</span> : r.status === 'warning' ? <span className="badge amber">Warning {r.rules}</span> : <span className="badge red">Rejected {r.rules}</span>}</td><td className="faint">{r.action}</td>
                <td className="right"><DeleteButton className="btn small ghost danger" title="Delete QC run" message="Delete this QC value (entered by mistake)?" onConfirm={(x) => run(() => A.softDelete('qc_runs', r, x), 'Deleted').then((y) => y !== undefined)} /></td></tr>
            ))}</tbody></table>
          </div></div>
        </>
      )}
      {edit && <QCMaterialModal m={edit} params={params} tests={tests} onClose={() => setEdit(null)} />}
    </>
  );
}

function QCMaterialModal({ m, params, tests, onClose }) {
  const [f, setF] = useState({ name: '', level: 'Level 1', lot_number: '', expiry: '', mean: '', sd: '', unit: '', parameter_id: '', ...m });
  const run = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const numericParams = params.filter((p) => p.result_type === 'numeric');
  return (
    <Modal wide title={m.id ? 'Edit control material' : 'Add control material'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" onClick={async () => {
        const out = { name: f.name, level: f.level, lot_number: f.lot_number || null, expiry: f.expiry || null, mean: Number(f.mean), sd: Number(f.sd), unit: f.unit || null, parameter_id: f.parameter_id || null, active: true };
        const ok = await run(() => { if (!out.name || !Number.isFinite(out.mean) || !(out.sd > 0)) throw new Error('Name, mean and SD are needed.'); return m.id ? updateRow('qc_materials', m.id, out) : insertRow('qc_materials', out); }, 'Saved');
        if (ok) onClose();
      }}>Save</button></>}>
      <div className="grid3">
        <Field label="Analyte / parameter"><select value={f.parameter_id || ''} onChange={(e) => { const p = params.find((x) => x.id === e.target.value); setF({ ...f, parameter_id: e.target.value, name: f.name || p?.name || '', unit: f.unit || p?.unit || '' }); }}>
          <option value="">Choose…</option>{numericParams.map((p) => <option key={p.id} value={p.id}>{p.name} ({tests.find((t) => t.id === p.test_id)?.code})</option>)}</select></Field>
        <Field label="Name" required><input value={f.name} onChange={set('name')} /></Field>
        <Field label="Level"><input value={f.level} onChange={set('level')} /></Field>
        <Field label="Target mean" required><input type="number" value={f.mean} onChange={set('mean')} /></Field>
        <Field label="Target SD" required><input type="number" value={f.sd} onChange={set('sd')} /></Field>
        <Field label="Unit"><input value={f.unit || ''} onChange={set('unit')} /></Field>
        <Field label="Lot number"><input value={f.lot_number || ''} onChange={set('lot_number')} /></Field>
        <Field label="Expiry"><input type="date" value={f.expiry || ''} onChange={set('expiry')} /></Field>
      </div>
    </Modal>
  );
}

// ===================================================================== equipment
export function Equipment() {
  const list = useLiveQuery(() => equipmentDue(), [], null);
  const [edit, setEdit] = useState(null);
  const [log, setLog] = useState(null);
  if (!list) return null;
  return (
    <>
      <div className="page-head"><div><h1>Equipment</h1><div className="sub">Analysers and instruments: calibration and maintenance dates with reminders.</div></div><div className="grow" />
        <button className="btn primary" onClick={() => setEdit({ active: true })}>Add equipment</button></div>
      <div className="panel flush"><div className="table-wrap">
        <table className="t">
          <thead><tr><th>Equipment</th><th>Next calibration</th><th>Next maintenance</th><th>Last entry</th><th /></tr></thead>
          <tbody>{list.map((e) => (
            <tr key={e.id}>
              <td><b>{e.name}</b>{e.overdue && <span className="badge red" style={{ marginLeft: 6 }}>Overdue</span>}{!e.overdue && e.dueSoon && <span className="badge amber" style={{ marginLeft: 6 }}>Due this week</span>}<div className="faint">{[e.model, e.serial_no && `S/N ${e.serial_no}`, e.location].filter(Boolean).join(' · ')}</div></td>
              <td className={e.nextCalibration && e.nextCalibration < todayISO() ? 'flag-high' : ''}>{e.nextCalibration ? fmtDate(e.nextCalibration) : '—'}</td>
              <td className={e.nextMaintenance && e.nextMaintenance < todayISO() ? 'flag-high' : ''}>{e.nextMaintenance ? fmtDate(e.nextMaintenance) : '—'}</td>
              <td className="faint">{e.logs[0] ? `${fmtDate(e.logs[0].log_date)} · ${e.logs[0].kind}${e.logs[0].note ? ' · ' + e.logs[0].note : ''}` : 'No entries yet'}</td>
              <td className="right nowrap"><button className="btn small primary" onClick={() => setLog(e)}>Add entry</button><button className="btn small ghost" onClick={() => setEdit(e)}>Edit</button></td>
            </tr>
          ))}</tbody>
        </table>
        {!list.length && <Empty><b>No equipment yet.</b>Add your analysers, centrifuge, microscope, fridge…</Empty>}
      </div></div>
      {edit && <SimpleModal title={edit.id ? 'Edit equipment' : 'Add equipment'} table="equipment" row={edit}
        fields={[['name', 'Name', true], ['model', 'Model'], ['serial_no', 'Serial number'], ['location', 'Location'], ['calib_interval_days', 'Calibrate every (days)', false, 'number'], ['maint_interval_days', 'Maintenance every (days)', false, 'number'], ['notes', 'Notes']]} onClose={() => setEdit(null)} />}
      {log && <SimpleModal title={`${log.name} — new entry`} table="equipment_logs" row={{ equipment_id: log.id, kind: 'maintenance', log_date: todayISO() }}
        fields={[['kind', 'Type', true, 'select:maintenance|calibration|breakdown|repair'], ['log_date', 'Date', true, 'date'], ['next_due', 'Next due (blank = by interval)', false, 'date'], ['done_by', 'Done by'], ['note', 'Note', false, 'textarea']]} onClose={() => setLog(null)} />}
    </>
  );
}

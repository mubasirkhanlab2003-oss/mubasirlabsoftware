import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db.js';
import * as A from '../lib/actions.js';
import { dues, loadCases, summary } from '../lib/reports.js';
import { useSettings } from '../lib/hooks.js';
import { methodLabel } from '../lib/pricing.js';
import { csvDownload, fmtDate, fmtDateTime, round2, sum, waNumber } from '../lib/format.js';
import { Caps, DueBadge, Empty, Field, Figures, Money, Tabs, useAction, useMoney } from '../components/ui.jsx';
import { PeriodPicker, usePeriod } from '../components/period.jsx';

export default function Billing() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') || 'bills';
  const setTab = (t) => { const n = new URLSearchParams(sp); n.set('tab', t); setSp(n); };
  return (
    <>
      <div className="page-head"><div><h1>Bills and cash</h1><div className="sub">Every visit has one bill, made automatically.</div></div></div>
      <Tabs value={tab} onChange={setTab} tabs={[['bills', 'Bills'], ['dues', 'Unpaid'], ['cash', 'Cash book & day closing'], ['changes', 'Refunds & late changes']]} />
      {tab === 'bills' && <Bills />}
      {tab === 'dues' && <Dues />}
      {tab === 'cash' && <Cash />}
      {tab === 'changes' && <Changes />}
    </>
  );
}

function Bills() {
  const period = usePeriod('today');
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [deleted, setDeleted] = useState(false);
  const cases = useLiveQuery(() => loadCases(period.from, period.to, { includeDeleted: deleted }), [period.from, period.to, deleted], null);
  const docs = useLiveQuery(async () => Object.fromEntries((await db().ref_doctors.toArray()).map((d) => [d.id, d.full_name])), [], {});
  if (!cases) return null;
  const s = q.trim().toLowerCase();
  const list = cases.filter((c) => !s || (c.patient?.full_name || '').toLowerCase().includes(s) || c.acc_number.toLowerCase().includes(s) || (c.patient?.mr_number || '').toLowerCase().includes(s))
    .sort((a, b) => b.registered_at.localeCompare(a.registered_at));
  const live = list.filter((c) => !c.deleted_at);
  return (
    <>
      <div className="panel"><PeriodPicker period={period} /></div>
      <Figures items={[
        { label: 'Bills', value: live.length },
        { label: 'Total billed', value: <Money v={sum(live, (c) => c.bill.total)} /> },
        { label: 'Discounts', value: <Money v={sum(live, (c) => c.bill.discount)} /> },
        { label: 'Paid on these bills', value: <Money v={sum(live, (c) => c.bill.paid)} /> },
        { label: 'Still unpaid', value: <Money v={sum(live, (c) => c.bill.due)} />, tone: 'bad' },
      ]} />
      <div className="panel flush">
        <div className="panel-head"><input style={{ maxWidth: 300 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Patient, MR or case no." />
          <label className="check faint"><input type="checkbox" checked={deleted} onChange={(e) => setDeleted(e.target.checked)} /> Show deleted</label>
          <div className="grow" />
          <button className="btn small" onClick={() => csvDownload(`bills-${period.from}-${period.to}.csv`, [['Date', 'Case', 'Patient', 'MR', 'Doctor', 'Tests', 'Gross', 'Discount', 'Total', 'Paid', 'Due', 'Deleted'],
            ...list.map((c) => [c.reg_date, c.acc_number, c.patient?.full_name, c.patient?.mr_number, docs[c.doctor_id] || c.doctor_text || '', c.bill.tests, c.bill.gross, c.bill.discount, c.bill.total, c.bill.paid, c.bill.due, c.deleted_at ? 'yes' : ''])])}>Export</button></div>
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>Case</th><th>Patient</th><th>Doctor</th><th>Tests</th><th className="r">Total</th><th className="r">Paid</th><th className="r">Due</th><th /></tr></thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id} className={`click ${c.deleted_at ? 'muted-row' : ''}`} onClick={() => nav(`/cases/${c.id}`)}>
                  <td className="nowrap"><b>{c.acc_number}</b><div className="faint">{fmtDateTime(c.registered_at)}</div></td>
                  <td>{c.patient?.full_name}<div className="faint">{c.patient?.mr_number}</div></td>
                  <td className="faint">{docs[c.doctor_id] || c.doctor_text || 'Self'}</td>
                  <td><Caps tests={c.tests} /></td>
                  <td className="r"><Money v={c.bill.total} /></td><td className="r"><Money v={c.bill.paid} /></td><td className="r"><Money v={c.bill.due || c.bill.panel_due} /></td>
                  <td><DueBadge bill={c.bill} deleted={!!c.deleted_at} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!list.length && <Empty>No bills in this period.</Empty>}
        </div>
      </div>
    </>
  );
}

function Dues() {
  const settings = useSettings();
  const list = useLiveQuery(() => dues(), [], null);
  const m = useMoney();
  if (!list) return null;
  const byPatient = new Map();
  for (const c of list) {
    const k = c.patient_id;
    const r = byPatient.get(k) || { patient: c.patient, cases: [], due: 0 };
    r.cases.push(c); r.due = round2(r.due + c.bill.due);
    byPatient.set(k, r);
  }
  const rows = [...byPatient.values()].sort((a, b) => b.due - a.due);
  return (
    <>
      <Figures items={[{ label: 'Patients with dues', value: rows.length }, { label: 'Total unpaid', value: m(sum(rows, (r) => r.due)), tone: 'bad' }]} />
      <div className="panel flush">
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>Patient</th><th>Bills</th><th className="r">Due</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.patient?.id}>
                  <td><Link to={`/patients/${r.patient?.id}`}><b>{r.patient?.full_name}</b></Link><div className="faint">{r.patient?.mr_number} · {r.patient?.phone}</div></td>
                  <td>{r.cases.map((c) => <Link key={c.id} to={`/cases/${c.id}`} style={{ marginRight: 8 }}>{c.acc_number} ({fmtDate(c.reg_date)}) {m(c.bill.due)}</Link>)}</td>
                  <td className="r"><b><Money v={r.due} /></b></td>
                  <td className="right">{r.patient?.phone && <button className="btn small" onClick={() => {
                    const t = `Assalam o Alaikum ${r.patient.full_name},\nThis is a reminder from ${settings?.lab_name || 'the lab'}: Rs ${r.due} is still due on your lab bill (${r.cases.map((c) => c.acc_number).join(', ')}).\nThank you.`;
                    window.open(`https://wa.me/${waNumber(r.patient.phone, settings?.phone_country_code || '92')}?text=${encodeURIComponent(t)}`, '_blank', 'noopener');
                  }}>WhatsApp reminder</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <Empty><b>Nothing unpaid.</b>Every bill is paid.</Empty>}
        </div>
      </div>
    </>
  );
}

function Cash() {
  const period = usePeriod('today');
  const s = useLiveQuery(() => summary(period.from, period.to), [period.from, period.to], null);
  const closing = useLiveQuery(() => (period.from === period.to ? db().day_closings.where('close_date').equals(period.from).first() : null), [period.from, period.to]);
  const m = useMoney();
  const run = useAction();
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  if (!s) return null;
  const cash = sum(s.money.filter((p) => p.method === 'cash'), (p) => p.amount);
  const cashExp = sum(s.expenses.filter((e) => e.method === 'cash'), (e) => e.amount);
  const cashPay = sum(s.payouts.filter((p) => p.method === 'cash'), (p) => p.amount);
  const expected = round2(cash - cashExp - cashPay);
  const single = period.from === period.to;
  return (
    <>
      <div className="panel"><PeriodPicker period={period} /></div>
      <Figures items={[
        { label: 'Received', value: m(s.received) },
        { label: 'Refunds', value: m(s.refunds), tone: s.refunds ? 'warn' : '' },
        { label: 'Net received', value: m(s.netCash) },
        { label: 'Expenses paid', value: m(s.expenseTotal) },
        { label: 'Paid to doctors', value: m(s.payoutTotal) },
      ]} />
      <div className="split">
        <div className="panel flush">
          <div className="panel-head"><h2>Money in and out</h2><div className="grow" />
            <button className="btn small" onClick={() => csvDownload(`cash-${period.from}-${period.to}.csv`, [['Date', 'No.', 'Kind', 'Method', 'Amount', 'Note'], ...s.money.map((p) => [p.business_date, p.payment_number, p.kind, p.method, p.amount, p.note || ''])])}>Export</button></div>
          <div className="table-wrap">
            <table className="t compact">
              <thead><tr><th>Date</th><th>No.</th><th>Type</th><th className="r">Amount</th></tr></thead>
              <tbody>
                {s.money.sort((a, b) => b.received_at.localeCompare(a.received_at)).map((p) => (
                  <tr key={p.id}>
                    <td className="nowrap">{fmtDate(p.business_date)}{p.late_adjustment && <span className="badge amber" style={{ marginLeft: 6 }}>late</span>}</td>
                    <td><Link to={`/cases/${p.accession_id}`}>{p.payment_number}</Link></td>
                    <td>{p.kind === 'refund' ? <span className="badge amber">Refund</span> : methodLabel(p.method)}{p.note && <div className="faint">{p.note}</div>}</td>
                    <td className="r"><Money v={p.amount} /></td>
                  </tr>
                ))}
                {s.expenses.map((e) => <tr key={e.id}><td>{fmtDate(e.exp_date)}</td><td className="faint">Expense</td><td>{e.category} · {methodLabel(e.method)}</td><td className="r">−<Money v={e.amount} /></td></tr>)}
                {s.payouts.map((p) => <tr key={p.id}><td>{fmtDate(p.paid_on)}</td><td className="faint">{p.payout_number}</td><td>Doctor commission · {methodLabel(p.method)}</td><td className="r">−<Money v={p.amount} /></td></tr>)}
              </tbody>
            </table>
            {!s.money.length && <Empty>No money in this period.</Empty>}
          </div>
        </div>
        <div>
          <div className="panel">
            <h2>By payment method</h2>
            <table className="t compact"><tbody>
              {s.byMethod.map((r) => <tr key={r.method}><td>{methodLabel(r.method)}</td><td className="r"><Money v={r.amount} /></td></tr>)}
            </tbody></table>
          </div>
          {single && (
            <div className="panel">
              <h2>Day closing — {fmtDate(period.from)}</h2>
              <p className="muted">Cash that should be in the drawer: cash received − cash refunds − cash expenses − cash paid to doctors.</p>
              <div className="bill-total" style={{ marginBottom: 10 }}><div className="grand"><span>Expected cash</span><Money v={expected} /></div></div>
              {closing && <div className="note good" style={{ marginBottom: 10 }}>Closed {fmtDateTime(closing.closed_at)} · counted <Money v={closing.counted_cash} /> · difference <b><Money v={round2((closing.counted_cash ?? 0) - closing.expected_cash)} /></b>
                {Math.abs(closing.expected_cash - expected) > 0.009 && <div className="flag-high">Figures for this day changed after closing (expected was <Money v={closing.expected_cash} />). See Refunds & late changes.</div>}</div>}
              <div className="grid2">
                <Field label="Cash counted in drawer"><input type="number" value={counted} onChange={(e) => setCounted(e.target.value)} /></Field>
                <Field label="Note"><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
              </div>
              {counted !== '' && <p>Difference: <b className={Math.abs(Number(counted) - expected) > 0.009 ? 'flag-high' : ''}><Money v={round2(Number(counted) - expected)} /></b></p>}
              <button className="btn primary" style={{ marginTop: 8 }} onClick={() => run(() => A.closeDay({ date: period.from, expected, counted, note }), 'Day closed')}>{closing ? 'Close again' : 'Close the day'}</button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function Changes() {
  const rows = useLiveQuery(async () => {
    const pays = (await db().bill_payments.toArray()).filter((p) => !p.deleted_at && (p.kind === 'refund' || p.late_adjustment));
    const del = (await db().bill_payments.toArray()).filter((p) => p.deleted_at);
    const tests = (await db().accession_tests.where('status').equals('cancelled').toArray());
    return { pays: pays.sort((a, b) => b.received_at.localeCompare(a.received_at)), del, tests: tests.sort((a, b) => (b.cancelled_at || '').localeCompare(a.cancelled_at || '')) };
  }, [], null);
  if (!rows) return null;
  return (
    <div className="stack">
      <div className="note">A refund for a cancelled test counts on the day the test was registered, so that day's revenue and cash go down. If it is made on a later day it is marked "late" here, so the difference from that day's drawer count is clear.</div>
      <div className="panel flush">
        <div className="panel-head"><h2>Refunds</h2></div>
        <table className="t compact"><tbody>
          {rows.pays.map((p) => (
            <tr key={p.id}><td className="nowrap">Counts on {fmtDate(p.business_date)}</td><td className="nowrap faint">made {fmtDateTime(p.received_at)}</td>
              <td><Link to={`/cases/${p.accession_id}`}>{p.payment_number}</Link> {p.note}</td><td className="r"><Money v={p.amount} /></td>
              <td>{p.late_adjustment && <span className="badge amber">late</span>}</td></tr>
          ))}
        </tbody></table>
        {!rows.pays.length && <Empty>No refunds.</Empty>}
      </div>
      <div className="grid2">
        <div className="panel flush">
          <div className="panel-head"><h2>Cancelled tests</h2></div>
          <table className="t compact"><tbody>
            {rows.tests.slice(0, 100).map((t) => <tr key={t.id}><td className="nowrap faint">{fmtDateTime(t.cancelled_at)}</td><td><Link to={`/cases/${t.accession_id}`}>{t.test_name}</Link><div className="faint">{t.cancel_reason}</div></td><td className="r"><Money v={t.price} /></td></tr>)}
          </tbody></table>
          {!rows.tests.length && <Empty>No cancelled tests.</Empty>}
        </div>
        <div className="panel flush">
          <div className="panel-head"><h2>Deleted payments</h2></div>
          <table className="t compact"><tbody>
            {rows.del.map((p) => <tr key={p.id}><td className="nowrap faint">{fmtDate(p.business_date)}</td><td><Link to={`/cases/${p.accession_id}`}>{p.payment_number}</Link><div className="faint">{p.delete_reason}</div></td><td className="r"><Money v={p.amount} /></td></tr>)}
          </tbody></table>
          {!rows.del.length && <Empty>No deleted payments.</Empty>}
        </div>
      </div>
    </div>
  );
}


import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db.js';
import { addMonths, csvDownload, fmtDateTime, fmtHours, monthEnd, monthStart, round2, sum, todayISO } from '../lib/format.js';
import { byDepartment, byDoctor, byTest, dailySeries, heatmap, summary, tat } from '../lib/reports.js';
import { methodLabel } from '../lib/pricing.js';
import { Empty, Figures, Money, Tabs, useMoney } from '../components/ui.jsx';
import { PeriodPicker, usePeriod } from '../components/period.jsx';
import { Bars, DayBars, Heatmap } from '../components/charts.jsx';

export default function Reports() {
  const period = usePeriod('month');
  const [tab, setTab] = useState('summary');
  const m = useMoney();
  const s = useLiveQuery(() => summary(period.from, period.to), [period.from, period.to], null);
  return (
    <>
      <div className="page-head"><div><h1>Reports</h1><div className="sub">All figures leave out deleted cases and payments. Revenue counts on the day the case was registered.</div></div></div>
      <div className="panel"><PeriodPicker period={period} /></div>
      {s && <Figures items={[
        { label: 'Patients', value: s.patients, hint: `${s.caseCount} visits · ${s.testCount} tests` },
        { label: 'Revenue', value: m(s.revenue), hint: s.discount ? `after ${m(s.discount)} discount` : null },
        { label: 'Received (net)', value: m(s.netCash) },
        { label: 'Commission', value: m(s.commission) },
        { label: 'Expenses', value: m(s.expenseTotal) },
        { label: 'Profit', value: m(s.profit), tone: s.profit >= 0 ? 'good' : 'bad', hint: 'revenue − commission − outsourcing − expenses' },
      ]} />}
      <Tabs value={tab} onChange={setTab} tabs={[['summary', 'Summary'], ['tests', 'Test-wise'], ['depts', 'Department-wise'], ['doctors', 'Doctor-wise'], ['panels', 'Panel-wise'], ['tat', 'Turnaround time'], ['profit', 'Profit & loss'], ['analysis', 'Business analysis'], ['critical', 'Critical calls']]} />
      {s && tab === 'summary' && <Summary s={s} period={period} />}
      {s && tab === 'tests' && <TestWise s={s} period={period} />}
      {s && tab === 'depts' && <DeptWise s={s} />}
      {s && tab === 'doctors' && <DoctorWise s={s} period={period} />}
      {s && tab === 'panels' && <PanelWise s={s} />}
      {s && tab === 'tat' && <Tat s={s} />}
      {s && tab === 'profit' && <Profit s={s} />}
      {tab === 'analysis' && <Analysis />}
      {tab === 'critical' && <Critical period={period} />}
    </>
  );
}

function Summary({ s, period }) {
  const m = useMoney();
  const series = dailySeries(s.cases, period.from, period.to);
  return (
    <div className="split">
      <div className="panel"><h2>Revenue by day</h2>{series.length > 1 ? <DayBars series={series} fmt={m} /> : <p className="muted">Choose a longer period to see the daily chart.</p>}</div>
      <div className="panel">
        <h2>Money received</h2>
        <table className="t compact"><tbody>
          {s.byMethod.map((r) => <tr key={r.method}><td>{methodLabel(r.method)}</td><td className="r"><Money v={r.amount} /></td></tr>)}
          <tr><td>Refunds</td><td className="r">−<Money v={s.refunds} /></td></tr>
          <tr><td><b>Net</b></td><td className="r"><b><Money v={s.netCash} /></b></td></tr>
          <tr><td>Unpaid (patients)</td><td className="r"><Money v={s.due} /></td></tr>
          <tr><td>Billed to panels</td><td className="r"><Money v={s.panelDue} /></td></tr>
        </tbody></table>
        {s.lateAdjustments.length > 0 && <p className="faint">{s.lateAdjustments.length} refund(s) were made after their day — see Bills & cash → Refunds.</p>}
      </div>
    </div>
  );
}

function TestWise({ s, period }) {
  const rows = byTest(s.cases);
  const m = useMoney();
  return (
    <div className="panel flush">
      <div className="panel-head"><h2>{rows.length} tests</h2><div className="grow" /><button className="btn small" onClick={() => csvDownload(`tests-${period.from}-${period.to}.csv`, [['Test', 'Department', 'Count', 'Amount'], ...rows.map((r) => [r.name, r.department, r.count, r.amount])])}>Export</button></div>
      <div className="table-wrap"><table className="t compact">
        <thead><tr><th>Test</th><th>Department</th><th className="r">Count</th><th className="r">Amount</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.test_id}><td>{r.name}</td><td className="faint">{r.department}</td><td className="r">{r.count}</td><td className="r">{m(r.amount)}</td></tr>)}</tbody>
      </table>{!rows.length && <Empty>No tests in this period.</Empty>}</div>
    </div>
  );
}

function DeptWise({ s }) {
  const rows = byDepartment(s.cases);
  const m = useMoney();
  return (
    <div className="split">
      <div className="panel"><h2>Revenue by department</h2><Bars rows={rows} label={(r) => r.department} value={(r) => r.amount} fmt={m} /></div>
      <div className="panel flush"><table className="t compact">
        <thead><tr><th>Department</th><th className="r">Tests</th><th className="r">Verified</th><th className="r">Amount</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.department}><td>{r.department}</td><td className="r">{r.count}</td><td className="r">{r.verified}</td><td className="r">{m(r.amount)}</td></tr>)}</tbody>
      </table></div>
    </div>
  );
}

function DoctorWise({ s, period }) {
  const rows = useLiveQuery(() => byDoctor(s.cases), [s], []);
  const m = useMoney();
  return (
    <div className="panel flush">
      <div className="panel-head"><h2>Who sent patients</h2><div className="grow" /><button className="btn small" onClick={() => csvDownload(`doctor-wise-${period.from}-${period.to}.csv`, [['Doctor', 'Patients', 'Visits', 'Tests', 'Revenue', 'Commission'], ...rows.map((r) => [r.name, r.patients, r.cases, r.tests, r.revenue, r.commission])])}>Export</button></div>
      <div className="table-wrap"><table className="t compact">
        <thead><tr><th>Doctor</th><th className="r">Patients</th><th className="r">Visits</th><th className="r">Tests</th><th className="r">Revenue</th><th className="r">Commission</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.key}><td>{r.doctor_id ? <Link to={`/doctors/${r.doctor_id}?from=${period.from}&to=${period.to}`}>{r.name}</Link> : r.name}</td><td className="r">{r.patients}</td><td className="r">{r.cases}</td><td className="r">{r.tests}</td><td className="r">{m(r.revenue)}</td><td className="r">{m(r.commission)}</td></tr>)}</tbody>
      </table></div>
    </div>
  );
}

function PanelWise({ s }) {
  const panels = useLiveQuery(async () => Object.fromEntries((await db().panels.toArray()).map((p) => [p.id, p.name])), [], {});
  const m = useMoney();
  const g = new Map();
  for (const c of s.cases) {
    const k = c.panel_id || '';
    const r = g.get(k) || { name: c.panel_id ? panels[c.panel_id] : 'Cash patients', cases: 0, revenue: 0, credit: 0 };
    r.cases += 1; r.revenue = round2(r.revenue + c.bill.total); r.credit = round2(r.credit + c.bill.panel_due);
    g.set(k, r);
  }
  return (
    <div className="panel flush"><table className="t compact">
      <thead><tr><th>Panel</th><th className="r">Visits</th><th className="r">Revenue</th><th className="r">Billed on credit</th></tr></thead>
      <tbody>{[...g.entries()].map(([k, r]) => <tr key={k}><td>{k ? <Link to={`/panels/${k}`}>{r.name}</Link> : r.name}</td><td className="r">{r.cases}</td><td className="r">{m(r.revenue)}</td><td className="r">{m(r.credit)}</td></tr>)}</tbody>
    </table></div>
  );
}

function Tat({ s }) {
  const t = tat(s.cases);
  return (
    <>
      <Figures items={[{ label: 'Verified tests', value: t.rows.length }, { label: 'On time', value: t.onTime == null ? '—' : `${t.onTime}%`, tone: t.onTime >= 90 ? 'good' : 'warn' },
        { label: 'Average turnaround', value: t.rows.length ? fmtHours(t.rows.reduce((a, r) => a + r.hours, 0) / t.rows.length) : '—' }]} />
      <div className="panel flush"><table className="t compact">
        <thead><tr><th>Department</th><th className="r">Tests</th><th className="r">Average</th><th className="r">Late</th></tr></thead>
        <tbody>{t.byDept.map((r) => <tr key={r.department}><td>{r.department}</td><td className="r">{r.count}</td><td className="r">{fmtHours(r.avg)}</td><td className="r">{r.late}</td></tr>)}</tbody>
      </table>{!t.rows.length && <Empty>No verified tests in this period.</Empty>}</div>
    </>
  );
}

function Profit({ s }) {
  const m = useMoney();
  const cats = [...new Set(s.expenses.map((e) => e.category))].map((c) => [c, sum(s.expenses.filter((e) => e.category === c), (e) => e.amount)]);
  return (
    <div className="panel" style={{ maxWidth: 640 }}>
      <h2>Profit and loss</h2>
      <table className="t"><tbody>
        <tr><td>Tests billed (before discount)</td><td className="r">{m(s.gross)}</td></tr>
        <tr><td>Discounts</td><td className="r">−{m(s.discount)}</td></tr>
        <tr><td><b>Revenue</b></td><td className="r"><b>{m(s.revenue)}</b></td></tr>
        <tr><td>Doctor commission</td><td className="r">−{m(s.commission)}</td></tr>
        <tr><td>Outside-lab charges</td><td className="r">−{m(s.outsource)}</td></tr>
        {cats.map(([c, v]) => <tr key={c}><td>Expense: {c}</td><td className="r">−{m(v)}</td></tr>)}
        <tr><td><b>Profit</b></td><td className="r"><b className={s.profit < 0 ? 'flag-high' : ''}>{m(s.profit)}</b></td></tr>
      </tbody></table>
      <p className="faint">Revenue is what was billed in the period (paid or not). Cash received is in Bills & cash.</p>
    </div>
  );
}

function Analysis() {
  const m = useMoney();
  const t = todayISO();
  const data = useLiveQuery(async () => {
    const cur = await summary(monthStart(t), t);
    const prevFrom = addMonths(monthStart(t), -1);
    const day = Number(t.slice(8));
    const prevTo = prevFrom.slice(0, 8) + String(Math.min(day, Number(monthEnd(prevFrom).slice(8)))).padStart(2, '0');
    const prev = await summary(prevFrom, prevTo);
    const last90 = await summary(addMonths(monthStart(t), -2), t);
    return { cur, prev, last90 };
  }, [t], null);
  if (!data) return null;
  const { cur, prev, last90 } = data;
  const ch = (a, b) => (b ? `${a >= b ? '+' : ''}${Math.round(((a - b) / b) * 100)}% vs last month` : 'no data last month');
  const top = byTest(last90.cases).slice(0, 10);
  return (
    <>
      <p className="muted">This month so far, compared with the same days of last month.</p>
      <Figures items={[
        { label: 'Patients', value: cur.patients, hint: ch(cur.patients, prev.patients) },
        { label: 'Revenue', value: m(cur.revenue), hint: ch(cur.revenue, prev.revenue), tone: cur.revenue >= prev.revenue ? 'good' : 'bad' },
        { label: 'Average bill', value: m(cur.caseCount ? cur.revenue / cur.caseCount : 0), hint: ch(cur.caseCount ? cur.revenue / cur.caseCount : 0, prev.caseCount ? prev.revenue / prev.caseCount : 0) },
        { label: 'Profit', value: m(cur.profit), hint: ch(cur.profit, prev.profit) },
      ]} />
      <div className="grid2">
        <div className="panel"><h2>Busiest days and hours (last 3 months)</h2><Heatmap grid={heatmap(last90.cases)} /></div>
        <div className="panel"><h2>Most done tests (last 3 months)</h2><Bars rows={top} label={(r) => r.name} value={(r) => r.count} /></div>
      </div>
    </>
  );
}

function Critical({ period }) {
  const rows = useLiveQuery(async () => {
    const calls = (await db().critical_calls.toArray()).filter((c) => c.informed_at.slice(0, 10) >= period.from && c.informed_at.slice(0, 10) <= period.to);
    const accs = Object.fromEntries((await db().accessions.bulkGet([...new Set(calls.map((c) => c.accession_id))])).filter(Boolean).map((a) => [a.id, a]));
    return calls.sort((a, b) => b.informed_at.localeCompare(a.informed_at)).map((c) => ({ ...c, acc: accs[c.accession_id] }));
  }, [period.from, period.to], []);
  return (
    <div className="panel flush"><table className="t compact">
      <thead><tr><th>When</th><th>Case</th><th>Value</th><th>Informed</th></tr></thead>
      <tbody>{rows.map((c) => <tr key={c.id}><td className="nowrap">{fmtDateTime(c.informed_at)}</td><td>{c.acc && <Link to={`/cases/${c.acc.id}`}>{c.acc.acc_number}</Link>}</td><td>{c.parameter}: <b>{c.value}</b></td><td>{c.informed_to}<div className="faint">{c.note}</div></td></tr>)}</tbody>
    </table>{!rows.length && <Empty>No critical values were called in this period.</Empty>}</div>
  );
}


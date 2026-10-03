import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db.js';
import { useAuth } from '../lib/auth.jsx';
import { attach, equipmentDue, stockLevels, summary } from '../lib/reports.js';
import { addDays, fmtDateTime, fmtTime, todayISO } from '../lib/format.js';
import { useNow } from '../lib/hooks.js';
import { Caps, DueBadge, Empty, Figures, useMoney } from '../components/ui.jsx';
import { patientName } from '../components/patients.jsx';

const LANES = [
  ['sample', 'Sample pending', 'amber'],
  ['lab', 'In the lab', 'blue'],
  ['verify', 'To verify', 'violet'],
  ['ready', 'Report ready', 'green'],
];

export default function Today() {
  const { isAdmin, can } = useAuth();
  const m = useMoney();
  const now = useNow();
  const today = todayISO();
  const data = useLiveQuery(async () => {
    // today's cases, plus anything older that is not finished yet
    const recent = (await db().accessions.where('reg_date').between(addDays(today, -60), today, true, true).toArray()).filter((a) => !a.deleted_at);
    const cases = await attach(recent);
    const board = cases.filter((c) => c.reg_date === today || (c.progress.state !== 'ready' && c.progress.state !== 'cancelled'));
    const [sum, stock, eq, qcBad] = await Promise.all([
      summary(today, today), stockLevels(), equipmentDue(),
      db().qc_runs.filter((r) => !r.deleted_at && r.status === 'reject' && r.run_at >= addDays(today, -1)).count(),
    ]);
    return { board, sum, stock, eq, qcBad };
  }, [today], null);
  if (!data) return null;
  const { board, sum, stock, eq, qcBad } = data;
  const nowIso = new Date(now).toISOString();
  const lane = (k) => board.filter((c) => (k === 'lab' ? ['lab', 'partial'].includes(c.progress.state) : c.progress.state === k))
    .sort((a, b) => (b.priority === 'urgent') - (a.priority === 'urgent') || a.registered_at.localeCompare(b.registered_at));
  const overdue = board.flatMap((c) => c.tests.filter((t) => t.due_at && t.due_at < nowIso && ['pending', 'collected', 'entered'].includes(t.status)));
  const homeToday = board.filter((c) => c.home_collection && c.home_status === 'scheduled');
  const low = stock.filter((s) => s.low || s.expired.length || s.expiringSoon.length);
  const eqDue = eq.filter((e) => e.overdue || e.dueSoon);
  const showMoney = isAdmin || can('payments');

  return (
    <>
      <div className="page-head">
        <div><h1>Today</h1><div className="sub">{new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div></div>
        <div className="grow" />
        <Link className="btn primary big" to="/register">New patient / test</Link>
      </div>

      <Figures items={[
        { label: 'Patients today', value: sum.patients, hint: `${sum.testCount} tests` },
        showMoney && { label: 'Revenue today', value: m(sum.revenue), to: '/billing' },
        showMoney && { label: 'Cash in hand today', value: m(sum.netCash), hint: sum.refunds ? `after ${m(sum.refunds)} refunds` : null, to: '/billing?tab=cash' },
        showMoney && { label: 'Unpaid today', value: m(sum.due), tone: sum.due > 0 ? 'bad' : '', to: '/billing?tab=dues' },
        { label: 'Late tests', value: overdue.length, tone: overdue.length ? 'bad' : 'good', to: '/worklist?late=1' },
      ]} />

      {(homeToday.length > 0 || low.length > 0 || eqDue.length > 0 || qcBad > 0) && (
        <div className="stack" style={{ marginBottom: 16 }}>
          {homeToday.length > 0 && <div className="note">Home collection: {homeToday.map((c) => <Link key={c.id} to={`/cases/${c.id}`} style={{ marginRight: 10 }}>{c.patient?.full_name}{c.home_time ? ` (${fmtTime(new Date(c.home_time).toTimeString().slice(0, 5))})` : ''}</Link>)}</div>}
          {qcBad > 0 && <div className="note bad">Quality control failed in the last day. <Link to="/qc">Check QC before reporting</Link></div>}
          {low.length > 0 && <div className="note warn">Stock: {low.slice(0, 5).map((s) => `${s.name}${s.low ? ' (low)' : ''}${s.expired.length ? ' (expired lot)' : s.expiringSoon.length ? ' (expiring soon)' : ''}`).join(', ')}. <Link to="/stock">Open stock</Link></div>}
          {eqDue.length > 0 && <div className="note warn">Equipment: {eqDue.map((e) => `${e.name}${e.overdue ? ' — overdue' : ' — due this week'}`).join(', ')}. <Link to="/equipment">Open equipment</Link></div>}
        </div>
      )}

      <div className="lanes">
        {LANES.map(([k, label, color]) => {
          const list = lane(k);
          return (
            <div className="lane" key={k}>
              <div className="lane-head"><span className={`dot`} style={{ color: `var(--${color})` }} />{label}<span className="n">{list.length}</span></div>
              {list.map((c) => {
                const late = c.tests.some((t) => t.due_at && t.due_at < nowIso && ['pending', 'collected', 'entered'].includes(t.status));
                return (
                  <Link key={c.id} to={`/cases/${c.id}`} className={`case ${c.priority === 'urgent' ? 'urgent' : ''} ${late ? 'late' : ''}`}>
                    <div className="top"><b>{patientName(c.patient)}</b><span className="faint">{c.acc_number}</span></div>
                    <div className="meta">
                      <Caps tests={c.tests} />
                      <span>{c.tests.filter((t) => t.status !== 'cancelled').length} tests</span>
                      {c.reg_date !== today && <span>{fmtDateTime(c.registered_at)}</span>}
                      {c.report_due_at && k !== 'ready' && <span className={late ? 'flag-high' : ''}>due {fmtDateTime(c.report_due_at)}</span>}
                      {showMoney && <DueBadge bill={c.bill} />}
                    </div>
                  </Link>
                );
              })}
              {!list.length && <div className="faint" style={{ padding: '6px 4px' }}>Nothing here.</div>}
            </div>
          );
        })}
      </div>
      {!board.length && <Empty><b>No patients yet today.</b>Register the first patient to start the day.</Empty>}
    </>
  );
}

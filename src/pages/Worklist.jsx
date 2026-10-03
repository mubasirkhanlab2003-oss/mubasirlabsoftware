import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db.js';
import * as A from '../lib/actions.js';
import { useAuth } from '../lib/auth.jsx';
import { useNow } from '../lib/hooks.js';
import { fmtDateTime } from '../lib/format.js';
import { Empty, TestBadge, useAction } from '../components/ui.jsx';
import ResultEntry from '../components/ResultEntry.jsx';
import { ResultSummary } from './Case.jsx';

const STATUS = [['collected', 'To do'], ['entered', 'To verify'], ['pending', 'Sample pending'], ['verified', 'Verified today'], ['open', 'All open']];

// The bench view: every test waiting for work, by department.
export default function Worklist() {
  const [sp, setSp] = useSearchParams();
  const status = sp.get('status') || 'collected';
  const dept = sp.get('dept') || '';
  const lateOnly = sp.get('late') === '1';
  const [q, setQ] = useState('');
  const [entry, setEntry] = useState(null);
  const [picked, setPicked] = useState([]);
  const { user, can, isAdmin } = useAuth();
  const run = useAction();
  const now = useNow();
  const nowIso = new Date(now).toISOString();
  const data = useLiveQuery(async () => {
    const want = status === 'open' ? ['pending', 'collected', 'entered'] : [status];
    let rows = await db().accession_tests.where('status').anyOf(want).toArray();
    if (status === 'verified') { const d = new Date(); d.setHours(0, 0, 0, 0); rows = rows.filter((r) => r.verified_at >= d.toISOString()); }
    const accs = Object.fromEntries((await db().accessions.bulkGet([...new Set(rows.map((r) => r.accession_id))])).filter(Boolean).map((a) => [a.id, a]));
    rows = rows.filter((r) => accs[r.accession_id] && !accs[r.accession_id].deleted_at);
    const pts = Object.fromEntries((await db().patients.bulkGet([...new Set(rows.map((r) => r.patient_id || accs[r.accession_id].patient_id))])).filter(Boolean).map((p) => [p.id, p]));
    const specs = Object.fromEntries((await db().specimens.bulkGet([...new Set(rows.map((r) => r.specimen_id).filter(Boolean))])).filter(Boolean).map((s) => [s.id, s]));
    const counts = {};
    for (const r of rows) counts[r.department || 'General'] = (counts[r.department || 'General'] || 0) + 1;
    return { rows, accs, pts, specs, counts };
  }, [status], null);
  if (!data) return null;
  const s = q.trim().toLowerCase();
  const list = data.rows.filter((r) => {
    const a = data.accs[r.accession_id], p = data.pts[r.patient_id || a.patient_id];
    if (dept && (r.department || 'General') !== dept) return false;
    if (lateOnly && !(r.due_at && r.due_at < nowIso)) return false;
    if (!s) return true;
    return (p?.full_name || '').toLowerCase().includes(s) || a.acc_number.toLowerCase().includes(s) || r.test_name.toLowerCase().includes(s)
      || (data.specs[r.specimen_id]?.specimen_number || '').toLowerCase() === s;
  }).sort((a, b) => {
    const ua = data.accs[a.accession_id].priority === 'urgent', ub = data.accs[b.accession_id].priority === 'urgent';
    return (ub - ua) || (a.due_at || '9').localeCompare(b.due_at || '9');
  });
  const mayVerify = isAdmin || can('verify');
  const set = (k, v) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n); setPicked([]); };

  return (
    <>
      <div className="page-head">
        <div><h1>Worklist and results</h1><div className="sub">Scan a sample barcode or click a test to enter its result.</div></div>
        <div className="grow" />
        {status === 'entered' && mayVerify && picked.length > 0 && (
          <button className="btn primary" onClick={async () => { await run(() => A.verifyTests(list.filter((r) => picked.includes(r.id)), { userId: user?.id }), `${picked.length} verified`); setPicked([]); }}>Verify {picked.length} selected</button>
        )}
      </div>
      <div className="tabs">{STATUS.map(([k, l]) => <button key={k} className={status === k ? 'on' : ''} onClick={() => set('status', k)}>{l}</button>)}</div>
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="chips">
          <button className={`chip ${!dept ? 'on' : ''}`} onClick={() => set('dept', '')}>All departments <b>{data.rows.length}</b></button>
          {Object.entries(data.counts).sort().map(([d, n]) => <button key={d} className={`chip ${dept === d ? 'on' : ''}`} onClick={() => set('dept', d)}>{d} <b>{n}</b></button>)}
          <button className={`chip ${lateOnly ? 'on' : ''}`} onClick={() => set('late', lateOnly ? '' : '1')}>Late only</button>
        </div>
        <div className="spacer" />
        <input style={{ maxWidth: 280 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Patient, case, test or barcode"
          onKeyDown={(e) => { if (e.key === 'Enter' && list.length === 1 && list[0].status !== 'verified') setEntry(list[0]); }} />
      </div>
      <div className="panel flush">
        <div className="table-wrap">
          <table className="t">
            <thead><tr>
              {status === 'entered' && mayVerify && <th><input type="checkbox" checked={picked.length === list.length && list.length > 0} onChange={(e) => setPicked(e.target.checked ? list.map((r) => r.id) : [])} aria-label="Select all" /></th>}
              <th>Patient</th><th>Test</th><th>Sample</th><th>Status</th><th>Due</th><th />
            </tr></thead>
            <tbody>
              {list.map((r) => {
                const a = data.accs[r.accession_id], p = data.pts[r.patient_id || a.patient_id], sp2 = data.specs[r.specimen_id];
                const late = r.due_at && r.due_at < nowIso && r.status !== 'verified';
                return (
                  <tr key={r.id}>
                    {status === 'entered' && mayVerify && <td><input type="checkbox" checked={picked.includes(r.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, r.id] : picked.filter((x) => x !== r.id))} aria-label="Select" /></td>}
                    <td><Link to={`/cases/${a.id}`}><b>{p?.full_name}</b></Link> <span className="faint">{a.acc_number}</span>{a.priority === 'urgent' && <span className="badge solid-red" style={{ marginLeft: 6 }}>Urgent</span>}</td>
                    <td><b>{r.test_name}</b><div className="faint">{r.department}</div>{r.status !== 'collected' && r.status !== 'pending' && <div className="res-line"><ResultSummary t={r} /></div>}</td>
                    <td className="faint">{sp2 ? sp2.specimen_number : r.sample_type}</td>
                    <td><TestBadge s={r.status} /></td>
                    <td className={late ? 'flag-high nowrap' : 'faint nowrap'}>{r.due_at ? fmtDateTime(r.due_at) : ''}</td>
                    <td className="right nowrap">
                      {r.status !== 'verified' && <button className="btn small primary" onClick={() => setEntry(r)}>{r.status === 'entered' ? 'Review' : 'Enter result'}</button>}
                      {r.status === 'entered' && mayVerify && <button className="btn small" style={{ marginLeft: 4 }} onClick={() => run(() => A.verifyTests([r], { userId: user?.id }), 'Verified')}>Verify</button>}
                      {r.status === 'verified' && <Link className="btn small" to={`/print/report/${a.id}`}>Report</Link>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!list.length && <Empty><b>Nothing waiting here.</b>{status === 'collected' ? 'Tests appear when their sample is taken.' : ''}</Empty>}
        </div>
      </div>
      {entry && <ResultEntry row={entry} acc={data.accs[entry.accession_id]} patient={data.pts[entry.patient_id || data.accs[entry.accession_id].patient_id]} onClose={() => setEntry(null)} />}
    </>
  );
}

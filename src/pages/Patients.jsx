import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db.js';
import { searchPatients } from '../lib/actions.js';
import { ageLabel, fmtDate, genderLabel } from '../lib/format.js';
import { Empty } from '../components/ui.jsx';

export default function Patients() {
  const [q, setQ] = useState('');
  const nav = useNavigate();
  const all = useLiveQuery(() => db().patients.toArray(), [], []);
  const last = useLiveQuery(async () => {
    const accs = (await db().accessions.toArray()).filter((a) => !a.deleted_at);
    const m = {};
    for (const a of accs) if (!m[a.patient_id] || a.registered_at > m[a.patient_id].registered_at) m[a.patient_id] = a;
    const n = {};
    for (const a of accs) n[a.patient_id] = (n[a.patient_id] || 0) + 1;
    return { m, n };
  }, [], { m: {}, n: {} });
  const list = searchPatients(all, q).sort((a, b) => (last.m[b.id]?.registered_at || b.created_at || '').localeCompare(last.m[a.id]?.registered_at || a.created_at || '')).slice(0, 200);
  return (
    <>
      <div className="page-head">
        <div><h1>Patients</h1><div className="sub">{all.filter((p) => !p.deleted_at).length} master profiles</div></div>
        <div className="grow" />
        <Link className="btn primary" to="/register">New patient / test</Link>
      </div>
      <div className="panel flush">
        <div style={{ padding: 14 }}><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, MR number, phone or CNIC" /></div>
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>Patient</th><th>MR</th><th>Age / sex</th><th>Phone</th><th className="r">Visits</th><th>Last visit</th></tr></thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id} className="click" onClick={() => nav(`/patients/${p.id}`)}>
                  <td><b>{[p.title, p.full_name].filter(Boolean).join(' ')}</b>{p.guardian && <div className="faint">{p.guardian}</div>}</td>
                  <td>{p.mr_number}</td>
                  <td>{ageLabel(p.dob)} {genderLabel(p.gender)}</td>
                  <td>{p.phone}</td>
                  <td className="r">{last.n[p.id] || 0}</td>
                  <td className="faint">{last.m[p.id] ? fmtDate(last.m[p.id].reg_date) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!list.length && <Empty><b>No patient found.</b><Link to="/register">Register a new patient</Link></Empty>}
        </div>
      </div>
    </>
  );
}

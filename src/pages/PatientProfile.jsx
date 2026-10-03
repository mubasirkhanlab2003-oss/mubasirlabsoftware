import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db.js';
import * as A from '../lib/actions.js';
import { patientAccount } from '../lib/reports.js';
import { useAuth } from '../lib/auth.jsx';
import { usePatient, useSettings } from '../lib/hooks.js';
import { toNum } from '../lib/results.js';
import { fmtDate, waNumber } from '../lib/format.js';
import { Caps, DeleteButton, DueBadge, Empty, Figures, Modal, Money, StateBadge, useAction, useMoney } from '../components/ui.jsx';
import { PatientForm, PatientSearch, patientLine, patientName } from '../components/patients.jsx';
import { TrendChart } from '../components/charts.jsx';
import { portalLink } from './Case.jsx';

export default function PatientProfile() {
  const { id } = useParams();
  const nav = useNavigate();
  const patient = usePatient(id);
  const settings = useSettings();
  const { isAdmin, can } = useAuth();
  const run = useAction();
  const m = useMoney();
  const account = useLiveQuery(() => patientAccount(id), [id], null);
  const membership = useLiveQuery(() => (patient?.membership_id ? db().memberships.get(patient.membership_id) : null), [patient?.membership_id]);
  const [edit, setEdit] = useState(false);
  const [merge, setMerge] = useState(false);
  const [showPin, setShowPin] = useState(false);
  if (patient === undefined) return null;
  if (!patient) return <Empty><b>Patient not found on this device.</b></Empty>;
  const cases = (account?.cases || []).sort((a, b) => b.registered_at.localeCompare(a.registered_at));
  const link = portalLink(settings, patient);

  return (
    <>
      {patient.deleted_at && <div className="note bad" style={{ marginBottom: 14 }}>
        {patient.merged_into ? <>This profile was merged into another one. <Link to={`/patients/${patient.merged_into}`}>Open the kept profile</Link></>
          : <>This patient is in the Recycle Bin ({patient.delete_reason}). <button className="btn small" onClick={() => run(() => A.restorePatient(patient), 'Patient and their cases restored')}>Restore</button></>}
      </div>}
      <div className="page-head">
        <div>
          <h1>{patientName(patient)}</h1>
          <div className="sub">{patientLine(patient)}</div>
          <div className="faint">
            {[patient.guardian && `Father/husband: ${patient.guardian}`, patient.cnic && `CNIC ${patient.cnic}`, patient.address, patient.email, `Registered ${fmtDate(patient.created_at)}`].filter(Boolean).join(' · ')}
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            {patient.notes && <span className="badge amber">{patient.notes}</span>}
            {membership && <span className="badge teal">{membership.name} {patient.membership_no || ''}{patient.membership_until ? ` · until ${fmtDate(patient.membership_until)}` : ''}</span>}
          </div>
        </div>
        <div className="grow" />
        {!patient.deleted_at && <div className="row">
          <Link className="btn primary" to={`/register?patient=${patient.id}`}>New test for this patient</Link>
          <button className="btn" onClick={() => setEdit(true)}>Edit</button>
          <Link className="btn" to={`/print/cumulative/${patient.id}`}>Cumulative report</Link>
        </div>}
      </div>

      <Figures items={[
        { label: 'Visits', value: cases.length },
        { label: 'Total billed', value: m(account?.total || 0) },
        { label: 'Paid', value: m(account?.paid || 0) },
        { label: 'Due', value: m(account?.due || 0), tone: account?.due > 0 ? 'bad' : 'good' },
      ]} />

      <div className="split">
        <div>
          <div className="panel flush">
            <div className="panel-head"><h2>Visits and reports</h2></div>
            <div className="table-wrap">
              <table className="t">
                <thead><tr><th>Date</th><th>Case</th><th>Tests</th><th>Status</th><th className="r">Bill</th><th /></tr></thead>
                <tbody>
                  {cases.map((c) => (
                    <tr key={c.id} className="click" onClick={() => nav(`/cases/${c.id}`)}>
                      <td className="nowrap">{fmtDate(c.reg_date)}</td>
                      <td>{c.acc_number}</td>
                      <td><Caps tests={c.tests} /> <span className="faint">{c.tests.filter((t) => t.status !== 'cancelled').map((t) => t.test_code || t.test_name).join(', ')}</span></td>
                      <td><StateBadge s={c.progress.state} /></td>
                      <td className="r nowrap"><Money v={c.bill.total} /> <DueBadge bill={c.bill} /></td>
                      <td className="right" onClick={(e) => e.stopPropagation()}>{c.progress.verified > 0 && <Link className="btn small" to={`/print/report/${c.id}`}>Report</Link>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!cases.length && <Empty><b>No visits yet.</b><Link to={`/register?patient=${patient.id}`}>Book the first tests</Link></Empty>}
            </div>
          </div>
          <Trends patientId={patient.id} />
        </div>

        <div className="sticky">
          <div className="panel">
            <h2>Online reports</h2>
            <p className="muted">The patient opens this link and types the PIN to see all their reports. The link and PIN are also printed on the receipt.</p>
            <div className="stack">
              <input readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Patient report link" />
              <div className="row">PIN: <b>{showPin ? patient.portal_pin : '••••'}</b>
                <button className="btn small ghost" onClick={() => setShowPin(!showPin)}>{showPin ? 'Hide' : 'Show'}</button>
                <span className="spacer" />
                <button className="btn small" onClick={() => run(() => A.resetPortalPin(patient), 'New PIN made')}>New PIN</button>
              </div>
              {patient.phone && <button className="btn" onClick={() => {
                const t = `Assalam o Alaikum ${patient.full_name},\nAll your lab reports from ${settings?.lab_name || 'our lab'}:\n${link}\nPIN: ${patient.portal_pin}`;
                window.open(`https://wa.me/${waNumber(patient.phone, settings?.phone_country_code || '92')}?text=${encodeURIComponent(t)}`, '_blank', 'noopener');
              }}>Send link on WhatsApp</button>}
            </div>
          </div>
          {!patient.deleted_at && (isAdmin || can('register')) && (
            <div className="panel">
              <h2>Profile tools</h2>
              <div className="stack">
                <button className="btn" onClick={() => setMerge(true)}>Merge a duplicate profile into this one</button>
                <DeleteButton label="Delete patient" className="btn danger" title={`Delete ${patient.full_name}`}
                  message={`All ${cases.length} visit(s) of this patient are deleted with them: their bills, payments and doctor commission leave every report. Restore brings everything back.`}
                  onConfirm={async (r) => { const ok = await run(() => A.deletePatient(patient, r).then(() => true), 'Patient moved to the Recycle Bin'); if (ok) nav('/patients'); return !!ok; }} />
              </div>
            </div>
          )}
        </div>
      </div>

      {edit && <Modal wide title="Edit patient" onClose={() => setEdit(false)}><PatientForm initial={patient} onCancel={() => setEdit(false)} onSaved={() => setEdit(false)} /></Modal>}
      {merge && <MergeModal keep={patient} onClose={() => setMerge(false)} />}
    </>
  );
}

function Trends({ patientId }) {
  const rows = useLiveQuery(async () => {
    const tests = (await db().accession_tests.where('patient_id').equals(patientId).toArray()).filter((t) => t.status === 'verified');
    const accs = Object.fromEntries((await db().accessions.bulkGet([...new Set(tests.map((t) => t.accession_id))])).filter(Boolean).map((a) => [a.id, a]));
    return tests.filter((t) => accs[t.accession_id] && !accs[t.accession_id].deleted_at).sort((a, b) => a.verified_at.localeCompare(b.verified_at));
  }, [patientId], []);
  const series = useMemo(() => {
    const m = new Map();
    for (const t of rows) for (const r of t.results || []) {
      const v = toNum(r.value);
      if (!Number.isFinite(v)) continue;
      const key = r.code || r.name;
      if (!m.has(key)) m.set(key, { name: r.name, unit: r.unit, low: r.ref_low, high: r.ref_high, points: [] });
      m.get(key).points.push({ y: v, label: fmtDate(t.verified_at).slice(0, 6) });
    }
    return [...m.entries()].filter(([, s]) => s.points.length >= 2);
  }, [rows]);
  const [pick, setPick] = useState('');
  if (!series.length) return null;
  const cur = series.find(([k]) => k === pick) || series[0];
  return (
    <div className="panel">
      <div className="panel-head"><h2>Results over time</h2><div className="grow" />
        <select style={{ width: 'auto' }} value={cur[0]} onChange={(e) => setPick(e.target.value)}>{series.map(([k, s]) => <option key={k} value={k}>{s.name}</option>)}</select></div>
      <TrendChart points={cur[1].points} low={cur[1].low} high={cur[1].high} unit={cur[1].unit} />
    </div>
  );
}

function MergeModal({ keep, onClose }) {
  const [dup, setDup] = useState(null);
  const run = useAction();
  return (
    <Modal wide title={`Merge into ${keep.full_name} (${keep.mr_number})`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={!dup || dup.id === keep.id} onClick={async () => { const ok = await run(() => A.mergePatients(keep, dup).then(() => true), 'Profiles merged'); if (ok) onClose(); }}>Merge</button>
    </>}>
      <p className="muted" style={{ marginTop: 0 }}>Find the duplicate profile. All its visits, bills and reports move here; the duplicate is closed.</p>
      {dup ? <div className="note row"><span><b>{dup.full_name}</b> · {patientLine(dup)}</span><span className="spacer" /><button className="btn small" onClick={() => setDup(null)}>Change</button></div>
        : <PatientSearch onPick={(p) => setDup(p)} />}
    </Modal>
  );
}

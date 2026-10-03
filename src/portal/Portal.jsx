// Public pages: patient reports, referring-doctor portal, report check.
// They talk to the server only through three read-only functions; the
// secret link + PIN decide what is shown. Nothing here can change data.
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';
import { fmtDate, fmtDateTime, money, monthStart, todayISO, addMonths, monthEnd } from '../lib/format.js';
import ReportBody, { useQr } from '../print/ReportBody.jsx';
import { downloadBlob, makePdf } from '../print/Documents.jsx';

const PIN_KEY = (k) => `lis_pin_${k}`;
const readPin = (k) => { try { return sessionStorage.getItem(PIN_KEY(k)) || ''; } catch { return ''; } };
const savePin = (k, v) => { try { sessionStorage.setItem(PIN_KEY(k), v); } catch { /* ignore */ } };

function Shell({ lab, children }) {
  useEffect(() => { if (lab?.lab_name) document.title = lab.lab_name; }, [lab?.lab_name]);
  return (
    <div className="portal">
      {lab && (
        <div className="portal-head">
          {lab.logo ? <img src={lab.logo} alt="" /> : <span className="brand-mark"><i /></span>}
          <div><h1 style={{ fontSize: 20 }}>{lab.lab_name}</h1><div className="faint">{[lab.address, lab.phone].filter(Boolean).join(' · ')}</div></div>
        </div>
      )}
      {children}
    </div>
  );
}

function PinForm({ title, onSubmit, error, busy }) {
  const [pin, setPin] = useState('');
  return (
    <div className="pin-box panel">
      <span className="brand-mark" style={{ marginBottom: 12 }}><i /></span>
      <h1 style={{ fontSize: 20, marginBottom: 6 }}>{title}</h1>
      <p className="muted">Enter the PIN printed on your receipt or sent on WhatsApp.</p>
      <form onSubmit={(e) => { e.preventDefault(); onSubmit(pin); }} className="stack">
        <input autoFocus inputMode="numeric" maxLength={8} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} aria-label="PIN" />
        {error && <div className="error-text">{error}</div>}
        <button className="btn primary big" disabled={busy || pin.length < 4}>{busy ? 'Opening…' : 'Open'}</button>
      </form>
    </div>
  );
}

async function call(fn, args) {
  if (!supabase) throw new Error('This page is not connected to the server.');
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(/fetch|network/i.test(error.message) ? 'No internet connection.' : error.message);
  return data;
}

function ReportView({ lab, patient, c, onBack }) {
  const ref = useRef(null);
  const [busy, setBusy] = useState(false);
  const qr = useQr(`${(lab.public_url || location.origin).replace(/\/$/, '')}/v/${c.verify_code}`);
  const tests = c.tests.filter((t) => t.status === 'verified');
  const data = {
    lab: { ...lab, public_url: (lab.public_url || location.origin).replace(/\/$/, ''), report_mode: 'full' }, pathologists: lab.pathologists || [], patient,
    acc: { acc_number: c.acc_number, registered_at: c.registered_at, doctor: c.doctor, verify_code: c.verify_code },
    tests, pending: c.tests.filter((t) => t.status !== 'verified').map((t) => t.test_name),
  };
  return (
    <div>
      <div className="row no-print" style={{ marginBottom: 12 }}>
        <button className="btn" onClick={onBack}>Back</button><div className="spacer" />
        <button className="btn" onClick={() => window.print()}>Print</button>
        <button className="btn primary" disabled={busy} onClick={async () => { setBusy(true); try { downloadBlob(await makePdf(ref.current, `Report-${c.acc_number}.pdf`), `Report-${c.acc_number}.pdf`); } finally { setBusy(false); } }}>{busy ? 'Making PDF…' : 'Download PDF'}</button>
      </div>
      <div className="paper-wrap" style={{ padding: 0 }}><div className="paper" ref={ref}><ReportBody data={data} qr={qr} /></div></div>
    </div>
  );
}

function CaseList({ cases, onOpen, showPatient }) {
  return (
    <div className="panel flush"><div className="table-wrap">
      <table className="t">
        <thead><tr><th>Date</th>{showPatient && <th>Patient</th>}<th className="hide-sm">Tests</th><th>Report</th></tr></thead>
        <tbody>{cases.map((c) => {
          const done = c.tests.filter((t) => t.status === 'verified').length;
          return (
            <tr key={c.id}>
              <td className="nowrap">{fmtDate(c.reg_date)}<div className="faint">{c.acc_number}</div></td>
              {showPatient && <td><b>{c.patient?.full_name}</b><div className="faint">{c.patient?.mr_number}</div></td>}
              <td className="hide-sm">{c.tests.map((t) => t.test_name).join(', ')}</td>
              <td className="nowrap">
                {c.locked ? <span className="badge amber">Pending payment</span>
                  : done ? <button className="btn small primary" onClick={() => onOpen(c)}>{done === c.tests.length ? 'View report' : `View ${done} ready`}</button>
                    : <span className="badge blue">In process</span>}
              </td>
            </tr>
          );
        })}</tbody>
      </table>
      {!cases.length && <div className="empty">Nothing here yet.</div>}
    </div></div>
  );
}

export function PatientPortal() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null);
  async function go(pin) {
    setBusy(true); setErr('');
    try {
      const d = await call('portal_patient', { p_token: token, p_pin: pin });
      if (d?.error) { setErr('Wrong PIN, or this link is not valid.'); return; }
      savePin(token, pin); setData(d);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  useEffect(() => { const p = readPin(token); if (p) go(p); }, [token]); // eslint-disable-line
  if (!data) return <Shell><PinForm title="Your lab reports" onSubmit={go} error={err} busy={busy} /></Shell>;
  return (
    <Shell lab={data.lab}>
      {open ? <ReportView lab={data.lab} patient={data.patient} c={open} onBack={() => setOpen(null)} /> : (
        <>
          <h2 style={{ fontSize: 22 }}>{data.patient.full_name}</h2>
          <p className="muted">{data.patient.mr_number} · all your visits to {data.lab.lab_name}</p>
          <CaseList cases={data.cases} onOpen={setOpen} />
        </>
      )}
    </Shell>
  );
}

export function DoctorPortal() {
  const { token } = useParams();
  const [pin, setPin] = useState(readPin(token));
  const [from, setFrom] = useState(monthStart(todayISO()));
  const [to, setTo] = useState(todayISO());
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null);
  const [q, setQ] = useState('');
  async function go(p = pin, f = from, t = to) {
    setBusy(true); setErr('');
    try {
      const d = await call('portal_doctor', { p_token: token, p_pin: p, p_from: f, p_to: t });
      if (d?.error) { setErr('Wrong PIN, or this link is not valid.'); setData(null); return; }
      savePin(token, p); setPin(p); setData(d);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  useEffect(() => { if (pin) go(pin); }, [token]); // eslint-disable-line
  if (!data) return <Shell><PinForm title="Doctor portal" onSubmit={(p) => go(p)} error={err} busy={busy} /></Shell>;
  const m = (v) => money(v, data.lab.currency || 'Rs');
  const cases = data.cases.filter((c) => !q || c.patient.full_name.toLowerCase().includes(q.toLowerCase()) || c.patient.mr_number.toLowerCase().includes(q.toLowerCase()));
  const lm = addMonths(monthStart(todayISO()), -1);
  return (
    <Shell lab={data.lab}>
      {open ? <ReportView lab={data.lab} patient={open.patient} c={open} onBack={() => setOpen(null)} /> : (
        <>
          <h2 style={{ fontSize: 22 }}>{data.doctor.full_name}</h2>
          <div className="row" style={{ marginBottom: 12 }}>
            <div className="chips">
              <button className="chip" onClick={() => { const f = todayISO(); setFrom(f); setTo(f); go(pin, f, f); }}>Today</button>
              <button className="chip" onClick={() => { const f = monthStart(todayISO()); setFrom(f); setTo(todayISO()); go(pin, f, todayISO()); }}>This month</button>
              <button className="chip" onClick={() => { setFrom(lm); setTo(monthEnd(lm)); go(pin, lm, monthEnd(lm)); }}>Last month</button>
            </div>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 150 }} aria-label="From" />
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 150 }} aria-label="To" />
            <button className="btn small" onClick={() => go()}>Show</button>
          </div>
          <div className="figures">
            <div className="stat"><span>Patients ({fmtDate(data.from)} – {fmtDate(data.to)})</span><b>{new Set(data.cases.map((c) => c.patient.mr_number)).size}</b></div>
            <div className="stat"><span>Tests</span><b>{data.cases.reduce((s, c) => s + c.tests.length, 0)}</b></div>
            {data.account && <>
              <div className="stat"><span>Commission this period</span><b>{m(data.cases.reduce((s, c) => s + Number(c.commission || 0), 0))}</b></div>
              <div className="stat warn"><span>Balance to receive</span><b>{m(data.account.balance)}</b></div>
            </>}
          </div>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find patient" style={{ marginBottom: 10 }} />
          <CaseList cases={cases} onOpen={setOpen} showPatient />
          {data.account && data.account.payouts?.length > 0 && (
            <div className="panel" style={{ marginTop: 16 }}><h2>Payments received from the lab</h2>
              <table className="t compact"><tbody>{data.account.payouts.map((p) => <tr key={p.payout_number || p.paid_on}><td>{fmtDate(p.paid_on)}</td><td>{p.payout_number}</td><td className="r">{m(p.amount)}</td></tr>)}</tbody></table></div>
          )}
        </>
      )}
    </Shell>
  );
}

export function VerifyReport() {
  const { code } = useParams();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { call('verify_report', { p_code: code }).then(setD).catch((e) => setErr(e.message)); }, [code]);
  return (
    <Shell>
      <div className="pin-box panel">
        <h1 style={{ fontSize: 20 }}>Report check</h1>
        {err && <div className="error-text">{err}</div>}
        {!d && !err && <p className="muted">Checking…</p>}
        {d && !d.valid && <div className="note bad">This code does not match any report. The report may not be genuine.</div>}
        {d?.valid && (
          <div className="stack">
            <div className="note good"><b>Genuine report</b> issued by {d.lab_name}.</div>
            <table className="t compact"><tbody>
              <tr><td>Patient</td><td><b>{d.patient}</b> ({d.mr_number})</td></tr>
              <tr><td>Case</td><td>{d.acc_number} · {fmtDate(d.reg_date)}</td></tr>
              {d.tests.map((t) => <tr key={t.name}><td>{t.name}</td><td>Verified {fmtDateTime(t.verified_at)}{t.amended ? ' (amended)' : ''}</td></tr>)}
            </tbody></table>
            <p className="faint">Results are not shown here. Compare the test names and dates with the paper report.</p>
          </div>
        )}
      </div>
    </Shell>
  );
}

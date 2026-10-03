import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db.js';
import * as A from '../lib/actions.js';
import { useSettings, useTests } from '../lib/hooks.js';
import { billTotals, methodLabel } from '../lib/pricing.js';
import { doctorLedger, panelLedger } from '../lib/reports.js';
import { toNum } from '../lib/results.js';
import { fmtDate, fmtDateTime, money, round2, waNumber } from '../lib/format.js';
import ReportBody, { LabHeader, PatientBox, useQr } from './ReportBody.jsx';
import { portalLink } from '../pages/Case.jsx';

// Every document is built from the data at the moment it is opened.
// Nothing is uploaded: Print uses the browser, the PDF is made in memory.

export async function makePdf(el, filename, { format = 'a4' } = {}) {
  const { default: html2pdf } = await import('html2pdf.js');
  el.classList.add('pdf-mode');
  try {
    return await html2pdf().set({
      margin: 0, filename, image: { type: 'jpeg', quality: 0.95 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
      jsPDF: { unit: 'mm', format, orientation: 'portrait' },
      pagebreak: { mode: ['css', 'legacy'], avoid: ['.doc-test', 'tr'] },
    }).from(el).outputPdf('blob');
  } finally {
    el.classList.remove('pdf-mode');
  }
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function PrintShell({ title, filename, phone, shareText, children, paperClass = '', paperStyle, accId, docType, extra, pdfFormat }) {
  const nav = useNavigate();
  const settings = useSettings();
  const ref = useRef(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => { document.title = title || 'Print'; return () => { document.title = settings?.lab_name || 'Laboratory'; }; }, [title]); // eslint-disable-line

  async function pdf() {
    setBusy('pdf'); setMsg('');
    try { downloadBlob(await makePdf(ref.current, filename, { format: pdfFormat }), filename); if (accId) A.logPrint(accId, docType, 'pdf'); }
    catch (e) { setMsg('Could not create the PDF: ' + e.message); }
    finally { setBusy(''); }
  }
  async function whatsapp() {
    setBusy('wa'); setMsg('');
    try {
      const blob = await makePdf(ref.current, filename, { format: pdfFormat });
      const file = new File([blob], filename, { type: 'application/pdf' });
      if (accId) A.logPrint(accId, docType, 'whatsapp');
      if (navigator.canShare?.({ files: [file] })) {
        try { await navigator.share({ files: [file], title, text: shareText }); return; } catch (e) { if (e.name === 'AbortError') return; }
      }
      downloadBlob(blob, filename);
      const n = waNumber(phone, settings?.phone_country_code || '92');
      const text = encodeURIComponent(`${shareText}\n(PDF attached: ${filename})`);
      window.open(n ? `https://wa.me/${n}?text=${text}` : `https://wa.me/?text=${text}`, '_blank', 'noopener');
      setMsg('PDF downloaded. Attach it in the WhatsApp chat that opened.');
    } catch (e) { setMsg('Could not share: ' + e.message); } finally { setBusy(''); }
  }
  return (
    <div className="print-page">
      <div className="print-bar no-print">
        <button className="btn" onClick={() => nav(-1)}>Back</button>
        <div className="grow" />
        {extra}
        <button className="btn primary" disabled={!!busy} onClick={() => { if (accId) A.logPrint(accId, docType, 'print'); window.print(); }}>Print</button>
        <button className="btn" onClick={pdf} disabled={!!busy}>{busy === 'pdf' ? 'Making PDF…' : 'Download PDF'}</button>
        {shareText && <button className="btn" onClick={whatsapp} disabled={!!busy}>{busy === 'wa' ? 'Preparing…' : 'WhatsApp PDF'}</button>}
        {msg && <div className="note" style={{ width: '100%' }}>{msg}</div>}
      </div>
      <div className="paper-wrap"><div className={`paper ${paperClass}`} style={paperStyle} ref={ref}>{children}</div></div>
    </div>
  );
}

const Loading = () => <div className="center-page muted">Loading…</div>;
const NotHere = ({ what }) => <div className="content"><div className="panel"><h2>{what} not found on this device</h2><p className="muted">It may not have synced yet.</p></div></div>;

// Collect everything the report needs, from this device.
export async function reportData(accId, onlyIds = null) {
  const acc = await db().accessions.get(accId);
  if (!acc) return null;
  const [patient, settings, paths, tests, doctor, panel] = await Promise.all([
    db().patients.get(acc.patient_id), db().lab_settings.get(1), db().pathologists.toArray(),
    db().accession_tests.where('accession_id').equals(accId).toArray(),
    acc.doctor_id ? db().ref_doctors.get(acc.doctor_id) : null, acc.panel_id ? db().panels.get(acc.panel_id) : null,
  ]);
  const cat = Object.fromEntries((await db().lab_tests.bulkGet(tests.map((t) => t.test_id))).filter(Boolean).map((t) => [t.id, t]));
  const live = tests.filter((t) => t.status !== 'cancelled').sort((a, b) => (a.department || '').localeCompare(b.department || '') || (a.sort_order || 0) - (b.sort_order || 0));
  const done = live.filter((t) => t.status === 'verified' && (!onlyIds || onlyIds.includes(t.id)))
    .map((t) => ({ ...t, report_note: cat[t.test_id]?.report_note, method: cat[t.test_id]?.method, amended: t.amend_count > 0 }));
  return {
    lab: { ...(settings || {}), public_url: (settings?.public_url || location.origin).replace(/\/$/, '') },
    pathologists: paths.filter((p) => p.active !== false), patient,
    acc: { ...acc, doctor: doctor?.full_name || acc.doctor_text, panel: panel?.name },
    tests: done, pending: live.filter((t) => t.status !== 'verified').map((t) => t.test_name),
  };
}

export function LabReportDoc() {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const only = sp.get('tests') ? sp.get('tests').split(',') : null;
  const data = useLiveQuery(async () => (await reportData(id, only)) || false, [id, sp.get('tests')]);
  const qr = useQr(data ? `${data.lab.public_url}/v/${data.acc.verify_code}` : null);
  const bill = useLiveQuery(() => A.accessionBill(id), [id]);
  const [pick, setPick] = useState(false);
  if (data === undefined) return <Loading />;
  if (!data) return <NotHere what="Report" />;
  const letter = data.lab.report_mode === 'letterhead';
  const unpaid = data.lab.report_needs_payment && bill?.due > 0;
  return (
    <PrintShell title={`Report ${data.acc.acc_number}`} filename={`Report-${data.acc.acc_number}-${data.patient.full_name.replace(/\W+/g, '_')}.pdf`}
      phone={data.patient.phone} shareText={`Lab report ${data.acc.acc_number} — ${data.patient.full_name}`} accId={id} docType="report"
      paperClass={letter ? 'letterhead' : ''} paperStyle={letter ? { '--lh-top': `${data.lab.letterhead_top_mm}mm`, '--lh-bottom': `${data.lab.letterhead_bottom_mm}mm` } : undefined}
      extra={<>
        {unpaid && <span className="badge red">Bill not paid: {money(bill.due)}</span>}
        <button className="btn" onClick={() => setPick(!pick)}>Choose tests</button>
        <Link className="btn" to={`/print/cumulative/${data.patient.id}`}>Cumulative</Link>
      </>}>
      {pick && <TestPicker accId={id} only={only} />}
      {data.tests.length ? <ReportBody data={data} qr={qr} /> : <p>No verified results yet.</p>}
    </PrintShell>
  );
}

function TestPicker({ accId, only }) {
  const tests = useLiveQuery(() => db().accession_tests.where('accession_id').equals(accId).toArray(), [accId], []);
  const nav = useNavigate();
  const [sel, setSel] = useState(only || tests.filter((t) => t.status === 'verified').map((t) => t.id));
  useEffect(() => { if (!only) setSel(tests.filter((t) => t.status === 'verified').map((t) => t.id)); }, [tests.length]); // eslint-disable-line
  return (
    <div className="no-print note" style={{ marginBottom: 10 }}>
      <div className="chips">{tests.filter((t) => t.status === 'verified').map((t) => (
        <button key={t.id} className={`chip ${sel.includes(t.id) ? 'on' : ''}`} onClick={() => setSel(sel.includes(t.id) ? sel.filter((x) => x !== t.id) : [...sel, t.id])}>{t.test_name}</button>
      ))}</div>
      <button className="btn small" style={{ marginTop: 8 }} onClick={() => nav(`/print/report/${accId}?tests=${sel.join(',')}`, { replace: true })}>Show only these</button>
    </div>
  );
}

// ---------------------------------------------------------------- receipt
export function ReceiptDoc() {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const settings = useSettings();
  const d = useLiveQuery(async () => {
    const acc = await db().accessions.get(id);
    if (!acc) return false;
    const [patient, tests, pays, doctor, panel] = await Promise.all([
      db().patients.get(acc.patient_id), db().accession_tests.where('accession_id').equals(id).toArray(),
      db().bill_payments.where('accession_id').equals(id).toArray(),
      acc.doctor_id ? db().ref_doctors.get(acc.doctor_id) : null, acc.panel_id ? db().panels.get(acc.panel_id) : null,
    ]);
    const cat = Object.fromEntries((await db().lab_tests.bulkGet([...new Set(tests.map((t) => t.test_id).concat(tests.map((t) => t.package_id).filter(Boolean)))])).filter(Boolean).map((t) => [t.id, t]));
    return { acc, patient, tests, pays, doctor, panel, cat };
  }, [id]);
  const link = d ? portalLink(settings, d.patient) : null;
  const qr = useQr(link);
  if (d === undefined || !settings) return <Loading />;
  if (!d) return <NotHere what="Bill" />;
  const { acc, patient, tests, pays, doctor, panel, cat } = d;
  const bill = billTotals(acc, tests, pays);
  const live = tests.filter((t) => t.status !== 'cancelled').sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  // packages print as one line
  const lines = [];
  for (const t of live) {
    if (t.package_id) {
      let l = lines.find((x) => x.pkg === t.package_id);
      if (!l) { l = { pkg: t.package_id, name: cat[t.package_id]?.name || 'Package', price: 0, sub: [] }; lines.push(l); }
      l.price = round2(l.price + Number(t.price)); l.sub.push(t.test_code || t.test_name);
    } else lines.push({ name: t.test_name, price: t.price });
  }
  const instructions = [...new Set(live.map((t) => cat[t.test_id]?.instructions).filter(Boolean))];
  const thermal = settings.receipt_format === 'thermal';
  const m = (v) => money(v, settings.currency || 'Rs');
  return (
    <PrintShell title={`Receipt ${acc.acc_number}`} filename={`Receipt-${acc.acc_number}.pdf`} phone={patient.phone} accId={id} docType="receipt"
      shareText={`Receipt ${acc.acc_number} — ${patient.full_name}`} paperClass={thermal ? 'thermal' : ''} pdfFormat={thermal ? [80, 200] : 'a4'}
      extra={<Link className={`btn ${sp.get('labels') ? 'primary' : ''}`} to={`/print/labels/${id}`}>Labels</Link>}>
      {thermal ? (
        <div style={{ textAlign: 'center' }}>
          {settings.logo && <img src={settings.logo} alt="" width="48" height="48" />}
          <b style={{ display: 'block', fontSize: 14 }}>{settings.lab_name}</b>
          <div>{settings.address}</div><div>{settings.phone}</div>
        </div>
      ) : <LabHeader lab={settings} qr={qr} qrLabel="Your reports online" />}
      <div className="doc-title">{bill.paid >= bill.total ? 'PAYMENT RECEIPT' : 'BILL'}</div>
      {thermal ? (
        <div>
          <div><b>{patient.full_name}</b> · {patient.mr_number}</div>
          <div>Case {acc.acc_number} · {fmtDateTime(acc.registered_at)}</div>
          <div>Ref: {doctor?.full_name || acc.doctor_text || 'Self'}{panel ? ` · ${panel.name}` : ''}</div>
        </div>
      ) : (
        <PatientBox patient={patient} at={acc.registered_at} cells={[['Case No.', acc.acc_number], ['Date', fmtDateTime(acc.registered_at)], ['Referred by', doctor?.full_name || acc.doctor_text || 'Self'],
          ['Phone', patient.phone], ...(panel ? [['Panel', `${panel.name}${acc.bill_to === 'panel' ? ' (credit)' : ''}`]] : []), ['Report ready', acc.report_due_at ? fmtDateTime(acc.report_due_at) : '—']]} />
      )}
      <table className="doc" style={{ marginTop: 6 }}>
        <thead><tr><th>Test</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
        <tbody>
          {lines.map((l, i) => <tr key={i}><td>{l.name}{l.sub && <div style={{ fontSize: 10, color: '#555' }}>{l.sub.join(', ')}</div>}</td><td style={{ textAlign: 'right' }}>{m(l.price)}</td></tr>)}
          {bill.home > 0 && <tr><td>Home collection</td><td style={{ textAlign: 'right' }}>{m(bill.home)}</td></tr>}
          {bill.discount > 0 && <tr><td>Discount{acc.discount_reason ? ` (${acc.discount_reason})` : ''}</td><td style={{ textAlign: 'right' }}>−{m(bill.discount)}</td></tr>}
          <tr><td><b>Total</b></td><td style={{ textAlign: 'right' }}><b>{m(bill.total)}</b></td></tr>
          <tr><td>Paid{pays.filter((p) => !p.deleted_at && p.kind === 'payment').length ? ` (${[...new Set(pays.filter((p) => !p.deleted_at && p.kind === 'payment').map((p) => methodLabel(p.method)))].join(', ')})` : ''}</td><td style={{ textAlign: 'right' }}>{m(bill.paid)}</td></tr>
          {acc.bill_to === 'panel' ? <tr><td>Billed to {panel?.name}</td><td style={{ textAlign: 'right' }}>{m(bill.panel_due)}</td></tr>
            : <tr><td><b>Balance due</b></td><td style={{ textAlign: 'right' }}><b>{m(bill.due)}</b></td></tr>}
        </tbody>
      </table>
      {thermal && acc.report_due_at && <p style={{ margin: '6px 0 0' }}>Report ready: <b>{fmtDateTime(acc.report_due_at)}</b></p>}
      {instructions.length > 0 && <div style={{ marginTop: 8 }}><b>Instructions:</b><ul style={{ margin: '2px 0 0', paddingLeft: 16 }}>{instructions.map((x) => <li key={x}>{x}</li>)}</ul></div>}
      {link && (
        <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', border: '1px dashed #999', padding: 6, borderRadius: 6 }}>
          {thermal && qr && <img src={qr} alt="" width="70" height="70" />}
          <div>Your reports online: <b>{link.replace(/^https?:\/\//, '')}</b><br />PIN: <b style={{ fontSize: 14 }}>{patient.portal_pin}</b></div>
        </div>
      )}
      {settings.receipt_footer && <div className="doc-note">{settings.receipt_footer}</div>}
      <div className="doc-note" style={{ borderTop: 0 }}>Printed {fmtDateTime(new Date())}</div>
    </PrintShell>
  );
}

// ---------------------------------------------------------------- barcode labels
function Barcode({ value }) {
  const ref = useRef(null);
  useEffect(() => {
    let live = true;
    import('jsbarcode').then(({ default: JsBarcode }) => {
      if (live && ref.current) JsBarcode(ref.current, value, { format: 'CODE128', displayValue: false, margin: 0, height: 34, width: 1.4 });
    });
    return () => { live = false; };
  }, [value]);
  return <svg ref={ref} />;
}

export function LabelsDoc() {
  const { id } = useParams();
  const settings = useSettings();
  const [busy, setBusy] = useState(false);
  const d = useLiveQuery(async () => {
    const acc = await db().accessions.get(id);
    if (!acc) return false;
    const [patient, specs, tests] = await Promise.all([db().patients.get(acc.patient_id), db().specimens.where('accession_id').equals(id).toArray(), db().accession_tests.where('accession_id').equals(id).toArray()]);
    return { acc, patient, specs: specs.filter((s) => s.status === 'collected'), tests };
  }, [id]);
  if (d === undefined || !settings) return <Loading />;
  if (!d) return <NotHere what="Case" />;
  const pending = d.tests.filter((t) => t.status === 'pending').length;
  const w = settings.label_width_mm || 50, h = settings.label_height_mm || 25;
  return (
    <PrintShell title={`Labels ${d.acc.acc_number}`} filename={`Labels-${d.acc.acc_number}.pdf`} paperClass="labels" pdfFormat={[w, h]} accId={id} docType="labels"
      paperStyle={{ '--lw': `${w}mm`, '--lh': `${h}mm` }}
      extra={pending > 0 && <button className="btn primary" disabled={busy} onClick={async () => { setBusy(true); await A.collectSamples(d.acc); setBusy(false); }}>Make barcodes for {pending} test(s) (sample taken)</button>}>
      <style>{`@media print { @page { size: ${w}mm ${h}mm; margin: 0; } }`}</style>
      {d.specs.map((s) => (
        <div className="label" key={s.id}>
          <b>{d.patient.full_name.slice(0, 26)}</b>
          <span>{d.patient.mr_number} · {d.acc.acc_number}{d.acc.priority === 'urgent' ? ' · URGENT' : ''}</span>
          <Barcode value={s.specimen_number} />
          <span><b>{s.specimen_number}</b> · {s.container || s.sample_type}</span>
          <span>{d.tests.filter((t) => t.specimen_id === s.id).map((t) => t.test_code).join(' ').slice(0, 40)} · {fmtDate(s.collected_at)}</span>
        </div>
      ))}
      {!d.specs.length && <p className="no-print" style={{ padding: 20 }}>No sample yet. Use the button above to make the barcodes.</p>}
    </PrintShell>
  );
}

// ---------------------------------------------------------------- cumulative report
export function CumulativeDoc() {
  const { id } = useParams();
  const settings = useSettings();
  const d = useLiveQuery(async () => {
    const patient = await db().patients.get(id);
    if (!patient) return false;
    const tests = (await db().accession_tests.where('patient_id').equals(id).toArray()).filter((t) => t.status === 'verified');
    const accs = Object.fromEntries((await db().accessions.bulkGet([...new Set(tests.map((t) => t.accession_id))])).filter(Boolean).map((a) => [a.id, a]));
    return { patient, tests: tests.filter((t) => accs[t.accession_id] && !accs[t.accession_id].deleted_at).sort((a, b) => a.verified_at.localeCompare(b.verified_at)) };
  }, [id]);
  if (d === undefined || !settings) return <Loading />;
  if (!d) return <NotHere what="Patient" />;
  const dates = [...new Set(d.tests.map((t) => t.verified_at.slice(0, 10)))].slice(-8);
  const params = new Map();
  for (const t of d.tests) for (const r of t.results || []) {
    if (!Number.isFinite(toNum(r.value))) continue;
    const k = r.code || r.name;
    if (!params.has(k)) params.set(k, { name: r.name, unit: r.unit, ref: r.ref_text, dept: t.department, v: {} });
    params.get(k).v[t.verified_at.slice(0, 10)] = r;
  }
  const rows = [...params.values()].filter((p) => dates.some((x) => p.v[x])).sort((a, b) => (a.dept || '').localeCompare(b.dept || ''));
  return (
    <PrintShell title={`Cumulative ${d.patient.full_name}`} filename={`Cumulative-${d.patient.mr_number}.pdf`} phone={d.patient.phone} shareText={`Cumulative report — ${d.patient.full_name}`}>
      <LabHeader lab={settings} letterhead={settings.report_mode === 'letterhead'} />
      <div className="doc-title">CUMULATIVE REPORT</div>
      <PatientBox patient={d.patient} cells={[['Phone', d.patient.phone]]} />
      <table className="doc">
        <thead><tr><th>Test</th><th>Unit</th><th>Reference</th>{dates.map((x) => <th key={x}>{fmtDate(x).slice(0, 6)}<br />{x.slice(0, 4)}</th>)}</tr></thead>
        <tbody>{rows.map((p) => <tr key={p.name}><td>{p.name}</td><td>{p.unit}</td><td>{p.ref}</td>{dates.map((x) => { const r = p.v[x]; return <td key={x} className={r && r.flag && r.flag !== 'normal' ? 'hl' : ''}>{r ? r.value : ''}</td>; })}</tr>)}</tbody>
      </table>
      {!rows.length && <p>No numeric results yet.</p>}
    </PrintShell>
  );
}

// ---------------------------------------------------------------- statements
export function DoctorStatementDoc() {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const from = sp.get('from'), to = sp.get('to');
  const settings = useSettings();
  const doctor = useLiveQuery(() => db().ref_doctors.get(id), [id]);
  const led = useLiveQuery(() => doctorLedger(id, from, to), [id, from, to]);
  if (!doctor || !led || !settings) return <Loading />;
  const m = (v) => money(v, settings.currency || 'Rs');
  return (
    <PrintShell title={`Statement ${doctor.full_name}`} filename={`Statement-${doctor.full_name.replace(/\W+/g, '_')}-${from}.pdf`} phone={doctor.phone} shareText={`Commission statement ${fmtDate(from)} – ${fmtDate(to)}`}>
      <LabHeader lab={settings} />
      <div className="doc-title">COMMISSION STATEMENT</div>
      <div className="doc-pt"><div><span>Doctor: </span><b>{doctor.full_name}</b></div><div><span>Period: </span><b>{fmtDate(from)} – {fmtDate(to)}</b></div><div><span>Patients: </span><b>{led.patients} ({led.testCount} tests)</b></div></div>
      <table className="doc">
        <thead><tr><th>Date</th><th>Patient</th><th>Test</th><th style={{ textAlign: 'right' }}>Price</th><th>Rate</th><th style={{ textAlign: 'right' }}>Commission</th></tr></thead>
        <tbody>{led.lines.map((l, i) => <tr key={i}><td>{fmtDate(l.date)}</td><td>{l.patient} ({l.acc_number})</td><td>{l.test}</td><td style={{ textAlign: 'right' }}>{m(l.price)}</td><td>{l.rate}</td><td style={{ textAlign: 'right' }}>{l.pending ? `(${m(l.pending)} unpaid)` : m(l.commission)}</td></tr>)}</tbody>
      </table>
      <table className="doc" style={{ marginTop: 10, width: '55%', marginLeft: 'auto' }}><tbody>
        <tr><td>Balance brought forward</td><td style={{ textAlign: 'right' }}>{m(led.opening)}</td></tr>
        <tr><td>Commission this period</td><td style={{ textAlign: 'right' }}>{m(led.earned)}</td></tr>
        <tr><td>Paid this period</td><td style={{ textAlign: 'right' }}>−{m(led.paid)}</td></tr>
        <tr><td><b>Balance</b></td><td style={{ textAlign: 'right' }}><b>{m(led.closing)}</b></td></tr>
      </tbody></table>
      {led.payouts.length > 0 && <><h3 style={{ marginTop: 10 }}>Payments</h3><table className="doc"><tbody>{led.payouts.map((p) => <tr key={p.id}><td>{fmtDate(p.paid_on)}</td><td>{p.payout_number}</td><td>{methodLabel(p.method)}</td><td style={{ textAlign: 'right' }}>{m(p.amount)}</td></tr>)}</tbody></table></>}
    </PrintShell>
  );
}

export function PanelStatementDoc() {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const from = sp.get('from'), to = sp.get('to');
  const settings = useSettings();
  const panel = useLiveQuery(() => db().panels.get(id), [id]);
  const led = useLiveQuery(() => panelLedger(id, from, to), [id, from, to]);
  if (!panel || !led || !settings) return <Loading />;
  const m = (v) => money(v, settings.currency || 'Rs');
  const credit = led.cases.filter((c) => c.bill_to === 'panel');
  return (
    <PrintShell title={`Statement ${panel.name}`} filename={`Invoice-${panel.name.replace(/\W+/g, '_')}-${from}.pdf`} phone={panel.phone} shareText={`Statement ${fmtDate(from)} – ${fmtDate(to)}`}>
      <LabHeader lab={settings} />
      <div className="doc-title">STATEMENT OF ACCOUNT</div>
      <div className="doc-pt"><div><span>To: </span><b>{panel.name}</b></div><div><span>Period: </span><b>{fmtDate(from)} – {fmtDate(to)}</b></div><div><span>Patients: </span><b>{credit.length}</b></div></div>
      <table className="doc">
        <thead><tr><th>Date</th><th>Case</th><th>Employee / patient</th><th>Tests</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
        <tbody>{credit.map((c) => <tr key={c.id}><td>{fmtDate(c.reg_date)}</td><td>{c.acc_number}</td><td>{c.patient?.full_name}</td><td>{c.tests.filter((t) => t.status !== 'cancelled').map((t) => t.test_code).join(', ')}</td><td style={{ textAlign: 'right' }}>{m(c.bill.panel_due)}</td></tr>)}</tbody>
      </table>
      <table className="doc" style={{ marginTop: 10, width: '55%', marginLeft: 'auto' }}><tbody>
        <tr><td>Billed this period</td><td style={{ textAlign: 'right' }}>{m(led.billed)}</td></tr>
        <tr><td><b>Total balance due</b></td><td style={{ textAlign: 'right' }}><b>{m(led.balance)}</b></td></tr>
      </tbody></table>
    </PrintShell>
  );
}

export function RateListDoc() {
  const settings = useSettings();
  const tests = useTests().filter((t) => t.active !== false && t.price != null);
  if (!settings) return <Loading />;
  const m = (v) => money(v, settings.currency || 'Rs');
  const depts = [...new Set(tests.map((t) => t.category || 'General'))].sort((a, b) => (a === 'Packages' ? -1 : b === 'Packages' ? 1 : a.localeCompare(b)));
  return (
    <PrintShell title="Rate list" filename="Rate-list.pdf" shareText="Our test rate list">
      <LabHeader lab={settings} />
      <div className="doc-title">TEST RATE LIST</div>
      <div style={{ columns: 2, columnGap: 18 }}>
        {depts.map((d) => (
          <div key={d} style={{ breakInside: 'avoid', marginBottom: 8 }}>
            <div className="doc-dept">{d}</div>
            <table className="doc"><tbody>{tests.filter((t) => (t.category || 'General') === d).map((t) => <tr key={t.id}><td>{t.name}{t.tat_hours ? <span style={{ color: '#666', fontSize: 10 }}> · {t.tat_hours <= 24 ? `${t.tat_hours} h` : `${Math.round(t.tat_hours / 24)} days`}</span> : ''}</td><td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{m(t.price)}</td></tr>)}</tbody></table>
          </div>
        ))}
      </div>
      <div className="doc-note">Rates as of {fmtDate(new Date())}. Subject to change.</div>
    </PrintShell>
  );
}

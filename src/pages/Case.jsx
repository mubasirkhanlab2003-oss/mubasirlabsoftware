import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db.js';
import * as A from '../lib/actions.js';
import { useAuth } from '../lib/auth.jsx';
import { useDoctors, useOutsourceLabs, usePanels, usePatient, useSettings, useTests } from '../lib/hooks.js';
import { billTotals, methodLabel, PAYMENT_METHODS } from '../lib/pricing.js';
import { progress } from '../lib/reports.js';
import { cultureSummary, FLAG_LABEL } from '../lib/results.js';
import { fmtDate, fmtDateTime, fmtHours, hoursBetween, round2, todayISO, waNumber } from '../lib/format.js';
import { Caps, ConfirmButton, DeleteButton, DueBadge, Empty, Field, Modal, Money, StateBadge, TestBadge, useAction, useMoney } from '../components/ui.jsx';
import { patientLine, patientName } from '../components/patients.jsx';
import ResultEntry from '../components/ResultEntry.jsx';

export function portalLink(settings, patient) {
  const base = (settings?.public_url || (typeof location !== 'undefined' ? location.origin : '')).replace(/\/$/, '');
  return patient?.portal_token ? `${base}/p/${patient.portal_token}` : '';
}

export function whatsappReport(settings, patient, acc) {
  const link = portalLink(settings, patient);
  const lab = settings?.lab_name || 'the laboratory';
  const text = `Assalam o Alaikum ${patient.full_name},\nYour lab report (${acc.acc_number}) from ${lab} is ready.\nView / download: ${link}\nPIN: ${patient.portal_pin}\nThank you.`;
  const n = waNumber(patient.phone, settings?.phone_country_code || '92');
  window.open(`https://wa.me/${n}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
}

export default function Case() {
  const { id } = useParams();
  const loc = useLocation();
  const nav = useNavigate();
  const { user, can, isAdmin } = useAuth();
  const settings = useSettings();
  const run = useAction();
  const acc = useLiveQuery(() => db().accessions.get(id), [id]);
  const patient = usePatient(acc?.patient_id);
  const tests = useLiveQuery(() => db().accession_tests.where('accession_id').equals(id).toArray(), [id], []);
  const specimens = useLiveQuery(() => db().specimens.where('accession_id').equals(id).toArray(), [id], []);
  const payments = useLiveQuery(() => db().bill_payments.where('accession_id').equals(id).toArray(), [id], []);
  const doctor = useLiveQuery(() => (acc?.doctor_id ? db().ref_doctors.get(acc.doctor_id) : null), [acc?.doctor_id]);
  const panel = useLiveQuery(() => (acc?.panel_id ? db().panels.get(acc.panel_id) : null), [acc?.panel_id]);
  const history = useLiveQuery(async () => {
    const ids = tests.map((t) => t.id);
    const [am, calls, prints] = await Promise.all([
      ids.length ? db().result_amendments.where('accession_test_id').anyOf(ids).toArray() : [],
      db().critical_calls.where('accession_id').equals(id).toArray(),
      db().print_log.where('accession_id').equals(id).toArray(),
    ]);
    return { am, calls, prints };
  }, [id, tests.length], { am: [], calls: [], prints: [] });
  const outsourceLabs = useOutsourceLabs();
  const [entry, setEntry] = useState(null);
  const [modal, setModal] = useState(null);
  const [sel, setSel] = useState([]);

  if (acc === undefined || (acc && patient === undefined)) return null;
  if (!acc) return <Empty><b>Case not found on this device.</b>It may not have synced yet.</Empty>;
  const bill = billTotals(acc, tests, payments);
  const pr = progress(tests);
  const ordered = [...tests].sort((a, b) => (a.department || '').localeCompare(b.department || '') || (a.sort_order || 0) - (b.sort_order || 0));
  const live = tests.filter((t) => t.status !== 'cancelled');
  const verified = live.filter((t) => t.status === 'verified');
  const toVerify = live.filter((t) => t.status === 'entered');
  const mayVerify = isAdmin || can('verify');
  const locked = settings?.report_needs_payment && bill.due > 0;
  const deleted = !!acc.deleted_at;

  return (
    <>
      {deleted && <div className="note bad" style={{ marginBottom: 14 }}>This case is in the Recycle Bin ({acc.delete_reason}). It is left out of all figures.
        <button className="btn small" style={{ marginLeft: 10 }} onClick={() => run(() => A.restoreAccession(acc), 'Case restored')}>Restore</button></div>}
      {loc.state?.justCreated && !deleted && (
        <div className="note good row" style={{ marginBottom: 14 }}>
          <span>Saved. Bill <b>{acc.acc_number}</b> is ready.</span><span className="spacer" />
          <Link className="btn small" to={`/print/receipt/${acc.id}?labels=1`}>Print receipt + labels</Link>
          {pr.pending > 0 && <button className="btn small" onClick={() => run(() => A.collectSamples(acc), 'Sample collected — tests sent to the lab')}>Sample taken</button>}
        </div>
      )}
      <div className="page-head">
        <div>
          <h1><Link to={`/patients/${patient.id}`} style={{ color: 'inherit' }}>{patientName(patient)}</Link></h1>
          <div className="sub">{patientLine(patient)}</div>
          <div className="row" style={{ marginTop: 6, gap: 8 }}>
            <b>{acc.acc_number}</b><span className="faint">{fmtDateTime(acc.registered_at)}</span>
            <StateBadge s={pr.state} /><Caps tests={tests} />
            {acc.priority === 'urgent' && <span className="badge solid-red">Urgent</span>}
            {acc.home_collection && <span className="badge teal">Home collection{acc.home_status ? ` · ${acc.home_status}` : ''}</span>}
          </div>
        </div>
        <div className="grow" />
        <div className="row">
          {pr.pending > 0 && !deleted && <button className="btn" onClick={() => run(() => A.collectSamples(acc), 'Sample collected — tests sent to the lab')}>Sample taken</button>}
          <Link className="btn" to={`/print/receipt/${acc.id}`}>Receipt</Link>
          <Link className="btn" to={`/print/labels/${acc.id}`}>Labels</Link>
          {verified.length > 0 && <Link className="btn primary" to={`/print/report/${acc.id}`}>Report</Link>}
          {verified.length > 0 && patient.phone && <button className="btn" disabled={locked} title={locked ? 'Bill not paid (Settings: report needs payment)' : ''}
            onClick={() => { whatsappReport(settings, patient, acc); A.logPrint(acc.id, 'report', 'whatsapp'); }}>WhatsApp link</button>}
        </div>
      </div>

      <div className="split">
        <div>
          <div className="panel flush">
            <div className="panel-head"><h2>Tests and results</h2><div className="grow" />
              {mayVerify && toVerify.length > 1 && <button className="btn small primary" onClick={() => run(() => A.verifyTests(toVerify, { userId: user?.id }), `${toVerify.length} results verified`)}>Verify all {toVerify.length}</button>}
              {!deleted && <button className="btn small" onClick={() => setModal('add')}>Add test</button>}
            </div>
            <div className="table-wrap">
              <table className="t">
                <thead><tr><th>Test and result</th><th>Status</th><th className="r">Due / took</th><th /></tr></thead>
                <tbody>
                  {ordered.map((t) => {
                    const late = t.due_at && t.status !== 'verified' && t.status !== 'cancelled' && t.due_at < new Date().toISOString();
                    return (
                      <tr key={t.id} className={t.status === 'cancelled' ? 'muted-row' : ''}>
                        <td>
                          <b>{t.test_name}</b> <span className="faint">{t.department}</span>
                          {t.amend_count > 0 && <span className="badge amber" style={{ marginLeft: 6 }}>Amended</span>}
                          {t.auto_verified && <span className="badge teal" style={{ marginLeft: 6 }}>Auto-verified</span>}
                          {t.outsource_lab_id && <div className="faint">Sent to {outsourceLabs.find((l) => l.id === t.outsource_lab_id)?.name || 'outside lab'}{t.outsource_cost ? ` · cost ${t.outsource_cost}` : ''}</div>}
                          {t.status === 'cancelled' && <div className="faint">Cancelled: {t.cancel_reason}</div>}
                          <div className="res-line"><ResultSummary t={t} /></div>
                          {t.lots?.length > 0 && <div className="faint">Reagent lot: {t.lots.map((l) => `${l.item} ${l.lot || ''}`).join(', ')}</div>}
                        </td>
                        <td><TestBadge s={t.status} /></td>
                        <td className="r nowrap">{t.status === 'verified' ? <span className="faint">{fmtHours(hoursBetween(acc.registered_at, t.verified_at))}</span> : t.due_at && t.status !== 'cancelled' ? <span className={late ? 'flag-high' : 'faint'}>{fmtDateTime(t.due_at)}</span> : ''}</td>
                        <td className="right nowrap">
                          {!deleted && ['pending', 'collected', 'entered'].includes(t.status) && <button className="btn small primary" onClick={() => setEntry({ row: t })}>{t.status === 'entered' ? 'Review' : 'Enter result'}</button>}
                          {!deleted && t.status === 'entered' && mayVerify && <button className="btn small" style={{ marginLeft: 4 }} onClick={() => run(() => A.verifyTests([t], { userId: user?.id }), 'Verified')}>Verify</button>}
                          {!deleted && t.status === 'verified' && <button className="btn small" onClick={() => setEntry({ row: t, amend: true })}>Amend</button>}
                          {!deleted && t.status !== 'cancelled' && t.status !== 'verified' && (
                            <TestMenu t={t} labs={outsourceLabs} onCancel={() => setModal({ cancel: t })} />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel">
            <div className="panel-head"><h2>Samples</h2><div className="grow" />
              {pr.pending > 0 && !deleted && <button className="btn small primary" onClick={() => run(() => A.collectSamples(acc), 'Sample collected')}>Collect {pr.pending} pending</button>}</div>
            {!specimens.length && <p className="muted" style={{ margin: 0 }}>No sample yet. Tests needing the same tube share one barcode.</p>}
            {specimens.length > 0 && (
              <table className="t compact"><tbody>
                {specimens.map((s) => (
                  <tr key={s.id} className={s.status !== 'collected' ? 'muted-row' : ''}>
                    <td><b>{s.specimen_number}</b></td>
                    <td>{s.sample_type}{s.container ? <span className="faint"> · {s.container}</span> : ''}</td>
                    <td className="faint">{tests.filter((t) => t.specimen_id === s.id).map((t) => t.test_code || t.test_name).join(', ')}</td>
                    <td className="faint">{fmtDateTime(s.collected_at)}{s.storage ? ` · kept in ${s.storage}` : ''}</td>
                    <td className="right nowrap">
                      {s.status === 'collected' ? <>
                        <button className="btn small ghost" onClick={() => setModal({ store: s })}>Storage</button>
                        <ConfirmButton label="Reject" className="btn small ghost" danger title="Reject sample" reason="Why (haemolysed, clotted, wrong tube, too little…)"
                          message="Its tests go back to 'sample pending' so a new sample can be taken." confirmLabel="Reject sample"
                          onConfirm={(r) => run(() => A.rejectSpecimen(s, r), 'Sample rejected — take a new one').then((x) => x !== undefined)} />
                      </> : <span className="badge">{s.status === 'rejected' ? `Rejected: ${s.reject_reason}` : 'Discarded'}</span>}
                    </td>
                  </tr>
                ))}
              </tbody></table>
            )}
          </div>

          {(history.am.length > 0 || history.calls.length > 0 || history.prints.length > 0) && (
            <div className="panel">
              <h2>History</h2>
              <table className="t compact"><tbody>
                {history.calls.map((c) => <tr key={c.id}><td className="nowrap faint">{fmtDateTime(c.informed_at)}</td><td><span className="badge red">Critical call</span> {c.parameter} {c.value} — informed {c.informed_to}{c.note ? ` (${c.note})` : ''}</td></tr>)}
                {history.am.map((a) => <tr key={a.id}><td className="nowrap faint">{fmtDateTime(a.amended_at)}</td><td><span className="badge amber">Amended</span> {tests.find((t) => t.id === a.accession_test_id)?.test_name}: {a.reason}
                  <div className="faint">Before: {(a.old_data?.results || []).filter((r) => r.value).map((r) => `${r.name} ${r.value}`).join(', ') || cultureSummary(a.old_data?.culture) || (a.old_data?.text_result || '').slice(0, 80)}</div></td></tr>)}
                {history.prints.slice(-10).map((p) => <tr key={p.id}><td className="nowrap faint">{fmtDateTime(p.printed_at)}</td><td>{p.doc_type} · {p.via}</td></tr>)}
              </tbody></table>
            </div>
          )}
        </div>

        <div className="sticky">
          <div className="panel">
            <div className="panel-head"><h2>Bill</h2><div className="grow" /><DueBadge bill={bill} deleted={deleted} /></div>
            <div className="bill-lines">
              {live.map((t) => <div className="bill-line" key={t.id}><span className="n">{t.test_name}</span><Money v={t.price} /></div>)}
            </div>
            <div className="bill-total">
              <div><span>Tests</span><Money v={bill.subtotal} /></div>
              {bill.home > 0 && <div><span>Home collection</span><Money v={bill.home} /></div>}
              {bill.discount > 0 && <div><span>Discount{acc.discount_reason ? ` (${acc.discount_reason})` : ''}</span><span>− <Money v={bill.discount} /></span></div>}
              <div className="grand"><span>Total</span><Money v={bill.total} /></div>
              <div><span>Paid</span><Money v={bill.paid} /></div>
              {bill.panel_due > 0 ? <div><span>Company owes</span><b><Money v={bill.panel_due} /></b></div>
                : <div><span>Due</span><b className={bill.due > 0 ? 'flag-high' : ''}><Money v={bill.due} /></b></div>}
            </div>
            <div className="stack" style={{ marginTop: 12, fontSize: 14 }}>
              <div className="row"><span className="faint">Referred by</span><span className="spacer" /><b>{doctor ? <Link to={`/doctors/${doctor.id}`}>{doctor.full_name}</Link> : (acc.doctor_text || 'Self')}</b></div>
              {doctor && <div className="row"><span className="faint">Doctor's commission</span><span className="spacer" /><Money v={round2(live.reduce((s, t) => s + Number(t.commission || 0), 0))} /></div>}
              {panel && <div className="row"><span className="faint">Panel</span><span className="spacer" /><b>{panel.name}</b>{acc.bill_to === 'panel' && <span className="badge blue">credit</span>}</div>}
            </div>
            {!deleted && (
              <div className="row" style={{ marginTop: 12 }}>
                {(bill.due > 0 || bill.panel_due > 0) && <button className="btn primary" onClick={() => setModal('pay')}>Receive payment</button>}
                <button className="btn" onClick={() => setModal('edit')}>Change doctor / discount</button>
                {bill.paid > 0 && <button className="btn ghost" onClick={() => setModal('refund')}>Refund</button>}
              </div>
            )}
          </div>

          <div className="panel">
            <h2>Payments</h2>
            {!payments.length && <p className="muted" style={{ margin: 0 }}>No payment yet.</p>}
            <table className="t compact"><tbody>
              {payments.sort((a, b) => a.received_at.localeCompare(b.received_at)).map((p) => (
                <tr key={p.id} className={p.deleted_at ? 'muted-row' : ''}>
                  <td className="nowrap">{fmtDate(p.business_date)}{p.late_adjustment && <div className="faint">entered {fmtDate(p.received_at)}</div>}</td>
                  <td>{p.kind === 'refund' ? <span className="badge amber">Refund</span> : methodLabel(p.method)}<div className="faint">{p.payment_number}{p.note ? ` · ${p.note}` : ''}</div></td>
                  <td className="r"><Money v={p.amount} /></td>
                  <td className="right nowrap">
                    {!p.deleted_at && !deleted && <>
                      <button className="btn small ghost" onClick={() => setModal({ editPay: p })}>Edit</button>
                      <DeleteButton className="btn small ghost danger" title="Delete payment" message={`Delete ${p.payment_number} (${p.amount})? It is removed from the cash figures of ${fmtDate(p.business_date)}.`}
                        onConfirm={(r) => run(() => A.softDelete('bill_payments', p, r), 'Payment deleted').then((x) => x !== undefined)} />
                    </>}
                    {p.deleted_at && <span className="faint">Deleted</span>}
                  </td>
                </tr>
              ))}
            </tbody></table>
          </div>

          {!deleted && (
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <DeleteButton label="Delete this case" title={`Delete case ${acc.acc_number}`} className="btn danger"
                message="The bill, its payments and the doctor's commission are removed from every report (on the day of this case). You can restore it from the Recycle Bin."
                onConfirm={async (r) => { const ok = await run(() => A.deleteAccession(acc, r), 'Case moved to the Recycle Bin'); if (ok) nav(`/patients/${patient.id}`); return ok !== undefined; }} />
            </div>
          )}
        </div>
      </div>

      {entry && <ResultEntry row={entry.row} amend={entry.amend} acc={acc} patient={patient} onClose={() => setEntry(null)} />}
      {modal === 'pay' && <PaymentModal acc={acc} bill={bill} onClose={() => setModal(null)} />}
      {modal === 'refund' && <RefundModal acc={acc} bill={bill} onClose={() => setModal(null)} />}
      {modal === 'edit' && <EditCaseModal acc={acc} bill={bill} onClose={() => setModal(null)} />}
      {modal === 'add' && <AddTestsModal acc={acc} have={live.map((t) => t.test_id)} sel={sel} setSel={setSel} onClose={() => { setModal(null); setSel([]); }} />}
      {modal?.cancel && <CancelTestModal t={modal.cancel} bill={bill} onClose={() => setModal(null)} />}
      {modal?.editPay && <EditPaymentModal p={modal.editPay} onClose={() => setModal(null)} />}
      {modal?.store && <StorageModal s={modal.store} onClose={() => setModal(null)} />}
    </>
  );
}

export function ResultSummary({ t }) {
  if (t.culture) return <span>{cultureSummary(t.culture)}</span>;
  if (t.text_result) return <span className="faint">{t.text_result.replace(/\s+/g, ' ').slice(0, 90)}{t.text_result.length > 90 ? '…' : ''}</span>;
  return (
    <>
      {(t.results || []).filter((r) => r.value !== '' && r.value != null).slice(0, 8).map((r) => (
        <span key={r.parameter_id || r.name} className={r.critical ? 'flag-critical' : r.flag && r.flag !== 'normal' ? `flag-${r.flag}` : ''}>
          {(t.results.length > 1 ? `${r.code || r.name}: ` : '')}{r.value}{r.flag && r.flag !== 'normal' && !r.critical ? ` ${FLAG_LABEL[r.flag] === 'High' ? '↑' : FLAG_LABEL[r.flag] === 'Low' ? '↓' : '*'}` : ''}
        </span>
      ))}
      {(t.results || []).filter((r) => r.value !== '').length > 8 && <span className="faint">…</span>}
    </>
  );
}

function TestMenu({ t, labs, onCancel }) {
  const [open, setOpen] = useState(false);
  const run = useAction();
  const [lab, setLab] = useState(t.outsource_lab_id || '');
  const [cost, setCost] = useState(t.outsource_cost ?? '');
  const rate = useLiveQuery(() => (lab ? db().outsource_rates.where('lab_id').equals(lab).filter((r) => r.test_id === t.test_id).first() : null), [lab]);
  return (
    <>
      <button className="btn small ghost" onClick={() => setOpen(true)} aria-label="More">⋯</button>
      {open && (
        <Modal title={t.test_name} onClose={() => setOpen(false)}>
          <div className="stack">
            <h3>Send to an outside lab</h3>
            <div className="grid2">
              <Field label="Outside lab">
                <select value={lab} onChange={(e) => setLab(e.target.value)}><option value="">Done in our lab</option>{labs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
              </Field>
              <Field label="Their charge to us"><input type="number" value={cost === '' && rate ? rate.cost : cost} onChange={(e) => setCost(e.target.value)} /></Field>
            </div>
            <div className="row"><button className="btn primary" onClick={async () => { const ok = await run(() => A.sendOutsource(t, lab, cost === '' && rate ? rate.cost : cost), lab ? 'Marked as sent out' : 'Marked as in-house'); if (ok) setOpen(false); }}>Save</button></div>
            <hr />
            <h3>Cancel this test</h3>
            <p className="faint">The bill goes down. If it was already paid, a refund is recorded on the day of this case.</p>
            <div><button className="btn danger" onClick={() => { setOpen(false); onCancel(); }}>Cancel test…</button></div>
          </div>
        </Modal>
      )}
    </>
  );
}

function CancelTestModal({ t, bill, onClose }) {
  const run = useAction();
  const [reason, setReason] = useState('');
  const after = round2(bill.total - Number(t.price || 0));
  const refund = Math.max(round2(bill.paid - Math.max(after, 0)), 0);
  return (
    <Modal title={`Cancel ${t.test_name}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Keep test</button>
      <button className="btn danger solid" disabled={!reason.trim()} onClick={async () => {
        const r = await run(() => A.cancelTest(t, reason));
        if (r) { onClose(); }
      }}>Cancel test</button>
    </>}>
      <p className="muted" style={{ marginTop: 0 }}>The bill becomes <b><Money v={Math.max(after, 0)} /></b>. The doctor's commission on this test is removed.</p>
      {refund > 0 && <div className="note warn" style={{ marginBottom: 10 }}>Give back <b><Money v={refund} /></b> to the patient. The refund counts on the day of this case.</div>}
      <Field label="Reason" required><textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </Modal>
  );
}

export function PaymentModal({ acc, bill, onClose }) {
  const open = acc.bill_to === 'panel' ? bill.panel_due : bill.due;
  const [f, setF] = useState({ amount: String(open), method: 'cash', reference: '' });
  const run = useAction();
  return (
    <Modal title="Receive payment" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" onClick={async () => { const ok = await run(() => A.addPayment(acc, f), 'Payment received'); if (ok) onClose(); }}>Save payment</button>
    </>}>
      <p className="muted" style={{ marginTop: 0 }}>Due: <b><Money v={open} /></b></p>
      <div className="grid2">
        <Field label="Amount" required><input autoFocus type="number" min="0" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <Field label="Method"><select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{PAYMENT_METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        {f.method !== 'cash' && <Field label="Reference / transaction no."><input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>}
      </div>
    </Modal>
  );
}

function RefundModal({ acc, bill, onClose }) {
  const [f, setF] = useState({ amount: '', method: 'cash', reason: '' });
  const run = useAction();
  return (
    <Modal title="Refund to patient" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn danger solid" onClick={async () => { const ok = await run(() => A.refund(acc, f), 'Refund recorded'); if (ok) onClose(); }}>Record refund</button>
    </>}>
      <p className="muted" style={{ marginTop: 0 }}>Paid so far: <Money v={bill.paid} />. To return money because a test was cancelled, cancel the test instead — the refund is made automatically.</p>
      <div className="grid2">
        <Field label="Amount" required><input autoFocus type="number" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <Field label="Method"><select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{PAYMENT_METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <div className="span2"><Field label="Reason" required><input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field></div>
      </div>
    </Modal>
  );
}

function EditPaymentModal({ p, onClose }) {
  const [f, setF] = useState({ amount: String(Math.abs(p.amount)), method: p.method, reference: p.reference || '', note: p.note || '' });
  const run = useAction();
  return (
    <Modal title={`Edit ${p.payment_number}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" onClick={async () => { const ok = await run(() => A.editPayment(p, f), 'Payment updated'); if (ok) onClose(); }}>Save</button>
    </>}>
      <div className="grid2">
        <Field label="Amount"><input type="number" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <Field label="Method"><select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{PAYMENT_METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Reference"><input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
        <Field label="Note"><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      </div>
      <p className="faint">Every change is kept in the audit log.</p>
    </Modal>
  );
}

function EditCaseModal({ acc, bill, onClose }) {
  const doctors = useDoctors();
  const panels = usePanels();
  const run = useAction();
  const m = useMoney();
  const [f, setF] = useState({
    doctor_id: acc.doctor_id || '', doctor_text: acc.doctor_text || '', panel_id: acc.panel_id || '', bill_to: acc.bill_to,
    discount: String(acc.discount || 0), discount_reason: acc.discount_reason || '', priority: acc.priority,
    home_collection: acc.home_collection, home_address: acc.home_address || '', home_charge: String(acc.home_charge || 0),
    clinical_notes: acc.clinical_notes || '',
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const panel = panels.find((p) => p.id === f.panel_id);
  return (
    <Modal wide title="Change case details" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" onClick={async () => {
        const r = await run(() => A.updateAccession(acc, {
          ...f, doctor_id: f.doctor_id || null, doctor_text: f.doctor_id ? null : (f.doctor_text || null), panel_id: f.panel_id || null,
          discount: Number(f.discount || 0), home_charge: f.home_collection ? Number(f.home_charge || 0) : 0,
          home_status: f.home_collection ? (acc.home_status || 'scheduled') : null,
        }));
        if (r) { onClose(); }
      }}>Save changes</button>
    </>}>
      <div className="grid2">
        <Field label="Referring doctor" hint="The commission moves to the new doctor automatically.">
          <select value={f.doctor_id} onChange={set('doctor_id')}><option value="">Self / not in list</option>{doctors.map((d) => <option key={d.id} value={d.id}>{d.full_name}</option>)}</select>
        </Field>
        {!f.doctor_id && <Field label="Doctor name (no commission)"><input value={f.doctor_text} onChange={set('doctor_text')} /></Field>}
        <Field label="Panel / company" hint="Changing it re-prices the tests.">
          <select value={f.panel_id} onChange={(e) => { const p = panels.find((x) => x.id === e.target.value); setF({ ...f, panel_id: e.target.value, bill_to: p?.credit ? 'panel' : 'patient' }); }}>
            <option value="">None</option>{panels.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        {panel && <Field label="Who pays"><select value={f.bill_to} onChange={set('bill_to')}><option value="panel">Company (credit)</option><option value="patient">Patient</option></select></Field>}
        <Field label={`Discount (bill before discount ${m(bill.gross)})`}><input type="number" min="0" value={f.discount} onChange={set('discount')} /></Field>
        <Field label="Discount reason"><input value={f.discount_reason} onChange={set('discount_reason')} /></Field>
        <Field label="Priority"><select value={f.priority} onChange={set('priority')}><option value="routine">Routine</option><option value="urgent">Urgent</option></select></Field>
        <Field label="Home collection"><label className="check"><input type="checkbox" checked={f.home_collection} onChange={(e) => setF({ ...f, home_collection: e.target.checked })} /> Yes</label></Field>
        {f.home_collection && <><Field label="Address"><input value={f.home_address} onChange={set('home_address')} /></Field>
          <Field label="Home charge"><input type="number" value={f.home_charge} onChange={set('home_charge')} /></Field></>}
        <div className="span2"><Field label="Clinical notes"><input value={f.clinical_notes} onChange={set('clinical_notes')} /></Field></div>
      </div>
      {bill.paid > 0 && <p className="faint">If the bill becomes smaller than what was paid, the difference is recorded as a refund on the day of this case.</p>}
    </Modal>
  );
}

function AddTestsModal({ acc, have, sel, setSel, onClose }) {
  const tests = useTests().filter((t) => t.active !== false && !have.includes(t.id));
  const [q, setQ] = useState('');
  const run = useAction();
  const m = useMoney();
  const s = q.trim().toLowerCase();
  const shown = tests.filter((t) => !s || t.name.toLowerCase().includes(s) || (t.code || '').toLowerCase().startsWith(s)).slice(0, 80);
  return (
    <Modal wide title="Add tests to this bill" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={!sel.length} onClick={async () => { const n = await run(() => A.addTests(acc, sel)); if (n) onClose(); }}>Add {sel.length || ''} to bill</button>
    </>}>
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Code or name" />
      <div className="test-pick" style={{ marginTop: 10 }}>
        {shown.map((t) => (
          <button key={t.id} className={sel.includes(t.id) ? 'on' : ''} onClick={() => setSel(sel.includes(t.id) ? sel.filter((x) => x !== t.id) : [...sel, t.id])}>
            <span className="code">{t.code}</span><span>{t.name}</span><span className="p">{t.price == null ? 'no price' : m(t.price)}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

function StorageModal({ s, onClose }) {
  const [v, setV] = useState(s.storage || '');
  const run = useAction();
  return (
    <Modal title={`Sample ${s.specimen_number}`} onClose={onClose} footer={<>
      <ConfirmButton label="Mark discarded" className="btn danger" title="Discard sample" message="Record that this sample has been thrown away." confirmLabel="Discard"
        onConfirm={() => run(() => A.discardSpecimen(s), 'Recorded as discarded').then(() => onClose())} />
      <span className="spacer" />
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" onClick={async () => { const ok = await run(() => A.storeSpecimen(s, v), 'Saved'); if (ok) onClose(); }}>Save</button>
    </>}>
      <Field label="Kept where (fridge / rack / position)"><input autoFocus value={v} onChange={(e) => setV(e.target.value)} placeholder="e.g. Fridge 1, rack B, slot 12" /></Field>
      <p className="faint">Keep until {fmtDate(s.discard_after)}{s.discard_after && s.discard_after < todayISO() ? ' — this date has passed, it can be discarded.' : '.'}</p>
    </Modal>
  );
}

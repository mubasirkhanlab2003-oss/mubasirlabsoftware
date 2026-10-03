import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db.js';
import * as A from '../lib/actions.js';
import { insertRow } from '../lib/repo.js';
import { useDoctors, usePanels, usePatient, useSettings, useTests } from '../lib/hooks.js';
import { PAYMENT_METHODS } from '../lib/pricing.js';
import { round2, todayISO } from '../lib/format.js';
import { Field, Modal, Money, useAction, useMoney } from '../components/ui.jsx';
import { PatientForm, PatientSearch, patientLine, patientName } from '../components/patients.jsx';

// One screen: patient → who sent them → tests → bill and payment → save.
export default function Register() {
  const [sp] = useSearchParams();
  const pre = usePatient(sp.get('patient'));
  const [picked, setPicked] = useState(null);
  const [newName, setNewName] = useState(null);
  const patient = picked || pre || null;
  const settings = useSettings();
  const tests = useTests().filter((t) => t.active !== false);
  const doctors = useDoctors();
  const panels = usePanels();
  const membership = useLiveQuery(() => (patient?.membership_id ? db().memberships.get(patient.membership_id) : null), [patient?.membership_id]);
  const run = useAction();
  const nav = useNavigate();
  const m = useMoney();

  const [sel, setSel] = useState([]);
  const [q, setQ] = useState('');
  const [dept, setDept] = useState('');
  const [doctorId, setDoctorId] = useState('');
  const [doctorText, setDoctorText] = useState('');
  const [panelId, setPanelId] = useState('');
  const [billTo, setBillTo] = useState('panel');
  const [priority, setPriority] = useState('routine');
  const [home, setHome] = useState(false);
  const [homeAddr, setHomeAddr] = useState('');
  const [homeTime, setHomeTime] = useState('');
  const [homeCharge, setHomeCharge] = useState(null);
  const [disc, setDisc] = useState('');
  const [discMode, setDiscMode] = useState('rs');
  const [discReason, setDiscReason] = useState('');
  const [notes, setNotes] = useState('');
  const [pay, setPay] = useState(null);
  const [method, setMethod] = useState('cash');
  const [addDoc, setAddDoc] = useState(false);
  const [busy, setBusy] = useState(false);
  const qRef = useRef(null);

  useEffect(() => { if (patient?.address && !homeAddr) setHomeAddr(patient.address); }, [patient?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const lines = useLiveQuery(() => (sel.length ? A.expandSelection(sel, panelId || null) : []), [sel.join(','), panelId], []);
  const subtotal = round2(lines.reduce((s, l) => s + Number(l.price || 0), 0));
  const hc = home ? Number(homeCharge ?? settings?.home_charge ?? 0) : 0;
  const memberValid = membership && (!patient?.membership_until || patient.membership_until >= todayISO());
  const autoDisc = memberValid ? round2(subtotal * Number(membership.discount_pct) / 100) : 0;
  const discount = disc === '' ? autoDisc : discMode === 'pct' ? round2(subtotal * Number(disc || 0) / 100) : round2(Number(disc || 0));
  const total = Math.max(round2(subtotal + hc - discount), 0);
  const panel = panels.find((p) => p.id === panelId);
  const panelCredit = panel && billTo === 'panel';
  const payNow = panelCredit ? 0 : (pay === null ? total : Number(pay || 0));
  const unpriced = lines.filter((l) => l.test.price == null && !panelId);

  const depts = useMemo(() => [...new Set(tests.map((t) => t.category || 'General'))].sort((a, b) => (a === 'Packages' ? -1 : b === 'Packages' ? 1 : a.localeCompare(b))), [tests]);
  const s = q.trim().toLowerCase();
  const shown = tests.filter((t) => (!dept || (t.category || 'General') === dept)
    && (!s || t.name.toLowerCase().includes(s) || (t.code || '').toLowerCase().startsWith(s)));
  const toggle = (id) => setSel((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));
  const selTests = sel.map((id) => tests.find((t) => t.id === id)).filter(Boolean);
  const instructions = [...new Set(lines.map((l) => l.test.instructions).filter(Boolean))];

  async function save(next) {
    if (busy) return;
    setBusy(true);
    const acc = await run(() => A.createAccession({
      patient, testIds: sel, doctorId: doctorId || null, doctorText: doctorId ? null : (doctorText.trim() || null),
      panelId: panelId || null, billTo, priority,
      home: home ? { address: homeAddr, time: homeTime ? new Date(homeTime).toISOString() : null, charge: hc } : null,
      discount, discountReason: discount ? (discReason || (disc === '' && memberValid ? `${membership.name} card` : null)) : null,
      clinicalNotes: notes || null, payment: payNow > 0 ? { amount: Math.min(payNow, total), method } : null,
    }), 'Saved — bill made');
    setBusy(false);
    if (!acc) return;
    if (next === 'collect') await A.collectSamples(acc);
    if (next === 'print') nav(`/print/receipt/${acc.id}?labels=1`);
    else nav(`/cases/${acc.id}`, { state: { justCreated: true } });
  }

  return (
    <>
      <div className="page-head">
        <div><h1>New patient / test</h1><div className="sub">Choose the patient and tests — the bill makes itself.</div></div>
      </div>
      <div className="split wide-side">
        <div>
          <div className="panel">
            <div className="panel-head"><h2>Patient</h2><div className="grow" />
              {patient && <button className="btn small" onClick={() => { setPicked(null); setNewName(null); nav('/register'); }}>Change patient</button>}</div>
            {patient ? (
              <div className="row">
                <div>
                  <b style={{ fontSize: 18 }}>{patientName(patient)}</b>
                  <div className="muted">{patientLine(patient)}{patient.guardian ? ` · ${patient.guardian}` : ''}</div>
                  {patient.notes && <div className="badge amber" style={{ marginTop: 4 }}>{patient.notes}</div>}
                  {memberValid && <div className="badge teal" style={{ marginTop: 4 }}>{membership.name} card · {membership.discount_pct}% off</div>}
                </div>
              </div>
            ) : (
              <div className="stack">
                <PatientSearch onPick={setPicked} autoFocus={false} />
                <hr style={{ margin: '4px 0' }} />
                <PatientForm key={newName || 'new'} compact initial={newName ? { full_name: newName } : {}} onSaved={setPicked} />
              </div>
            )}
          </div>

          <div className="panel">
            <div className="panel-head"><h2>Referred by</h2></div>
            <div className="grid3">
              <Field label="Doctor">
                <div className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
                  <select value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
                    <option value="">Self / walk-in</option>
                    {doctors.map((d) => <option key={d.id} value={d.id}>{d.full_name}{d.hospital ? ` — ${d.hospital}` : ''}</option>)}
                  </select>
                  <button className="btn small" onClick={() => setAddDoc(true)} title="Add a doctor">+</button>
                </div>
              </Field>
              {!doctorId && <Field label="Or write a name (no commission)"><input value={doctorText} onChange={(e) => setDoctorText(e.target.value)} placeholder="e.g. Dr. Khan, DHQ" /></Field>}
              <Field label="Panel / company">
                <select value={panelId} onChange={(e) => { setPanelId(e.target.value); const p = panels.find((x) => x.id === e.target.value); setBillTo(p?.credit ? 'panel' : 'patient'); }}>
                  <option value="">None (cash patient)</option>
                  {panels.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>
              {panel && <Field label="Who pays">
                <div className="seg">
                  <button type="button" className={billTo === 'panel' ? 'on' : ''} onClick={() => setBillTo('panel')}>Company (credit)</button>
                  <button type="button" className={billTo === 'patient' ? 'on' : ''} onClick={() => setBillTo('patient')}>Patient</button>
                </div>
              </Field>}
              <Field label="Priority">
                <div className="seg">
                  <button type="button" className={priority === 'routine' ? 'on' : ''} onClick={() => setPriority('routine')}>Routine</button>
                  <button type="button" className={priority === 'urgent' ? 'on' : ''} onClick={() => setPriority('urgent')}>Urgent</button>
                </div>
              </Field>
              <Field label="Home collection">
                <label className="check"><input type="checkbox" checked={home} onChange={(e) => setHome(e.target.checked)} /> Sample from patient's home</label>
              </Field>
            </div>
            {home && (
              <div className="grid3" style={{ marginTop: 12 }}>
                <Field label="Address" required><input value={homeAddr} onChange={(e) => setHomeAddr(e.target.value)} /></Field>
                <Field label="Date and time"><input type="datetime-local" value={homeTime} onChange={(e) => setHomeTime(e.target.value)} /></Field>
                <Field label="Home charge"><input type="number" min="0" value={homeCharge ?? settings?.home_charge ?? 0} onChange={(e) => setHomeCharge(e.target.value)} /></Field>
              </div>
            )}
            <div style={{ marginTop: 12 }}><Field label="Clinical notes (optional, printed on report)"><input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. fever 3 days, on insulin" /></Field></div>
          </div>

          <div className="panel">
            <div className="panel-head"><h2>Tests</h2><div className="grow" /><span className="faint">Type a code or name, press Enter to add</span></div>
            <input ref={qRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. CBC, LFT, sugar, thyroid…"
              onKeyDown={(e) => { if (e.key === 'Enter' && shown[0]) { e.preventDefault(); if (!sel.includes(shown[0].id)) toggle(shown[0].id); setQ(''); } }} />
            <div className="chips" style={{ margin: '10px 0' }}>
              <button className={`chip ${!dept ? 'on' : ''}`} onClick={() => setDept('')}>All</button>
              {depts.map((d) => <button key={d} className={`chip ${dept === d ? 'on' : ''}`} onClick={() => setDept(d)}>{d}</button>)}
            </div>
            <div className="test-pick">
              {shown.map((t) => (
                <button key={t.id} className={sel.includes(t.id) ? 'on' : ''} onClick={() => toggle(t.id)}>
                  <span className="code">{t.code}</span><span>{t.name}</span>
                  <span className="p">{t.price == null ? 'no price' : m(t.price)}</span>
                </button>
              ))}
              {!shown.length && <div className="empty">No test matches. Add tests in Settings → Tests & prices.</div>}
            </div>
          </div>
        </div>

        <div className="sticky">
          <div className="panel">
            <div className="panel-head"><h2>Bill</h2><div className="grow" /><span className="faint">{lines.length} test(s)</span></div>
            {!lines.length && <p className="muted">Tests you choose appear here with their price.</p>}
            <div className="bill-lines">
              {selTests.map((t) => {
                const mine = lines.filter((l) => l.test.id === t.id || l.package_id === t.id);
                const amt = round2(mine.reduce((s2, l) => s2 + Number(l.price || 0), 0));
                return (
                  <div className="bill-line" key={t.id}>
                    <div className="n"><b>{t.name}</b>{t.kind === 'package' && <div className="faint">{mine.map((l) => l.test.code).join(', ')}</div>}</div>
                    <Money v={amt} />
                    <button className="btn small ghost" onClick={() => toggle(t.id)} aria-label={`Remove ${t.name}`}>✕</button>
                  </div>
                );
              })}
            </div>
            {unpriced.length > 0 && <div className="note warn" style={{ marginTop: 8 }}>No price set for {unpriced.map((l) => l.test.name).join(', ')}. Set it in Settings → Tests & prices.</div>}
            <div className="grid2" style={{ marginTop: 12 }}>
              <Field label={disc === '' && autoDisc ? 'Discount (card applied)' : 'Discount'}>
                <div className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
                  <input type="number" min="0" value={disc === '' ? (autoDisc || '') : disc} onChange={(e) => setDisc(e.target.value)} placeholder="0" />
                  <div className="seg"><button type="button" className={discMode === 'rs' ? 'on' : ''} onClick={() => setDiscMode('rs')}>Rs</button><button type="button" className={discMode === 'pct' ? 'on' : ''} onClick={() => setDiscMode('pct')}>%</button></div>
                </div>
              </Field>
              {discount > 0 && <Field label="Discount reason"><input value={discReason} onChange={(e) => setDiscReason(e.target.value)} placeholder={memberValid ? membership.name : 'e.g. staff, poor patient'} /></Field>}
            </div>
            <div className="bill-total">
              <div><span>Tests</span><Money v={subtotal} /></div>
              {hc > 0 && <div><span>Home collection</span><Money v={hc} /></div>}
              {discount > 0 && <div><span>Discount</span><span>− <Money v={discount} /></span></div>}
              <div className="grand"><span>Total</span><Money v={total} /></div>
            </div>
            {panelCredit
              ? <div className="note" style={{ marginTop: 12 }}>Billed to <b>{panel.name}</b> on credit. The patient pays nothing now.</div>
              : (
                <div className="grid2" style={{ marginTop: 12 }}>
                  <Field label="Received now"><input type="number" min="0" value={pay === null ? total : pay} onChange={(e) => setPay(e.target.value)} /></Field>
                  <Field label="Method">
                    <select value={method} onChange={(e) => setMethod(e.target.value)}>
                      {PAYMENT_METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select>
                  </Field>
                  {payNow < total && <div className="span2 faint">Balance due: <Money v={round2(total - payNow)} /></div>}
                  {payNow > total && <div className="span2 error-text">Received is more than the total.</div>}
                </div>
              )}
            {instructions.length > 0 && <div className="note warn" style={{ marginTop: 12 }}><b>Tell the patient:</b><ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{instructions.map((i) => <li key={i}>{i}</li>)}</ul></div>}
            <div className="stack" style={{ marginTop: 14 }}>
              <button className="btn primary big" disabled={!patient || !lines.length || busy || unpriced.length > 0 || payNow > total} onClick={() => save('print')}>Save and print receipt + labels</button>
              <div className="row">
                <button className="btn" style={{ flex: 1 }} disabled={!patient || !lines.length || busy || unpriced.length > 0 || payNow > total} onClick={() => save('collect')}>Save, sample taken</button>
                <button className="btn" style={{ flex: 1 }} disabled={!patient || !lines.length || busy || unpriced.length > 0 || payNow > total} onClick={() => save()}>Save only</button>
              </div>
              {!patient && <span className="faint">Choose or register the patient first.</span>}
            </div>
          </div>
        </div>
      </div>
      {addDoc && <QuickDoctor onClose={() => setAddDoc(false)} onSaved={(d) => { setDoctorId(d.id); setAddDoc(false); }} />}
    </>
  );
}

export function QuickDoctor({ onClose, onSaved }) {
  const [f, setF] = useState({ full_name: '', qualification: '', hospital: '', phone: '', rate_type: 'percent', rate_value: '' });
  const run = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title="Add referring doctor" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={!f.full_name.trim()} onClick={async () => {
        const d = await run(() => insertRow('ref_doctors', { ...f, full_name: f.full_name.trim(), rate_value: Number(f.rate_value || 0), active: true }), 'Doctor added');
        if (d) onSaved(d);
      }}>Add doctor</button>
    </>}>
      <div className="grid2">
        <Field label="Name" required><input autoFocus value={f.full_name} onChange={set('full_name')} placeholder="Dr. …" /></Field>
        <Field label="Phone / WhatsApp"><input value={f.phone} onChange={set('phone')} /></Field>
        <Field label="Qualification"><input value={f.qualification} onChange={set('qualification')} /></Field>
        <Field label="Hospital / clinic"><input value={f.hospital} onChange={set('hospital')} /></Field>
        <Field label="Commission">
          <div className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
            <input type="number" min="0" value={f.rate_value} onChange={set('rate_value')} placeholder="0" />
            <div className="seg"><button type="button" className={f.rate_type === 'percent' ? 'on' : ''} onClick={() => setF({ ...f, rate_type: 'percent' })}>%</button><button type="button" className={f.rate_type === 'fixed' ? 'on' : ''} onClick={() => setF({ ...f, rate_type: 'fixed' })}>Rs per test</button></div>
          </div>
        </Field>
      </div>
      <p className="faint">Department or single-test rates can be set later in Doctors.</p>
    </Modal>
  );
}

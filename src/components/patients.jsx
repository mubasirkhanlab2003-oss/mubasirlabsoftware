import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db.js';
import { registerPatient, updatePatient, findPossibleDuplicates, searchPatients } from '../lib/actions.js';
import { ageLabel, dobFromAge, genderLabel, fmtDate, todayISO } from '../lib/format.js';
import { useMemberships } from '../lib/hooks.js';
import { Field, useAction } from './ui.jsx';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CUR_YEAR = new Date().getFullYear();
const daysInMonth = (y, m) => new Date(y, m, 0).getDate();
const TITLES = ['', 'Mr.', 'Mrs.', 'Miss', 'Ms.', 'Baby', 'Master', 'Dr.'];

// Day / Month / Year dropdowns: fewer clicks than a calendar for birth dates.
function DobDropdowns({ value, onChange }) {
  const [y, m, d] = value ? value.split('-').map(Number) : ['', '', ''];
  const set = (ny, nm, nd) => {
    if (!ny || !nm || !nd) { onChange(''); return; }
    const dd = Math.min(nd, daysInMonth(ny, nm));
    onChange(`${ny}-${String(nm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`);
  };
  const days = Array.from({ length: y && m ? daysInMonth(y, m) : 31 }, (_, i) => i + 1);
  return (
    <div className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
      <select value={d || ''} onChange={(e) => set(y, m || 1, Number(e.target.value))} aria-label="Day">
        <option value="">Day</option>{days.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
      <select value={m || ''} onChange={(e) => set(y, Number(e.target.value), d || 1)} aria-label="Month">
        <option value="">Month</option>{MONTHS.map((name, i) => <option key={name} value={i + 1}>{name}</option>)}
      </select>
      <select value={y || ''} onChange={(e) => set(Number(e.target.value), m || 1, d || 1)} aria-label="Year">
        <option value="">Year</option>{Array.from({ length: 121 }, (_, i) => CUR_YEAR - i).map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
    </div>
  );
}

// Age can be typed in years, months or days (babies).
function ageToDob(n, unit) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return null;
  if (unit === 'y') return dobFromAge(v);
  const d = new Date();
  if (unit === 'm') d.setMonth(d.getMonth() - Math.floor(v));
  else d.setDate(d.getDate() - Math.floor(v));
  return d.toISOString().slice(0, 10);
}

export function PatientForm({ initial = {}, onSaved, onCancel, compact = false }) {
  const memberships = useMemberships();
  const [f, setF] = useState(() => ({
    title: '', full_name: '', phone: '', gender: '', dob: '', cnic: '', guardian: '', email: '', address: '', notes: '',
    membership_id: '', membership_no: '', membership_until: '', ...initial,
    age: initial.dob && initial.dob_estimated ? String(Math.floor((Date.now() - new Date(initial.dob)) / 31557600000)) : '',
    ageUnit: 'y', ageMode: initial.dob && !initial.dob_estimated ? 'dob' : 'age',
  }));
  const [dups, setDups] = useState(null);
  const [err, setErr] = useState('');
  const run = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  function validate() {
    if (!f.full_name.trim()) return 'Enter the patient name.';
    if (!f.gender) return 'Select gender (needed for reference ranges).';
    if (f.ageMode === 'dob' && !f.dob) return 'Enter date of birth, or switch to age.';
    if (f.ageMode === 'age' && (f.age === '' || ageToDob(f.age, f.ageUnit) === null)) return 'Enter the age.';
    if (f.ageMode === 'dob' && f.dob > todayISO()) return 'Date of birth cannot be in the future.';
    if (f.phone && f.phone.replace(/\D/g, '').length < 7) return 'Phone number looks too short.';
    if (f.cnic && f.cnic.replace(/\D/g, '').length !== 13) return 'CNIC should have 13 digits.';
    return '';
  }

  async function save(force = false) {
    const e = validate();
    setErr(e);
    if (e) return;
    const data = {
      title: f.title || null, full_name: f.full_name.trim(), phone: f.phone.trim() || null, gender: f.gender,
      dob: f.ageMode === 'dob' ? f.dob : ageToDob(f.age, f.ageUnit), dob_estimated: f.ageMode === 'age',
      cnic: f.cnic?.trim() || null, guardian: f.guardian?.trim() || null, email: f.email?.trim() || null,
      address: f.address || null, notes: f.notes || null,
      membership_id: f.membership_id || null, membership_no: f.membership_no || null, membership_until: f.membership_until || null,
    };
    if (initial.id) {
      const p = await run(() => updatePatient(initial.id, data), 'Patient details saved');
      if (p) onSaved?.(p);
      return;
    }
    if (!force) {
      const d = await findPossibleDuplicates(data);
      if (d.length) { setDups(d); return; }
    }
    const p = await run(() => registerPatient(data), 'Patient registered');
    if (p) onSaved?.(p);
  }

  return (
    <div className="stack" onKeyDown={(e) => { if (e.key === 'Enter' && e.ctrlKey) save(false); }}>
      <div className="grid3">
        <Field label="Full name" required>
          <div className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
            <select value={f.title || ''} onChange={set('title')} style={{ width: 86 }} aria-label="Title">
              {TITLES.map((t) => <option key={t} value={t}>{t || 'Title'}</option>)}
            </select>
            <input autoFocus value={f.full_name} onChange={set('full_name')} />
          </div>
        </Field>
        <Field label="Gender" required>
          <div className="seg">
            {[['male', 'Male'], ['female', 'Female'], ['other', 'Other']].map(([k, l]) => (
              <button type="button" key={k} className={f.gender === k ? 'on' : ''} onClick={() => setF({ ...f, gender: k })}>{l}</button>
            ))}
          </div>
        </Field>
        <Field label={f.ageMode === 'dob' ? 'Date of birth' : 'Age'} required>
          <div className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
            {f.ageMode === 'dob'
              ? <DobDropdowns value={f.dob || ''} onChange={(v) => setF({ ...f, dob: v })} />
              : <>
                <input type="number" min="0" max="130" value={f.age} onChange={set('age')} style={{ width: 80 }} />
                <select value={f.ageUnit} onChange={set('ageUnit')} style={{ width: 96 }} aria-label="Age unit">
                  <option value="y">years</option><option value="m">months</option><option value="d">days</option>
                </select>
              </>}
            <button type="button" className="btn small ghost" onClick={() => setF({ ...f, ageMode: f.ageMode === 'dob' ? 'age' : 'dob' })}>
              {f.ageMode === 'dob' ? 'Age' : 'DOB'}
            </button>
          </div>
        </Field>
        <Field label="Phone / WhatsApp"><input inputMode="tel" value={f.phone || ''} onChange={set('phone')} placeholder="03xx xxxxxxx" /></Field>
        <Field label="CNIC"><input inputMode="numeric" value={f.cnic || ''} onChange={set('cnic')} placeholder="xxxxx-xxxxxxx-x" /></Field>
        <Field label="Father / husband name"><input value={f.guardian || ''} onChange={set('guardian')} /></Field>
        {!compact && <>
          <Field label="Address"><input value={f.address || ''} onChange={set('address')} /></Field>
          <Field label="Email"><input type="email" value={f.email || ''} onChange={set('email')} /></Field>
          <Field label="Membership / discount card">
            <select value={f.membership_id || ''} onChange={set('membership_id')}>
              <option value="">None</option>
              {memberships.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.discount_pct}% off)</option>)}
            </select>
          </Field>
          {f.membership_id && <>
            <Field label="Card number"><input value={f.membership_no || ''} onChange={set('membership_no')} /></Field>
            <Field label="Valid until"><input type="date" value={f.membership_until || ''} onChange={set('membership_until')} /></Field>
          </>}
          <Field label="Notes (e.g. diabetic, difficult vein)"><input value={f.notes || ''} onChange={set('notes')} /></Field>
        </>}
      </div>
      {dups && (
        <div className="note warn">
          <b>This patient may already be registered.</b> Use the existing profile so all reports stay in one place:
          <div className="stack" style={{ marginTop: 8 }}>
            {dups.map((d) => (
              <div key={d.id} className="row">
                <span><b>{d.full_name}</b> · {d.mr_number} · {d.phone || 'no phone'} · {ageLabel(d.dob)} {genderLabel(d.gender)}</span>
                <span className="spacer" />
                <button className="btn small primary" onClick={() => onSaved?.(d)}>Use this patient</button>
              </div>
            ))}
          </div>
          <button className="btn small" style={{ marginTop: 8 }} onClick={() => save(true)}>No, this is a different person</button>
        </div>
      )}
      {err && <div className="error-text" role="alert">{err}</div>}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        {onCancel && <button className="btn" onClick={onCancel}>Cancel</button>}
        <button className="btn primary" onClick={() => save(false)}>{initial.id ? 'Save changes' : 'Register patient'}</button>
      </div>
    </div>
  );
}

// Find an existing patient (name, MR, phone, CNIC).
export function PatientSearch({ onPick, autoFocus = true, onNew }) {
  const [q, setQ] = useState('');
  const all = useLiveQuery(() => db().patients.toArray(), [], []);
  const results = q.trim() ? searchPatients(all, q).slice(0, 8) : [];
  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <input autoFocus={autoFocus} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Returning patient? Search name, MR, phone or CNIC" />
        {onNew && <button className="btn" onClick={() => onNew(q)}>New patient</button>}
      </div>
      {q.trim() && (
        <div className="table-wrap">
          <table className="t compact">
            <tbody>
              {results.map((p) => (
                <tr key={p.id} className="click" onClick={() => onPick(p)}>
                  <td><b>{p.full_name}</b> <span className="faint">{p.mr_number}</span></td>
                  <td>{p.phone}</td>
                  <td>{ageLabel(p.dob)} {genderLabel(p.gender)}</td>
                  <td className="faint">Since {fmtDate(p.created_at)}</td>
                </tr>
              ))}
              {!results.length && <tr><td className="empty">No patient found — fill the form below to register.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function patientName(p) {
  if (!p) return '';
  return [p.title, p.full_name].filter(Boolean).join(' ');
}
export function patientLine(p) {
  if (!p) return '';
  return [p.mr_number, (ageLabel(p.dob) || '') + (p.dob && p.dob_estimated ? ' (approx.)' : ''), genderLabel(p.gender), p.phone].filter(Boolean).join(' · ');
}

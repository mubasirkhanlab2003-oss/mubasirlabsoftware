import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, setMeta, TABLES } from '../lib/db.js';
import { supabase } from '../lib/supabase.js';
import { insertRow, updateRow, clean } from '../lib/repo.js';
import { listFailed, retryFailed, discardLocal, syncNow } from '../lib/sync.js';
import { useAuth } from '../lib/auth.jsx';
import { useDepartments, useOutsourceLabs, useSettings, useTests } from '../lib/hooks.js';
import { ROLES } from '../lib/perms.js';
import { fmtDateTime, todayISO } from '../lib/format.js';
import { rangeText } from '../lib/results.js';
import { registerPatient } from '../lib/actions.js';
import { ConfirmButton, Empty, Field, ImagePicker, Modal, Tabs, useAction, useMoney, useToast } from '../components/ui.jsx';

const TABS = [['lab', 'Lab details'], ['rules', 'Billing & workflow'], ['printing', 'Printing'], ['tests', 'Tests & prices'],
  ['pathologists', 'Pathologists'], ['memberships', 'Discount cards'], ['micro', 'Antibiotics & templates'], ['users', 'Users'],
  ['backup', 'Backup & import'], ['sync', 'Sync'], ['audit', 'Audit log']];

export default function Settings() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') || 'lab';
  return (
    <>
      <div className="page-head"><h1>Settings</h1></div>
      <Tabs tabs={TABS} value={tab} onChange={(t) => setSp({ tab: t })} />
      {tab === 'lab' && <SettingsForm kind="lab" />}
      {tab === 'rules' && <SettingsForm kind="rules" />}
      {tab === 'printing' && <SettingsForm kind="printing" />}
      {tab === 'tests' && <TestsAndPrices />}
      {tab === 'pathologists' && <Pathologists />}
      {tab === 'memberships' && <Memberships />}
      {tab === 'micro' && <><Antibiotics /><Templates /></>}
      {tab === 'users' && <Users />}
      {tab === 'backup' && <Backup />}
      {tab === 'sync' && <><SyncIssues /><ServerConflicts /></>}
      {tab === 'audit' && <Audit />}
    </>
  );
}

// ---------------------------------------------------------------- settings forms
function SettingsForm({ kind }) {
  const s = useSettings();
  const run = useAction();
  const [f, setF] = useState(null);
  useEffect(() => { if (s && !f) setF(clean(s)); }, [s, f]);
  if (!f) return <div className="panel"><Empty>Loading settings… (the first sync must finish once, online)</Empty></div>;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const chk = (k, label, hint) => (
    <label className="check"><input type="checkbox" checked={!!f[k]} onChange={(e) => setF({ ...f, [k]: e.target.checked })} /><span>{label}{hint && <small>{hint}</small>}</span></label>
  );
  async function save() {
    const out = { ...f };
    for (const k of ['home_charge', 'letterhead_top_mm', 'letterhead_bottom_mm', 'label_width_mm', 'label_height_mm', 'sample_keep_days', 'backup_reminder_days']) out[k] = Number(out[k] || 0);
    if (typeof out.expense_categories === 'string') out.expense_categories = out.expense_categories.split(',').map((x) => x.trim()).filter(Boolean);
    for (const k of Object.keys(out)) if (out[k] === '') out[k] = null;
    delete out.id; delete out.created_at;
    await run(() => updateRow('lab_settings', 1, out), 'Settings saved');
  }
  return (
    <div className="panel" style={{ maxWidth: 980 }}>
      {kind === 'lab' && <div className="grid2">
        <Field label="Lab name" required><input value={f.lab_name || ''} onChange={set('lab_name')} /></Field>
        <Field label="Tagline (under the name)"><input value={f.tagline || ''} onChange={set('tagline')} placeholder="e.g. Diagnostic & Research Laboratory" /></Field>
        <div className="span2"><Field label="Address"><input value={f.address || ''} onChange={set('address')} /></Field></div>
        <Field label="Phone"><input value={f.phone || ''} onChange={set('phone')} /></Field>
        <Field label="WhatsApp"><input value={f.whatsapp || ''} onChange={set('whatsapp')} /></Field>
        <Field label="Email"><input value={f.email || ''} onChange={set('email')} /></Field>
        <Field label="Website"><input value={f.website || ''} onChange={set('website')} /></Field>
        <Field label="Timings"><input value={f.working_hours || ''} onChange={set('working_hours')} placeholder="e.g. 24 hours / 8 AM – 10 PM" /></Field>
        <Field label="Web address of this app" hint="Used in QR codes and WhatsApp report links, e.g. https://mylab.vercel.app"><input value={f.public_url || ''} onChange={set('public_url')} placeholder={location.origin} /></Field>
        <Field label="Currency"><input value={f.currency || 'Rs'} onChange={set('currency')} /></Field>
        <Field label="Country code for WhatsApp"><input value={f.phone_country_code || '92'} onChange={set('phone_country_code')} /></Field>
        <div className="span2"><ImagePicker label="Logo (printed on reports, receipts)" value={f.logo} onChange={(v) => setF({ ...f, logo: v })} /></div>
      </div>}
      {kind === 'rules' && <div className="stack">
        <h2>Doctor commission</h2>
        <Field label="Commission is worked out on">
          <select value={f.commission_basis} onChange={set('commission_basis')} style={{ maxWidth: 420 }}>
            <option value="net">Price after the patient's discount (recommended)</option>
            <option value="gross">Full price (discount is the lab's loss)</option>
          </select>
        </Field>
        {chk('commission_needs_payment', 'Count commission only after the bill is fully paid', 'Unpaid bills show the commission as "waiting".')}
        <h2 style={{ marginTop: 10 }}>Reports</h2>
        {chk('report_needs_payment', 'Online report opens only when the bill is paid', 'The patient sees "pending payment" in the portal until then. Printing at the lab is not blocked.')}
        {chk('auto_verify', 'Auto-verify normal results', 'A result verifies itself when every value is inside its range, nothing is critical and nothing changed much from last time. Tests marked "always manual" (cultures, histopathology, HIV…) are never auto-verified.')}
        <h2 style={{ marginTop: 10 }}>Other</h2>
        <div className="grid3">
          <Field label="Home collection charge"><input type="number" value={f.home_charge ?? 0} onChange={set('home_charge')} /></Field>
          <Field label="Keep samples for (days)"><input type="number" value={f.sample_keep_days ?? 7} onChange={set('sample_keep_days')} /></Field>
          <Field label="Remind to download a backup every (days)"><input type="number" value={f.backup_reminder_days ?? 7} onChange={set('backup_reminder_days')} /></Field>
          <Field label="Delete PIN" hint="Asked before anything is deleted. Leave empty for no PIN."><input type="password" inputMode="numeric" value={f.delete_pin || ''} onChange={set('delete_pin')} autoComplete="new-password" /></Field>
          <div className="span2"><Field label="Expense categories (comma separated)"><input value={Array.isArray(f.expense_categories) ? f.expense_categories.join(', ') : f.expense_categories || ''} onChange={set('expense_categories')} /></Field></div>
        </div>
      </div>}
      {kind === 'printing' && <div className="grid2">
        <Field label="Report paper">
          <select value={f.report_mode} onChange={set('report_mode')}><option value="full">Plain paper — print our header with logo</option><option value="letterhead">Pre-printed letterhead — leave space, no header</option></select>
        </Field>
        <div className="row">
          <Field label="Top space (mm)"><input type="number" value={f.letterhead_top_mm} onChange={set('letterhead_top_mm')} /></Field>
          <Field label="Bottom space (mm)"><input type="number" value={f.letterhead_bottom_mm} onChange={set('letterhead_bottom_mm')} /></Field>
        </div>
        <Field label="Receipt printer">
          <select value={f.receipt_format} onChange={set('receipt_format')}><option value="a4">A4 / A5 paper</option><option value="thermal">Thermal 80 mm</option></select>
        </Field>
        <div className="row">
          <Field label="Barcode label width (mm)"><input type="number" value={f.label_width_mm} onChange={set('label_width_mm')} /></Field>
          <Field label="Label height (mm)"><input type="number" value={f.label_height_mm} onChange={set('label_height_mm')} /></Field>
        </div>
        <div className="span2"><Field label="Report footer (printed under every report)"><textarea value={f.report_footer || ''} onChange={set('report_footer')} placeholder="e.g. This report is for the use of the referring doctor. Results relate only to the sample tested." /></Field></div>
        <div className="span2"><Field label="Receipt footer"><textarea value={f.receipt_footer || ''} onChange={set('receipt_footer')} placeholder="e.g. Reports are kept for 30 days." /></Field></div>
      </div>}
      <div className="row" style={{ marginTop: 16 }}><button className="btn primary" onClick={save}>Save settings</button></div>
    </div>
  );
}

// ---------------------------------------------------------------- tests & prices
function TestsAndPrices() {
  const tests = useTests();
  const depts = useDepartments();
  const { isAdmin, can } = useAuth();
  const manage = isAdmin || can('prices');
  const [q, setQ] = useState('');
  const [dept, setDept] = useState('');
  const [edit, setEdit] = useState(null);
  const [inactive, setInactive] = useState(false);
  const shown = tests.filter((t) => (inactive || t.active !== false) && (!dept || (t.category || 'General') === dept)
    && (!q || t.name.toLowerCase().includes(q.toLowerCase()) || (t.code || '').toLowerCase().includes(q.toLowerCase())));
  const noPrice = tests.filter((t) => t.active !== false && t.price == null).length;
  return (
    <>
      {noPrice > 0 && <div className="note warn" style={{ marginBottom: 12 }}>{noPrice} active tests have no price yet. Type the prices below (only for tests you do), or switch off tests you don't do.</div>}
      <div className="panel flush">
        <div className="panel-head">
          <input style={{ maxWidth: 240 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find test or code" />
          <select style={{ maxWidth: 220 }} value={dept} onChange={(e) => setDept(e.target.value)}><option value="">All departments</option>{depts.map((d) => <option key={d}>{d}</option>)}<option>Packages</option></select>
          <label className="check faint"><input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} /> Show switched-off</label>
          <div className="grow" />
          <Link className="btn small" to="/print/ratelist">Print rate list</Link>
          {(isAdmin || can('catalogue') || manage) && <button className="btn small" onClick={() => setEdit({ kind: 'test', active: true, result_kind: 'parameters', sample_type: 'Serum', auto_verify: true })}>Add test</button>}
          {manage && <button className="btn small" onClick={() => setEdit({ kind: 'package', active: true, category: 'Packages', sample_type: 'Multiple', components: [] })}>Add package</button>}
        </div>
        <div className="table-wrap">
          <table className="t compact">
            <thead><tr><th>Code</th><th>Test</th><th>Department</th><th>Sample</th><th className="r">Report in</th><th className="r" style={{ width: 130 }}>Price</th><th>On</th><th /></tr></thead>
            <tbody>
              {shown.map((t) => (
                <tr key={t.id} className={t.active === false ? 'muted-row' : ''}>
                  <td className="faint">{t.code}</td>
                  <td><b>{t.name}</b>{!t.ranges_reviewed && t.kind !== 'package' && t.result_kind === 'parameters' && <span className="badge amber" style={{ marginLeft: 6 }} title="Starter reference ranges">ranges to review</span>}</td>
                  <td className="faint">{t.category}</td><td className="faint">{t.sample_type}</td>
                  <td className="r faint">{t.tat_hours ? `${t.tat_hours} h` : ''}</td>
                  <td className="r"><PriceInput t={t} disabled={!manage} /></td>
                  <td><input type="checkbox" checked={t.active !== false} disabled={!manage} onChange={(e) => updateRow('lab_tests', t.id, { active: e.target.checked })} aria-label="Active" /></td>
                  <td className="right"><button className="btn small ghost" onClick={() => setEdit(t)}>{t.kind === 'package' ? 'Edit package' : 'Parameters & ranges'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {edit && (edit.kind === 'package' ? <PackageModal t={edit} onClose={() => setEdit(null)} /> : <TestModal t={edit} manage={manage} onClose={() => setEdit(null)} />)}
    </>
  );
}

function PriceInput({ t, disabled }) {
  const [v, setV] = useState(t.price ?? '');
  const run = useAction();
  useEffect(() => setV(t.price ?? ''), [t.price]);
  return (
    <input type="number" min="0" value={v} disabled={disabled} placeholder="no price" style={{ textAlign: 'right' }}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { const n = v === '' ? null : Number(v); if (n !== (t.price ?? null)) run(() => updateRow('lab_tests', t.id, { price: n }), 'Price saved'); }} />
  );
}

function TestModal({ t, manage, onClose }) {
  const depts = useDepartments();
  const labs = useOutsourceLabs();
  const templates = useLiveQuery(() => db().report_templates.toArray(), [], []);
  const params = useLiveQuery(() => (t.id ? db().lab_parameters.where('test_id').equals(t.id).toArray() : []), [t.id], []);
  const ranges = useLiveQuery(async () => (params.length ? db().lab_reference_ranges.where('parameter_id').anyOf(params.map((p) => p.id)).toArray() : []), [params.map((p) => p.id).join()], []);
  const [f, setF] = useState({ code: '', name: '', category: '', sample_type: 'Serum', container: '', tat_hours: '', result_kind: 'parameters', method: '', instructions: '', report_note: '', auto_verify: true, outsourced: false, outsource_lab_id: '', template_id: '', ...t });
  const [rangeFor, setRangeFor] = useState(null);
  const [paramEdit, setParamEdit] = useState(null);
  const run = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function save() {
    const out = {
      code: f.code.trim().toUpperCase(), name: f.name.trim(), category: f.category || 'General', sample_type: f.sample_type || 'Serum',
      container: f.container || null, tat_hours: f.tat_hours === '' || f.tat_hours == null ? null : Number(f.tat_hours), result_kind: f.result_kind,
      method: f.method || null, instructions: f.instructions || null, report_note: f.report_note || null, auto_verify: !!f.auto_verify,
      outsourced: !!f.outsourced, outsource_lab_id: f.outsourced ? (f.outsource_lab_id || null) : null, template_id: f.template_id || null,
      ranges_reviewed: !!f.ranges_reviewed, kind: 'test',
    };
    if (!out.code || !out.name) throw new Error('Code and name are needed.');
    if (t.id) return updateRow('lab_tests', t.id, out);
    return insertRow('lab_tests', { ...out, active: true, components: [], sort_order: 9000 });
  }
  return (
    <Modal wide="x" title={t.id ? t.name : 'Add test'} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Close</button>
      <button className="btn primary" onClick={async () => { const ok = await run(save, 'Test saved'); if (ok && !t.id) onClose(); }}>{t.id ? 'Save test details' : 'Add test'}</button>
    </>}>
      <div className="grid4">
        <Field label="Code" required><input value={f.code} onChange={set('code')} /></Field>
        <div className="span2"><Field label="Name" required><input value={f.name} onChange={set('name')} /></Field></div>
        <Field label="Department"><input list="depts" value={f.category || ''} onChange={set('category')} /><datalist id="depts">{depts.map((d) => <option key={d} value={d} />)}</datalist></Field>
        <Field label="Sample"><input value={f.sample_type || ''} onChange={set('sample_type')} /></Field>
        <Field label="Tube / container"><input value={f.container || ''} onChange={set('container')} placeholder="EDTA (purple)" /></Field>
        <Field label="Report ready in (hours)"><input type="number" value={f.tat_hours ?? ''} onChange={set('tat_hours')} /></Field>
        <Field label="Result type"><select value={f.result_kind} onChange={set('result_kind')}><option value="parameters">Values (parameters)</option><option value="culture">Culture & sensitivity</option><option value="text">Written report (template)</option></select></Field>
        <Field label="Method (printed)"><input value={f.method || ''} onChange={set('method')} /></Field>
        {f.result_kind === 'text' && <Field label="Template"><select value={f.template_id || ''} onChange={set('template_id')}><option value="">None</option>{templates.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>}
        <div className="span2"><Field label="Patient instructions (receipt)"><input value={f.instructions || ''} onChange={set('instructions')} placeholder="e.g. Fasting 10–12 hours" /></Field></div>
        <div className="span2"><Field label="Note printed on the report"><input value={f.report_note || ''} onChange={set('report_note')} /></Field></div>
        <label className="check"><input type="checkbox" checked={!!f.auto_verify} onChange={(e) => setF({ ...f, auto_verify: e.target.checked })} /><span>May auto-verify<small>Off = always checked by hand</small></span></label>
        <label className="check"><input type="checkbox" checked={!!f.outsourced} onChange={(e) => setF({ ...f, outsourced: e.target.checked })} /><span>Usually sent to an outside lab</span></label>
        {f.outsourced && <Field label="Outside lab"><select value={f.outsource_lab_id || ''} onChange={set('outsource_lab_id')}><option value="">Choose…</option>{labs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
        {f.result_kind === 'parameters' && <label className="check"><input type="checkbox" checked={!!f.ranges_reviewed} onChange={(e) => setF({ ...f, ranges_reviewed: e.target.checked })} /><span>Reference ranges reviewed<small>Confirmed for our analyser</small></span></label>}
      </div>

      {t.id && f.result_kind === 'parameters' && (
        <>
          <div className="panel-head" style={{ marginTop: 18 }}><h2>Parameters</h2><div className="grow" />
            <button className="btn small" onClick={() => setParamEdit({ test_id: t.id, result_type: 'numeric', decimals: 1, sort_order: (params.length + 1) * 10, active: true })}>Add parameter</button></div>
          <div className="table-wrap">
            <table className="t compact">
              <thead><tr><th>#</th><th>Parameter</th><th>Code</th><th>Unit</th><th>Type</th><th>Reference ranges</th><th>Critical</th><th /></tr></thead>
              <tbody>
                {params.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)).map((p) => (
                  <tr key={p.id} className={p.active === false ? 'muted-row' : ''}>
                    <td className="faint">{p.sort_order}</td>
                    <td><b>{p.name}</b>{p.section && <div className="faint">{p.section}</div>}</td>
                    <td className="faint">{p.code}</td><td className="faint">{p.unit}</td>
                    <td className="faint">{p.result_type}{p.formula ? `: ${p.formula.length > 30 ? p.formula.slice(0, 30) + '…' : p.formula}` : ''}{p.options ? `: ${p.options}` : ''}</td>
                    <td className="faint">{ranges.filter((r) => r.parameter_id === p.id && r.active !== false).map((r) => <div key={r.id}>{r.gender !== 'any' ? r.gender + ' ' : ''}{ageBand(r)}{rangeText(r)}</div>)}</td>
                    <td className="faint">{[p.critical_low != null && `< ${p.critical_low}`, p.critical_high != null && `> ${p.critical_high}`].filter(Boolean).join(' · ')}</td>
                    <td className="right nowrap"><button className="btn small ghost" onClick={() => setParamEdit(p)}>Edit</button><button className="btn small ghost" onClick={() => setRangeFor(p)}>Ranges</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!params.length && <Empty>No parameters yet.</Empty>}
          </div>
        </>
      )}
      {!t.id && <p className="faint" style={{ marginTop: 10 }}>Save the test first, then add its parameters and ranges.</p>}
      {paramEdit && <ParamModal p={paramEdit} siblings={params} onClose={() => setParamEdit(null)} />}
      {rangeFor && <RangesModal p={rangeFor} ranges={ranges.filter((r) => r.parameter_id === rangeFor.id && r.active !== false)} onClose={() => setRangeFor(null)} />}
      {!manage && <p className="faint">Prices are changed by the Admin or Accountant.</p>}
    </Modal>
  );
}

function ageBand(r) {
  const y = (d) => (d >= 365 ? `${Math.round(d / 365.25)}y` : `${d}d`);
  if (!r.age_min_days && r.age_max_days == null) return '';
  return `${y(r.age_min_days || 0)}–${r.age_max_days == null ? '' : y(r.age_max_days)}: `;
}

function ParamModal({ p, siblings, onClose }) {
  const [f, setF] = useState({ name: '', code: '', unit: '', result_type: 'numeric', options: '', decimals: 1, formula: '', critical_low: '', critical_high: '', delta_pct: '', section: '', default_value: '', sort_order: 10, active: true, ...p, reflex_when: p.reflex?.when || '', reflex_test: p.reflex?.test || '' });
  const run = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const num = (v) => (v === '' || v == null ? null : Number(v));
  return (
    <Modal wide title={p.id ? `Parameter: ${p.name}` : 'Add parameter'} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" onClick={async () => {
        const out = {
          test_id: p.test_id, name: f.name.trim(), code: f.code.trim().toUpperCase() || null, unit: f.unit || null, result_type: f.result_type,
          options: f.options || null, decimals: Number(f.decimals || 0), formula: f.result_type === 'calculated' ? f.formula : null,
          critical_low: num(f.critical_low), critical_high: num(f.critical_high), delta_pct: num(f.delta_pct), section: f.section || null,
          default_value: f.default_value || null, sort_order: Number(f.sort_order || 0), active: f.active !== false,
          reflex: f.reflex_when && f.reflex_test ? { when: f.reflex_when, test: f.reflex_test.toUpperCase() } : null,
        };
        const ok = await run(() => { if (!out.name) throw new Error('Name is needed.'); return p.id ? updateRow('lab_parameters', p.id, out) : insertRow('lab_parameters', out); }, 'Parameter saved');
        if (ok) onClose();
      }}>Save</button>
    </>}>
      <div className="grid3">
        <Field label="Name" required><input autoFocus value={f.name} onChange={set('name')} /></Field>
        <Field label="Code (for formulas)"><input value={f.code || ''} onChange={set('code')} placeholder="e.g. TC" /></Field>
        <Field label="Unit"><input value={f.unit || ''} onChange={set('unit')} /></Field>
        <Field label="Type"><select value={f.result_type} onChange={set('result_type')}><option value="numeric">Number</option><option value="option">Pick from list</option><option value="text">Free text</option><option value="calculated">Calculated</option></select></Field>
        <Field label="Decimals"><input type="number" min="0" max="4" value={f.decimals} onChange={set('decimals')} /></Field>
        <Field label="Order"><input type="number" value={f.sort_order} onChange={set('sort_order')} /></Field>
        {f.result_type === 'option' && <div className="span3"><Field label="Choices (comma separated)"><input value={f.options || ''} onChange={set('options')} /></Field></div>}
        {f.result_type === 'calculated' && <div className="span3"><Field label="Formula" hint={`Use other parameters by code: ${siblings.filter((s) => s.code).map((s) => `{${s.code}}`).join(' ') || 'give them codes first'}. Also AGE, FEMALE, min(), max(), pow(). Example LDL: {TC}-{HDL}-{TG}/5`}><input value={f.formula || ''} onChange={set('formula')} /></Field></div>}
        <Field label="Critical below"><input type="number" value={f.critical_low ?? ''} onChange={set('critical_low')} /></Field>
        <Field label="Critical above"><input type="number" value={f.critical_high ?? ''} onChange={set('critical_high')} /></Field>
        <Field label="Warn if changed more than (%)" hint="Delta check against the last result"><input type="number" value={f.delta_pct ?? ''} onChange={set('delta_pct')} /></Field>
        <Field label="Sub-heading on report"><input value={f.section || ''} onChange={set('section')} placeholder="e.g. Differential count" /></Field>
        <Field label="Default value"><input value={f.default_value || ''} onChange={set('default_value')} /></Field>
        <Field label="Suggest another test when">
          <div className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
            <select value={f.reflex_when} onChange={set('reflex_when')} style={{ width: 120 }}><option value="">never</option><option value="high">high</option><option value="low">low</option><option value="abnormal">abnormal</option></select>
            <input value={f.reflex_test} onChange={set('reflex_test')} placeholder="test code" />
          </div>
        </Field>
        <label className="check"><input type="checkbox" checked={f.active !== false} onChange={(e) => setF({ ...f, active: e.target.checked })} /> In use</label>
      </div>
    </Modal>
  );
}

function RangesModal({ p, ranges, onClose }) {
  const [f, setF] = useState({ gender: 'any', from: '', fromU: 'y', to: '', toU: 'y', low: '', high: '', display_text: '' });
  const run = useAction();
  const days = (v, u) => (v === '' ? null : Math.round(Number(v) * (u === 'y' ? 365.25 : u === 'm' ? 30.44 : 1)));
  return (
    <Modal wide title={`Reference ranges: ${p.name}`} onClose={onClose} footer={<button className="btn" onClick={onClose}>Done</button>}>
      <p className="muted" style={{ marginTop: 0 }}>The range matching the patient's sex and age is used. A sex-specific range wins over "any"; the narrowest age band wins.</p>
      <table className="t compact"><tbody>
        {ranges.map((r) => <tr key={r.id}><td>{r.gender}</td><td>{ageBand(r) || 'all ages'}</td><td><b>{rangeText(r)}</b></td><td className="faint">{r.note}</td>
          <td className="right"><button className="btn small ghost" onClick={() => run(() => updateRow('lab_reference_ranges', r.id, { active: false }), 'Range removed')}>Remove</button></td></tr>)}
      </tbody></table>
      {!ranges.length && <p className="faint">No range yet.</p>}
      <h3 style={{ marginTop: 14 }}>Add a range</h3>
      <div className="grid4">
        <Field label="Sex"><select value={f.gender} onChange={(e) => setF({ ...f, gender: e.target.value })}><option value="any">Any</option><option value="male">Male</option><option value="female">Female</option></select></Field>
        <Field label="Age from"><div className="row" style={{ flexWrap: 'nowrap', gap: 4 }}><input type="number" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /><select value={f.fromU} onChange={(e) => setF({ ...f, fromU: e.target.value })} style={{ width: 70 }}><option value="y">yr</option><option value="m">mo</option><option value="d">day</option></select></div></Field>
        <Field label="Age to (blank = no limit)"><div className="row" style={{ flexWrap: 'nowrap', gap: 4 }}><input type="number" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /><select value={f.toU} onChange={(e) => setF({ ...f, toU: e.target.value })} style={{ width: 70 }}><option value="y">yr</option><option value="m">mo</option><option value="d">day</option></select></div></Field>
        <div />
        <Field label="Low"><input type="number" value={f.low} onChange={(e) => setF({ ...f, low: e.target.value })} /></Field>
        <Field label="High"><input type="number" value={f.high} onChange={(e) => setF({ ...f, high: e.target.value })} /></Field>
        <Field label="Or normal text" hint="e.g. Non-reactive, Nil"><input value={f.display_text} onChange={(e) => setF({ ...f, display_text: e.target.value })} /></Field>
        <button className="btn primary" style={{ alignSelf: 'end' }} onClick={() => run(async () => {
          const row = { parameter_id: p.id, gender: f.gender, age_min_days: days(f.from, f.fromU) || 0, age_max_days: days(f.to, f.toU), low: f.low === '' ? null : Number(f.low), high: f.high === '' ? null : Number(f.high), display_text: f.display_text || null, active: true };
          if (row.low == null && row.high == null && !row.display_text) throw new Error('Enter low/high or a normal text.');
          await insertRow('lab_reference_ranges', row);
          setF({ ...f, low: '', high: '', display_text: '' });
        }, 'Range added')}>Add range</button>
      </div>
    </Modal>
  );
}

function PackageModal({ t, onClose }) {
  const tests = useTests().filter((x) => x.kind !== 'package' && x.active !== false);
  const [f, setF] = useState({ code: '', name: '', price: '', components: [], ...t });
  const [q, setQ] = useState('');
  const run = useAction();
  const m = useMoney();
  const comps = (f.components || []).map((id) => tests.find((x) => x.id === id)).filter(Boolean);
  const listSum = comps.reduce((s, x) => s + Number(x.price || 0), 0);
  return (
    <Modal wide title={t.id ? `Package: ${t.name}` : 'Add package'} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" onClick={async () => {
        const out = { code: f.code.trim().toUpperCase(), name: f.name.trim(), price: f.price === '' || f.price == null ? null : Number(f.price), components: f.components, kind: 'package', category: 'Packages', sample_type: 'Multiple' };
        const ok = await run(() => { if (!out.code || !out.name || !out.components.length) throw new Error('Code, name and at least one test are needed.'); return t.id ? updateRow('lab_tests', t.id, out) : insertRow('lab_tests', { ...out, active: true, sort_order: 50 }); }, 'Package saved');
        if (ok) onClose();
      }}>Save</button>
    </>}>
      <div className="grid3">
        <Field label="Code" required><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
        <Field label="Name" required><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Package price" hint={`Tests separately: ${m(listSum)}`}><input type="number" value={f.price ?? ''} onChange={(e) => setF({ ...f, price: e.target.value })} /></Field>
      </div>
      <h3 style={{ marginTop: 12 }}>Tests in this package</h3>
      <div className="chips">{comps.map((c) => <button key={c.id} className="chip on" onClick={() => setF({ ...f, components: f.components.filter((x) => x !== c.id) })}>{c.name} ✕</button>)}</div>
      <input style={{ marginTop: 10 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Add test…" />
      <div className="test-pick" style={{ marginTop: 8, maxHeight: 260 }}>
        {tests.filter((x) => !f.components.includes(x.id) && (!q || x.name.toLowerCase().includes(q.toLowerCase()) || x.code.toLowerCase().startsWith(q.toLowerCase()))).slice(0, 40).map((x) => (
          <button key={x.id} onClick={() => setF({ ...f, components: [...f.components, x.id] })}><span className="code">{x.code}</span><span>{x.name}</span></button>
        ))}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- pathologists, cards, micro
function Pathologists() {
  const list = useLiveQuery(() => db().pathologists.toArray(), [], []);
  const [edit, setEdit] = useState(null);
  return (
    <div className="panel" style={{ maxWidth: 900 }}>
      <div className="panel-head"><h2>Pathologists (sign the reports)</h2><div className="grow" /><button className="btn small primary" onClick={() => setEdit({ active: true, is_default: !list.length })}>Add pathologist</button></div>
      <table className="t"><tbody>
        {list.map((p) => <tr key={p.id}><td>{p.signature && <img src={p.signature} alt="" style={{ height: 34 }} />}</td><td><b>{p.full_name}</b>{p.is_default && <span className="badge teal" style={{ marginLeft: 6 }}>Default</span>}{p.active === false && <span className="badge">Off</span>}<div className="faint">{[p.qualification, p.designation].filter(Boolean).join(' · ')}</div></td>
          <td className="right"><button className="btn small ghost" onClick={() => setEdit(p)}>Edit</button></td></tr>)}
      </tbody></table>
      {!list.length && <Empty>Add the pathologist whose name and signature are printed on reports.</Empty>}
      {edit && <PathologistModal p={edit} others={list} onClose={() => setEdit(null)} />}
    </div>
  );
}

function PathologistModal({ p, others, onClose }) {
  const [f, setF] = useState({ full_name: '', qualification: '', designation: 'Consultant Pathologist', signature: null, is_default: false, active: true, sort_order: 0, ...p });
  const run = useAction();
  return (
    <Modal wide title={p.id ? 'Edit pathologist' : 'Add pathologist'} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" onClick={async () => {
        const ok = await run(async () => {
          if (!f.full_name.trim()) throw new Error('Enter the name.');
          const out = { full_name: f.full_name.trim(), qualification: f.qualification || null, designation: f.designation || null, signature: f.signature || null, is_default: !!f.is_default, active: f.active !== false, sort_order: Number(f.sort_order || 0) };
          if (out.is_default) for (const o of others.filter((x) => x.id !== p.id && x.is_default)) await updateRow('pathologists', o.id, { is_default: false });
          return p.id ? updateRow('pathologists', p.id, out) : insertRow('pathologists', out);
        }, 'Saved');
        if (ok) onClose();
      }}>Save</button>
    </>}>
      <div className="grid2">
        <Field label="Name" required><input autoFocus value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} placeholder="Dr. …" /></Field>
        <Field label="Qualification"><input value={f.qualification || ''} onChange={(e) => setF({ ...f, qualification: e.target.value })} placeholder="MBBS, FCPS (Histopathology)" /></Field>
        <Field label="Designation"><input value={f.designation || ''} onChange={(e) => setF({ ...f, designation: e.target.value })} /></Field>
        <div className="stack">
          <label className="check"><input type="checkbox" checked={!!f.is_default} onChange={(e) => setF({ ...f, is_default: e.target.checked })} /> Default signer</label>
          <label className="check"><input type="checkbox" checked={f.active !== false} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active</label>
        </div>
        <div className="span2"><ImagePicker label="Signature (photo of the signature on white paper)" value={f.signature} maxW={360} maxH={140} onChange={(v) => setF({ ...f, signature: v })} /></div>
      </div>
    </Modal>
  );
}

function Memberships() {
  const list = useLiveQuery(() => db().memberships.toArray(), [], []);
  const [f, setF] = useState({ name: '', discount_pct: '' });
  const run = useAction();
  return (
    <div className="panel" style={{ maxWidth: 720 }}>
      <h2>Discount / membership cards</h2>
      <p className="muted">Give a patient a card in their profile; its discount is applied automatically on new bills.</p>
      <table className="t compact"><tbody>{list.map((x) => <tr key={x.id} className={x.active === false ? 'muted-row' : ''}><td>{x.name}</td><td>{x.discount_pct}% off</td>
        <td className="right"><button className="btn small ghost" onClick={() => run(() => updateRow('memberships', x.id, { active: x.active === false }))}>{x.active === false ? 'Turn on' : 'Turn off'}</button></td></tr>)}</tbody></table>
      <div className="row" style={{ marginTop: 10, flexWrap: 'nowrap' }}>
        <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Family card, Senior citizen" />
        <input type="number" value={f.discount_pct} onChange={(e) => setF({ ...f, discount_pct: e.target.value })} placeholder="%" style={{ width: 90 }} />
        <button className="btn" disabled={!f.name.trim() || f.discount_pct === ''} onClick={() => run(() => insertRow('memberships', { name: f.name.trim(), discount_pct: Number(f.discount_pct), active: true }), 'Card added').then(() => setF({ name: '', discount_pct: '' }))}>Add</button>
      </div>
    </div>
  );
}

function Antibiotics() {
  const list = useLiveQuery(() => db().antibiotics.toArray(), [], []);
  const [n, setN] = useState('');
  const [c, setC] = useState('');
  const run = useAction();
  return (
    <div className="panel">
      <h2>Antibiotics for culture reports</h2>
      <div className="chips">{list.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)).map((a) => (
        <button key={a.id} className={`chip ${a.active !== false ? 'on' : ''}`} title={a.class} onClick={() => run(() => updateRow('antibiotics', a.id, { active: a.active === false }))}>{a.name}</button>
      ))}</div>
      <p className="faint">Click to switch an antibiotic on/off for the culture form.</p>
      <div className="row" style={{ flexWrap: 'nowrap', maxWidth: 640 }}>
        <input value={n} onChange={(e) => setN(e.target.value)} placeholder="New antibiotic" /><input value={c} onChange={(e) => setC(e.target.value)} placeholder="Class" />
        <button className="btn" disabled={!n.trim()} onClick={() => run(() => insertRow('antibiotics', { name: n.trim(), class: c || null, sort_order: list.length + 1, active: true }), 'Added').then(() => { setN(''); setC(''); })}>Add</button>
      </div>
    </div>
  );
}

function Templates() {
  const list = useLiveQuery(() => db().report_templates.toArray(), [], []);
  const [edit, setEdit] = useState(null);
  const run = useAction();
  return (
    <div className="panel">
      <div className="panel-head"><h2>Written report templates</h2><div className="grow" /><button className="btn small" onClick={() => setEdit({ name: '', body: '' })}>Add template</button></div>
      <table className="t compact"><tbody>{list.map((t) => <tr key={t.id}><td>{t.name}</td><td className="faint">{t.body.slice(0, 80)}…</td><td className="right"><button className="btn small ghost" onClick={() => setEdit(t)}>Edit</button></td></tr>)}</tbody></table>
      {edit && (
        <Modal wide title={edit.id ? 'Edit template' : 'Add template'} onClose={() => setEdit(null)} footer={<><button className="btn" onClick={() => setEdit(null)}>Cancel</button>
          <button className="btn primary" onClick={async () => { const ok = await run(() => (edit.id ? updateRow('report_templates', edit.id, { name: edit.name, body: edit.body }) : insertRow('report_templates', { name: edit.name, body: edit.body, active: true })), 'Saved'); if (ok) setEdit(null); }}>Save</button></>}>
          <div className="stack"><Field label="Name"><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Text"><textarea rows={14} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></Field></div>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- users
function Users() {
  const run = useAction();
  const { user, refreshProfile } = useAuth();
  const list = useLiveQuery(() => db().profiles.toArray(), [], []);
  const change = (p, patch) => run(async () => { await updateRow('profiles', p.id, patch); if (p.id === user.id) await refreshProfile(); }, 'User updated');
  return (
    <div className="panel" style={{ maxWidth: 900 }}>
      <h2>Users</h2>
      <div className="note" style={{ marginBottom: 10 }}>
        One person running the lab needs only the Admin login. To add staff: Supabase → Authentication → Users → <b>Add user</b> (email + password). The account appears here switched off; switch it on and choose the role. Each role sees only its own work.
      </div>
      <table className="t">
        <thead><tr><th>User</th><th>Role</th><th>Active</th></tr></thead>
        <tbody>{list.map((p) => (
          <tr key={p.id}>
            <td><b>{p.full_name}</b><div className="faint">{p.email}</div></td>
            <td><select value={p.role} style={{ width: 190 }} onChange={(e) => change(p, { role: e.target.value })}>{ROLES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></td>
            <td><input type="checkbox" checked={p.active} disabled={p.id === user.id} onChange={(e) => change(p, { active: e.target.checked })} aria-label="Active" /></td>
          </tr>
        ))}</tbody>
      </table>
      <p className="faint">Receptionist: registration, bills, payments. Technician: worklist, results, samples, QC, stock. Pathologist: technician + verify. Accountant: bills, doctors' commission, panels, expenses, reports, prices.</p>
    </div>
  );
}

// ---------------------------------------------------------------- backup & import
function Backup() {
  const run = useAction();
  const last = useLiveQuery(() => db().meta.get('last_backup'), [], null);
  async function download() {
    const out = { app: 'lab-information-system', version: 2, made_at: new Date().toISOString(), tables: {} };
    for (const t of TABLES) out.tables[t] = (await db()[t].toArray()).map(clean);
    const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `lab-backup-${todayISO()}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    await setMeta('last_backup', todayISO());
  }
  return (
    <div className="stack" style={{ maxWidth: 900 }}>
      <div className="panel">
        <h2>Backup</h2>
        <p className="muted">Downloads everything on this device (patients, bills, results, settings) as one file. Keep it on a USB or Google Drive. The server (Supabase) also keeps the data.</p>
        <div className="row"><button className="btn primary" onClick={() => run(download, 'Backup downloaded')}>Download full backup</button>
          <span className="faint">Last backup: {last?.value || 'never'}</span></div>
      </div>
      <ImportBox kind="patients" />
      <ImportBox kind="prices" />
    </div>
  );
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

function ImportBox({ kind }) {
  const run = useAction();
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const head = kind === 'patients' ? 'name, phone, gender (male/female), age or date of birth (YYYY-MM-DD), cnic, address' : 'code, price';
  async function doImport() {
    let n = 0;
    if (kind === 'patients') {
      for (const r of rows.slice(1)) {
        const [name, phone, gender, age, cnic, address] = r.map((x) => (x || '').trim());
        if (!name) continue;
        const g = /^f/i.test(gender) ? 'female' : /^m/i.test(gender) ? 'male' : null;
        const dob = /^\d{4}-\d\d-\d\d$/.test(age) ? age : age ? `${new Date().getFullYear() - Number(age)}-01-01` : null;
        await registerPatient({ full_name: name, phone: phone || null, gender: g, dob, dob_estimated: !/^\d{4}-/.test(age), cnic: cnic || null, address: address || null });
        n++;
      }
    } else {
      const tests = await db().lab_tests.toArray();
      for (const r of rows.slice(1)) {
        const [code, price] = r.map((x) => (x || '').trim());
        const t = tests.find((x) => x.code.toUpperCase() === code.toUpperCase());
        if (t && price !== '' && Number.isFinite(Number(price))) { await updateRow('lab_tests', t.id, { price: Number(price) }); n++; }
      }
    }
    setRows(null);
    return n;
  }
  return (
    <div className="panel">
      <h2>{kind === 'patients' ? 'Import patients (from old software / Excel)' : 'Import test prices'}</h2>
      <p className="muted">Save the Excel sheet as CSV. First row = headings. Columns: <b>{head}</b>.</p>
      <input type="file" accept=".csv,text/csv" onChange={async (e) => { const f = e.target.files[0]; if (f) setRows(parseCsv(await f.text())); }} />
      {rows && <div style={{ marginTop: 10 }}>
        <p>{rows.length - 1} rows found. First rows:</p>
        <table className="t compact"><tbody>{rows.slice(0, 6).map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table>
        <button className="btn primary" style={{ marginTop: 8 }} onClick={async () => { const n = await run(doImport); if (n !== undefined) toast(`${n} imported`); }}>Import {rows.length - 1} rows</button>
      </div>}
    </div>
  );
}

// ---------------------------------------------------------------- sync + audit
export function SyncIssues() {
  const run = useAction();
  const [list, setList] = useState([]);
  const refresh = () => listFailed().then(setList);
  useEffect(() => { refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t); }, []);
  return (
    <div className="panel">
      <div className="panel-head"><h2>Changes on this device that did not reach the server</h2><div className="grow" /><button className="btn small" onClick={() => run(async () => { await syncNow(); await refresh(); }, 'Sync finished')}>Sync now</button></div>
      {!list.length && <Empty>Everything on this device has reached the server, or is waiting for internet.</Empty>}
      <table className="t"><tbody>
        {list.map(({ table, row }) => (
          <tr key={table + row.id}>
            <td><b>{table.replace(/_/g, ' ')}</b><div className="faint">{row.mr_number || row.acc_number || row.payment_number || row.full_name || row.name || row.test_name || row.id}</div></td>
            <td className="error-text">{row._error}</td>
            <td className="right"><div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn small" onClick={() => run(async () => { await retryFailed(table, row.id); await refresh(); })}>Try again</button>
              <ConfirmButton label="Discard this change" danger title="Discard local change" confirmLabel="Discard"
                message={row._base ? 'This device goes back to the last version saved on the server.' : 'This record was never saved on the server and will be removed from this device.'}
                onConfirm={() => run(async () => { await discardLocal(table, row.id); await refresh(); }, 'Discarded')} />
            </div></td>
          </tr>
        ))}
      </tbody></table>
    </div>
  );
}

function ServerConflicts() {
  const run = useAction();
  const [rows, setRows] = useState(null);
  async function load() {
    const { data, error } = await supabase.from('sync_conflicts').select('*').is('resolved_at', null).order('created_at', { ascending: false }).limit(100);
    if (error) throw new Error(error.message);
    setRows(data);
  }
  useEffect(() => { if (navigator.onLine) run(load); }, []); // eslint-disable-line
  async function resolve(c, how) {
    if (how === 'mine' && c.local_data && c.record_id) {
      const cur = await db()[c.table_name]?.get(c.record_id);
      if (!cur) throw new Error('Record is not on this device.');
      const { id, created_at, updated_at, row_version, created_by, updated_by, ...patch } = c.local_data; // eslint-disable-line no-unused-vars
      await updateRow(c.table_name, c.record_id, patch);
    }
    const { data: s } = await supabase.auth.getSession();
    const { error } = await supabase.from('sync_conflicts').update({ resolved_at: new Date().toISOString(), resolved_by: s.session?.user?.id, resolution: how }).eq('id', c.id);
    if (error) throw new Error(error.message);
    await load();
  }
  return (
    <div className="panel">
      <div className="panel-head"><h2>Conflicts reported by all devices</h2><div className="grow" /><button className="btn small" onClick={() => run(load)}>Refresh</button></div>
      {rows === null && <p className="muted">Connect to the internet to see conflicts.</p>}
      {rows && !rows.length && <Empty>No open conflicts.</Empty>}
      {rows && rows.map((c) => (
        <div key={c.id} className="note warn" style={{ marginBottom: 8 }}>
          <div className="row"><b>{c.table_name}</b><span className="faint">{fmtDateTime(c.created_at)} · device {c.device_code}</span><div className="spacer" />
            {c.server_data && c.local_data && <button className="btn small" onClick={() => run(() => resolve(c, 'mine'), 'Applied the other version')}>Apply the saved version</button>}
            <button className="btn small" onClick={() => run(() => resolve(c, 'kept'), 'Marked as resolved')}>Keep current</button></div>
          <div>{c.error}</div>
        </div>
      ))}
    </div>
  );
}

function Audit() {
  const run = useAction();
  const [rows, setRows] = useState(null);
  const [table, setTable] = useState('');
  async function load() {
    let q = supabase.from('audit_log').select('*').order('at', { ascending: false }).limit(300);
    if (table) q = q.eq('table_name', table);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    setRows(data);
  }
  useEffect(() => { if (navigator.onLine) run(load); }, [table]); // eslint-disable-line
  return (
    <div className="panel">
      <div className="panel-head"><h2>Audit log — every change, who and when</h2><div className="grow" />
        <select value={table} onChange={(e) => setTable(e.target.value)} style={{ width: 220 }}>
          <option value="">All records</option>
          {['bill_payments', 'accessions', 'accession_tests', 'patients', 'lab_tests', 'lab_reference_ranges', 'ref_doctors', 'commission_rules', 'doctor_payouts', 'expenses', 'lab_settings', 'profiles'].map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
        </select></div>
      {rows === null && <p className="muted">Connect to the internet to view the audit log.</p>}
      {rows && <div className="table-wrap"><table className="t compact"><tbody>
        {rows.map((r) => (
          <tr key={r.id}><td className="faint nowrap">{fmtDateTime(r.at)}</td><td>{r.table_name.replace(/_/g, ' ')}</td><td>{r.action}</td>
            <td style={{ fontSize: 12.5, wordBreak: 'break-word' }}>{r.action === 'update' ? Object.entries(r.changes || {}).map(([k, v]) => `${k}: ${JSON.stringify(v.old)} → ${JSON.stringify(v.new)}`).join('; ') : ''}</td></tr>
        ))}
      </tbody></table></div>}
    </div>
  );
}


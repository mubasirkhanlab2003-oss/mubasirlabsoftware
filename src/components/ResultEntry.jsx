import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db.js';
import * as A from '../lib/actions.js';
import { useAuth } from '../lib/auth.jsx';
import { usePathologists, useSettings } from '../lib/hooks.js';
import {
  autoVerifyReason, buildResults, CULTURE_GROWTH, cultureComplete, deltaChecks, FLAG_LABEL, numericValid,
  ORGANISMS, reflexSuggestions, SIR,
} from '../lib/results.js';
import { fmtDate } from '../lib/format.js';
import { Field, Modal, useAction, useToast } from './ui.jsx';

// Enter results for one test. Parameter tests get a fast grid (Enter moves
// down), cultures get organism + antibiotic S/I/R grid, text reports get a
// template. Shows the last result, flags, critical values and suggestions.
export default function ResultEntry({ row, acc, patient, amend = false, onClose }) {
  const { user, can, isAdmin } = useAuth();
  const settings = useSettings();
  const paths = usePathologists();
  const run = useAction();
  const toast = useToast();
  const test = useLiveQuery(() => db().lab_tests.get(row.test_id), [row.test_id]);
  const params = useLiveQuery(() => db().lab_parameters.where('test_id').equals(row.test_id).toArray(), [row.test_id], []);
  const ranges = useLiveQuery(async () => {
    if (!params.length) return {};
    const all = await db().lab_reference_ranges.where('parameter_id').anyOf(params.map((p) => p.id)).toArray();
    return all.reduce((m, r) => ((m[r.parameter_id] ||= []).push(r), m), {});
  }, [params.map((p) => p.id).join()], {});
  const previous = useLiveQuery(() => A.previousResults(row.patient_id || patient?.id, row.test_id, row.id), [row.id], {});
  const kind = test?.result_kind || 'parameters';
  const at = useMemo(() => new Date(acc?.registered_at || Date.now()), [acc?.registered_at]);
  const active = params.filter((p) => p.active !== false).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  const [vals, setVals] = useState(() => {
    const o = {};
    for (const r of row.results || []) o[r.parameter_id || r.name] = r.value;
    return o;
  });
  useEffect(() => {
    // fill defaults once parameters are known
    if (!active.length) return;
    setVals((v) => {
      const o = { ...v };
      for (const p of active) if (o[p.id] == null && p.default_value) o[p.id] = p.default_value;
      return o;
    });
  }, [active.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const [culture, setCulture] = useState(() => row.culture || { growth: '', isolates: [], gram: '', comment: '' });
  const [text, setText] = useState(row.text_result || '');
  const [remarks, setRemarks] = useState(row.remarks || '');
  const [reason, setReason] = useState('');
  const [pathId, setPathId] = useState(row.pathologist_id || '');
  const [critical, setCritical] = useState(null);
  const [busy, setBusy] = useState(false);
  const gridRef = useRef(null);
  useEffect(() => { if (!pathId && paths.length) setPathId((paths.find((p) => p.is_default) || paths[0]).id); }, [paths.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const results = kind === 'parameters' ? buildResults(active, vals, ranges, patient, at) : [];
  const prevFor = (p) => previous[p.id] || (p.code ? previous['code:' + p.code] : null);
  const deltas = kind === 'parameters' ? deltaChecks(active, results, Object.fromEntries(active.map((p) => [p.id, prevFor(p)]).filter(([, v]) => v))) : [];
  const reflex = kind === 'parameters' ? reflexSuggestions(active, results) : [];
  const invalid = active.filter((p) => p.result_type === 'numeric' && !numericValid(vals[p.id]));
  const empty = kind === 'parameters' ? results.filter((r) => r.value === '' && !r.calculated).length
    : kind === 'culture' ? (cultureComplete(culture) ? 0 : 1) : (text.trim() ? 0 : 1);
  const mayVerify = isAdmin || can('verify');
  const autoBlock = kind === 'parameters' ? autoVerifyReason(test, results, deltas, settings?.auto_verify) : 'Needs manual verification';
  const criticalRows = results.filter((r) => r.critical);

  const reflexTests = useLiveQuery(async () => {
    if (!reflex.length) return [];
    const all = await db().lab_tests.toArray();
    const on = await db().accession_tests.where('accession_id').equals(row.accession_id).toArray();
    return reflex.map((r) => ({ ...r, test: all.find((t) => t.code === r.code) }))
      .filter((r) => r.test && !on.some((x) => x.test_id === r.test.id && x.status !== 'cancelled'));
  }, [reflex.map((r) => r.code).join()], []);

  function payload() {
    if (kind === 'culture') return { culture, remarks: remarks || null };
    if (kind === 'text') return { text_result: text, remarks: remarks || null };
    return { results, remarks: remarks || null };
  }

  async function save(verify) {
    if (invalid.length) return;
    setBusy(true);
    let ok;
    if (amend) {
      ok = await run(() => A.amendResult(row, payload(), reason, { userId: user?.id, pathologistId: pathId || null }), 'Result amended — the old values are kept in history');
    } else {
      const auto = !verify && !autoBlock && empty === 0;
      ok = await run(() => A.saveResult(row, payload(), { verify: verify || auto, autoVerified: auto, pathologistId: pathId || null, userId: user?.id }),
        verify ? 'Saved and verified — report ready' : (!autoBlock && empty === 0 ? 'Saved and auto-verified (all normal)' : 'Saved — waiting for verification'));
    }
    setBusy(false);
    if (!ok) return;
    if (criticalRows.length && !amend) { setCritical(ok); return; }
    onClose(ok);
  }

  // Enter = next field (fast keyboard entry)
  function onGridKey(e) {
    if (e.key !== 'Enter' || e.target.tagName === 'TEXTAREA') return;
    e.preventDefault();
    const inputs = [...gridRef.current.querySelectorAll('input:not([disabled]), select')];
    const i = inputs.indexOf(e.target);
    if (i >= 0 && i < inputs.length - 1) inputs[i + 1].focus();
    else if (e.ctrlKey || i === inputs.length - 1) document.getElementById('re-save')?.focus();
  }

  if (critical) {
    return <CriticalCall testRow={critical} rows={criticalRows} acc={acc} onClose={() => onClose(critical)} toast={toast} />;
  }

  return (
    <Modal wide="x" title={`${amend ? 'Amend' : 'Result'}: ${row.test_name}`} onClose={() => onClose(null)} footer={<>
      {paths.length > 0 && mayVerify && (
        <select value={pathId} onChange={(e) => setPathId(e.target.value)} style={{ width: 'auto', marginRight: 'auto' }} aria-label="Signing pathologist">
          {paths.map((p) => <option key={p.id} value={p.id}>Signed by {p.full_name}</option>)}
        </select>
      )}
      <button className="btn" onClick={() => onClose(null)}>Cancel</button>
      {amend
        ? <button id="re-save" className="btn primary" disabled={busy || !reason.trim() || invalid.length > 0} onClick={() => save(true)}>Save amendment</button>
        : <>
          <button id={mayVerify ? undefined : 're-save'} className="btn" disabled={busy || invalid.length > 0} onClick={() => save(false)}
            title={autoBlock || 'All values normal — it will verify itself'}>{!autoBlock && empty === 0 ? 'Save (auto-verify)' : 'Save'}</button>
          {mayVerify && <button id="re-save" className="btn primary" disabled={busy || invalid.length > 0 || empty > 0}
            title={empty ? 'Fill every result first' : ''} onClick={() => save(true)}>Save and verify</button>}
        </>}
    </>}>
      <div className="muted" style={{ marginTop: -6, marginBottom: 10 }}>
        {patient?.full_name} · {acc?.acc_number}{row.sample_type ? ` · ${row.sample_type}` : ''}{test?.method ? ` · Method: ${test.method}` : ''}
      </div>
      {test && !test.ranges_reviewed && kind === 'parameters' && <div className="note warn" style={{ marginBottom: 10 }}>Reference ranges of this test are starter values. Check them once in Settings → Tests & prices and tick "Reviewed".</div>}
      {acc?.clinical_notes && <div className="note" style={{ marginBottom: 10 }}>Clinical notes: {acc.clinical_notes}</div>}

      <div ref={gridRef} onKeyDown={onGridKey}>
        {kind === 'parameters' && (
          <>
            {!active.length && <div className="note bad">This test has no parameters yet. Add them in Settings → Tests & prices.</div>}
            <div className="table-wrap">
              <table className="t result-grid">
                <thead><tr><th>Parameter</th><th style={{ width: 170 }}>Result</th><th>Unit</th><th>Reference</th><th>Flag</th><th>Last result</th></tr></thead>
                <tbody>
                  {active.map((p, i) => {
                    const r = results[i];
                    const prev = prevFor(p);
                    const d = deltas.find((x) => x.parameter_id === p.id);
                    const sec = p.section && p.section !== active[i - 1]?.section ? p.section : null;
                    return [
                      sec && <tr key={'s' + p.id} className="sec"><td colSpan={6}>{sec}</td></tr>,
                      <tr key={p.id}>
                        <td>{p.name}</td>
                        <td>
                          {p.result_type === 'calculated'
                            ? <input value={r.value} disabled title={`Calculated: ${p.formula}`} />
                            : p.result_type === 'option'
                              ? <select autoFocus={i === 0} value={vals[p.id] ?? ''} onChange={(e) => setVals({ ...vals, [p.id]: e.target.value })}>
                                  <option value="" />{(p.options || '').split(',').map((o) => o.trim()).filter(Boolean).map((o) => <option key={o}>{o}</option>)}
                                </select>
                              : <input autoFocus={i === 0} inputMode={p.result_type === 'numeric' ? 'decimal' : 'text'} value={vals[p.id] ?? ''}
                                  className={p.result_type === 'numeric' && !numericValid(vals[p.id]) ? 'bad' : ''}
                                  list={p.result_type === 'text' ? `opts-${p.id}` : undefined}
                                  onChange={(e) => setVals({ ...vals, [p.id]: e.target.value })} />}
                          {p.result_type === 'text' && r.ref_text && <datalist id={`opts-${p.id}`}><option value={r.ref_text} /></datalist>}
                        </td>
                        <td className="faint">{p.unit}</td>
                        <td className="faint">{r.ref_text || (p.result_type === 'numeric' ? <i>none for this age/sex</i> : '')}</td>
                        <td>
                          {r.critical ? <span className="flag-critical">Critical {r.critical}</span>
                            : r.flag && r.flag !== 'normal' ? <span className={`flag-${r.flag}`}>{FLAG_LABEL[r.flag]}</span>
                              : r.flag ? <span className="faint">Normal</span> : null}
                        </td>
                        <td className="prev">{prev ? <>{prev.value} <span className="faint">({fmtDate(prev.on)})</span>{d && <div className="delta">changed {d.pct}%</div>}</> : ''}</td>
                      </tr>,
                    ];
                  })}
                </tbody>
              </table>
            </div>
            {invalid.length > 0 && <div className="error-text">Numbers only for: {invalid.map((p) => p.name).join(', ')}.</div>}
          </>
        )}

        {kind === 'culture' && <CultureEntry value={culture} onChange={setCulture} sample={row.sample_type} />}

        {kind === 'text' && <TextEntry value={text} onChange={setText} templateId={test?.template_id} />}
      </div>

      {(deltas.length > 0 || criticalRows.length > 0 || reflexTests.length > 0) && (
        <div className="stack" style={{ marginTop: 12 }}>
          {criticalRows.length > 0 && <div className="note bad"><b>Critical value:</b> {criticalRows.map((r) => `${r.name} ${r.value}`).join(', ')}. After saving you will record who was informed.</div>}
          {deltas.length > 0 && <div className="note warn"><b>Big change from last time:</b> {deltas.map((d) => `${d.name} ${d.from} → ${d.to} (${d.pct}%)`).join(', ')}. Re-check the sample before verifying.</div>}
          {reflexTests.map((r) => (
            <div key={r.code} className="note row">
              <span>Suggested: <b>{r.test.name}</b> — because {r.because}.</span><span className="spacer" />
              <button className="btn small" onClick={() => run(() => A.addTests(acc, [r.test.id]), `${r.test.name} added to the bill`)}>Add to bill</button>
            </div>
          ))}
        </div>
      )}

      <div className="grid2" style={{ marginTop: 12 }}>
        <Field label="Remarks (printed on report)"><textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} /></Field>
        {amend && <Field label="Reason for amendment" required><textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
      </div>
      {!amend && kind === 'parameters' && settings?.auto_verify && <p className="faint" style={{ marginBottom: 0 }}>{autoBlock ? `Manual verification needed: ${autoBlock.toLowerCase()}.` : 'All values normal — Save will verify it automatically.'}</p>}
      {amend && <p className="faint">The report will say "Amended". The old values stay in the history.</p>}
    </Modal>
  );
}

function CultureEntry({ value, onChange, sample }) {
  const abx = (useLiveQuery(() => db().antibiotics.toArray(), [], []) || []).filter((a) => a.active !== false).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  const [hide, setHide] = useState(() => Object.fromEntries((value.isolates || []).map((x, i) => [i, Object.keys(x.ab || {}).length > 0])));
  const set = (patch) => onChange({ ...value, ...patch });
  const isolates = value.isolates || [];
  const setIso = (i, patch) => set({ isolates: isolates.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  return (
    <div className="stack">
      <div className="grid2">
        <Field label="Specimen"><input value={value.specimen ?? sample ?? ''} onChange={(e) => set({ specimen: e.target.value })} /></Field>
        <Field label="Culture result" required>
          <select value={value.growth || ''} onChange={(e) => set({ growth: e.target.value, isolates: e.target.value === 'Growth isolated' ? (isolates.length ? isolates : [{ organism: '', count: '', ab: {} }]) : [] })}>
            <option value="">Choose…</option>{CULTURE_GROWTH.map((g) => <option key={g}>{g}</option>)}
          </select>
        </Field>
        <Field label="Gram stain / microscopy"><input value={value.gram || ''} onChange={(e) => set({ gram: e.target.value })} placeholder="e.g. Gram-negative rods seen; pus cells 10–15/HPF" /></Field>
      </div>
      {isolates.map((iso, i) => (
        <div key={i} className="panel" style={{ margin: 0, background: 'var(--sunk)' }}>
          <div className="grid3">
            <Field label={`Organism ${isolates.length > 1 ? i + 1 : ''}`} required>
              <input list="organisms" value={iso.organism || ''} onChange={(e) => setIso(i, { organism: e.target.value })} />
            </Field>
            <Field label="Colony count"><input value={iso.count || ''} onChange={(e) => setIso(i, { count: e.target.value })} placeholder="e.g. > 10^5 CFU/mL" /></Field>
            <div className="row" style={{ alignSelf: 'end' }}>
              <button className="btn small" onClick={() => setHide({ ...hide, [i]: !hide[i] })}>{hide[i] ? 'Show all antibiotics' : 'Show tested only'}</button>
              {isolates.length > 1 && <button className="btn small danger" onClick={() => set({ isolates: isolates.filter((_, j) => j !== i) })}>Remove</button>}
            </div>
          </div>
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table className="t compact ab-grid">
              <thead><tr><th>Antibiotic</th><th>Result</th><th>MIC / zone (optional)</th></tr></thead>
              <tbody>
                {abx.filter((a) => !hide[i] || iso.ab?.[a.name]).map((a) => {
                  const cur = iso.ab?.[a.name] || {};
                  const setAb = (p) => {
                    const next = { ...(iso.ab || {}) };
                    const v = { ...cur, ...p };
                    if (!v.r && !v.mic) delete next[a.name]; else next[a.name] = v;
                    setIso(i, { ab: next });
                  };
                  return (
                    <tr key={a.id}>
                      <td>{a.name} <span className="faint">{a.class}</span></td>
                      <td>
                        <div className="sir">
                          {SIR.map(([k, l]) => <button key={k} type="button" title={l} className={`${k} ${cur.r === k ? 'on' : ''}`} onClick={() => setAb({ r: cur.r === k ? '' : k })}>{k}</button>)}
                        </div>
                      </td>
                      <td><input value={cur.mic || ''} onChange={(e) => setAb({ mic: e.target.value })} style={{ maxWidth: 140 }} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      {value.growth === 'Growth isolated' && <button className="btn small" style={{ justifySelf: 'start' }} onClick={() => set({ isolates: [...isolates, { organism: '', count: '', ab: {} }] })}>Add another organism</button>}
      <Field label="Comment"><textarea rows={2} value={value.comment || ''} onChange={(e) => set({ comment: e.target.value })} /></Field>
      <datalist id="organisms">{ORGANISMS.map((o) => <option key={o} value={o} />)}</datalist>
    </div>
  );
}

function TextEntry({ value, onChange, templateId }) {
  const templates = (useLiveQuery(() => db().report_templates.toArray(), [], []) || []).filter((t) => t.active !== false);
  useEffect(() => {
    if (!value && templateId) {
      const t = templates.find((x) => x.id === templateId);
      if (t) onChange(t.body);
    }
  }, [templateId, templates.length]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="stack">
      <div className="row">
        <span className="faint">Template</span>
        <select style={{ width: 'auto' }} value="" onChange={(e) => { const t = templates.find((x) => x.id === e.target.value); if (t && (!value.trim() || window.confirm('Replace the text with this template?'))) onChange(t.body); }}>
          <option value="">Insert a template…</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </div>
      <textarea autoFocus rows={16} value={value} onChange={(e) => onChange(e.target.value)} style={{ lineHeight: 1.55 }} />
    </div>
  );
}

// Who was told about the critical value (international lab practice).
function CriticalCall({ testRow, rows, acc, onClose, toast }) {
  const doctor = useLiveQuery(() => (acc?.doctor_id ? db().ref_doctors.get(acc.doctor_id) : null), [acc?.doctor_id]);
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => { if (doctor && !to) setTo(`${doctor.full_name}${doctor.phone ? ' · ' + doctor.phone : ''}`); }, [doctor]); // eslint-disable-line react-hooks/exhaustive-deps
  async function save() {
    try {
      for (const r of rows) await A.logCriticalCall({ testRow, parameter: r.name, value: r.value, informedTo: to, note });
      toast('Critical call recorded');
      onClose();
    } catch (e) { toast(e.message, true); }
  }
  return (
    <Modal title="Critical value — inform the doctor now" onClose={onClose} footer={<>
      <button className="btn" onClick={() => { toast('Not recorded — remember to inform the doctor', true); onClose(); }}>Later</button>
      <button className="btn primary" disabled={!to.trim()} onClick={save}>Record call</button>
    </>}>
      <div className="note bad" style={{ marginBottom: 12 }}>{rows.map((r) => <div key={r.name}><b>{r.name}: {r.value} {r.unit}</b> (critical {r.critical})</div>)}</div>
      <div className="stack">
        <Field label="Informed to (name and phone)" required><input autoFocus value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label="Note"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. read back confirmed" /></Field>
      </div>
    </Modal>
  );
}

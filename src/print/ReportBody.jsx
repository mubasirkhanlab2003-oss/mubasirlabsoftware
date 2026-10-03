// The lab report itself. Pure: it only draws the data it is given, so the
// lab (from this device) and the online portal (from the server) print the
// exact same report.
import { useEffect, useState } from 'react';
import { ageLabel, fmtDate, fmtDateTime, genderLabel } from '../lib/format.js';
import { SIR } from '../lib/results.js';

export function useQr(text, size = 110) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let live = true;
    if (!text) { setUrl(null); return undefined; }
    import('qrcode').then(({ default: QR }) => QR.toDataURL(text, { margin: 0, width: size, errorCorrectionLevel: 'M' }))
      .then((u) => live && setUrl(u)).catch(() => {});
    return () => { live = false; };
  }, [text, size]);
  return url;
}

export function LabHeader({ lab, qr, qrLabel, letterhead }) {
  if (letterhead) return null;
  const contact = [lab?.phone && `Ph: ${lab.phone}`, lab?.whatsapp && `WhatsApp: ${lab.whatsapp}`, lab?.email, lab?.website].filter(Boolean).join('  |  ');
  return (
    <div className="doc-head">
      {lab?.logo && <img src={lab.logo} alt="" width="70" height="70" />}
      <div className="lab">
        <h1>{lab?.lab_name || 'Laboratory'}</h1>
        {lab?.tagline && <div style={{ fontWeight: 700 }}>{lab.tagline}</div>}
        {lab?.address && <div>{lab.address}</div>}
        {contact && <div>{contact}</div>}
        {lab?.working_hours && <div>{lab.working_hours}</div>}
      </div>
      {qr && <div className="qr"><img src={qr} alt="" width="78" height="78" /><div>{qrLabel}</div></div>}
    </div>
  );
}

export function PatientBox({ patient, cells = [], at }) {
  const age = ageLabel(patient?.dob, at ? new Date(at) : new Date());
  const all = [
    ['Patient', [patient?.title, patient?.full_name].filter(Boolean).join(' ')],
    ['MR No.', patient?.mr_number],
    ['Age / Sex', [age && `${age}${patient?.dob_estimated ? '' : ''}`, genderLabel(patient?.gender)].filter(Boolean).join(' / ')],
    ...cells,
  ];
  return <div className="doc-pt">{all.map(([k, v]) => <div key={k}><span>{k}: </span><b>{v || '—'}</b></div>)}</div>;
}

function flagMark(r) {
  if (r.critical) return 'Critical';
  if (r.flag === 'high') return 'H';
  if (r.flag === 'low') return 'L';
  if (r.flag === 'abnormal') return '*';
  return '';
}

function ParamTable({ t }) {
  const rows = (t.results || []).filter((r) => r.value !== '' && r.value != null);
  let lastSec = null;
  return (
    <table className="doc">
      <thead><tr><th style={{ width: '38%' }}>Test</th><th>Result</th><th>Flag</th><th>Unit</th><th>Reference range</th></tr></thead>
      <tbody>
        {rows.map((r) => {
          const sec = r.section && r.section !== lastSec ? r.section : null;
          lastSec = r.section || lastSec;
          const out = r.flag && r.flag !== 'normal';
          return [
            sec && <tr key={'s' + (r.parameter_id || r.name)} className="sec"><td colSpan={5}>{sec}</td></tr>,
            <tr key={r.parameter_id || r.name}>
              <td>{r.name}</td>
              <td className={`v ${out || r.critical ? 'hl' : ''}`}>{r.value}</td>
              <td className={out || r.critical ? 'hl' : ''}>{flagMark(r)}</td>
              <td>{r.unit}</td>
              <td>{r.ref_text}</td>
            </tr>,
          ];
        })}
      </tbody>
    </table>
  );
}

function CultureBlock({ c }) {
  if (!c) return null;
  const isolates = c.isolates || [];
  const abNames = [...new Set(isolates.flatMap((i) => Object.keys(i.ab || {})))];
  return (
    <div>
      <table className="doc"><tbody>
        {c.specimen && <tr><td style={{ width: '30%' }}>Specimen</td><td className="v">{c.specimen}</td></tr>}
        {c.gram && <tr><td>Gram stain / microscopy</td><td>{c.gram}</td></tr>}
        <tr><td>Culture</td><td className="v">{c.growth === 'Growth isolated' ? isolates.map((i, n) => <div key={n}>{isolates.length > 1 ? `${n + 1}. ` : ''}<i>{i.organism}</i>{i.count ? ` — ${i.count}` : ''}</div>) : c.growth}</td></tr>
      </tbody></table>
      {abNames.length > 0 && (
        <table className="doc" style={{ marginTop: 6 }}>
          <thead><tr><th>Antibiotic</th>{isolates.map((i, n) => <th key={n}>{isolates.length > 1 ? `Organism ${n + 1}` : 'Result'}</th>)}</tr></thead>
          <tbody>
            {abNames.map((a) => (
              <tr key={a}><td>{a}</td>{isolates.map((i, n) => {
                const v = i.ab?.[a];
                return <td key={n} className={v?.r === 'R' ? 'hl' : ''}>{v?.r ? (SIR.find((x) => x[0] === v.r)?.[1] || v.r) : '—'}{v?.mic ? ` (${v.mic})` : ''}</td>;
              })}</tr>
            ))}
          </tbody>
        </table>
      )}
      {c.comment && <p style={{ marginTop: 4 }}><b>Comment:</b> {c.comment}</p>}
    </div>
  );
}

export default function ReportBody({ data, qr }) {
  const { lab, patient, acc, tests, pending = [], pathologists = [] } = data;
  const letterhead = lab?.report_mode === 'letterhead';
  const byDept = [];
  for (const t of tests) {
    const d = t.department || 'General';
    let g = byDept.find((x) => x.d === d);
    if (!g) { g = { d, tests: [] }; byDept.push(g); }
    g.tests.push(t);
  }
  const signers = [...new Set(tests.map((t) => t.pathologist_id).filter(Boolean))].map((id) => pathologists.find((p) => p.id === id)).filter(Boolean);
  if (!signers.length) { const d = pathologists.find((p) => p.is_default) || pathologists[0]; if (d) signers.push(d); }
  const lastVerified = tests.map((t) => t.verified_at).filter(Boolean).sort().pop();
  const amended = tests.some((t) => t.amended || t.amend_count > 0);
  return (
    <>
      <LabHeader lab={lab} qr={qr} qrLabel="Scan to verify" letterhead={letterhead} />
      <div className="doc-title">LABORATORY REPORT {amended && <span className="stamp" style={{ marginLeft: 8, fontSize: 11 }}>AMENDED</span>}</div>
      <PatientBox patient={patient} at={acc.registered_at} cells={[
        ['Case No.', acc.acc_number], ['Referred by', acc.doctor || 'Self'], ['Registered', fmtDateTime(acc.registered_at)],
        ['Reported', lastVerified ? fmtDateTime(lastVerified) : '—'], ['Phone', patient?.phone],
        ...(acc.panel ? [['Panel', acc.panel]] : []),
      ]} />
      {letterhead && qr && <div style={{ float: 'right', textAlign: 'center', fontSize: 9, marginTop: -4 }}><img src={qr} alt="" width="62" height="62" /><div>Verify</div></div>}
      {acc.clinical_notes && <p style={{ margin: '0 0 6px' }}><b>Clinical notes:</b> {acc.clinical_notes}</p>}
      {byDept.map((g) => (
        <div key={g.d}>
          <div className="doc-dept">{g.d}</div>
          {g.tests.map((t) => (
            <div className="doc-test" key={t.id}>
              <h3>{t.test_name}{t.sample_type ? <span style={{ fontWeight: 400, color: '#555' }}> — {t.sample_type}</span> : ''}{(t.amended || t.amend_count > 0) && <span style={{ color: '#b42a2a', fontWeight: 400 }}> (amended)</span>}</h3>
              {t.culture ? <CultureBlock c={t.culture} />
                : t.text_result ? <div style={{ whiteSpace: 'pre-wrap' }}>{t.text_result}</div>
                  : <ParamTable t={t} />}
              {t.remarks && <p style={{ margin: '4px 0 0' }}><b>Remarks:</b> {t.remarks}</p>}
              {t.report_note && <p style={{ margin: '3px 0 0', fontSize: 11, color: '#444' }}>{t.report_note}</p>}
              {t.method && <p style={{ margin: '2px 0 0', fontSize: 10.5, color: '#666' }}>Method: {t.method}</p>}
            </div>
          ))}
        </div>
      ))}
      {pending.length > 0 && <p style={{ marginTop: 10 }}><b>Reports to follow:</b> {pending.join(', ')}</p>}
      <p style={{ fontSize: 10.5, color: '#555', marginTop: 10 }}>H = above, L = below the reference range. Reference ranges depend on age, sex and method.</p>
      <div className="doc-foot">
        <div style={{ fontSize: 10.5, color: '#555' }}>
          {acc.verify_code && lab?.public_url && <>Verify online: {lab.public_url.replace(/^https?:\/\//, '')}/v/{acc.verify_code}<br /></>}
          Printed {fmtDate(new Date())}
        </div>
        <div className="row" style={{ gap: 26 }}>
          {signers.map((p) => (
            <div className="doc-sign" key={p.id}>
              {p.signature && <img src={p.signature} alt="" />}
              <b>{p.full_name}</b>
              <div>{p.qualification}</div>
              <div>{p.designation}</div>
            </div>
          ))}
        </div>
      </div>
      {lab?.report_footer && <div className="doc-note">{lab.report_footer}</div>}
      <div className="doc-note" style={{ borderTop: 0, textAlign: 'center' }}>This is an electronically verified report.</div>
    </>
  );
}

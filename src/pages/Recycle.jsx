import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db.js';
import * as A from '../lib/actions.js';
import { fmtDateTime } from '../lib/format.js';
import { Empty, Money, useAction } from '../components/ui.jsx';

// Everything deleted, in one place, with Restore.
export default function Recycle() {
  const run = useAction();
  const rows = useLiveQuery(async () => {
    const out = [];
    const pts = Object.fromEntries((await db().patients.toArray()).map((p) => [p.id, p]));
    for (const p of Object.values(pts)) if (p.deleted_at && !p.merged_into) out.push({ table: 'patients', row: p, what: 'Patient', label: `${p.full_name} · ${p.mr_number}`, to: `/patients/${p.id}` });
    for (const a of await db().accessions.toArray()) if (a.deleted_at && !a.deleted_batch) out.push({ table: 'accessions', row: a, what: 'Case / bill', label: `${a.acc_number} · ${pts[a.patient_id]?.full_name || ''}`, to: `/cases/${a.id}` });
    for (const p of await db().bill_payments.toArray()) if (p.deleted_at) out.push({ table: 'bill_payments', row: p, what: 'Payment', label: p.payment_number, amount: p.amount, to: `/cases/${p.accession_id}` });
    const docs = Object.fromEntries((await db().ref_doctors.toArray()).map((d) => [d.id, d]));
    for (const d of Object.values(docs)) if (d.deleted_at) out.push({ table: 'ref_doctors', row: d, what: 'Doctor', label: d.full_name, to: `/doctors/${d.id}` });
    for (const p of await db().doctor_payouts.toArray()) if (p.deleted_at) out.push({ table: 'doctor_payouts', row: p, what: 'Payment to doctor', label: `${p.payout_number} · ${docs[p.doctor_id]?.full_name || ''}`, amount: p.amount });
    for (const e of await db().expenses.toArray()) if (e.deleted_at) out.push({ table: 'expenses', row: e, what: 'Expense', label: `${e.category} ${e.paid_to || ''}`, amount: e.amount });
    for (const p of await db().panel_payments.toArray()) if (p.deleted_at) out.push({ table: 'panel_payments', row: p, what: 'Panel payment', label: p.reference || '', amount: p.amount });
    for (const p of await db().outsource_payments.toArray()) if (p.deleted_at) out.push({ table: 'outsource_payments', row: p, what: 'Outside-lab payment', label: p.note || '', amount: p.amount });
    for (const q of await db().qc_runs.toArray()) if (q.deleted_at) out.push({ table: 'qc_runs', row: q, what: 'QC run', label: String(q.value) });
    return out.sort((a, b) => (b.row.deleted_at || b.row.updated_at || '').localeCompare(a.row.deleted_at || a.row.updated_at || ''));
  }, [], null);
  if (!rows) return null;
  return (
    <>
      <div className="page-head"><div><h1>Recycle bin</h1><div className="sub">Deleted records are kept here and left out of every report. Restore brings them (and their money) back.</div></div></div>
      <div className="panel flush"><div className="table-wrap">
        <table className="t">
          <thead><tr><th>Deleted</th><th>What</th><th>Record</th><th>Reason</th><th className="r">Amount</th><th /></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.table + r.row.id}>
              <td className="nowrap faint">{fmtDateTime(r.row.deleted_at)}</td><td>{r.what}</td>
              <td>{r.to ? <Link to={r.to}>{r.label}</Link> : r.label}</td><td className="faint">{r.row.delete_reason}</td>
              <td className="r">{r.amount != null && <Money v={r.amount} />}</td>
              <td className="right"><button className="btn small" onClick={() => run(() => A.restore(r.table, r.row).then(() => true), 'Restored')}>Restore</button></td>
            </tr>
          ))}</tbody>
        </table>
        {!rows.length && <Empty><b>The recycle bin is empty.</b></Empty>}
      </div></div>
    </>
  );
}

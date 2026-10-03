import { useSearchParams } from 'react-router-dom';
import { addDays, addMonths, monthEnd, monthStart, todayISO, weekStart } from '../lib/format.js';

export function presets() {
  const t = todayISO();
  const lm = addMonths(monthStart(t), -1);
  return [
    ['today', 'Today', t, t],
    ['yesterday', 'Yesterday', addDays(t, -1), addDays(t, -1)],
    ['week', 'This week', weekStart(t), t],
    ['month', 'This month', monthStart(t), t],
    ['lastmonth', 'Last month', lm, monthEnd(lm)],
    ['year', 'This year', t.slice(0, 4) + '-01-01', t],
  ];
}

// Period kept in the address (so a refresh or a printed statement keeps it).
export function usePeriod(def = 'month') {
  const [sp, setSp] = useSearchParams();
  const p = presets();
  const key = sp.get('p') || (sp.get('from') ? 'custom' : def);
  const pre = p.find((x) => x[0] === key);
  const from = pre ? pre[2] : sp.get('from') || todayISO();
  const to = pre ? pre[3] : sp.get('to') || todayISO();
  const set = (k, f, tt) => {
    const n = new URLSearchParams(sp);
    n.delete('p'); n.delete('from'); n.delete('to');
    if (k === 'custom') { n.set('from', f); n.set('to', tt); } else n.set('p', k);
    setSp(n, { replace: true });
  };
  return { key, from, to, set, label: pre ? pre[1] : `${from} to ${to}` };
}

export function PeriodPicker({ period }) {
  return (
    <div className="row">
      <div className="chips">
        {presets().map(([k, l]) => <button key={k} className={`chip ${period.key === k ? 'on' : ''}`} onClick={() => period.set(k)}>{l}</button>)}
      </div>
      <div className="row" style={{ gap: 6 }}>
        <input type="date" value={period.from} onChange={(e) => period.set('custom', e.target.value, period.to < e.target.value ? e.target.value : period.to)} style={{ width: 150 }} aria-label="From" />
        <span className="faint">to</span>
        <input type="date" value={period.to} onChange={(e) => period.set('custom', period.from > e.target.value ? e.target.value : period.from, e.target.value)} style={{ width: 150 }} aria-label="To" />
      </div>
    </div>
  );
}

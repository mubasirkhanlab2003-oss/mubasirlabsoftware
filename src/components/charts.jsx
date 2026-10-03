// Small dependency-free SVG charts.

const W = 640;

function scale(min, max, h, pad = 18) {
  const span = max - min || 1;
  return (v) => pad + (h - pad * 2) * (1 - (v - min) / span);
}

// A value over time, with the normal band shaded.
export function TrendChart({ points, low, high, unit = '', height = 200 }) {
  const ys = points.map((p) => p.y).filter(Number.isFinite);
  if (!ys.length) return <p className="muted">No numeric results yet.</p>;
  let min = Math.min(...ys, low ?? Infinity), max = Math.max(...ys, high ?? -Infinity);
  const padv = (max - min) * 0.15 || Math.abs(max) * 0.1 || 1;
  min -= padv; max += padv;
  const y = scale(min, max, height);
  const left = 44, right = 14;
  const x = (i) => (points.length === 1 ? (left + W - right) / 2 : left + ((W - left - right) * i) / (points.length - 1));
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.y)}`).join(' ');
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${height}`} role="img" aria-label="Result trend">
      {low != null && high != null && <rect x={left} width={W - left - right} y={y(high)} height={Math.max(y(low) - y(high), 1)} fill="var(--green-50)" />}
      {[min + padv, (min + max) / 2, max - padv].map((v) => <g key={v}><line x1={left} x2={W - right} y1={y(v)} y2={y(v)} stroke="var(--line-2)" /><text x={left - 6} y={y(v) + 4} textAnchor="end">{Math.round(v * 100) / 100}</text></g>)}
      <path d={path} fill="none" stroke="var(--teal)" strokeWidth="2" />
      {points.map((p, i) => {
        const out = (low != null && p.y < low) || (high != null && p.y > high);
        return (
          <g key={i}>
            <circle cx={x(i)} cy={y(p.y)} r="4.5" fill={out ? 'var(--red)' : 'var(--teal)'} stroke="var(--panel)" strokeWidth="1.5" />
            <text x={x(i)} y={y(p.y) - 9} textAnchor="middle" style={{ fill: 'var(--ink)', fontWeight: 700 }}>{p.y}</text>
            <text x={x(i)} y={height - 2} textAnchor="middle">{p.label}</text>
          </g>
        );
      })}
      {unit && <text x={4} y={12}>{unit}</text>}
    </svg>
  );
}

// Levey–Jennings chart: mean, ±1/2/3 SD lines, runs coloured by Westgard result.
export function LJChart({ runs, mean, sd, height = 240 }) {
  const m = Number(mean), s = Number(sd);
  const y = scale(m - 3.6 * s, m + 3.6 * s, height, 12);
  const left = 54, right = 12;
  const x = (i) => (runs.length <= 1 ? (left + W - right) / 2 : left + ((W - left - right) * i) / (runs.length - 1));
  const lines = [[3, 'var(--red)'], [2, 'var(--amber)'], [1, 'var(--line)'], [0, 'var(--teal)'], [-1, 'var(--line)'], [-2, 'var(--amber)'], [-3, 'var(--red)']];
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${height}`} role="img" aria-label="Levey-Jennings chart">
      {lines.map(([k, c]) => (
        <g key={k}><line x1={left} x2={W - right} y1={y(m + k * s)} y2={y(m + k * s)} stroke={c} strokeDasharray={k ? '4 4' : ''} />
          <text x={left - 6} y={y(m + k * s) + 4} textAnchor="end">{k === 0 ? 'Mean' : `${k > 0 ? '+' : ''}${k}SD`}</text></g>
      ))}
      {runs.length > 1 && <path d={runs.map((r, i) => `${i ? 'L' : 'M'}${x(i)},${y(Math.max(Math.min(Number(r.value), m + 3.5 * s), m - 3.5 * s))}`).join(' ')} fill="none" stroke="var(--ink-3)" />}
      {runs.map((r, i) => (
        <circle key={r.id || i} cx={x(i)} cy={y(Math.max(Math.min(Number(r.value), m + 3.5 * s), m - 3.5 * s))} r="4.5"
          fill={r.status === 'reject' ? 'var(--red)' : r.status === 'warning' ? 'var(--amber)' : 'var(--teal)'} stroke="var(--panel)" strokeWidth="1.5">
          <title>{`${new Date(r.run_at).toLocaleString('en-GB')}: ${r.value}${r.rules ? ' — ' + r.rules : ''}`}</title>
        </circle>
      ))}
    </svg>
  );
}

// Daily bars (revenue by day).
export function DayBars({ series, value = (d) => d.revenue, height = 170, fmt = (v) => v }) {
  const max = Math.max(...series.map(value), 1);
  const left = 8, right = 8, bw = (W - left - right) / Math.max(series.length, 1);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${height}`} role="img" aria-label="Daily figures">
      {series.map((d, i) => {
        const h = ((height - 30) * value(d)) / max;
        return (
          <g key={d.date}>
            <rect x={left + i * bw + 1} y={height - 18 - h} width={Math.max(bw - 2, 1)} height={h} rx="2" fill="var(--teal)"><title>{`${d.date}: ${fmt(value(d))}`}</title></rect>
            {(series.length <= 16 || i % Math.ceil(series.length / 12) === 0) && <text x={left + i * bw + bw / 2} y={height - 4} textAnchor="middle">{d.date.slice(8)}</text>}
          </g>
        );
      })}
    </svg>
  );
}

export function Bars({ rows, label, value, fmt = (v) => v }) {
  const max = Math.max(...rows.map(value), 1);
  return (
    <div className="bars">
      {rows.map((r, i) => (
        <div className="bar" key={i}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={label(r)}>{label(r)}</span>
          <span className="track"><span className="fill" style={{ width: `${(value(r) / max) * 100}%`, display: 'block' }} /></span>
          <span className="right num">{fmt(value(r))}</span>
        </div>
      ))}
    </div>
  );
}

export function Heatmap({ grid }) {
  const max = Math.max(...grid.flat(), 1);
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return (
    <div className="heat">
      <span />{Array.from({ length: 24 }, (_, h) => <span key={h} style={{ textAlign: 'center' }}>{h % 3 === 0 ? h : ''}</span>)}
      {grid.map((row, d) => [
        <span key={'d' + d}>{days[d]}</span>,
        ...row.map((v, h) => <i key={`${d}-${h}`} style={{ opacity: v ? 0.15 + 0.85 * (v / max) : 0.06 }} title={`${days[d]} ${h}:00 — ${v} patients`} />),
      ])}
    </div>
  );
}

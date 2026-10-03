export const todayISO = () => toISODate(new Date());

export function toISODate(d) {
  const x = new Date(d);
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const day = String(x.getDate()).padStart(2, '0');
  return `${x.getFullYear()}-${m}-${day}`;
}

export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const x = new Date(y, m - 1, d);
  x.setDate(x.getDate() + n);
  return toISODate(x);
}

export function fmtDate(v) {
  if (!v) return '';
  const d = typeof v === 'string' && v.length === 10 ? new Date(v + 'T00:00:00') : new Date(v);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function fmtDateTime(v) {
  if (!v) return '';
  return new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${ap}`;
}

export function money(n, currency = 'Rs') {
  const v = Number(n || 0);
  return `${currency} ${v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

export function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// Age in days at a given date (for reference ranges)
export function ageDays(dob, at = new Date()) {
  if (!dob) return null;
  const a = new Date(dob + 'T00:00:00');
  const b = new Date(at);
  return Math.floor((b - a) / 86400000);
}

export function ageLabel(dob, at = new Date()) {
  const days = ageDays(dob, at);
  if (days == null) return '';
  if (days < 31) return `${days} d`;
  if (days < 730) return `${Math.floor(days / 30.44)} m`;
  return `${Math.floor(days / 365.25)} y`;
}

// DOB from an age typed in years (marked as estimated)
export function dobFromAge(years) {
  const n = Number(years);
  if (!Number.isFinite(n) || n < 0 || n > 130) return null;
  const d = new Date();
  d.setFullYear(d.getFullYear() - Math.floor(n));
  d.setMonth(0, 1);
  return toISODate(d);
}

export const genderLabel = (g) => ({ male: 'Male', female: 'Female', other: 'Other' }[g] || '');

export function calcBmi(w, h) {
  const W = Number(w), H = Number(h);
  if (!W || !H) return null;
  return Math.round((W / ((H / 100) ** 2)) * 10) / 10;
}

// WhatsApp link: local numbers like 0300… become 92300…
export function waNumber(phone, cc = '92') {
  if (!phone) return '';
  let d = String(phone).replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = cc + d.slice(1);
  return d;
}

export function csvDownload(filename, rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const text = rows.map((r) => r.map(esc).join(',')).join('\n');
  const blob = new Blob([text], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export const nowIso = () => new Date().toISOString();

export function monthStart(iso = todayISO()) { return iso.slice(0, 8) + '01'; }
export function monthEnd(iso = todayISO()) {
  const [y, m] = iso.split('-').map(Number);
  return toISODate(new Date(y, m, 0));
}
export function weekStart(iso = todayISO()) {
  const [y, m, d] = iso.split('-').map(Number);
  const x = new Date(y, m - 1, d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // Monday
  return toISODate(x);
}
export function addMonths(iso, n) {
  const [y, m] = iso.split('-').map(Number);
  return toISODate(new Date(y, m - 1 + n, 1));
}
export const localDay = (ts) => (ts ? toISODate(new Date(ts)) : null);
export function hoursBetween(a, b) {
  if (!a || !b) return null;
  return (new Date(b) - new Date(a)) / 3600000;
}
export function fmtHours(h) {
  if (h == null) return '';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${Math.round(h * 10) / 10} h`;
  return `${Math.round(h / 24 * 10) / 10} days`;
}
export function fmtMonth(iso) {
  const [y, m] = iso.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

// Secret link token (portal) and short PIN.
export function randomToken(len = 24) {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => abc[b % abc.length]).join('');
}
export function randomPin(len = 4) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => String(b % 10)).join('');
}
export function randomCode(len = 10) { return randomToken(len); }

export function maskName(name = '') {
  return String(name).split(/\s+/).filter(Boolean).map((w) => w[0] + '***').join(' ');
}

export const sum = (arr, f = (x) => x) => round2(arr.reduce((s, x) => s + (Number(f(x)) || 0), 0));
export function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

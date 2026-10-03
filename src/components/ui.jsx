import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { money } from '../lib/format.js';
import { useSettings } from '../lib/hooks.js';
import { TEST_STATUS_LABEL } from '../lib/results.js';
import { STATE_COLOR, STATE_LABEL } from '../lib/reports.js';

// ---------- toast ----------
const ToastCtx = createContext(() => {});
export function ToastProvider({ children }) {
  const [t, setT] = useState(null);
  const show = useCallback((msg, bad = false) => {
    setT({ msg, bad });
    clearTimeout(show.timer);
    show.timer = setTimeout(() => setT(null), bad ? 6000 : 2500);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {t && <div className={`toast ${t.bad ? 'bad' : ''}`} role="status">{t.msg}</div>}
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// Runs an async action and reports errors in plain language.
export function useAction() {
  const toast = useToast();
  return useCallback(async (fn, okMsg) => {
    try {
      const r = await fn();
      if (okMsg) toast(okMsg);
      return r;
    } catch (e) {
      toast(e.message || String(e), true);
      return undefined;
    }
  }, [toast]);
}

export function Money({ v }) {
  const s = useSettings();
  return <span className="money">{money(v, s?.currency || 'Rs')}</span>;
}
export function useMoney() {
  const s = useSettings();
  return (v) => money(v, s?.currency || 'Rs');
}

export function Modal({ title, onClose, children, footer, wide }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  // While any dialog is open the page behind it must not scroll, otherwise a
  // swipe on a phone moves the page instead of the form. Counted, so a
  // confirm box opened on top of another dialog doesn't unlock too early.
  useEffect(() => {
    const b = document.body;
    b.dataset.modals = String(Number(b.dataset.modals || 0) + 1);
    b.classList.add('modal-open');
    return () => {
      const n = Number(b.dataset.modals || 1) - 1;
      b.dataset.modals = String(n);
      if (n <= 0) b.classList.remove('modal-open');
    };
  }, []);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${wide === 'x' ? 'xwide' : wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// Confirmation / reason prompt
export function ConfirmButton({ label, title, message, confirmLabel = 'Confirm', danger, reason, onConfirm, className = 'btn small', disabled }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button type="button" className={`${className} ${danger ? 'danger' : ''}`} disabled={disabled} onClick={() => setOpen(true)}>{label}</button>
      {open && (
        <Modal title={title || label} onClose={() => setOpen(false)} footer={<>
          <button className="btn" onClick={() => setOpen(false)}>Keep it</button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} disabled={busy || (reason && !text.trim())}
            onClick={async () => { setBusy(true); const ok = await onConfirm(text); setBusy(false); if (ok !== false) setOpen(false); }}>
            {confirmLabel}
          </button>
        </>}>
          <p className="muted" style={{ marginTop: 0 }}>{message}</p>
          {reason && <label className="f"><span className="req">{reason}</span>
            <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} /></label>}
        </Modal>
      )}
    </>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([k, label]) => (
        <button key={k} role="tab" aria-selected={value === k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>{label}</button>
      ))}
    </div>
  );
}

const TEST_COLOR = { pending: 'amber', collected: 'blue', entered: 'violet', verified: 'green', cancelled: '' };
export const TestBadge = ({ s }) => <span className={`badge ${TEST_COLOR[s] || ''}`}>{TEST_STATUS_LABEL[s] || s}</span>;
export const StateBadge = ({ s }) => <span className={`badge ${STATE_COLOR[s] || ''}`}>{STATE_LABEL[s] || s}</span>;

// One tube cap per test, coloured by where it stands.
export function Caps({ tests, max = 14 }) {
  const list = tests.filter((t) => t.status !== 'cancelled');
  return (
    <span className="caps" title={list.map((t) => `${t.test_name}: ${TEST_STATUS_LABEL[t.status]}`).join('\n')}>
      {list.slice(0, max).map((t) => <i key={t.id} className={`cap ${t.status}`} />)}
      {list.length > max && <small>+{list.length - max}</small>}
    </span>
  );
}

export function DueBadge({ bill, deleted }) {
  if (deleted) return <span className="badge">Deleted</span>;
  if (!bill) return null;
  if (bill.panel_due > 0) return <span className="badge blue">Panel</span>;
  if (bill.due > 0) return <span className="badge red">Due</span>;
  return <span className="badge green">Paid</span>;
}

export function Figures({ items }) {
  return (
    <div className="figures">
      {items.filter(Boolean).map((it) => {
        const inner = <><span>{it.label}</span><b>{it.value}</b>{it.hint && <small>{it.hint}</small>}</>;
        return it.to
          ? <Link key={it.label} className={`stat ${it.tone || ''}`} to={it.to}>{inner}</Link>
          : <div key={it.label} className={`stat ${it.tone || ''}`}>{inner}</div>;
      })}
    </div>
  );
}

// Delete with a reason, and the delete PIN when one is set in Settings.
export function DeleteButton({ label = 'Delete', title, message, onConfirm, className = 'btn small danger', disabled }) {
  const s = useSettings();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const needPin = !!s?.delete_pin;
  return (
    <>
      <button type="button" className={className} disabled={disabled} onClick={() => { setOpen(true); setErr(''); setPin(''); setReason(''); }}>{label}</button>
      {open && (
        <Modal title={title || label} onClose={() => setOpen(false)} footer={<>
          <button className="btn" onClick={() => setOpen(false)}>Keep it</button>
          <button className="btn danger solid" disabled={busy || !reason.trim() || (needPin && !pin)}
            onClick={async () => {
              if (needPin && pin !== s.delete_pin) { setErr('Wrong PIN.'); return; }
              setBusy(true); const ok = await onConfirm(reason); setBusy(false); if (ok !== false) setOpen(false);
            }}>{label}</button>
        </>}>
          <p className="muted" style={{ marginTop: 0 }}>{message}</p>
          <p className="faint">It goes to the Recycle Bin. You can restore it from there.</p>
          <div className="stack">
            <Field label="Reason (kept on record)" required><textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            {needPin && <Field label="Delete PIN" required><input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} /></Field>}
            {err && <div className="error-text">{err}</div>}
          </div>
        </Modal>
      )}
    </>
  );
}

export function Field({ label, required, children, hint }) {
  return (
    <label className="f">
      <span className={required ? 'req' : ''}>{label}</span>
      {children}
      {hint && <span className="faint">{hint}</span>}
    </label>
  );
}

// Text input that saves on blur (for autosaving forms)
export function BlurInput({ value, onSave, as = 'input', ...rest }) {
  const [v, setV] = useState(value ?? '');
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setV(value ?? ''); }, [value]);
  const Tag = as;
  return (
    <Tag {...rest} value={v}
      onFocus={() => { focused.current = true; }}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { focused.current = false; if ((value ?? '') !== v) onSave(v); }} />
  );
}

// Simple autocomplete: free text allowed, suggestions from a list
export function Autocomplete({ value, onChange, options, placeholder, onPick, autoFocus }) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const q = (value || '').toLowerCase();
  const list = q.length >= 1 ? options.filter((o) => o.label.toLowerCase().includes(q)).slice(0, 12) : [];
  const pick = (o) => { onChange(o.label); onPick?.(o); setOpen(false); };
  return (
    <div className="ac">
      <input value={value || ''} placeholder={placeholder} autoFocus={autoFocus}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setHi(0); }}
        onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (!open || !list.length) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, list.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          if (e.key === 'Enter') { e.preventDefault(); pick(list[hi]); }
        }} />
      {open && list.length > 0 && (
        <div className="ac-list">
          {list.map((o, i) => (
            <button type="button" key={o.key || o.label} className={i === hi ? 'hi' : ''} onMouseDown={(e) => { e.preventDefault(); pick(o); }}>
              {o.label}{o.hint && <span className="faint"> · {o.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Image picker that shrinks and compresses before saving (keeps DB light)
export function ImagePicker({ value, onChange, maxW = 400, maxH = 200, label }) {
  const toast = useToast();
  async function onFile(f) {
    if (!f) return;
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) { toast('Use a PNG, JPG or WebP image.', true); return; }
    const img = new Image();
    img.src = URL.createObjectURL(f);
    await img.decode();
    const scale = Math.min(1, maxW / img.width, maxH / img.height);
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    let url = c.toDataURL('image/webp', 0.85);
    if (!url.startsWith('data:image/webp')) url = c.toDataURL('image/png');
    if (url.length > 280000) { toast('Image is too large even after compression. Use a simpler image.', true); return; }
    onChange(url);
  }
  return (
    <div className="stack">
      <span className="faint">{label}</span>
      {value && <img src={value} alt="" style={{ maxHeight: 70, maxWidth: 200, border: '1px solid var(--line)', borderRadius: 6, padding: 4, background: '#fff' }} />}
      <div className="row">
        <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => onFile(e.target.files[0])} style={{ maxWidth: 260 }} />
        {value && <button type="button" className="btn small" onClick={() => onChange(null)}>Remove</button>}
      </div>
    </div>
  );
}

export function Empty({ children }) { return <div className="empty">{children}</div>; }

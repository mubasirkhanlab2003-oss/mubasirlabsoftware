import { useState } from 'react';
import { useAuth } from '../lib/auth.jsx';

export default function Login() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const offline = navigator.onLine === false;

  async function submit(e) {
    e.preventDefault();
    setErr(''); setBusy(true);
    try { await signIn(email.trim(), password); }
    catch (x) {
      setErr(/invalid login/i.test(x.message) ? 'Email or password is incorrect.'
        : /fetch|network/i.test(x.message) ? 'No internet connection. The first sign-in on a device needs internet.' : x.message);
    } finally { setBusy(false); }
  }

  return (
    <div className="center-page">
      <form className="login stack" onSubmit={submit}>
        <span className="brand-mark"><i /></span>
        <h1>Sign in to the lab</h1>
        <p className="muted" style={{ margin: 0 }}>Laboratory staff only.</p>
        {offline && <div className="note warn">You are offline. Signing in needs internet the first time on this device.</div>}
        <label className="f">Email<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label className="f">Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {err && <div className="error-text">{err}</div>}
        <button className="btn primary big" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="faint" style={{ margin: 0 }}>Forgot the password? Reset it in Supabase → Authentication → Users.</p>
      </form>
    </div>
  );
}

export function Pending() {
  const { signOut, user } = useAuth();
  return (
    <div className="center-page">
      <div className="login stack">
        <h1>Account waiting for approval</h1>
        <p className="muted">{user?.email} is signed in, but the Admin has not activated this account yet. Ask the Admin to open Settings → Users and activate it, then sign in again.</p>
        <button className="btn" onClick={() => signOut()}>Sign out</button>
      </div>
    </div>
  );
}

export function NotConfigured() {
  return (
    <div className="center-page">
      <div className="login stack" style={{ maxWidth: 520 }}>
        <h1>Connection settings missing</h1>
        <p className="muted">Set <b>VITE_SUPABASE_URL</b> and <b>VITE_SUPABASE_ANON_KEY</b> in Vercel → Project → Settings → Environment Variables (or in a local <code>.env</code> file), then redeploy.</p>
      </div>
    </div>
  );
}

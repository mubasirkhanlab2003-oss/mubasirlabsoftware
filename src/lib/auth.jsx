import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { supabase } from './supabase.js';
import { openUserDb, deleteUserDb, db } from './db.js';
import { initSync, stopSync, syncNow, countPending } from './sync.js';
import { can as canDo } from './perms.js';

const Ctx = createContext(null);
const ID_KEY = 'lis_identity';
const isOnline = () => navigator.onLine !== false;

const readIdentity = () => { try { return JSON.parse(localStorage.getItem(ID_KEY)); } catch { return null; } };
const writeIdentity = (v) => { try { localStorage.setItem(ID_KEY, JSON.stringify(v)); } catch { /* private mode */ } };

export function AuthProvider({ children }) {
  const [st, setSt] = useState({ loading: true, user: null, profile: null, dbReady: false });
  const activeId = useRef(null);

  async function activate(user) {
    if (activeId.current === user.id && st.dbReady) return;
    activeId.current = user.id;
    openUserDb(user.id);
    let profile = readIdentity()?.id === user.id ? readIdentity().profile : null;
    if (isOnline()) {
      const { data, error } = await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle();
      if (!error && data) profile = data;
    }
    writeIdentity({ id: user.id, email: user.email, profile });
    if (profile?.active) {
      initSync(supabase);
      syncNow();
    }
    setSt({ loading: false, user: { id: user.id, email: user.email }, profile, dbReady: true });
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let session = null;
      try { session = (await supabase.auth.getSession()).data.session; } catch { /* offline */ }
      if (cancelled) return;
      const cached = readIdentity();
      if (session?.user) await activate(session.user);
      else if (cached?.id && cached.profile?.active) {
        // Offline (or token not yet refreshed): keep working on this device's data.
        await activate({ id: cached.id, email: cached.email });
      } else setSt({ loading: false, user: null, profile: null, dbReady: false });
    })();
    const { data: sub } = supabase.auth.onAuthStateChange((evt, session) => {
      if (evt === 'SIGNED_IN' && session?.user && activeId.current !== session.user.id) activate(session.user);
      if (evt === 'SIGNED_OUT') {
        activeId.current = null;
        stopSync();
        setSt({ loading: false, user: null, profile: null, dbReady: false });
      }
    });
    return () => { cancelled = true; sub.subscription.unsubscribe(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    await activate(data.user);
  }

  async function signOut({ removeLocalData = false } = {}) {
    try { await syncNow(); } catch { /* ignore */ }
    const { pending } = await countPending().catch(() => ({ pending: 0 }));
    if (pending && !window.confirm(`${pending} change(s) have not reached the server yet. They stay saved on this device and will sync when you sign in again here. Sign out now?`)) return;
    const uid = st.user?.id;
    stopSync();
    await supabase.auth.signOut().catch(() => {});
    try { localStorage.removeItem(ID_KEY); } catch { /* ignore */ }
    if (removeLocalData && uid && !pending) await deleteUserDb(uid);
    activeId.current = null;
    setSt({ loading: false, user: null, profile: null, dbReady: false });
  }

  async function refreshProfile() {
    if (!st.user) return;
    const p = await db().profiles.get(st.user.id);
    if (p) { writeIdentity({ id: st.user.id, email: st.user.email, profile: p }); setSt((s) => ({ ...s, profile: p })); }
  }

  const role = st.profile?.active ? st.profile.role : null;
  return (
    <Ctx.Provider value={{ ...st, role, isAdmin: role === 'admin', can: (p) => canDo(role, p), signIn, signOut, refreshProfile }}>
      {children}
    </Ctx.Provider>
  );
}

export const useAuth = () => useContext(Ctx);

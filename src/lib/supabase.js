import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
const demo = import.meta.env.VITE_DEMO === '1';

export const configured = demo || Boolean(url && key);

export const supabase = demo
  ? (await import('../demo/demoClient.js')).createDemoClient()
  : configured
    ? createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
    : null;

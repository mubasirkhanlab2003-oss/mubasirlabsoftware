import React from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import '@fontsource/atkinson-hyperlegible/400.css';
import '@fontsource/atkinson-hyperlegible/700.css';
import App from './App.jsx';
import './styles.css';

// Theme chosen by the user (else follows the device).
try { const t = localStorage.getItem('lis_theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* ignore */ }

// Service worker caches the app so it opens without internet.
registerSW({ immediate: true });

// Ask the browser not to evict the lab's local data under storage pressure.
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);

import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth.jsx';
import { configured } from './lib/supabase.js';
import { ToastProvider } from './components/ui.jsx';
import Layout from './components/Layout.jsx';
import Login, { Pending, NotConfigured } from './pages/Login.jsx';
import Today from './pages/Today.jsx';
import Register from './pages/Register.jsx';
import Patients from './pages/Patients.jsx';
import PatientProfile from './pages/PatientProfile.jsx';
import Case from './pages/Case.jsx';
import Worklist from './pages/Worklist.jsx';

// Less-used screens load on demand (still cached for offline use).
const Billing = lazy(() => import('./pages/Billing.jsx'));
const Doctors = lazy(() => import('./pages/Doctors.jsx'));
const DoctorPage = lazy(() => import('./pages/Doctors.jsx').then((m) => ({ default: m.DoctorPage })));
const Panels = lazy(() => import('./pages/Panels.jsx'));
const PanelPage = lazy(() => import('./pages/Panels.jsx').then((m) => ({ default: m.PanelPage })));
const Reports = lazy(() => import('./pages/Reports.jsx'));
const Settings = lazy(() => import('./pages/Settings.jsx'));
const Recycle = lazy(() => import('./pages/Recycle.jsx'));
const Op = (name) => lazy(() => import('./pages/Operations.jsx').then((m) => ({ default: m[name] })));
const Expenses = Op('Expenses'), HomeCollection = Op('HomeCollection'), Outsource = Op('Outsource'), Stock = Op('Stock'), QC = Op('QC'), Equipment = Op('Equipment');
const Doc = (name) => lazy(() => import('./print/Documents.jsx').then((m) => ({ default: m[name] })));
const Docs = {
  Report: Doc('LabReportDoc'), Receipt: Doc('ReceiptDoc'), Labels: Doc('LabelsDoc'), Cumulative: Doc('CumulativeDoc'),
  Doctor: Doc('DoctorStatementDoc'), Panel: Doc('PanelStatementDoc'), Rates: Doc('RateListDoc'),
};
const Portal = (name) => lazy(() => import('./portal/Portal.jsx').then((m) => ({ default: m[name] })));
const PatientPortal = Portal('PatientPortal'), DoctorPortal = Portal('DoctorPortal'), VerifyReport = Portal('VerifyReport');

const Loading = () => <div className="center-page muted">Loading…</div>;

// Screen guard by role. The database (row level security) is the real protection.
function Allow({ perm, children }) {
  const { isAdmin, can } = useAuth();
  return isAdmin || can(perm) ? children : <Navigate to="/" replace />;
}

export function Gate() {
  const { loading, user, profile } = useAuth();
  if (loading) return <Loading />;
  if (!user) return <Login />;
  if (!profile?.active) return <Pending />;
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/print/report/:id" element={<Docs.Report />} />
        <Route path="/print/receipt/:id" element={<Docs.Receipt />} />
        <Route path="/print/labels/:id" element={<Docs.Labels />} />
        <Route path="/print/cumulative/:id" element={<Docs.Cumulative />} />
        <Route path="/print/doctor/:id" element={<Allow perm="doctors_view"><Docs.Doctor /></Allow>} />
        <Route path="/print/panel/:id" element={<Allow perm="panels"><Docs.Panel /></Allow>} />
        <Route path="/print/ratelist" element={<Docs.Rates />} />
        <Route element={<Layout />}>
          <Route index element={<Today />} />
          <Route path="register" element={<Allow perm="register"><Register /></Allow>} />
          <Route path="patients" element={<Patients />} />
          <Route path="patients/:id" element={<PatientProfile />} />
          <Route path="cases/:id" element={<Case />} />
          <Route path="worklist" element={<Allow perm="worklist"><Worklist /></Allow>} />
          <Route path="home-collection" element={<Allow perm="home"><HomeCollection /></Allow>} />
          <Route path="billing" element={<Allow perm="payments"><Billing /></Allow>} />
          <Route path="doctors" element={<Allow perm="doctors_view"><Doctors /></Allow>} />
          <Route path="doctors/:id" element={<Allow perm="doctors_view"><DoctorPage /></Allow>} />
          <Route path="panels" element={<Allow perm="panels"><Panels /></Allow>} />
          <Route path="panels/:id" element={<Allow perm="panels"><PanelPage /></Allow>} />
          <Route path="expenses" element={<Allow perm="expenses"><Expenses /></Allow>} />
          <Route path="reports" element={<Allow perm="reports"><Reports /></Allow>} />
          <Route path="stock" element={<Allow perm="stock"><Stock /></Allow>} />
          <Route path="qc" element={<Allow perm="qc"><QC /></Allow>} />
          <Route path="equipment" element={<Allow perm="equipment"><Equipment /></Allow>} />
          <Route path="outsource" element={<Allow perm="outsource"><Outsource /></Allow>} />
          <Route path="settings" element={<Settings />} />
          <Route path="recycle" element={<Allow perm="settings"><Recycle /></Allow>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}

export default function App() {
  if (!configured) return <NotConfigured />;
  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ToastProvider>
        <Suspense fallback={<Loading />}>
          <Routes>
            {/* public pages: no sign-in, read-only, secret link + PIN */}
            <Route path="/p/:token" element={<PatientPortal />} />
            <Route path="/d/:token" element={<DoctorPortal />} />
            <Route path="/v/:code" element={<VerifyReport />} />
            <Route path="*" element={<AuthProvider><Gate /></AuthProvider>} />
          </Routes>
        </Suspense>
      </ToastProvider>
    </BrowserRouter>
  );
}

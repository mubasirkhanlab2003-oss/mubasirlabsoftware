// What each role may open. Admin can do everything. With a single login
// (one person runs the lab) everything is simply available.
export const ROLES = [
  ['admin', 'Admin / Owner'], ['reception', 'Receptionist'], ['technician', 'Technician'],
  ['pathologist', 'Pathologist'], ['accountant', 'Accountant'],
];
export const roleLabel = (r) => (ROLES.find((x) => x[0] === r) || [r, r])[1];

const P = {
  reception: ['register', 'patients', 'cases', 'payments', 'home', 'print', 'doctors_view', 'today'],
  technician: ['patients', 'cases', 'worklist', 'results', 'samples', 'qc', 'stock', 'equipment', 'print', 'today', 'outsource'],
  pathologist: ['patients', 'cases', 'worklist', 'results', 'verify', 'samples', 'qc', 'stock', 'equipment', 'print', 'today', 'outsource', 'catalogue'],
  accountant: ['patients', 'cases', 'payments', 'billing', 'doctors', 'doctors_view', 'panels', 'expenses', 'reports', 'print', 'today', 'outsource', 'prices'],
};

export function can(role, perm) {
  if (role === 'admin') return true;
  return (P[role] || []).includes(perm);
}

// ---------------------------------------------------------------------------
// Role-Based Access Control (RBAC)
// ---------------------------------------------------------------------------

const ROLES = {
  admin:     { level: 100, description: 'Full access — manage policies, approve, execute, configure' },
  approver:  { level: 75,  description: 'Can approve actions and view execution plans' },
  developer: { level: 50,  description: 'Can run recipes and view results' },
  viewer:    { level: 25,  description: 'Read-only — can view recipes, policies, and logs' },
};

const PERMISSIONS = {
  run_recipe:     { minRole: 'developer', description: 'Execute recipes' },
  approve_action: { minRole: 'approver',  description: 'Approve pending actions' },
  reject_action:  { minRole: 'approver',  description: 'Reject pending actions' },
  modify_policy:  { minRole: 'admin',     description: 'Create or modify policies' },
  manage_users:   { minRole: 'admin',     description: 'Manage user roles and access' },
  view_audit:     { minRole: 'viewer',    description: 'View audit logs' },
  view_recipes:   { minRole: 'viewer',    description: 'List and inspect recipes' },
  export_data:    { minRole: 'approver',  description: 'Export compliance data' },
  manage_keys:    { minRole: 'admin',     description: 'Manage API keys and secrets' },
  emergency_control: { minRole: 'admin',  description: 'Invoke break-glass lane/session emergency controls' },
};

/**
 * Create a user with a role.
 */
export function createUser(name, role, opts = {}) {
  if (!ROLES[role]) throw new Error(`Invalid role: "${role}". Valid: ${Object.keys(ROLES).join(', ')}`);
  return {
    name,
    role,
    groups:    opts.groups || [],
    createdAt: new Date().toISOString(),
  };
}

/**
 * Check if a user has a specific permission.
 */
export function hasPermission(user, permission) {
  const perm = PERMISSIONS[permission];
  if (!perm) return false;
  const userLevel = ROLES[user.role]?.level ?? 0;
  const requiredLevel = ROLES[perm.minRole]?.level ?? 100;
  return userLevel >= requiredLevel;
}

/**
 * Enforce a permission check — returns { allowed, reason }.
 */
export function enforcePermission(user, permission) {
  if (!PERMISSIONS[permission]) {
    return { allowed: false, reason: `Unknown permission: "${permission}"` };
  }
  if (hasPermission(user, permission)) {
    return { allowed: true, reason: null };
  }
  return {
    allowed: false,
    reason: `User "${user.name}" (${user.role}) lacks permission "${permission}" — requires ${PERMISSIONS[permission].minRole} or higher`,
  };
}

/**
 * List all permissions for a role.
 */
export function rolePermissions(role) {
  if (!ROLES[role]) return [];
  const level = ROLES[role].level;
  return Object.entries(PERMISSIONS)
    .filter(([, perm]) => level >= (ROLES[perm.minRole]?.level ?? 100))
    .map(([name, perm]) => ({ name, ...perm }));
}

/**
 * Format user info for display.
 */
export function formatUser(user) {
  const perms = rolePermissions(user.role);
  const lines = [];
  lines.push(`User: ${user.name}  Role: ${user.role}`);
  lines.push(`  ${ROLES[user.role]?.description ?? ''}`);
  lines.push(`  Permissions: ${perms.map(p => p.name).join(', ')}`);
  if (user.groups.length > 0) lines.push(`  Groups: ${user.groups.join(', ')}`);
  return lines.join('\n');
}

export { ROLES, PERMISSIONS };

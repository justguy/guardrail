import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Deployment Modes — local, team, enterprise
// ---------------------------------------------------------------------------

const MODES = {
  local: {
    description: 'Single user, local storage, no shared state',
    features: {
      shared_manifests: false,
      approval_queue:   false,
      org_policies:     false,
      rbac:             false,
      centralized_audit: false,
      key_management:   true,
      notifications:    false,
      marketplace:      false,
    },
  },
  team: {
    description: 'Shared backend, team approval, shared recipes',
    features: {
      shared_manifests: true,
      approval_queue:   true,
      org_policies:     false,
      rbac:             true,
      centralized_audit: true,
      key_management:   true,
      notifications:    true,
      marketplace:      true,
    },
  },
  enterprise: {
    description: 'Fully managed, org policies, compliance, SSO',
    features: {
      shared_manifests: true,
      approval_queue:   true,
      org_policies:     true,
      rbac:             true,
      centralized_audit: true,
      key_management:   true,
      notifications:    true,
      marketplace:      true,
    },
  },
};

/**
 * Get the current deployment mode config.
 */
export function getMode(stateDir) {
  const configPath = join(resolve(stateDir), 'mode.json');
  if (!existsSync(configPath)) return { mode: 'local', ...MODES.local };
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const modeDef = MODES[config.mode] || MODES.local;
  return { mode: config.mode, ...modeDef, overrides: config.overrides || {} };
}

/**
 * Set the deployment mode.
 */
export function setMode(stateDir, mode) {
  if (!MODES[mode]) throw new Error(`Invalid mode: "${mode}". Valid: ${Object.keys(MODES).join(', ')}`);
  const dir = resolve(stateDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'mode.json'), JSON.stringify({ mode, set_at: new Date().toISOString() }, null, 2) + '\n');
}

/**
 * Check if a feature is enabled for the current mode.
 */
export function isFeatureEnabled(stateDir, feature) {
  const config = getMode(stateDir);
  if (config.overrides?.[feature] !== undefined) return config.overrides[feature];
  return config.features?.[feature] ?? false;
}

/**
 * Format mode info for display.
 */
export function formatMode(config) {
  const lines = [];
  lines.push(`Deployment mode: ${config.mode}`);
  lines.push(`  ${config.description}`);
  lines.push('  Features:');
  for (const [feature, enabled] of Object.entries(config.features || {})) {
    lines.push(`    ${feature.padEnd(25)} ${enabled ? 'enabled' : 'disabled'}`);
  }
  return lines.join('\n');
}

export { MODES };

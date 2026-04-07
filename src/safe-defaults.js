// ---------------------------------------------------------------------------
// Safe Defaults — global default policy layer
// ---------------------------------------------------------------------------

/**
 * Dangerous patterns that are blocked by default.
 * These require explicit --force to bypass.
 */
const BLOCKED_PATTERNS = [
  { pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f\s+\/\s*$/,  reason: 'Recursive delete at filesystem root' },
  { pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f\s+\/[a-z]+\s*$/, reason: 'Recursive delete on system directory' },
  { pattern: /\bchmod\s+-R\s+777\s+\//,                  reason: 'Recursive world-writable on root path' },
  { pattern: /\*\s*\/\s*$/,                               reason: 'Wildcard operation on root directory' },
  { pattern: /\bdd\b.*of=\/dev\//,                        reason: 'Raw device write' },
  { pattern: />\s*\/dev\/[sh]d[a-z]/,                     reason: 'Direct disk overwrite' },
  { pattern: /\bmkfs\./,                                  reason: 'Filesystem format' },
  { pattern: /:()\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,   reason: 'Fork bomb' },
];

/**
 * Check a command string against safe defaults.
 *
 * @param {string} commandStr - Full command string (command + args).
 * @returns {{ blocked: boolean, reason: string|null }}
 */
export function checkSafeDefaults(commandStr) {
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(commandStr)) {
      return { blocked: true, reason };
    }
  }
  return { blocked: false, reason: null };
}

/**
 * Compute default policy overrides based on action properties.
 *
 * @param {object} action - { riskLevel, isDestructive, targetsProduction, hasSecrets }
 * @returns {{ dryRunRequired: boolean, approvalRequired: boolean, warnings: string[] }}
 */
export function computeDefaults(action = {}) {
  const warnings = [];
  let dryRunRequired = false;
  let approvalRequired = false;

  // Dry-run default for high-risk actions
  if (action.riskLevel === 'high') {
    dryRunRequired = true;
    warnings.push('High-risk action: dry-run enabled by default. Use --no-dry-run to execute.');
  }

  // Approval required for destructive operations
  if (action.isDestructive) {
    approvalRequired = true;
    warnings.push('Destructive operation: approval required.');
  }

  // Approval required for production changes
  if (action.targetsProduction) {
    approvalRequired = true;
    warnings.push('Production target: approval required.');
  }

  // Approval required for secret handling
  if (action.hasSecrets && action.targetsProduction) {
    warnings.push('Secrets with production target: elevated scrutiny.');
  }

  return { dryRunRequired, approvalRequired, warnings };
}

/**
 * Check if --force override is valid and produce warnings.
 *
 * @param {boolean} forceFlag - Whether --force was passed.
 * @param {{ blocked: boolean, reason: string|null }} safeCheck - From checkSafeDefaults.
 * @returns {{ allowed: boolean, warnings: string[] }}
 */
export function applyForceOverride(forceFlag, safeCheck) {
  if (!safeCheck.blocked) {
    return { allowed: true, warnings: [] };
  }

  if (!forceFlag) {
    return {
      allowed: false,
      warnings: [`BLOCKED: ${safeCheck.reason}. Use --force to override (dangerous).`],
    };
  }

  return {
    allowed: true,
    warnings: [
      `WARNING: --force overriding safe default: ${safeCheck.reason}`,
      'You are bypassing a safety check. Proceed with extreme caution.',
    ],
  };
}

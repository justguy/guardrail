// ---------------------------------------------------------------------------
// Agent Identity and Governance + Strict Mode
// ---------------------------------------------------------------------------

const VALID_ORIGINS = new Set(['cli', 'api', 'openclaw', 'ci', 'agent', 'unknown']);

// ---------------------------------------------------------------------------
// Identity model
// ---------------------------------------------------------------------------

/**
 * Create an execution identity.
 *
 * @param {object} opts
 * @param {string} opts.actor   - User or agent name.
 * @param {string} [opts.origin] - Source: cli, api, openclaw, ci, agent.
 * @param {string[]} [opts.permissions] - Declared permissions.
 * @param {string[]} [opts.scope]       - Allowed execution scope (paths).
 * @returns {object} Identity object.
 */
export function createIdentity(opts = {}) {
  return {
    actor:       opts.actor || process.env.USER || 'unknown',
    origin:      VALID_ORIGINS.has(opts.origin) ? opts.origin : 'unknown',
    permissions: Array.isArray(opts.permissions) ? opts.permissions : ['*'],
    scope:       Array.isArray(opts.scope) ? opts.scope : [],
    createdAt:   new Date().toISOString(),
  };
}

/**
 * Validate an identity object.
 *
 * @param {object} identity
 * @returns {string[]} Errors.
 */
export function validateIdentity(identity) {
  const errors = [];
  if (typeof identity.actor !== 'string' || identity.actor.trim() === '') {
    errors.push('actor must be a non-empty string');
  }
  if (!VALID_ORIGINS.has(identity.origin)) {
    errors.push(`origin must be one of ${[...VALID_ORIGINS].join(', ')}`);
  }
  if (!Array.isArray(identity.permissions)) {
    errors.push('permissions must be an array');
  }
  if (!Array.isArray(identity.scope)) {
    errors.push('scope must be an array');
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Strict mode enforcement
// ---------------------------------------------------------------------------

/**
 * Create a strict mode enforcer for an agent identity.
 *
 * @param {object} identity        - Agent identity.
 * @param {string[]} approvedRecipeIds - IDs of recipes this agent may run.
 * @returns {object} Strict mode interface.
 */
export function createStrictMode(identity, approvedRecipeIds = []) {
  const approved = new Set(approvedRecipeIds);

  /**
   * Check if a recipe is allowed under strict mode.
   */
  function checkRecipe(recipeId) {
    if (approved.size === 0) return { allowed: true, reason: null }; // no restrictions
    if (approved.has(recipeId)) return { allowed: true, reason: null };
    return {
      allowed: false,
      reason: `Agent "${identity.actor}" is not approved to run recipe "${recipeId}". Approved: [${[...approved].join(', ')}]`,
    };
  }

  /**
   * Check if a command is within the agent's scope.
   */
  function checkScope(command, args, cwd) {
    if (identity.scope.length === 0) return { allowed: true, violations: [] };

    const violations = [];
    const resolvedScope = identity.scope.map(s => {
      try { return import('node:path').then(p => p.resolve(s)); }
      catch { return s; }
    });

    // Synchronous scope check for paths in args
    for (const arg of (args || [])) {
      if (!arg.startsWith('/') && !arg.startsWith('./') && !arg.startsWith('../')) continue;
      const inScope = identity.scope.some(s => arg.startsWith(s));
      if (!inScope) {
        violations.push(`Path "${arg}" outside agent scope`);
      }
    }

    return { allowed: violations.length === 0, violations };
  }

  /**
   * Check if dynamic command generation is being attempted.
   * In strict mode, commands must come from approved recipes only.
   */
  function checkDynamicCommand(command) {
    // If the command contains interpolation or eval-like patterns, block it
    const dynamicPatterns = [/\$\(/, /`/, /\beval\b/, /\bexec\b/];
    for (const pattern of dynamicPatterns) {
      if (pattern.test(command)) {
        return {
          allowed: false,
          reason: `Dynamic command generation blocked in strict mode: "${command}"`,
        };
      }
    }
    return { allowed: true, reason: null };
  }

  return {
    identity,
    enabled: true,
    checkRecipe,
    checkScope,
    checkDynamicCommand,
  };
}

/**
 * Format an identity for audit logging.
 */
export function formatIdentity(identity) {
  return `${identity.actor} (${identity.origin})${identity.scope.length > 0 ? ` scope: [${identity.scope.join(', ')}]` : ''}`;
}

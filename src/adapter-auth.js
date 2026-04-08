import { executeSubprocess } from './shared.js';

const AUTH_ENV_HINTS = {
  claude_login: ['CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'HOME'],
  gh_auth: ['GH_CONFIG_DIR', 'XDG_CONFIG_HOME', 'HOME'],
};

function formatList(values) {
  return values.join(', ');
}

export function deriveAuthEnvRequirements(requirements = [], currentEnv = process.env) {
  const required = new Set();

  for (const requirement of requirements) {
    if (!requirement || typeof requirement !== 'object') continue;

    const declared = Array.isArray(requirement.env) ? requirement.env.filter(Boolean) : [];
    const candidates = declared.length > 0
      ? declared
      : (AUTH_ENV_HINTS[requirement.type] || []);

    const presentCandidates = candidates.filter((name) => name in currentEnv);
    const effective = presentCandidates.length > 0
      ? presentCandidates
      : (candidates.includes('HOME') ? ['HOME'] : candidates);

    for (const name of effective) {
      required.add(name);
    }
  }

  return [...required];
}

export function checkEnvMappings(requiredEnv = [], envAllow = [], options = {}) {
  const authEnv = deriveAuthEnvRequirements(options.authRequirements || [], options.currentEnv || process.env);
  const combinedRequired = [...new Set([...requiredEnv, ...authEnv])];
  const allowed = new Set(['PATH', ...envAllow]);
  const missing = combinedRequired.filter((name) => !allowed.has(name));
  if (missing.length === 0) {
    return { ok: true, code: null, message: null, missing: [] };
  }

  const envOnlyMissing = requiredEnv.filter((name) => missing.includes(name));
  const authOnlyMissing = authEnv.filter((name) => missing.includes(name));
  const detail = [];
  if (envOnlyMissing.length > 0) {
    detail.push(`profile env: ${formatList(envOnlyMissing)}`);
  }
  if (authOnlyMissing.length > 0) {
    detail.push(`auth runtime: ${formatList(authOnlyMissing)}`);
  }

  return {
    ok: false,
    code: 'missing_auth_mapping',
    message: `This adapter profile requires explicit env mappings for: ${formatList(missing)}.${detail.length ? ` (${detail.join('; ')})` : ''}`,
    missing,
  };
}

function getAuthCheckDefinition(requirement) {
  switch (requirement.type) {
    case 'claude_login':
      return {
        command: 'claude',
        args: ['auth', 'status'],
        code: 'missing_auth_prerequisite',
        message: requirement.message || 'Claude CLI is not logged in for this runtime. Run claude auth login.',
      };
    case 'gh_auth':
      return {
        command: 'gh',
        args: ['auth', 'status', '--hostname', 'github.com'],
        code: 'missing_auth_prerequisite',
        message: requirement.message || 'GitHub CLI is not authenticated for this runtime. Run gh auth login -h github.com.',
      };
    default:
      return null;
  }
}

export async function checkAuthPrerequisites(requirements = [], options = {}) {
  const checkRunner = options.checkRunner || executeSubprocess;

  for (const requirement of requirements) {
    const definition = getAuthCheckDefinition(requirement);
    if (!definition) {
      return {
        ok: false,
        code: 'missing_auth_prerequisite',
        message: `Unsupported auth prerequisite type: ${requirement?.type ?? '<unknown>'}`,
      };
    }

    const result = await checkRunner(definition.command, definition.args, options.cwd);
    if (result.success) {
      continue;
    }

    return {
      ok: false,
      code: definition.code,
      message: definition.message,
      detail: (result.stderr || result.stdout || '').trim(),
    };
  }

  return { ok: true, code: null, message: null };
}

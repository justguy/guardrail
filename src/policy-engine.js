import { resolve, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Trust classes
// ---------------------------------------------------------------------------

const TRUST_CLASSES = new Set([
  'reviewed_internal',
  'pinned_external',
  'generated',
  'unknown',
]);

// ---------------------------------------------------------------------------
// Risk levels (traffic light)
// ---------------------------------------------------------------------------

const RISK_LEVELS = { GREEN: 'green', YELLOW: 'yellow', RED: 'red' };

// ---------------------------------------------------------------------------
// Binary classification sets
// ---------------------------------------------------------------------------

const PACKAGE_INSTALL_BINARIES = new Set([
  'npm', 'npx', 'yarn', 'pnpm', 'pip', 'pip3', 'pipx',
  'apt', 'apt-get', 'yum', 'dnf', 'apk', 'pacman', 'brew', 'gem',
  'cargo', 'go',
]);

const PACKAGE_INSTALL_SUBCOMMANDS = new Map([
  ['npm',      new Set(['install', 'i', 'ci', 'add'])],
  ['yarn',     new Set(['add', 'install'])],
  ['pnpm',     new Set(['add', 'install', 'i'])],
  ['pip',      new Set(['install'])],
  ['pip3',     new Set(['install'])],
  ['pipx',     new Set(['install'])],
  ['gem',      new Set(['install'])],
  ['cargo',    new Set(['install'])],
  ['go',       new Set(['install', 'get'])],
  ['apt',      new Set(['install'])],
  ['apt-get',  new Set(['install'])],
  ['yum',      new Set(['install'])],
  ['dnf',      new Set(['install'])],
  ['apk',      new Set(['add'])],
  ['pacman',   new Set(['-S', '-Sy', '-Syu'])],
  ['brew',     new Set(['install'])],
]);

const ADMIN_BINARIES = new Set([
  'sudo', 'su', 'doas',
  'docker', 'podman', 'kubectl', 'helm',
  'terraform', 'pulumi', 'ansible', 'ansible-playbook',
  'aws', 'gcloud', 'az',
  'systemctl', 'service', 'launchctl',
]);

const DESTRUCTIVE_BINARIES = new Set([
  'rm', 'mkfs', 'dd', 'fdisk', 'parted', 'shred',
]);

const DB_ADMIN_BINARIES = new Set([
  'psql', 'mysql', 'mongo', 'mongosh', 'redis-cli', 'cqlsh',
]);

const DOWNLOAD_BINARIES = new Set(['curl', 'wget']);

const SAFE_BINARY_ALLOWLIST = new Set([
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'python', 'python3', 'ruby', 'perl',
  'cat', 'echo', 'printf', 'ls', 'pwd', 'test', 'true', 'false',
  'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr',
  'grep', 'sed', 'awk', 'jq', 'yq',
  'git', 'tsc', 'eslint', 'prettier', 'jest', 'vitest', 'mocha',
  'cp', 'mv', 'mkdir', 'touch', 'chmod', 'basename', 'dirname',
  'date', 'env', 'which', 'whoami', 'uname',
]);

// ---------------------------------------------------------------------------
// Production / environment indicators
// ---------------------------------------------------------------------------

const PROD_TARGET_PATTERNS = [
  /\bprod(uction)?\b/i,
  /\bstaging\b/i,
  /\blive\b/i,
  /\brelease\b/i,
];

const SYSTEM_PATHS = [
  '/usr/local/bin', '/usr/bin', '/usr/sbin', '/sbin',
  '/etc', '/var', '/opt', '/boot', '/sys', '/proc',
  '/Library', '/System',
  'C:\\Windows', 'C:\\Program Files',
];

const RESTART_INDICATORS = [
  'systemctl restart', 'systemctl reload', 'systemctl stop',
  'service restart', 'service reload', 'service stop',
  'launchctl', 'pm2 restart', 'pm2 reload',
  'nginx -s reload', 'apachectl restart',
  'kill', 'killall', 'pkill',
];

const DESTRUCTIVE_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--force|-[a-zA-Z]*f[a-zA-Z]*r)\b/,
  /\brm\s+-rf\b/,
  /\bdrop\s+(database|table|index|schema)\b/i,
  /\btruncate\b/i,
  /\bformat\b/i,
  /\bmkfs\b/,
  /\bdd\s+/,
  /\bfdisk\b/,
  /\bgit\s+push\s+.*--force\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-zA-Z]*f/,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a path to absolute, using the given base.
 */
function toAbsolute(p, base) {
  if (!p) return null;
  return isAbsolute(p) ? resolve(p) : resolve(base, p);
}

/**
 * Extract the basename of a binary path (strip directories).
 */
function binaryName(bin) {
  if (!bin) return '';
  const segments = bin.replace(/\\/g, '/').split('/');
  return segments[segments.length - 1];
}

/**
 * Check whether a path is inside (or equal to) a given root.
 */
function isUnderRoot(testPath, root) {
  if (!testPath || !root) return false;
  const normTest = resolve(testPath) + '/';
  const normRoot = resolve(root) + '/';
  return normTest.startsWith(normRoot) || resolve(testPath) === resolve(root);
}

/**
 * Check whether a path targets a well-known temp directory.
 */
function isTempPath(p) {
  const normalized = resolve(p);
  const tmp = resolve(tmpdir());
  return isUnderRoot(normalized, tmp) || isUnderRoot(normalized, '/tmp');
}

/**
 * Test a string against an array of regexes.
 */
function matchesAny(text, patterns) {
  return patterns.some(pat => pat.test(text));
}

// ---------------------------------------------------------------------------
// Trust classification
// ---------------------------------------------------------------------------

/**
 * Classify the trust level of a workflow source.
 *
 * @param {object} options
 * @param {string} [options.trustClass]        - explicit trust class assertion
 * @param {boolean} [options.isFirstParty]     - true if authored/maintained by user/team
 * @param {boolean} [options.isReviewed]       - true if the workflow has been reviewed
 * @param {boolean} [options.isPinned]         - true if pinned to a specific version/commit
 * @param {boolean} [options.isGenerated]      - true if AI-generated or dynamically produced
 * @returns {string} one of the TRUST_CLASSES values
 */
export function classifyTrust(options = {}) {
  // Explicit assertion takes priority when valid.
  if (options.trustClass && TRUST_CLASSES.has(options.trustClass)) {
    return options.trustClass;
  }

  if (options.isGenerated) return 'generated';
  if (options.isFirstParty && options.isReviewed) return 'reviewed_internal';
  if (options.isPinned) return 'pinned_external';

  return 'unknown';
}

// ---------------------------------------------------------------------------
// Risk evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate the risk of executing a contract.
 *
 * @param {object} contract  - a normalised execution contract (see contract.js)
 * @param {object} [options]
 * @param {string} [options.trustClass]   - override trust classification
 * @param {string} [options.projectRoot]  - root directory of the project (for scope analysis)
 * @param {boolean} [options.isFirstParty]
 * @param {boolean} [options.isReviewed]
 * @param {boolean} [options.isPinned]
 * @param {boolean} [options.isGenerated]
 * @returns {{ trustClass: string, riskLevel: string, reasons: string[], requiresStrongConfirmation: boolean }}
 */
export function evaluateRisk(contract, options = {}) {
  const reasons = [];

  // -- Trust classification --------------------------------------------------
  const trustClass = classifyTrust({
    trustClass: options.trustClass,
    isFirstParty: options.isFirstParty,
    isReviewed: options.isReviewed,
    isPinned: options.isPinned,
    isGenerated: options.isGenerated,
  });

  // -- Gather signals --------------------------------------------------------
  const projectRoot = options.projectRoot
    ? resolve(options.projectRoot)
    : contract.cwd
      ? resolve(contract.cwd)
      : null;

  const isShellMode = contract.mode === 'shell';
  const shellText = contract.shell || '';
  const commandText = buildCommandText(contract);

  // Collect all referenced binaries (from allowedBinaries, command, args, shell text).
  const referencedBinaries = collectBinaries(contract);

  // ---- Trust ---------------------------------------------------------------
  if (trustClass === 'generated') {
    reasons.push('generated workflow source');
  }
  if (trustClass === 'unknown') {
    reasons.push('unknown workflow provenance');
  }

  // ---- Execution mode ------------------------------------------------------
  if (isShellMode) {
    reasons.push('shell mode enabled');
  }

  // ---- Writable path breadth -----------------------------------------------
  const writesOutsideRepo = checkWritesOutsideRepo(contract.writablePaths, projectRoot);
  if (writesOutsideRepo) {
    reasons.push('writes outside repo root');
  }

  const hasBroadWritableScope = checkBroadWritableScope(contract.writablePaths, projectRoot);
  if (hasBroadWritableScope) {
    reasons.push('broad writable scope');
  }

  // ---- Package installation ------------------------------------------------
  const hasPackageInstall = detectPackageInstall(referencedBinaries, commandText);
  if (hasPackageInstall) {
    reasons.push('package installation requested');
  }

  // ---- Download behaviour --------------------------------------------------
  const hasDownload = detectDownloadBehaviour(referencedBinaries, commandText);
  if (hasDownload) {
    reasons.push('download piped to shell');
  }

  // ---- Privilege indicators ------------------------------------------------
  const hasSudoOrRoot = detectPrivilegeEscalation(referencedBinaries, commandText, contract.writablePaths);
  if (hasSudoOrRoot) {
    reasons.push('sudo or root-level access');
  }

  // ---- System path modification --------------------------------------------
  const hasSystemPathMod = detectSystemPathModification(contract.writablePaths);
  if (hasSystemPathMod && !hasSudoOrRoot) {
    reasons.push('system path modification');
  }

  // ---- Admin / cloud / infra commands --------------------------------------
  const hasAdminBinaries = detectAdminBinaries(referencedBinaries);
  if (hasAdminBinaries) {
    reasons.push('cloud, infrastructure, or admin commands present');
  }

  // ---- Database admin commands ---------------------------------------------
  const hasDbAdmin = detectDbAdmin(referencedBinaries, commandText);
  if (hasDbAdmin) {
    reasons.push('database admin commands present');
  }

  // ---- Destructive commands ------------------------------------------------
  const hasDestructive = detectDestructiveCommands(referencedBinaries, commandText);
  if (hasDestructive) {
    reasons.push('destructive command detected');
  }

  // ---- Production-like targets ---------------------------------------------
  const hasProdTarget = detectProdTarget(contract, commandText);
  if (hasProdTarget) {
    reasons.push('production-like target');
  }

  // ---- Service restart / patch capability ----------------------------------
  const hasRestart = detectRestartCapability(commandText);
  if (hasRestart) {
    reasons.push('service restart capability');
  }

  const hasPatchPath = detectPatchPath(contract);
  if (hasPatchPath) {
    reasons.push('patch/update path enabled');
  }

  // ---- Secret / env exposure -----------------------------------------------
  const hasSecretInjection = detectSecretInjection(contract);
  if (hasSecretInjection) {
    reasons.push('secret injection enabled');
  }

  const hasEnvInheritance = detectEnvInheritance(contract);
  if (hasEnvInheritance) {
    reasons.push('environment variable inheritance enabled');
  }

  // -- Compute risk level ----------------------------------------------------
  const riskLevel = computeRiskLevel({
    trustClass,
    isShellMode,
    reasons,
    writesOutsideRepo,
    hasSudoOrRoot,
    hasSystemPathMod,
    hasPackageInstall,
    hasDownload,
    hasDestructive,
    hasProdTarget,
    hasAdminBinaries,
    hasDbAdmin,
    hasBroadWritableScope,
    hasRestart,
    hasSecretInjection,
    referencedBinaries,
    projectRoot,
    contract,
  });

  return {
    trustClass,
    riskLevel,
    reasons,
    requiresStrongConfirmation: requiresStrongConfirmation(riskLevel),
  };
}

// ---------------------------------------------------------------------------
// Strong confirmation predicate
// ---------------------------------------------------------------------------

/**
 * Returns true when the risk level demands heightened user attention.
 * @param {string} riskLevel
 * @returns {boolean}
 */
export function requiresStrongConfirmation(riskLevel) {
  return riskLevel === RISK_LEVELS.RED;
}

// ---------------------------------------------------------------------------
// Internal: build full command text for pattern matching
// ---------------------------------------------------------------------------

function buildCommandText(contract) {
  const parts = [];
  if (contract.command) parts.push(contract.command);
  if (Array.isArray(contract.args)) parts.push(...contract.args);
  if (contract.shell) parts.push(contract.shell);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Internal: collect all referenced binary names
// ---------------------------------------------------------------------------

function collectBinaries(contract) {
  const bins = new Set();

  // From allowedBinaries
  if (Array.isArray(contract.allowedBinaries)) {
    for (const b of contract.allowedBinaries) {
      bins.add(binaryName(b));
    }
  }

  // From the command field
  if (contract.command) {
    bins.add(binaryName(contract.command));
  }

  // From shell text - pick out leading words of pipe segments
  if (contract.shell) {
    const segments = contract.shell.split(/[|;]|&&|\|\|/);
    for (const seg of segments) {
      const trimmed = seg.trim();
      // Skip env-var assignments at the start (VAR=val cmd ...)
      const tokens = trimmed.split(/\s+/);
      for (const tok of tokens) {
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue;
        bins.add(binaryName(tok));
        break;
      }
    }
  }

  bins.delete('');
  return bins;
}

// ---------------------------------------------------------------------------
// Internal: detection functions
// ---------------------------------------------------------------------------

function checkWritesOutsideRepo(writablePaths, projectRoot) {
  if (!Array.isArray(writablePaths) || writablePaths.length === 0) return false;
  if (!projectRoot) return false;

  for (const wp of writablePaths) {
    const abs = resolve(wp);
    if (!isUnderRoot(abs, projectRoot) && !isTempPath(abs)) {
      return true;
    }
  }
  return false;
}

function checkBroadWritableScope(writablePaths, projectRoot) {
  if (!Array.isArray(writablePaths) || writablePaths.length === 0) return false;

  for (const wp of writablePaths) {
    const abs = resolve(wp);
    // Writing to / or home directory root is very broad.
    if (abs === '/' || abs === resolve(tmpdir(), '..')) return true;
    // Writing to a parent of the project root is broad.
    if (projectRoot && isUnderRoot(projectRoot, abs) && abs !== resolve(projectRoot)) {
      return true;
    }
  }
  return false;
}

function detectPackageInstall(binaries, commandText) {
  for (const bin of binaries) {
    if (PACKAGE_INSTALL_BINARIES.has(bin)) {
      const subcommands = PACKAGE_INSTALL_SUBCOMMANDS.get(bin);
      if (!subcommands) return true; // binary is always an installer (apt, brew, etc.)
      for (const sub of subcommands) {
        if (commandText.includes(`${bin} ${sub}`) || commandText.includes(`${bin}  ${sub}`)) {
          return true;
        }
      }
    }
  }
  return false;
}

function detectDownloadBehaviour(binaries, commandText) {
  for (const bin of DOWNLOAD_BINARIES) {
    if (binaries.has(bin)) {
      // Download piped to shell is high risk.
      if (/\b(curl|wget)\b.*\|\s*(sh|bash|zsh|node|python)/.test(commandText)) {
        return true;
      }
    }
  }
  return false;
}

function detectPrivilegeEscalation(binaries, commandText, writablePaths) {
  if (binaries.has('sudo') || binaries.has('su') || binaries.has('doas')) return true;
  if (/\bsudo\b/.test(commandText)) return true;

  // Root-level writable paths
  if (Array.isArray(writablePaths)) {
    for (const wp of writablePaths) {
      for (const sp of SYSTEM_PATHS) {
        if (isUnderRoot(resolve(wp), sp) || resolve(wp) === resolve(sp)) {
          return true;
        }
      }
    }
  }
  return false;
}

function detectSystemPathModification(writablePaths) {
  if (!Array.isArray(writablePaths)) return false;
  for (const wp of writablePaths) {
    for (const sp of SYSTEM_PATHS) {
      if (isUnderRoot(resolve(wp), sp) || resolve(wp) === resolve(sp)) {
        return true;
      }
    }
  }
  return false;
}

function detectAdminBinaries(binaries) {
  for (const bin of binaries) {
    if (ADMIN_BINARIES.has(bin)) return true;
  }
  return false;
}

function detectDbAdmin(binaries, commandText) {
  for (const bin of DB_ADMIN_BINARIES) {
    if (binaries.has(bin)) {
      // Any DB CLI usage beyond read-only SELECT is suspicious.
      // Presence alone is notable; combined with admin-like patterns it is red.
      if (/\b(DROP|ALTER|TRUNCATE|DELETE|CREATE|GRANT|REVOKE|FLUSHALL|FLUSHDB|SHUTDOWN|CONFIG\s+SET)\b/i.test(commandText)) {
        return true;
      }
      // Bare presence of the binary still counts as DB admin.
      return true;
    }
  }
  return false;
}

function detectDestructiveCommands(binaries, commandText) {
  for (const bin of DESTRUCTIVE_BINARIES) {
    if (binaries.has(bin)) return true;
  }
  return matchesAny(commandText, DESTRUCTIVE_PATTERNS);
}

function detectProdTarget(contract, commandText) {
  // Check command text
  if (matchesAny(commandText, PROD_TARGET_PATTERNS)) return true;

  // Check env inject values and names
  if (contract.envPolicy && typeof contract.envPolicy.inject === 'object') {
    for (const [key, value] of Object.entries(contract.envPolicy.inject)) {
      const combined = `${key} ${value}`;
      if (matchesAny(combined, PROD_TARGET_PATTERNS)) return true;
    }
  }

  // Check writable paths for production indicators
  if (Array.isArray(contract.writablePaths)) {
    for (const wp of contract.writablePaths) {
      if (matchesAny(wp, PROD_TARGET_PATTERNS)) return true;
    }
  }

  return false;
}

function detectRestartCapability(commandText) {
  for (const indicator of RESTART_INDICATORS) {
    if (commandText.includes(indicator)) return true;
  }
  return false;
}

function detectPatchPath(contract) {
  if (!contract.updatePolicy) return false;
  const actions = contract.updatePolicy.allowedActions;
  if (!Array.isArray(actions)) return false;
  // If the policy allows running scripts or applying patches beyond defaults
  const patchIndicators = new Set(['run_script', 'apply_patch', 'restart_service', 'update_dependency']);
  for (const action of actions) {
    if (patchIndicators.has(action)) return true;
  }
  return false;
}

const HIGH_RISK_ENV_PATTERNS = /secret|token|password|api[_-]?key|credential|auth|private[_-]?key/i;

function detectSecretInjection(contract) {
  if (!contract.envPolicy) return false;

  // Check injected vars
  const inject = contract.envPolicy.inject;
  if (inject && typeof inject === 'object') {
    for (const key of Object.keys(inject)) {
      if (HIGH_RISK_ENV_PATTERNS.test(key)) return true;
    }
  }

  // Check allow list — explicitly allowing a secret var is still exposure
  if (contract.envPolicy.inherit === false && Array.isArray(contract.envPolicy.allow)) {
    for (const key of contract.envPolicy.allow) {
      if (HIGH_RISK_ENV_PATTERNS.test(key)) return true;
    }
  }

  return false;
}

function detectEnvInheritance(contract) {
  if (!contract.envPolicy) return false;
  return contract.envPolicy.inherit === true;
}

// ---------------------------------------------------------------------------
// Internal: compute final risk level
// ---------------------------------------------------------------------------

function computeRiskLevel(ctx) {
  // ---- RED conditions (any one triggers red) --------------------------------

  // Untrusted provenance
  if (ctx.trustClass === 'generated' || ctx.trustClass === 'unknown') {
    return RISK_LEVELS.RED;
  }

  // Shell mode combined with package install, download, or destructive behaviour
  if (ctx.isShellMode && (ctx.hasPackageInstall || ctx.hasDownload || ctx.hasDestructive)) {
    return RISK_LEVELS.RED;
  }

  // Production-like targets
  if (ctx.hasProdTarget) {
    return RISK_LEVELS.RED;
  }

  // Writes extend outside project boundaries (excluding temp)
  if (ctx.writesOutsideRepo) {
    return RISK_LEVELS.RED;
  }

  // Sudo / root-level / system-path modification
  if (ctx.hasSudoOrRoot || ctx.hasSystemPathMod) {
    return RISK_LEVELS.RED;
  }

  // Cloud, infrastructure, or database admin commands
  if (ctx.hasAdminBinaries || ctx.hasDbAdmin) {
    return RISK_LEVELS.RED;
  }

  // Secret injection combined with shell mode or production targets
  if (ctx.hasSecretInjection && (ctx.isShellMode || ctx.hasProdTarget)) {
    return RISK_LEVELS.RED;
  }

  // ---- GREEN conditions (all must hold) -------------------------------------

  const isReviewedOrPinned =
    ctx.trustClass === 'reviewed_internal' || ctx.trustClass === 'pinned_external';
  const isStructured = !ctx.isShellMode;

  // All writable paths must be repo-local or temp-only.
  const writablePaths = ctx.contract.writablePaths || [];
  const allWritesLocal = writablePaths.length === 0 || writablePaths.every(wp => {
    const abs = resolve(wp);
    return (ctx.projectRoot && isUnderRoot(abs, ctx.projectRoot)) || isTempPath(abs);
  });

  // Only safe binaries
  const allBinariesSafe = [...ctx.referencedBinaries].every(b => SAFE_BINARY_ALLOWLIST.has(b));

  const noPackageInstall = !ctx.hasPackageInstall;
  const noRootSudo = !ctx.hasSudoOrRoot;
  const noProdTarget = !ctx.hasProdTarget;
  const noDestructive = !ctx.hasDestructive;
  const noBroadScope = !ctx.hasBroadWritableScope;
  const noRestart = !ctx.hasRestart;

  // No broad secret exposure
  const noSecretInjection = !ctx.reasons.includes('secret injection enabled');
  const noEnvInheritance = !ctx.reasons.includes('environment variable inheritance enabled');

  if (
    isReviewedOrPinned &&
    isStructured &&
    allWritesLocal &&
    allBinariesSafe &&
    noPackageInstall &&
    noRootSudo &&
    noProdTarget &&
    noDestructive &&
    noBroadScope &&
    noRestart &&
    noSecretInjection &&
    noEnvInheritance
  ) {
    return RISK_LEVELS.GREEN;
  }

  // ---- YELLOW: everything else -----------------------------------------------
  return RISK_LEVELS.YELLOW;
}

// ---------------------------------------------------------------------------
// Workflow-level risk evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate the aggregate risk of executing a multi-step workflow.
 *
 * @param {object} normalizedWorkflow - normalised workflow with name, entryStep,
 *   maxIterations, services[], steps[]
 * @param {object} [options]
 * @param {string} [options.trustClass]   - override trust classification
 * @param {string} [options.projectRoot]  - root directory of the project
 * @returns {{ trustClass: string, riskLevel: string, reasons: string[], requiresStrongConfirmation: boolean }}
 */
export function evaluateWorkflowRisk(normalizedWorkflow, options = {}) {
  const trustClass = classifyTrust(options);
  const allReasons = new Set();
  const stepRiskLevels = [];

  // Evaluate each step that has a run block.
  const steps = normalizedWorkflow.steps || [];

  if (steps.length > 1) {
    allReasons.add('multi-step workflow');
  }
  for (const step of steps) {
    if (!step.run) continue;

    // Build a contract-like object from the step's run block.
    // The default workflow envPolicy (inherit=true, no inject) shouldn't inflate
    // per-step risk. But if the step explicitly injects secrets, keep envPolicy
    // so detectSecretInjection can flag it.
    const { envPolicy, ...runFields } = step.run;
    const hasExplicitInject = envPolicy?.inject && Object.keys(envPolicy.inject).length > 0;
    const hasExplicitAllow = envPolicy?.inherit === false && Array.isArray(envPolicy.allow) && envPolicy.allow.length > 0;
    const contract = hasExplicitInject || hasExplicitAllow
      ? { ...runFields, envPolicy }
      : { ...runFields };

    const stepResult = evaluateRisk(contract, options);
    stepRiskLevels.push(stepResult.riskLevel);

    for (const reason of stepResult.reasons) {
      allReasons.add(reason);
    }
  }

  // Workflow-level amplifiers.
  const services = normalizedWorkflow.services || [];
  if (services.length > 0) {
    allReasons.add('service lifecycle capability');
  }

  const hasServiceRestart = steps.some(s => s.type === 'service_restart');
  if (hasServiceRestart) {
    allReasons.add('service restart capability');
  }

  // Compute workflow risk level.
  let riskLevel = RISK_LEVELS.GREEN;

  // If any step is RED → workflow is RED.
  if (stepRiskLevels.includes(RISK_LEVELS.RED)) {
    riskLevel = RISK_LEVELS.RED;
  }

  // If trust is generated or unknown → RED.
  if (trustClass === 'generated') {
    allReasons.add('generated workflow source');
    riskLevel = RISK_LEVELS.RED;
  }
  if (trustClass === 'unknown') {
    allReasons.add('unknown workflow provenance');
    riskLevel = RISK_LEVELS.RED;
  }

  // If workflow has services → at least YELLOW.
  if (services.length > 0 && riskLevel === RISK_LEVELS.GREEN) {
    riskLevel = RISK_LEVELS.YELLOW;
  }

  // If any step has service_restart type → at least YELLOW.
  if (hasServiceRestart && riskLevel === RISK_LEVELS.GREEN) {
    riskLevel = RISK_LEVELS.YELLOW;
  }

  // If any step is YELLOW and we haven't already escalated → YELLOW.
  if (stepRiskLevels.includes(RISK_LEVELS.YELLOW) && riskLevel === RISK_LEVELS.GREEN) {
    riskLevel = RISK_LEVELS.YELLOW;
  }

  const reasons = [...allReasons];

  return {
    trustClass,
    riskLevel,
    reasons,
    requiresStrongConfirmation: requiresStrongConfirmation(riskLevel),
  };
}

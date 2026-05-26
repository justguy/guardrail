import { hasShellMetacharacters } from '../contract.js';

export function parseArgs(argv) {
  const result = {
    subcommand: null,
    shell: null,
    template: null,
    inputs: {},
    envAllow: [],
    manifest: null,
    nonInteractive: false,
    json: false,
    jsonStream: false,
    trust: null,
    validator: null,
    updateSource: null,
    definition: null,
    recipeSearchDirs: [],
    allowUnverified: false,
    laneOpts: {},
    command: null,
    args: [],
    demoTarget: null,
  };

  let i = 0;

  const assignInputValue = (key, value) => {
    if (!(key in result.inputs)) {
      result.inputs[key] = value;
      return;
    }
    if (Array.isArray(result.inputs[key])) {
      result.inputs[key].push(value);
      return;
    }
    result.inputs[key] = [result.inputs[key], value];
  };

  const readFlagValue = () => {
    i++;
    if (i >= argv.length) return { error: 'usage' };
    return { value: argv[i++] };
  };

  const parseMappedFlags = (target, mappings, context = {}) => {
    while (i < argv.length) {
      const arg = argv[i];
      if (arg === '--help') return { help: true };
      if (arg === '--version' && context.allowVersionValue !== true) return { version: true };
      if (arg === '--json') {
        result.json = true;
        i++;
        continue;
      }
      const mapping = mappings[arg];
      if (!mapping) return { error: 'usage' };
      const key = typeof mapping === 'string' ? mapping : mapping.key;
      const isBoolean = typeof mapping === 'object' && mapping.boolean === true;
      if (isBoolean) {
        target[key] = true;
        i++;
        continue;
      }
      i++;
      if (i >= argv.length) return { error: 'usage' };
      const value = argv[i++];
      if (!(key in target)) {
        target[key] = value;
      } else if (Array.isArray(target[key])) {
        target[key].push(value);
      } else {
        target[key] = [target[key], value];
      }
    }
    return null;
  };

  if (i >= argv.length) {
    return { error: 'usage' };
  }

  const sub = argv[i++];

  if (sub === '--help') {
    return { help: true };
  }
  if (sub === '--version') {
    return { version: true };
  }

  if (sub === 'template') {
    if (i >= argv.length || !['lint', 'explain', 'schema', 'simulate', 'diff', 'create', 'list', 'publish'].includes(argv[i])) {
      return { error: 'usage' };
    }
    const action = argv[i++];
    result.subcommand = `template-${action}`;

    while (i < argv.length) {
      const arg = argv[i];
      if (arg === '--help') return { help: true };
      if (arg === '--version' && action !== 'publish') return { version: true };

      if (arg === '--template') {
        const next = readFlagValue();
        if (next.error) return next;
        result.template = next.value;
        continue;
      }
      if (arg === '--from-manifest') {
        const next = readFlagValue();
        if (next.error) return next;
        result.manifestPath = next.value;
        continue;
      }
      if (arg === '--templates-dir') {
        const next = readFlagValue();
        if (next.error) return next;
        result.templatesDir = next.value;
        continue;
      }
      if (arg === '--output') {
        const next = readFlagValue();
        if (next.error) return next;
        result.outputPath = next.value;
        continue;
      }
      if (arg === '--name') {
        const next = readFlagValue();
        if (next.error) return next;
        result.name = next.value;
        continue;
      }
      if (arg === '--category') {
        const next = readFlagValue();
        if (next.error) return next;
        result.category = next.value;
        continue;
      }
      if (arg === '--description') {
        const next = readFlagValue();
        if (next.error) return next;
        result.description = next.value;
        continue;
      }
      if (arg === '--version') {
        const next = readFlagValue();
        if (next.error) return next;
        result.version = next.value;
        continue;
      }
      if (arg === '--author') {
        const next = readFlagValue();
        if (next.error) return next;
        result.author = next.value;
        continue;
      }
      if (arg === '--input') {
        const next = readFlagValue();
        if (next.error) return next;
        const kv = next.value;
        const eq = kv.indexOf('=');
        if (eq < 1) return { error: 'usage' };
        assignInputValue(kv.slice(0, eq), kv.slice(eq + 1));
        continue;
      }
      if (arg === '--env-allow') {
        const next = readFlagValue();
        if (next.error) return next;
        result.envAllow.push(next.value);
        continue;
      }
      if (arg === '--manifest') {
        const next = readFlagValue();
        if (next.error) return next;
        result.manifest = next.value;
        continue;
      }
      if (arg === '--dry-run') {
        result.dryRun = true;
        i++;
        continue;
      }
      if (arg === '--json') {
        result.json = true;
        i++;
        continue;
      }
      if (arg === '--json-stream') {
        result.jsonStream = true;
        i++;
        continue;
      }
      if (arg.startsWith('--')) return { error: 'usage' };
      return { error: 'usage' };
    }
    return result;
  }

  if (sub === 'workflow') {
    if (i >= argv.length || !['run', 'lint'].includes(argv[i])) {
      return { error: 'usage' };
    }
    const workflowAction = argv[i];
    i++;
    result.subcommand = workflowAction === 'lint' ? 'workflow-lint' : 'workflow';

    while (i < argv.length) {
      const arg = argv[i];

      if (arg === '--help') return { help: true };
      if (arg === '--version') return { version: true };
      if (arg === '--definition') {
        i++;
        if (i >= argv.length) return { error: 'usage' };
        result.definition = argv[i++];
        continue;
      }
      if (arg === '--recipe-search-dir') {
        i++;
        if (i >= argv.length) return { error: 'usage' };
        result.recipeSearchDirs.push(argv[i++]);
        continue;
      }
      if (arg === '--allow-unverified') {
        result.allowUnverified = true;
        i++;
        continue;
      }
      if (arg === '--manifest' || arg === '--approved-manifest') {
        i++;
        if (i >= argv.length) return { error: 'usage' };
        result.manifest = argv[i++];
        continue;
      }
      if (arg === '--non-interactive') {
        result.nonInteractive = true;
        i++;
        continue;
      }
      if (arg === '--json') {
        result.json = true;
        i++;
        continue;
      }
      if (arg === '--json-stream') {
        result.jsonStream = true;
        i++;
        continue;
      }
      if (arg === '--trust') {
        i++;
        if (i >= argv.length) return { error: 'usage' };
        result.trust = argv[i++];
        continue;
      }
      if (arg === '--validator') {
        i++;
        if (i >= argv.length) return { error: 'usage' };
        result.validator = argv[i++];
        continue;
      }
      if (arg === '--update-source') {
        i++;
        if (i >= argv.length) return { error: 'usage' };
        result.updateSource = argv[i++];
        continue;
      }
      if (arg.startsWith('--')) return { error: 'usage' };
      return { error: 'usage' };
    }

    return result;
  }

  if (sub !== 'run' && sub !== 'demo' && sub !== 'pack' && sub !== 'recipe' && sub !== 'audit' && sub !== 'list' && sub !== 'create' && sub !== 'profile' && sub !== 'policy' && sub !== 'metrics' && sub !== 'approve' && sub !== 'export' && sub !== 'marketplace' && sub !== 'verify' && sub !== 'adapter' && sub !== 'lane' && sub !== 'repo' && sub !== 'mcp' && sub !== 'session' && sub !== 'key') {
    return { error: 'usage' };
  }

  result.subcommand = sub;

  if (sub === 'list') {
    result.subcommand = 'list';
    result.listFilters = {};
    while (i < argv.length) {
      if (argv[i] === '--category') { i++; result.listFilters.category = argv[i++]; continue; }
      if (argv[i] === '--tag') { i++; result.listFilters.tag = argv[i++]; continue; }
      if (argv[i] === '--search') { i++; result.listFilters.search = argv[i++]; continue; }
      if (argv[i] === '--risk') { i++; result.listFilters.risk_level = argv[i++]; continue; }
      if (argv[i] === '--channel') { i++; result.listFilters.channel = argv[i++]; continue; }
      if (argv[i] === '--json') { result.json = true; i++; continue; }
      return { error: 'usage' };
    }
    return result;
  }

  if (sub === 'profile') {
    if (i >= argv.length || !['create', 'use', 'list', 'show'].includes(argv[i])) {
      return { error: 'usage' };
    }
    const action = argv[i++];
    result.subcommand = `profile-${action}`;
    result.profileOpts = {};
    while (i < argv.length) {
      if (argv[i] === '--name') { i++; result.profileOpts.name = argv[i++]; continue; }
      if (argv[i] === '--risk') { i++; result.profileOpts.risk = argv[i++]; continue; }
      if (argv[i] === '--env') { i++; result.profileOpts.env = argv[i++]; continue; }
      if (argv[i] === '--role') { i++; result.profileOpts.role = argv[i++]; continue; }
      if (argv[i] === '--json') { result.json = true; i++; continue; }
      if (!argv[i].startsWith('--')) { result.profileOpts.name = argv[i++]; continue; }
      return { error: 'usage' };
    }
    return result;
  }

  if (sub === 'policy') {
    if (i >= argv.length || !['list', 'inspect', 'validate', 'simulate'].includes(argv[i])) {
      return { error: 'usage' };
    }
    const action = argv[i++];
    result.subcommand = `policy-${action}`;
    result.policyOpts = {};
    while (i < argv.length) {
      if (argv[i] === '--name') { i++; result.policyOpts.name = argv[i++]; continue; }
      if (argv[i] === '--json') { result.json = true; i++; continue; }
      if (argv[i] === '--contract') { i++; result.policyOpts.contract = argv[i++]; continue; }
      if (argv[i] === '--contract-file') { i++; result.policyOpts.contractFile = argv[i++]; continue; }
      if (argv[i] === '--trust-class') { i++; result.policyOpts.trustClass = argv[i++]; continue; }
      if (argv[i] === '--project-root') { i++; result.policyOpts.projectRoot = argv[i++]; continue; }
      if (argv[i] === '--principal') { i++; result.policyOpts.principal = argv[i++]; continue; }
      if (!argv[i].startsWith('--')) { result.policyOpts.name = argv[i++]; continue; }
      return { error: 'usage' };
    }
    return result;
  }

  if (sub === 'approve') {
    result.subcommand = 'approve';
    result.approveOpts = {};
    if (i < argv.length && argv[i] === 'list') {
      result.subcommand = 'approve-list';
      i++;
    } else if (i < argv.length && !argv[i].startsWith('--')) {
      result.approveOpts.id = argv[i++];
    }
    while (i < argv.length) {
      if (argv[i] === '--reject') { result.approveOpts.action = 'reject'; i++; continue; }
      if (argv[i] === '--json') { result.json = true; i++; continue; }
      if (argv[i] === '--state-dir') {
        i++;
        if (i >= argv.length) return { error: 'usage' };
        result.approveOpts.stateDir = argv[i++];
        continue;
      }
      return { error: 'usage' };
    }
    return result;
  }

  if (sub === 'export') {
    result.subcommand = 'export';
    result.exportOpts = { format: 'json' };
    while (i < argv.length) {
      if (argv[i] === '--format') { i++; result.exportOpts.format = argv[i++]; continue; }
      if (argv[i] === '--path') { i++; result.exportOpts.path = argv[i++]; continue; }
      if (argv[i] === '--output') { i++; result.outputPath = argv[i++]; continue; }
      return { error: 'usage' };
    }
    return result;
  }

  if (sub === 'marketplace') {
    if (i < argv.length && argv[i] === 'list') { result.subcommand = 'marketplace-list'; i++; }
    else { result.subcommand = 'marketplace-list'; }
    while (i < argv.length) {
      if (argv[i] === '--json') { result.json = true; i++; continue; }
      return { error: 'usage' };
    }
    return result;
  }

  if (sub === 'metrics') {
    result.subcommand = 'metrics';
    result.metricsOpts = {};
    while (i < argv.length) {
      if (argv[i] === '--path') { i++; result.metricsOpts.path = argv[i++]; continue; }
      if (argv[i] === '--json') { result.json = true; i++; continue; }
      return { error: 'usage' };
    }
    return result;
  }

  if (sub === 'lane') {
    if (i >= argv.length || !['start', 'send', 'run-sequence', 'chat', 'result', 'wait', 'status', 'inspect', 'history', 'portfolio', 'logs', 'stop', 'cleanup', 'batch', 'list', 'prune', 'adapters', 'extend', 'revoke', 'kill'].includes(argv[i])) {
      return { error: 'usage' };
    }
    const action = argv[i++];
    result.subcommand = `lane-${action}`;
    result.laneOpts = {};
    const error = parseMappedFlags(result.laneOpts, {
      '--id': 'id',
      '--lane-dir': 'laneDir',
      '--key-path': 'keyPath',
      '--guardrail-repo': 'guardrailRepo',
      '--working-dir': 'workingDir',
      '--tool': 'tool',
      '--model': 'model',
      '--effort': 'effort',
      '--permission-mode': 'permissionMode',
      '--output-format': 'outputFormat',
      '--max-budget-usd': 'maxBudgetUsd',
      '--allowed-tools': 'allowedTools',
      '--system-prompt': 'systemPrompt',
      '--add-dirs': 'addDirs',
      '--input-files': 'inputFiles',
      '--profile': 'profile',
      '--sandbox': 'sandbox',
      '--image-files': 'imageFiles',
      '--color': 'color',
      '--oss': 'oss',
      '--local-provider': 'localProvider',
      '--skip-git-repo-check': 'skipGitRepoCheck',
      '--ephemeral': 'ephemeral',
      '--full-auto': 'fullAuto',
      '--session-name': 'sessionName',
      '--session-id': 'sessionId',
      '--scope-type': 'scopeType',
      '--scope-mode': 'scopeMode',
      '--scope-path': 'scopePaths',
      '--scope-paths': 'scopePaths',
      '--resource-mode': 'resourceMode',
      '--resource': 'resources',
      '--resources': 'resources',
      '--command': 'command',
      '--arg': 'commandArgs',
      '--args': 'commandArgs',
      '--wrapper-command': 'wrapperCommand',
      '--wrapper-arg': 'wrapperArgs',
      '--wrapper-args': 'wrapperArgs',
      '--ssh-target': 'sshTarget',
      '--ssh-arg': 'sshArgs',
      '--ssh-args': 'sshArgs',
      '--remote-working-dir': 'remoteWorkingDir',
      '--no-session-persistence': { key: 'noSessionPersistence', boolean: true },
      '--auth-fd': 'authFd',
      '--poll-interval-ms': 'pollIntervalMs',
      '--idle-timeout-ms': 'idleTimeoutMs',
      '--health-timeout-ms': 'healthTimeoutMs',
      '--heartbeat': { key: 'heartbeat', boolean: true },
      '--request-id': 'requestId',
      '--prompt': 'prompt',
      '--prompt-file': 'promptFiles',
      '--report-artifact': 'reportArtifact',
      '--completion-mode': 'completionMode',
      '--stop-when-done': { key: 'stopWhenDone', boolean: true },
      '--action': 'action',
      '--all': { key: 'all', boolean: true },
      '--wait': { key: 'wait', boolean: true },
      '--timeout-ms': 'timeoutMs',
      '--tail': 'tail',
      '--limit': 'limit',
      '--event': 'event',
      '--status': 'status',
      '--alive': { key: 'alive', boolean: true },
      '--has-conflicts': { key: 'hasConflicts', boolean: true },
      '--tool-filter': 'toolFilter',
      '--lane-id-filter': 'filterLaneId',
      '--session-name-filter': 'filterSessionName',
      '--scope-type-filter': 'scopeTypeFilter',
      '--scope-mode-filter': 'scopeModeFilter',
      '--resource-filter': 'resourceFilter',
      '--repo-filter': 'repoFilter',
      '--host-state-dir': 'hostStateDir',
      '--all-repos': { key: 'allRepos', boolean: true },
      '--lanes-dir': 'lanesDir',
      '--include-failed': { key: 'includeFailed', boolean: true },
      '--dry-run': { key: 'dryRun', boolean: true },
      '--actor': 'actor',
      '--reason': 'reason',
    });
    if (result.laneOpts.dryRun === true) {
      result.dryRun = true;
    }
    return error || result;
  }

  if (sub === 'session') {
    if (i >= argv.length || !['revoke'].includes(argv[i])) {
      return { error: 'usage' };
    }
    const action = argv[i++];
    result.subcommand = `session-${action}`;
    result.sessionOpts = {};
    const error = parseMappedFlags(result.sessionOpts, {
      '--recipe': 'recipe',
      '--session-name': 'sessionName',
      '--actor': 'actor',
      '--reason': 'reason',
      '--guardrail-repo': 'guardrailRepo',
      '--state-dir': 'stateDir',
    });
    return error || result;
  }

  if (sub === 'key') {
    if (i >= argv.length || !['revoke'].includes(argv[i])) {
      return { error: 'usage' };
    }
    const action = argv[i++];
    result.subcommand = `key-${action}`;
    result.keyOpts = {};
    while (i < argv.length) {
      if (argv[i] === '--name') { i++; result.keyOpts.name = argv[i++]; continue; }
      if (argv[i] === '--state-dir') { i++; result.keyOpts.stateDir = argv[i++]; continue; }
      if (argv[i] === '--guardrail-repo') { i++; result.keyOpts.guardrailRepo = argv[i++]; continue; }
      if (argv[i] === '--actor') { i++; result.keyOpts.actor = argv[i++]; continue; }
      if (argv[i] === '--reason') { i++; result.keyOpts.reason = argv[i++]; continue; }
      if (argv[i] === '--json') { result.json = true; i++; continue; }
      if (!argv[i].startsWith('--') && !result.keyOpts.name) { result.keyOpts.name = argv[i++]; continue; }
      return { error: 'usage' };
    }
    return result;
  }

  if (sub === 'repo') {
    if (i >= argv.length || argv[i] !== 'status') {
      return { error: 'usage' };
    }
    i++;
    result.subcommand = 'repo-status';
    result.repoOpts = { path: '.' };
    while (i < argv.length) {
      if (argv[i] === '--path') { i++; result.repoOpts.path = argv[i++]; continue; }
      if (argv[i] === '--json') { result.json = true; i++; continue; }
      return { error: 'usage' };
    }
    return result;
  }

  if (sub === 'mcp') {
    if (i >= argv.length || argv[i] !== 'serve') {
      return { error: 'usage' };
    }
    i++;
    result.subcommand = 'mcp-serve';
    result.mcpOpts = {};
    const readMcpFlagValue = () => {
      const next = readFlagValue();
      if (next.error) return next;
      if (typeof next.value !== 'string' || next.value.startsWith('--')) return { error: 'usage' };
      return next;
    };
    while (i < argv.length) {
      if (argv[i] === '--grant') {
        const next = readMcpFlagValue();
        if (next.error) return next;
        result.mcpOpts.grantPath = next.value;
        continue;
      }
      if (argv[i] === '--agent') {
        const next = readMcpFlagValue();
        if (next.error) return next;
        result.mcpOpts.agent = next.value;
        continue;
      }
      if (argv[i] === '--cwd') {
        const next = readMcpFlagValue();
        if (next.error) return next;
        result.mcpOpts.cwd = next.value;
        continue;
      }
      if (argv[i] === '--audit-path') {
        const next = readMcpFlagValue();
        if (next.error) return next;
        result.mcpOpts.auditPath = next.value;
        continue;
      }
      return { error: 'usage' };
    }
    return result;
  }

  if (sub === 'create') {
    result.subcommand = 'create';
    result.createOpts = {};
    while (i < argv.length) {
      if (argv[i] === '--name') { i++; result.createOpts.name = argv[i++]; continue; }
      if (argv[i] === '--category') { i++; result.createOpts.category = argv[i++]; continue; }
      if (argv[i] === '--risk') { i++; result.createOpts.risk = argv[i++]; continue; }
      if (argv[i] === '--output') { i++; result.outputPath = argv[i++]; continue; }
      if (argv[i] === '--json') { result.json = true; i++; continue; }
      return { error: 'usage' };
    }
    return result;
  }

  if (sub === 'pack') {
    if (i >= argv.length) return { error: 'usage' };
    result.recipePath = argv[i++];
    result.subcommand = 'pack';
    while (i < argv.length) {
      if (argv[i] === '--output') { i++; result.outputPath = argv[i++]; continue; }
      if (argv[i] === '--json') { result.json = true; i++; continue; }
      return { error: 'usage' };
    }
    return result;
  }

  if (sub === 'adapter') {
    return { subcommand: 'adapter', adapterArgv: argv.slice(i) };
  }

  if (sub === 'recipe') {
    if (i >= argv.length || !['validate', 'inspect', 'install', 'versions', 'publish', 'registry', 'compose', 'progress', 'continue'].includes(argv[i])) {
      return { error: 'usage' };
    }
    const action = argv[i++];
    result.subcommand = `recipe-${action}`;

    if (action === 'registry') {
      if (i >= argv.length || !['export', 'list'].includes(argv[i])) return { error: 'usage' };
      const registryAction = argv[i++];
      result.subcommand = `recipe-registry-${registryAction}`;
      result.recipeSearchDirs = [];

      if (registryAction === 'export') {
        if (i >= argv.length) return { error: 'usage' };
        result.outputPath = argv[i++];
        while (i < argv.length) {
          if (argv[i] === '--recipe-search-dir' && i + 1 < argv.length) {
            result.recipeSearchDirs.push(argv[++i]);
            i++;
            continue;
          }
          if (argv[i] === '--json') { result.json = true; i++; continue; }
          return { error: 'usage' };
        }
        return result;
      }

      if (i >= argv.length) return { error: 'usage' };
      result.registry = argv[i++];
      while (i < argv.length) {
        if (argv[i] === '--json') { result.json = true; i++; continue; }
        return { error: 'usage' };
      }
      return result;
    }

    if (action === 'publish') {
      while (i < argv.length) {
        if (argv[i] === '--name' && i + 1 < argv.length) { result.name = argv[++i]; i++; continue; }
        if (argv[i] === '--category' && i + 1 < argv.length) { result.category = argv[++i]; i++; continue; }
        if (argv[i] === '--description' && i + 1 < argv.length) { result.description = argv[++i]; i++; continue; }
        if (argv[i] === '--version' && i + 1 < argv.length) { result.version = argv[++i]; i++; continue; }
        if (argv[i] === '--author' && i + 1 < argv.length) { result.author = argv[++i]; i++; continue; }
        if ((argv[i] === '--manifest-path' || argv[i] === '--manifest') && i + 1 < argv.length) {
          result.manifestPath = argv[++i];
          i++;
          continue;
        }
        if (argv[i] === '--dry-run') { result.dryRun = true; i++; continue; }
        if (argv[i] === '--json') { result.json = true; i++; continue; }
        return { error: 'usage' };
      }
      return result;
    }

    if (action === 'compose') {
      result.recipeSearchDirs = [];
      while (i < argv.length) {
        if (argv[i] === '--transport' && i + 1 < argv.length) { result.transportRecipe = argv[++i]; i++; continue; }
        if (argv[i] === '--transport-step' && i + 1 < argv.length) { result.transportStep = argv[++i]; i++; continue; }
        if (argv[i] === '--exec' && i + 1 < argv.length) { result.execRecipe = argv[++i]; i++; continue; }
        if (argv[i] === '--output' && i + 1 < argv.length) { result.outputPath = argv[++i]; i++; continue; }
        if (argv[i] === '--name' && i + 1 < argv.length) { result.name = argv[++i]; i++; continue; }
        if (argv[i] === '--category' && i + 1 < argv.length) { result.category = argv[++i]; i++; continue; }
        if (argv[i] === '--description' && i + 1 < argv.length) { result.description = argv[++i]; i++; continue; }
        if (argv[i] === '--version' && i + 1 < argv.length) { result.version = argv[++i]; i++; continue; }
        if (argv[i] === '--recipe-search-dir' && i + 1 < argv.length) { result.recipeSearchDirs.push(argv[++i]); i++; continue; }
        if (argv[i] === '--json') { result.json = true; i++; continue; }
        return { error: 'usage' };
      }
      return result;
    }

    if (action === 'progress') {
      while (i < argv.length) {
        if (argv[i] === '--state-dir' && i + 1 < argv.length) { result.stateDir = argv[++i]; i++; continue; }
        if (argv[i] === '--run-id' && i + 1 < argv.length) { result.runId = argv[++i]; i++; continue; }
        if (argv[i] === '--json') { result.json = true; i++; continue; }
        if (argv[i] === '--follow') { result.follow = true; i++; continue; }
        return { error: 'usage' };
      }
      return result;
    }

    if (action === 'continue') {
      while (i < argv.length) {
        if (argv[i] === '--state-dir' && i + 1 < argv.length) { result.stateDir = argv[++i]; i++; continue; }
        if (argv[i] === '--prompt' && i + 1 < argv.length) { result.prompt = argv[++i]; i++; continue; }
        if (argv[i] === '--json') { result.json = true; i++; continue; }
        return { error: 'usage' };
      }
      if (!result.stateDir || !result.prompt) return { error: 'usage' };
      return result;
    }

    if (i >= argv.length) return { error: 'usage' };
    result.recipePath = argv[i++];
    while (i < argv.length) {
      if (argv[i] === '--registry') { i++; result.registry = argv[i++]; continue; }
      if (argv[i] === '--json') { result.json = true; i++; continue; }
      if (argv[i] === '--overwrite') { result.force = true; i++; continue; }
      return { error: 'usage' };
    }
    return result;
  }

  if (sub === 'audit') {
    if (i >= argv.length || !['verify', 'query'].includes(argv[i])) {
      return { error: 'usage' };
    }
    const auditAction = argv[i++];
    result.subcommand = `audit-${auditAction}`;
    result.auditFilters = {};

    while (i < argv.length) {
      const arg = argv[i];
      if (arg === '--help') return { help: true };
      if (arg === '--path') { i++; result.auditPath = argv[i++]; continue; }
      if (arg === '--trace-id') { i++; result.auditFilters.trace_id = argv[i++]; continue; }
      if (arg === '--manifest-hash') { i++; result.auditFilters.manifest_hash = argv[i++]; continue; }
      if (arg === '--event') { i++; result.auditFilters.event = argv[i++]; continue; }
      if (arg === '--after') { i++; result.auditFilters.after = argv[i++]; continue; }
      if (arg === '--before') { i++; result.auditFilters.before = argv[i++]; continue; }
      if (arg === '--json') { result.json = true; i++; continue; }
      return { error: 'usage' };
    }
    return result;
  }

  if (sub === 'demo') {
    if (i >= argv.length) {
      return { error: 'usage' };
    }
    result.demoTarget = argv[i++];
    if (!['drift', 'recipe', 'trust', 'blocked', 'list'].includes(result.demoTarget)) {
      return { error: 'usage' };
    }
    return result;
  }

  if (sub === 'verify') {
    result.subcommand = 'verify';
    while (i < argv.length) {
      if (argv[i] === '--json') { result.json = true; i++; continue; }
      return { error: 'usage' };
    }
    return result;
  }

  let foundSeparator = false;

  while (i < argv.length) {
    const arg = argv[i];

    if (arg === '--') {
      foundSeparator = true;
      i++;
      break;
    }
    if (arg === '--help') return { help: true };
    if (arg === '--version') return { version: true };
    if (arg === '--shell') {
      i++;
      if (i >= argv.length) return { error: 'usage' };
      result.shell = argv[i++];
      continue;
    }
    if (arg === '--recipe') {
      i++;
      if (i >= argv.length) return { error: 'usage' };
      result.recipeId = argv[i++];
      continue;
    }
    if (arg === '--dry-run') {
      result.dryRunOnly = true;
      i++;
      continue;
    }
    if (arg === '--allow-unverified') {
      result.allowUnverified = true;
      i++;
      continue;
    }
    if (arg === '--template') {
      i++;
      if (i >= argv.length) return { error: 'usage' };
      result.template = argv[i++];
      continue;
    }
    if (arg === '--input') {
      i++;
      if (i >= argv.length) return { error: 'usage' };
      const kv = argv[i++];
      const eq = kv.indexOf('=');
      if (eq < 1) return { error: 'usage' };
      assignInputValue(kv.slice(0, eq), kv.slice(eq + 1));
      continue;
    }
    if (arg === '--env-allow') {
      i++;
      if (i >= argv.length) return { error: 'usage' };
      result.envAllow.push(argv[i++]);
      continue;
    }
    if (arg === '--manifest' || arg === '--approved-manifest') {
      i++;
      if (i >= argv.length) return { error: 'usage' };
      result.manifest = argv[i++];
      continue;
    }
    if (arg === '--non-interactive') {
      result.nonInteractive = true;
      i++;
      continue;
    }
    if (arg === '--json') {
      result.json = true;
      i++;
      continue;
    }
    if (arg === '--json-stream') {
      result.jsonStream = true;
      i++;
      continue;
    }
    if (arg === '--trust') {
      i++;
      if (i >= argv.length) return { error: 'usage' };
      result.trust = argv[i++];
      continue;
    }
    if (arg === '--validator') {
      i++;
      if (i >= argv.length) return { error: 'usage' };
      result.validator = argv[i++];
      continue;
    }
    if (arg === '--update-source') {
      i++;
      if (i >= argv.length) return { error: 'usage' };
      result.updateSource = argv[i++];
      continue;
    }
    if (arg.startsWith('--')) return { error: 'usage' };
    result.command = arg;
    i++;
    break;
  }

  if (foundSeparator) {
    if (i >= argv.length) return { error: 'usage' };
    result.command = argv[i++];
    result.args = argv.slice(i);
  }

  if (result.recipeId || result.template !== null || result.shell !== null) {
    return result;
  }

  if (result.command === null) {
    return { error: 'usage' };
  }

  if (!foundSeparator) {
    const text = result.command;
    if (hasShellMetacharacters(text)) {
      return {
        error: 'shell_meta',
        text,
      };
    }
    const tokens = text.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      return { error: 'usage' };
    }
    result.command = tokens[0];
    result.args = tokens.slice(1);
  }

  return result;
}

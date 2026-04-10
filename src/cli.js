#!/usr/bin/env node

import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { runSupervisor, STATUS_EXIT_CODES } from './supervisor.js';
import { hasShellMetacharacters } from './contract.js';
import { DEFAULT_MANIFEST_PATH } from './manifest.js';

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

function getVersion() {
  try {
    const pkgPath = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function defaultLaneDir(laneId) {
  return `.guardrail/lanes/${laneId}`;
}

function defaultLaneKeyPath(laneId) {
  return resolve(homedir(), '.guardrail', 'lanes', `${laneId}.key`);
}

function normalizeLaneCliOptions(raw = {}) {
  const laneId = raw.id || raw.laneId || '';
  const laneDir = raw.laneDir || (laneId ? defaultLaneDir(laneId) : '');
  const keyPath = raw.keyPath || (laneId ? defaultLaneKeyPath(laneId) : '');
  return {
    ...raw,
    laneId,
    laneDir,
    keyPath,
    sessionName: raw.sessionName || laneId || '',
    guardrailRepo: raw.guardrailRepo || '.',
    workingDir: raw.workingDir || '.',
  };
}

function ensureLaneKeyFile(keyPath) {
  mkdirSync(dirname(keyPath), { recursive: true });
  const secret = randomBytes(32).toString('hex');
  writeFileSync(keyPath, `${secret}\n`, { mode: 0o600 });
  chmodSync(keyPath, 0o600);
}

function isLikelyLaneAlive(laneDir) {
  try {
    const state = JSON.parse(readFileSync(resolve(laneDir, 'state.json'), 'utf8'));
    if (!Number.isInteger(state?.pid) || state.pid <= 0) return false;
    process.kill(state.pid, 0);
    return state.status !== 'expired' && state.status !== 'stopped';
  } catch {
    return false;
  }
}

async function appendLaneAuditEntry(laneOpts, event, details = {}) {
  try {
    const { createAuditLog } = await import('./audit.js');
    const guardrailRepo = resolve(laneOpts.guardrailRepo || '.');
    const auditLog = createAuditLog(resolve(guardrailRepo, '.guardrail', 'audit.jsonl'));
    auditLog.append({
      event,
      trace_id: `lane:${laneOpts.laneId || laneOpts.sessionName || 'resident'}`,
      lane_id: laneOpts.laneId || null,
      lane_dir: laneOpts.laneDir || null,
      session_name: laneOpts.sessionName || null,
      session_id: laneOpts.sessionId || null,
      ...details,
    });
  } catch {
    // Best effort: lane execution must not fail solely because audit append failed.
  }
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

const USAGE = `Usage: guardrail <command> [options]

Commands:
  run [flags] -- <command> [args...]    Run a command under Guardrail
  run --shell "<script>"                Run a shell script under Guardrail
  run --recipe <id[@ver]> --input k=v     Run a recipe by ID (optional @version)
  run --template <path> --input k=v     Run a template under Guardrail
  lane start [flags]                    Start a resident interactive lane
  lane send [flags]                     Send one message through a resident lane
  lane status [flags]                   Show resident lane status and recovery hints
  lane stop [flags]                     Stop a resident interactive lane
  workflow run [flags]                  Run a workflow definition under Guardrail
  workflow lint --definition <path>     Lint a workflow definition for issues
  template lint --template <path>       Lint a template for issues
  template explain --template <path>    Explain what a template does
  template schema --template <path>     Show template input schema
  template simulate --template <path>   Simulate a template run (no execution)
  template diff --template <path>       Show diff from approved hash
  template create --from-manifest <p>   Create a starter template from an approved manifest
  template list [--templates-dir <p>]   List local templates
  template publish --template <path>    Publish a template through the recipe pipeline
  list [--category X] [--search Q]      List and filter available recipes
  pack <recipe.json> [--output <path>]   Package a recipe for distribution
  recipe validate <recipe.json>         Validate a recipe file
  recipe inspect <packed.json>          Inspect a packaged recipe (verify hash)
  recipe install <path|url|github://>   Install a recipe to local registry
  recipe versions <id>                  List installed versions of a recipe
  recipe publish --name <n> --category <c> [--manifest <path>] [--description <d>] [--dry-run]
  adapter run --tool <name> -- <cmd>    Run a command through an adapter profile
  adapter probe --tool <name>           Probe an MCP stdio profile for discovery only
  adapter mcp call --tool <name>        Perform one bounded MCP tools/call over stdio
  adapter shim --tool <n> --commands <c>  Create PATH shims for adapter interception
  adapter profile install <source>      Install an adapter profile
  adapter profile index verify <path> --index-key <pubkey.pem>  Verify a signed adapter profile index file
  adapter profile list                  List adapter profiles
  adapter profile show <tool>           Show adapter profile details
  create --name <n> --category <c>      Generate a recipe skeleton
  profile create|use|list|show          Manage user profiles
  policy list|inspect|validate          Manage and enforce policies
  metrics [--path <file>]               View execution metrics
  audit verify [--path <file>]           Verify audit log chain integrity
  audit query [--trace-id X] [filters]  Query audit log entries
  verify                                Run quick self-test verification
  demo drift|recipe|trust|blocked       Run a built-in demo scenario

Flags:
  --shell <text>              Shell mode with script text
  --template <path>           Template file path
  --input <key=value>         Template input (repeatable)
  --env-allow <var>           Env var to allow for recipe/template runtime handshakes (repeatable)
  --manifest <path>           Custom manifest path
  --approved-manifest <path>  Approved manifest path (CI)
  --non-interactive           Never prompt, fail on missing approval
  --json                      Emit JSON output
  --json-stream               Emit machine-readable progress stream (and structured result) for supported modes
  --trust <class>             Override trust class
  --validator <mode>          Validator mode: exit_code | ndjson
  --update-source <source>    Update source: none | worker_proposal | demo
  --definition <path>         Workflow definition file path
  --recipe-search-dir <path>  Extra recipe directory for workflow recipe_ref resolution (repeatable)
  --allow-unverified          Allow community/unsigned workflow recipes
  --env-allow <var>           Env var to allow for adapter auth/credential plumbing (repeatable)
  --help                      Show this help
  --version                   Show version

Examples:
  guardrail run -- npm test
  guardrail run "npm test"
  guardrail run --shell "npm test && npm run lint"
  guardrail run --template ./templates/npm-publish.json --input package_dir=packages/my-lib --input tag=beta
  guardrail lane start --id claude-live
  guardrail lane send --id claude-live --prompt "2x3=?"
  guardrail lane stop --id claude-live
  guardrail template lint --template ./templates/npm-publish.json
  guardrail template create --from-manifest .guardrail/approved.json --name npm-publish
  guardrail template list --json
  guardrail template explain --template ./templates/npm-publish.json
  guardrail template simulate --template ./templates/npm-publish.json --input package_dir=packages/my-lib
  guardrail run --non-interactive --approved-manifest .guardrail/approved.json -- npm test
  guardrail demo drift`;

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

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

  const parseMappedFlags = (target, mappings) => {
    while (i < argv.length) {
      const arg = argv[i];
      if (arg === '--help') return { help: true };
      if (arg === '--version' && action !== 'publish') return { version: true };
      if (arg === '--json') {
        result.json = true;
        i++;
        continue;
      }
      const key = mappings[arg];
      if (!key) return { error: 'usage' };
      i++;
      if (i >= argv.length) return { error: 'usage' };
      target[key] = argv[i++];
    }
    return null;
  };

  // --- Subcommand -----------------------------------------------------------

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

  // --- template subcommand --------------------------------------------------

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

  // --- workflow subcommand --------------------------------------------------

  if (sub === 'workflow') {
    if (i >= argv.length || !['run', 'lint'].includes(argv[i])) {
      return { error: 'usage' };
    }
    const workflowAction = argv[i];
    i++;
    result.subcommand = workflowAction === 'lint' ? 'workflow-lint' : 'workflow';

    // Parse workflow flags
    while (i < argv.length) {
      const arg = argv[i];

      if (arg === '--help') {
        return { help: true };
      }

      if (arg === '--version') {
        return { version: true };
      }

      if (arg === '--definition') {
        i++;
        if (i >= argv.length) {
          return { error: 'usage' };
        }
        result.definition = argv[i++];
        continue;
      }

      if (arg === '--recipe-search-dir') {
        i++;
        if (i >= argv.length) {
          return { error: 'usage' };
        }
        result.recipeSearchDirs.push(argv[i++]);
        continue;
      }

      if (arg === '--allow-unverified') {
        result.allowUnverified = true;
        i++;
        continue;
      }

      if (arg === '--manifest') {
        i++;
        if (i >= argv.length) {
          return { error: 'usage' };
        }
        result.manifest = argv[i++];
        continue;
      }

      if (arg === '--approved-manifest') {
        i++;
        if (i >= argv.length) {
          return { error: 'usage' };
        }
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
        if (i >= argv.length) {
          return { error: 'usage' };
        }
        result.trust = argv[i++];
        continue;
      }

      if (arg === '--validator') {
        i++;
        if (i >= argv.length) {
          return { error: 'usage' };
        }
        result.validator = argv[i++];
        continue;
      }

      if (arg === '--update-source') {
        i++;
        if (i >= argv.length) {
          return { error: 'usage' };
        }
        result.updateSource = argv[i++];
        continue;
      }

      // Unknown flag
      if (arg.startsWith('--')) {
        return { error: 'usage' };
      }

      // No positional args for workflow
      return { error: 'usage' };
    }

    return result;
  }

  if (sub !== 'run' && sub !== 'demo' && sub !== 'pack' && sub !== 'recipe' && sub !== 'audit' && sub !== 'list' && sub !== 'create' && sub !== 'profile' && sub !== 'policy' && sub !== 'metrics' && sub !== 'approve' && sub !== 'export' && sub !== 'marketplace' && sub !== 'verify' && sub !== 'adapter' && sub !== 'lane') {
    return { error: 'usage' };
  }

  result.subcommand = sub;

  // --- list subcommand -------------------------------------------------------

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

  // --- profile subcommand ----------------------------------------------------

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
      if (argv[i] === '--json') { result.json = true; i++; continue; }
      if (!argv[i].startsWith('--')) { result.profileOpts.name = argv[i++]; continue; }
      return { error: 'usage' };
    }
    return result;
  }

  // --- policy subcommand -----------------------------------------------------

  if (sub === 'policy') {
    if (i >= argv.length || !['list', 'inspect', 'validate'].includes(argv[i])) {
      return { error: 'usage' };
    }
    const action = argv[i++];
    result.subcommand = `policy-${action}`;
    result.policyOpts = {};
    while (i < argv.length) {
      if (argv[i] === '--name') { i++; result.policyOpts.name = argv[i++]; continue; }
      if (argv[i] === '--json') { result.json = true; i++; continue; }
      if (!argv[i].startsWith('--')) { result.policyOpts.name = argv[i++]; continue; }
      return { error: 'usage' };
    }
    return result;
  }

  // --- approve subcommand ----------------------------------------------------

  if (sub === 'approve') {
    result.subcommand = 'approve';
    result.approveOpts = {};
    if (i < argv.length && argv[i] === 'list') { result.subcommand = 'approve-list'; i++; }
    else if (i < argv.length && !argv[i].startsWith('--')) { result.approveOpts.id = argv[i++]; }
    while (i < argv.length) {
      if (argv[i] === '--reject') { result.approveOpts.action = 'reject'; i++; continue; }
      if (argv[i] === '--json') { result.json = true; i++; continue; }
      return { error: 'usage' };
    }
    return result;
  }

  // --- export subcommand -----------------------------------------------------

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

  // --- marketplace subcommand ------------------------------------------------

  if (sub === 'marketplace') {
    if (i < argv.length && argv[i] === 'list') { result.subcommand = 'marketplace-list'; i++; }
    else { result.subcommand = 'marketplace-list'; }
    while (i < argv.length) {
      if (argv[i] === '--json') { result.json = true; i++; continue; }
      return { error: 'usage' };
    }
    return result;
  }

  // --- metrics subcommand ----------------------------------------------------

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

  // --- lane subcommand ------------------------------------------------------

  if (sub === 'lane') {
    if (i >= argv.length || !['start', 'send', 'status', 'stop'].includes(argv[i])) {
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
      '--model': 'model',
      '--effort': 'effort',
      '--permission-mode': 'permissionMode',
      '--output-format': 'outputFormat',
      '--max-budget-usd': 'maxBudgetUsd',
      '--allowed-tools': 'allowedTools',
      '--system-prompt': 'systemPrompt',
      '--add-dirs': 'addDirs',
      '--input-files': 'inputFiles',
      '--session-name': 'sessionName',
      '--session-id': 'sessionId',
      '--no-session-persistence': 'noSessionPersistence',
      '--auth-fd': 'authFd',
      '--poll-interval-ms': 'pollIntervalMs',
      '--idle-timeout-ms': 'idleTimeoutMs',
      '--request-id': 'requestId',
      '--prompt': 'prompt',
      '--timeout-ms': 'timeoutMs',
    });
    return error || result;
  }

  // --- create subcommand -----------------------------------------------------

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

  // --- pack subcommand -------------------------------------------------------

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

  // --- adapter subcommand ---------------------------------------------------

  if (sub === 'adapter') {
    return { subcommand: 'adapter', adapterArgv: argv.slice(i) };
  }

  // --- recipe subcommand ----------------------------------------------------

  if (sub === 'recipe') {
    if (i >= argv.length || !['validate', 'inspect', 'install', 'versions', 'publish'].includes(argv[i])) {
      return { error: 'usage' };
    }
    const action = argv[i++];
    result.subcommand = `recipe-${action}`;

    if (action === 'publish') {
      // parse --name, --category, --description, --version, --author, --dry-run, --manifest/--manifest-path
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

    if (i >= argv.length) return { error: 'usage' };
    result.recipePath = argv[i++];
    while (i < argv.length) {
      if (argv[i] === '--json') { result.json = true; i++; continue; }
      if (argv[i] === '--overwrite') { result.force = true; i++; continue; }
      return { error: 'usage' };
    }
    return result;
  }

  // --- audit subcommand -----------------------------------------------------

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

  // --- demo subcommand ------------------------------------------------------

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

  // --- verify subcommand ----------------------------------------------------

  if (sub === 'verify') {
    result.subcommand = 'verify';
    while (i < argv.length) {
      if (argv[i] === '--json') { result.json = true; i++; continue; }
      return { error: 'usage' };
    }
    return result;
  }

  // --- run subcommand: parse flags then command -----------------------------

  let foundSeparator = false;

  while (i < argv.length) {
    const arg = argv[i];

    if (arg === '--') {
      foundSeparator = true;
      i++;
      break;
    }

    if (arg === '--help') {
      return { help: true };
    }

    if (arg === '--version') {
      return { version: true };
    }

    if (arg === '--shell') {
      i++;
      if (i >= argv.length) {
        return { error: 'usage' };
      }
      result.shell = argv[i++];
      continue;
    }

    if (arg === '--recipe') {
      i++;
      if (i >= argv.length) {
        return { error: 'usage' };
      }
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
      if (i >= argv.length) {
        return { error: 'usage' };
      }
      result.template = argv[i++];
      continue;
    }

    if (arg === '--input') {
      i++;
      if (i >= argv.length) {
        return { error: 'usage' };
      }
      const kv = argv[i++];
      const eq = kv.indexOf('=');
      if (eq < 1) {
        return { error: 'usage' };
      }
      assignInputValue(kv.slice(0, eq), kv.slice(eq + 1));
      continue;
    }

    if (arg === '--env-allow') {
      i++;
      if (i >= argv.length) {
        return { error: 'usage' };
      }
      result.envAllow.push(argv[i++]);
      continue;
    }

    if (arg === '--manifest') {
      i++;
      if (i >= argv.length) {
        return { error: 'usage' };
      }
      result.manifest = argv[i++];
      continue;
    }

    if (arg === '--approved-manifest') {
      i++;
      if (i >= argv.length) {
        return { error: 'usage' };
      }
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
      if (i >= argv.length) {
        return { error: 'usage' };
      }
      result.trust = argv[i++];
      continue;
    }

    if (arg === '--validator') {
      i++;
      if (i >= argv.length) {
        return { error: 'usage' };
      }
      result.validator = argv[i++];
      continue;
    }

    if (arg === '--update-source') {
      i++;
      if (i >= argv.length) {
        return { error: 'usage' };
      }
      result.updateSource = argv[i++];
      continue;
    }

    // Unknown flag
    if (arg.startsWith('--')) {
      return { error: 'usage' };
    }

    // Positional argument (shorthand string mode): "npm test"
    result.command = arg;
    i++;
    break;
  }

  // After `--` separator, everything is the command + args
  if (foundSeparator) {
    if (i >= argv.length) {
      return { error: 'usage' };
    }
    result.command = argv[i++];
    result.args = argv.slice(i);
  }

  // Recipe mode: command comes from --recipe, nothing else needed
  if (result.recipeId) {
    return result;
  }

  // Template mode: command comes from --template, nothing else needed
  if (result.template !== null) {
    return result;
  }

  // Shell mode: command comes from --shell, nothing else needed
  if (result.shell !== null) {
    return result;
  }

  // Must have a command by now
  if (result.command === null) {
    return { error: 'usage' };
  }

  // Shorthand string mode (no `--` separator, no --shell):
  // tokenize the quoted string and check for metacharacters
  if (!foundSeparator) {
    const text = result.command;
    if (hasShellMetacharacters(text)) {
      return {
        error: 'shell_meta',
        text,
      };
    }
    // Tokenize by whitespace
    const tokens = text.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      return { error: 'usage' };
    }
    result.command = tokens[0];
    result.args = tokens.slice(1);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  // --- Help / version ------------------------------------------------------

  if (parsed.help) {
    console.log(USAGE);
    process.exit(0);
  }

  if (parsed.version) {
    console.log(getVersion());
    process.exit(0);
  }

  // --- Errors --------------------------------------------------------------

  if (parsed.error === 'usage') {
    console.error(USAGE);
    process.exit(1);
  }

  if (parsed.error === 'shell_meta') {
    console.error(
      `Error: Shell metacharacters detected in command: ${parsed.text}\n` +
      `Use --shell to run shell scripts:\n` +
      `  guardrail run --shell "${parsed.text}"`
    );
    process.exit(1);
  }

  // --- demo drift ----------------------------------------------------------

  if (parsed.subcommand === 'demo') {
    if (parsed.demoTarget === 'drift') {
      const { default: runDemoDrift } = await import('./demo-drift.js');
      await runDemoDrift();
    } else if (parsed.demoTarget === 'list') {
      const { listScenarios } = await import('./demo-scenarios.js');
      for (const s of listScenarios()) {
        console.log(`  ${s.id.padEnd(12)} ${s.name.padEnd(22)} ${s.description}`);
      }
    } else {
      const mod = await import('./demo-scenarios.js');
      const fns = { recipe: mod.runDemoRecipe, trust: mod.runDemoTrust, blocked: mod.runDemoBlocked };
      if (fns[parsed.demoTarget]) {
        await fns[parsed.demoTarget]();
      } else {
        console.error(`Unknown demo: ${parsed.demoTarget}`);
        process.exit(1);
      }
    }
    process.exit(0);
  }

  // --- verify ---------------------------------------------------------------

  if (parsed.subcommand === 'verify') {
    const { runFullVerification } = await import('./verify.js');
    const result = await runFullVerification();
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log('');
      console.log('  Guardrail Self-Verification');
      console.log('  ' + '─'.repeat(40));
      for (const c of result.checks) {
        const icon = c.passed ? '  PASS' : '  FAIL';
        const color = c.passed ? '\x1b[32m' : '\x1b[31m';
        console.log(`${color}${icon}\x1b[0m  ${c.name}: ${c.detail}`);
      }
      console.log('');
      console.log(result.passed ? '  All checks passed.' : '  Some checks failed.');
      console.log('');
    }
    process.exit(result.passed ? 0 : 1);
  }

  // --- lane start/send -----------------------------------------------------

  if (parsed.subcommand === 'lane-start') {
    const { launchResidentLane } = await import('./claude-resident-lane.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    if (!laneOpts.laneId && !laneOpts.laneDir) {
      console.error('Error: --id <lane-id> or --lane-dir <path> is required for lane start');
      process.exit(1);
    }
    if (!laneOpts.sessionName) {
      console.error('Error: --session-name <name> or --id <lane-id> is required for lane start');
      process.exit(1);
    }
    if (laneOpts.keyPath && existsSync(laneOpts.keyPath) && !isLikelyLaneAlive(laneOpts.laneDir)) {
      unlinkSync(laneOpts.keyPath);
    }
    if (laneOpts.keyPath && !existsSync(laneOpts.keyPath)) {
      ensureLaneKeyFile(laneOpts.keyPath);
    }
    const keyFd = laneOpts.keyPath ? openSync(laneOpts.keyPath, 'r') : null;
    let summary;
    try {
      summary = await launchResidentLane({
        ...laneOpts,
        authFd: keyFd ?? '',
      });
    } finally {
      if (keyFd !== null) closeSync(keyFd);
    }
    await appendLaneAuditEntry(laneOpts, 'lane_start', {
      reused: !!summary.reused,
      pid: summary.pid ?? null,
      auth_mode: summary.authMode ?? 'none',
      status: 'success',
    });
    if (parsed.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`Lane started: ${summary.sessionName}`);
      if (laneOpts.laneId) console.log(`  Lane id:       ${laneOpts.laneId}`);
      console.log(`  Lane dir:      ${summary.laneDir}`);
      if (summary.keyPath) console.log(`  Key path:      ${summary.keyPath}`);
      console.log(`  Request FIFO:  ${summary.requestFifo}`);
      console.log(`  Response FIFO: ${summary.responseFifo}`);
      console.log(`  State path:    ${summary.statePath}`);
      console.log(`  PID:           ${summary.pid}`);
      if (summary.reused) {
        console.log('  Reused:        yes');
      }
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'lane-send') {
    const { sendResidentLaneMessage } = await import('./claude-resident-lane-client.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    if (!laneOpts.laneId && !laneOpts.laneDir) {
      console.error('Error: --id <lane-id> or --lane-dir <path> is required for lane send');
      process.exit(1);
    }
    if (!laneOpts.prompt) {
      console.error('Error: --prompt <text> is required for lane send');
      process.exit(1);
    }
    if (laneOpts.keyPath && !existsSync(laneOpts.keyPath)) {
      const expired = {
        status: 'error',
        reason: 'lane_expired',
        message: 'The resident lane has idled out. Run `guardrail lane start` to initialize a new session.',
      };
      await appendLaneAuditEntry(laneOpts, 'lane_send', {
        request_id: laneOpts.requestId || null,
        status: 'error',
        reason: expired.reason,
      });
      if (parsed.json) {
        console.log(JSON.stringify(expired, null, 2));
      } else {
        console.error(expired.message);
      }
      process.exit(1);
    }

    const requestId = laneOpts.requestId || `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const keyFd = laneOpts.keyPath ? openSync(laneOpts.keyPath, 'r') : null;
    let response;
    try {
      response = await sendResidentLaneMessage([
        '--lane-dir', laneOpts.laneDir,
        '--request-id', requestId,
        '--prompt', laneOpts.prompt,
        '--timeout-ms', laneOpts.timeoutMs || '30000',
        ...(keyFd !== null ? ['--auth-fd', String(keyFd)] : []),
      ]);
    } catch (err) {
      const expired = err?.code === 'ENOENT' || err?.code === 'ENXIO' || err?.code === 'EPIPE' || String(err?.message || '').includes('timed out');
      if (!expired) throw err;
      response = {
        status: 'error',
        reason: 'lane_expired',
        message: 'The resident lane has idled out. Run `guardrail lane start` to initialize a new session.',
        ok: false,
        exitCode: 1,
      };
    } finally {
      if (keyFd !== null) closeSync(keyFd);
    }

    await appendLaneAuditEntry(laneOpts, 'lane_send', {
      request_id: requestId,
      status: response.ok ? 'success' : 'error',
      reason: response.reason || response.error || null,
      exit_code: response.exitCode ?? null,
    });

    if (parsed.json) {
      console.log(JSON.stringify(response, null, 2));
    } else if (response.ok) {
      process.stdout.write(response.stdout || '');
    } else {
      console.error(response.error || response.stderr || 'Resident lane request failed');
    }

    process.exit(response.ok ? 0 : (response.exitCode || 1));
  }

  if (parsed.subcommand === 'lane-stop') {
    const { stopResidentLane } = await import('./claude-resident-lane.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    if (!laneOpts.laneId && !laneOpts.laneDir) {
      console.error('Error: --id <lane-id> or --lane-dir <path> is required for lane stop');
      process.exit(1);
    }
    const result = stopResidentLane(laneOpts);
    if (laneOpts.keyPath) {
      try {
        unlinkSync(laneOpts.keyPath);
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
    }
    await appendLaneAuditEntry(laneOpts, 'lane_stop', {
      status: result.stopped ? 'success' : 'error',
      stopped: !!result.stopped,
    });
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Lane stopped: ${laneOpts.laneId || laneOpts.laneDir}`);
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'lane-status') {
    const { getResidentLaneStatus } = await import('./claude-resident-lane.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    if (!laneOpts.laneId && !laneOpts.laneDir) {
      console.error('Error: --id <lane-id> or --lane-dir <path> is required for lane status');
      process.exit(1);
    }
    const status = getResidentLaneStatus(laneOpts);
    if (parsed.json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log(`Lane status: ${status.status}`);
      if (laneOpts.laneId) console.log(`  Lane id:            ${laneOpts.laneId}`);
      console.log(`  Lane dir:           ${status.laneDir}`);
      if (status.sessionName) console.log(`  Session name:       ${status.sessionName}`);
      if (status.sessionId) console.log(`  Session id:         ${status.sessionId}`);
      console.log(`  Alive:              ${status.alive ? 'yes' : 'no'}`);
      console.log(`  PID:                ${status.pid ?? 'n/a'}`);
      console.log(`  Last request id:    ${status.lastRequestId ?? 'n/a'}`);
      console.log(`  Last activity at:   ${status.lastActivityAt ?? 'n/a'}`);
      console.log(`  Key present:        ${status.keyPresent ? 'yes' : 'no'}`);
      console.log(`  Request FIFO:       ${status.requestFifoPresent ? 'present' : 'missing'}`);
      console.log(`  Response FIFO:      ${status.responseFifoPresent ? 'present' : 'missing'}`);
      console.log(`  Recommended action: ${status.recommendedAction}`);
    }
    process.exit(0);
  }

  // --- template create -----------------------------------------------------

  if (parsed.subcommand === 'template-create') {
    if (!parsed.manifestPath) {
      console.error('Error: --from-manifest <path> is required for template create');
      process.exit(1);
    }

    const { buildTemplateFromApprovedManifest, lintTemplate } = await import('./template.js');

    let templateDef;
    try {
      templateDef = buildTemplateFromApprovedManifest(parsed.manifestPath, {
        name: parsed.name,
        sourcePath: parsed.manifestPath,
      });
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }

    const outputPath = resolve(parsed.outputPath || `.guardrail/templates/${templateDef.name}.json`);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, JSON.stringify(templateDef, null, 2) + '\n');

    const warnings = lintTemplate(templateDef);
    if (parsed.json) {
      console.log(JSON.stringify({ path: outputPath, template: templateDef, warnings }, null, 2));
    } else {
      console.log(`Template created: ${outputPath}`);
      if (warnings.length > 0) {
        console.log('');
        console.log('Warnings:');
        for (const warning of warnings) {
          console.log(`  - ${warning}`);
        }
      }
    }
    process.exit(0);
  }

  // --- template list -------------------------------------------------------

  if (parsed.subcommand === 'template-list') {
    const { listTemplates } = await import('./template.js');

    let rows;
    try {
      rows = listTemplates(parsed.templatesDir || '.guardrail/templates');
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }

    if (parsed.json) {
      console.log(JSON.stringify(rows, null, 2));
    } else if (rows.length === 0) {
      console.log('No templates found.');
    } else {
      for (const row of rows) {
        const provenance = row.source
          ? `${row.source.type}${row.sourceMatch === false ? ' (modified)' : ''}`
          : 'local';
        console.log(`  ${row.name.padEnd(24)} ${row.kind.padEnd(18)} ${row.effectiveTrustClass.padEnd(18)} ${provenance}`);
      }
    }
    process.exit(0);
  }

  // --- template publish ----------------------------------------------------

  if (parsed.subcommand === 'template-publish') {
    try {
      const { publishTemplate } = await import('./recipe-publish.js');
      const result = await publishTemplate({
        templatePath: parsed.template,
        name: parsed.name,
        category: parsed.category,
        description: parsed.description,
        version: parsed.version,
        author: parsed.author,
        dryRun: parsed.dryRun,
      });
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
      }
      process.exit(0);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  // --- template lint -------------------------------------------------------

  if (parsed.subcommand === 'template-lint') {
    if (!parsed.template) {
      console.error('Error: --template <path> is required for template lint');
      process.exit(1);
    }

    const { loadTemplate, lintTemplate } = await import('./template.js');

    let def;
    try {
      def = loadTemplate(parsed.template);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }

    const warnings = lintTemplate(def);

    if (warnings.length === 0) {
      console.log('No issues found.');
      process.exit(0);
    }

    console.error(`${warnings.length} warning${warnings.length > 1 ? 's' : ''}:\n`);
    for (const w of warnings) {
      console.error(`  ⚠ ${w}`);
    }
    process.exit(1);
  }

  // --- template explain ----------------------------------------------------

  if (parsed.subcommand === 'template-explain') {
    if (!parsed.template) {
      console.error('Error: --template <path> is required for template explain');
      process.exit(1);
    }

    const { loadTemplate, explainTemplate } = await import('./template.js');

    let def;
    try {
      def = loadTemplate(parsed.template);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }

    console.log(explainTemplate(def));
    process.exit(0);
  }

  // --- template schema -----------------------------------------------------

  if (parsed.subcommand === 'template-schema') {
    if (!parsed.template) {
      console.error('Error: --template <path> is required for template schema');
      process.exit(1);
    }

    const { loadTemplate, describeSchema } = await import('./template.js');

    let def;
    try {
      def = loadTemplate(parsed.template);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }

    console.log(describeSchema(def));
    process.exit(0);
  }

  // --- template simulate ---------------------------------------------------

  if (parsed.subcommand === 'template-simulate') {
    if (!parsed.template) {
      console.error('Error: --template <path> is required for template simulate');
      process.exit(1);
    }

    const { loadTemplate, simulateTemplate } = await import('./template.js');

    let def;
    try {
      def = loadTemplate(parsed.template);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }

    const result = simulateTemplate(def, parsed.inputs, parsed.envAllow);
    if (result.errors.length > 0) {
      console.error('Simulation failed:');
      for (const e of result.errors) {
        console.error(`  - ${e}`);
      }
      process.exit(1);
    }

    console.log(result.output);
    process.exit(0);
  }

  // --- template diff -------------------------------------------------------

  if (parsed.subcommand === 'template-diff') {
    if (!parsed.template) {
      console.error('Error: --template <path> is required for template diff');
      process.exit(1);
    }

    const { resolve } = await import('node:path');
    const { loadTemplate, hashTemplateExecution, createTemplateManifest, diffTemplateManifests, evaluateTemplateRisk, validateUserInputs, computeEnvIntersection } = await import('./template.js');
    const { loadManifest } = await import('./manifest.js');

    let def;
    try {
      def = loadTemplate(parsed.template);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }

    const manifestPath = resolve(parsed.manifest || `.guardrail/templates/${def.name}.approved.json`);
    const approved = loadManifest(manifestPath);

    if (!approved) {
      console.log('No approved manifest found. Nothing to diff against.');
      process.exit(0);
    }

    // Rebuild candidate with the same inputs from the approved manifest
    const savedInputs = approved.resolvedInputs || {};
    const savedEnv = approved.envIntersection || [];

    const inputValidation = validateUserInputs(def.inputs, { ...savedInputs, ...parsed.inputs });
    const inputs = inputValidation.valid ? inputValidation.values : savedInputs;
    const callerAllow = parsed.envAllow.length > 0 ? parsed.envAllow : savedEnv;
    const envResult = computeEnvIntersection(def.requires_env || [], callerAllow);
    const templateHash = hashTemplateExecution(def, inputs, envResult.intersection);
    const riskAssessment = evaluateTemplateRisk(def, envResult.intersection);
    const candidate = createTemplateManifest(def, templateHash, riskAssessment, inputs, envResult.intersection);

    const diffs = diffTemplateManifests(candidate, approved);

    if (diffs.length === 0) {
      console.log('No changes detected. Template matches approved hash.');
      process.exit(0);
    }

    console.log(`Template: ${def.name}`);
    console.log(`Approved hash: ${approved.templateHash?.slice(0, 12)}...`);
    console.log(`Current hash:  ${candidate.templateHash?.slice(0, 12)}...`);
    console.log('');
    console.log('Changes:');
    for (const diff of diffs) {
      console.log(`  ${diff}`);
    }
    process.exit(12);
  }

  // --- audit verify ----------------------------------------------------------

  // --- pack ----------------------------------------------------------------

  // --- list ----------------------------------------------------------------

  if (parsed.subcommand === 'list') {
    const { buildIndex, filterRecipes, formatRecipeList, deduplicateLatest } = await import('./recipe-index.js');
    const { buildRecipeSearchDirs } = await import('./recipe-runner.js');

    const dirs = buildRecipeSearchDirs({ basePath: process.cwd(), includeDefaults: true });
    const index = buildIndex(dirs);
    const deduped = deduplicateLatest(index);
    const filtered = filterRecipes(deduped, parsed.listFilters);

    if (parsed.json) {
      console.log(JSON.stringify(filtered.map(r => ({
        id: r.id, name: r.name, version: r.version,
        category: r.category, tags: r.tags, channel: r.channel,
        risk_level: r.risk_level, approval_required: r.approval_required,
      })), null, 2));
    } else {
      if (filtered.length === 0) {
        console.log('No recipes found.');
      } else {
        console.log(`  ${'ID'.padEnd(25)} ${'VERSION'.padEnd(8)} ${'RISK'.padEnd(6)} ${'CHANNEL'.padEnd(12)} NAME`);
        console.log(`  ${'─'.repeat(25)} ${'─'.repeat(8)} ${'─'.repeat(6)} ${'─'.repeat(12)} ${'─'.repeat(30)}`);
        console.log(formatRecipeList(filtered));
        console.log(`\n  ${filtered.length} recipe(s) found.`);
      }
    }
    process.exit(0);
  }

  // --- create --------------------------------------------------------------

  if (parsed.subcommand === 'create') {
    const opts = parsed.createOpts || {};
    if (!opts.name) {
      console.error('Error: --name is required for create');
      process.exit(1);
    }

    const id = opts.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const category = opts.category || 'custom';
    const risk = opts.risk || 'medium';
    const outputPath = parsed.outputPath || `${id}.recipe.json`;

    const skeleton = {
      id,
      name: opts.name,
      description: `TODO: Describe what ${opts.name} does`,
      version: '0.1.0',
      author: process.env.USER || 'unknown',
      category,
      tags: [category],
      channel: 'community',
      signature: null,
      inputs: {
        target: { type: 'string', pattern: '^[a-zA-Z0-9_.-]+$', description: 'TODO: describe this input' },
      },
      steps: [
        { id: 'step-1', description: 'TODO: describe this step', run: { command: 'echo', args: ['{{inputs.target}}'], mode: 'structured' } },
      ],
      guardrails: {
        constraints: ['TODO: define constraints'],
        invariants: ['TODO: define invariants'],
      },
      approval_required: risk !== 'low',
      risk_level: risk,
    };

    const { writeFileSync } = await import('node:fs');
    writeFileSync(outputPath, JSON.stringify(skeleton, null, 2) + '\n');

    const riskWarnings = {
      high: '  WARNING: High-risk recipe — will require explicit approval before execution.',
      medium: '  Note: Medium-risk recipe — approval required by default.',
      low: '',
    };

    if (!parsed.json) {
      console.log(`Created recipe skeleton: ${outputPath}`);
      console.log(`  ID:       ${id}`);
      console.log(`  Category: ${category}`);
      console.log(`  Risk:     ${risk}`);
      if (riskWarnings[risk]) console.log(riskWarnings[risk]);
      console.log('\n  Edit the file to define your inputs, steps, and guardrails.');
    } else {
      console.log(JSON.stringify({ created: outputPath, id, category, risk }));
    }
    process.exit(0);
  }

  // --- profile commands ------------------------------------------------------

  if (parsed.subcommand === 'profile-create') {
    const { saveProfile, BUILTIN_PROFILES } = await import('./profile.js');
    const opts = parsed.profileOpts || {};
    const name = opts.name;
    if (!name) { console.error('Error: profile name required'); process.exit(1); }

    // Check if it's a builtin
    const builtin = BUILTIN_PROFILES[name];
    const profile = builtin || {
      name,
      description: `Custom profile: ${name}`,
      risk_tolerance: opts.risk || 'medium',
      environment: opts.env || 'dev',
      approval_rules: { require_for_high_risk: true, require_for_prod: true, auto_approve_low_risk: opts.risk === 'high' },
    };

    const path = saveProfile(profile);
    console.log(`Profile "${name}" saved to ${path}`);
    process.exit(0);
  }

  if (parsed.subcommand === 'profile-use') {
    const { setActiveProfile } = await import('./profile.js');
    const name = parsed.profileOpts?.name;
    if (!name) { console.error('Error: profile name required'); process.exit(1); }
    try { setActiveProfile(name); console.log(`Active profile set to "${name}"`); }
    catch (err) { console.error(err.message); process.exit(1); }
    process.exit(0);
  }

  if (parsed.subcommand === 'profile-list') {
    const { listProfiles, getActiveProfile } = await import('./profile.js');
    const profiles = listProfiles();
    const active = getActiveProfile();
    if (parsed.json) {
      console.log(JSON.stringify({ profiles, active: active?.name ?? null }, null, 2));
    } else {
      if (profiles.length === 0) { console.log('No profiles found. Create one with `guardrail profile create <name>`.'); }
      else {
        for (const p of profiles) {
          const marker = active?.name === p.name ? ' (active)' : '';
          console.log(`  ${p.name.padEnd(20)} ${p.environment.padEnd(10)} risk: ${p.risk_tolerance}${marker}`);
        }
      }
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'profile-show') {
    const { loadProfile, getActiveProfile } = await import('./profile.js');
    const name = parsed.profileOpts?.name;
    const profile = name ? loadProfile(name) : getActiveProfile();
    if (!profile) { console.error('No profile found. Specify --name or set active profile.'); process.exit(1); }
    console.log(JSON.stringify(profile, null, 2));
    process.exit(0);
  }

  // --- policy commands -------------------------------------------------------

  if (parsed.subcommand === 'policy-list') {
    const { listPolicies, formatPolicy } = await import('./policy.js');
    const policies = listPolicies('.guardrail');
    if (parsed.json) { console.log(JSON.stringify(policies, null, 2)); }
    else if (policies.length === 0) { console.log('No policies found.'); }
    else { for (const p of policies) { console.log(formatPolicy(p)); console.log(); } }
    process.exit(0);
  }

  if (parsed.subcommand === 'policy-inspect') {
    const { loadPolicy, formatPolicy } = await import('./policy.js');
    const name = parsed.policyOpts?.name;
    if (!name) { console.error('Error: policy name required'); process.exit(1); }
    try {
      const policy = loadPolicy(name, '.guardrail');
      console.log(parsed.json ? JSON.stringify(policy, null, 2) : formatPolicy(policy));
    } catch (err) { console.error(err.message); process.exit(1); }
    process.exit(0);
  }

  if (parsed.subcommand === 'policy-validate') {
    const { loadPolicy, validatePolicy } = await import('./policy.js');
    const name = parsed.policyOpts?.name;
    if (!name) { console.error('Error: policy name required'); process.exit(1); }
    try {
      const policy = loadPolicy(name, '.guardrail');
      const errors = validatePolicy(policy);
      if (errors.length === 0) { console.log(`Policy "${name}" is valid.`); process.exit(0); }
      else { console.error(`Policy "${name}" has errors:\n  - ${errors.join('\n  - ')}`); process.exit(1); }
    } catch (err) { console.error(err.message); process.exit(1); }
  }

  // --- metrics ---------------------------------------------------------------

  if (parsed.subcommand === 'metrics') {
    const { aggregateMetrics, formatMetrics } = await import('./metrics.js');
    const metricsPath = parsed.metricsOpts?.path || '.guardrail/metrics.jsonl';
    const metrics = aggregateMetrics(metricsPath);
    console.log(parsed.json ? JSON.stringify(metrics, null, 2) : formatMetrics(metrics));
    process.exit(0);
  }

  // --- approve commands ------------------------------------------------------

  if (parsed.subcommand === 'approve-list') {
    const { listRequests, formatRequest } = await import('./approval-queue.js');
    const requests = listRequests('.guardrail');
    if (parsed.json) { console.log(JSON.stringify(requests, null, 2)); }
    else if (requests.length === 0) { console.log('No pending approvals.'); }
    else { for (const r of requests) { console.log(formatRequest(r)); console.log(); } }
    process.exit(0);
  }

  if (parsed.subcommand === 'approve' && parsed.approveOpts?.id) {
    const { loadRequest, saveRequest, approveRequest, rejectRequest } = await import('./approval-queue.js');
    try {
      const req = loadRequest(parsed.approveOpts.id, '.guardrail');
      const result = parsed.approveOpts.action === 'reject'
        ? rejectRequest(req, process.env.USER || 'cli-user', 'Rejected via CLI')
        : approveRequest(req, process.env.USER || 'cli-user');
      saveRequest(req, '.guardrail');
      console.log(`${result.status === 'approved' ? 'Approved' : result.status === 'rejected' ? 'Rejected' : 'Advanced'}: ${req.id}`);
      if (result.nextStage) console.log(`  Next stage: ${result.nextStage}`);
    } catch (err) { console.error(err.message); process.exit(1); }
    process.exit(0);
  }

  // --- export ----------------------------------------------------------------

  if (parsed.subcommand === 'export') {
    const { exportAuditLog } = await import('./compliance.js');
    const auditPath = parsed.exportOpts?.path || '.guardrail/audit.jsonl';
    const output = exportAuditLog(auditPath, { format: parsed.exportOpts?.format || 'json' });
    if (parsed.outputPath) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(parsed.outputPath, output, 'utf8');
      console.log(`Exported to ${parsed.outputPath}`);
    } else {
      console.log(output);
    }
    process.exit(0);
  }

  // --- marketplace -----------------------------------------------------------

  if (parsed.subcommand === 'marketplace-list') {
    const { buildMarketplaceIndex, formatMarketplace } = await import('./marketplace.js');
    const entries = buildMarketplaceIndex('recipes');
    if (parsed.json) { console.log(JSON.stringify(entries, null, 2)); }
    else {
      console.log(`  ${'ID'.padEnd(25)} ${'VERSION'.padEnd(9)} ${'CHANNEL'.padEnd(12)} AUTHOR`);
      console.log(`  ${'─'.repeat(25)} ${'─'.repeat(9)} ${'─'.repeat(12)} ${'─'.repeat(20)}`);
      console.log(formatMarketplace(entries));
      console.log(`\n  ${entries.length} recipe(s) in marketplace.`);
    }
    process.exit(0);
  }

  // --- pack ----------------------------------------------------------------

  if (parsed.subcommand === 'pack') {
    const { loadRecipe, packRecipe, writePackedRecipe } = await import('./recipe.js');

    let recipe;
    try {
      recipe = loadRecipe(parsed.recipePath);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }

    const packed = packRecipe(recipe);
    const outputPath = parsed.outputPath || parsed.recipePath.replace(/\.recipe\.json$/, '.packed.json').replace(/\.json$/, '.packed.json');

    writePackedRecipe(packed, outputPath);

    if (parsed.json) {
      console.log(JSON.stringify({ status: 'packed', outputPath, contentHash: packed.content_hash, version: recipe.version }, null, 2));
    } else {
      console.log(`Packed recipe "${recipe.name}" v${recipe.version}`);
      console.log(`  Hash:   ${packed.content_hash}`);
      console.log(`  Output: ${outputPath}`);
    }
    process.exit(0);
  }

  // --- adapter dispatch -----------------------------------------------------

  if (parsed.subcommand === 'adapter') {
    const { runAdapterCli } = await import('./adapter-cli.js');
    await runAdapterCli(parsed.adapterArgv || [], { jsonOutput: parsed.json });
    process.exit(0);
  }

  // --- recipe validate -----------------------------------------------------

  if (parsed.subcommand === 'recipe-validate') {
    const { loadRecipe } = await import('./recipe.js');

    try {
      const recipe = loadRecipe(parsed.recipePath);
      if (parsed.json) {
        console.log(JSON.stringify({ valid: true, id: recipe.id, version: recipe.version }));
      } else {
        console.log(`Recipe "${recipe.name}" v${recipe.version} is valid.`);
        console.log(`  ID:       ${recipe.id}`);
        console.log(`  Risk:     ${recipe.risk_level}`);
        console.log(`  Approval: ${recipe.approval_required ? 'required' : 'not required'}`);
        console.log(`  Steps:    ${recipe.steps.length}`);
        console.log(`  Inputs:   ${Object.keys(recipe.inputs).length}`);
      }
      process.exit(0);
    } catch (err) {
      if (parsed.json) {
        console.log(JSON.stringify({ valid: false, errors: err.errors || [err.message] }));
      } else {
        console.error(err.message);
      }
      process.exit(1);
    }
  }

  // --- recipe inspect ------------------------------------------------------

  if (parsed.subcommand === 'recipe-inspect') {
    const { loadPackedRecipe } = await import('./recipe.js');

    try {
      const result = loadPackedRecipe(parsed.recipePath);
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Recipe: ${result.recipe.name} v${result.recipe.version}`);
        console.log(`  ID:       ${result.recipe.id}`);
        console.log(`  Hash:     ${result.contentHash}`);
        console.log(`  Verified: ${result.verified ? 'YES — content matches hash' : 'FAILED — content tampered'}`);
        console.log(`  Packed:   ${result.packedAt}`);
        console.log(`  Risk:     ${result.recipe.risk_level}`);
        console.log(`  Steps:    ${result.recipe.steps.length}`);
      }
      process.exit(result.verified ? 0 : 1);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  // --- recipe versions ------------------------------------------------------

  if (parsed.subcommand === 'recipe-versions') {
    const { listVersions } = await import('./recipe-install.js');
    const recipeId = parsed.recipePath; // reused field
    const versions = listVersions(recipeId);
    if (parsed.json) {
      console.log(JSON.stringify({ id: recipeId, versions }));
    } else if (versions.length === 0) {
      console.log(`No installed versions of "${recipeId}".`);
    } else {
      console.log(`Versions of "${recipeId}":`);
      for (const v of versions) {
        console.log(`  ${v}`);
      }
    }
    process.exit(0);
  }

  // --- recipe install -------------------------------------------------------

  if (parsed.subcommand === 'recipe-install') {
    const source = parsed.recipePath;
    try {
      let result;
      if (source.startsWith('github://')) {
        const { installFromGitHub } = await import('./recipe-install.js');
        result = await installFromGitHub(source, { force: parsed.force });
      } else if (source.startsWith('http://') || source.startsWith('https://')) {
        const { installFromUrl } = await import('./recipe-install.js');
        result = await installFromUrl(source, { force: parsed.force });
      } else if (/^[a-z][a-z0-9-]*$/.test(source) && !existsSync(source)) {
        // Looks like a recipe name, not a file path
        console.error(
          `Recipe "${source}" is not a local path, URL, or github:// source.\n` +
          'To install from the public registry, use the full GitHub URL:\n' +
          `  guardrail recipe install github://guardrail-dev/recipes/<category>/${source}.json@<sha>\n` +
          'Browse available recipes at: https://github.com/guardrail-dev/recipes'
        );
        process.exit(1);
      } else {
        const { installFromPath } = await import('./recipe-install.js');
        result = installFromPath(source, { force: parsed.force });
      }
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Installed recipe "${result.id}" v${result.version}`);
        console.log(`  Path: ${result.path}`);
        console.log(`  Hash: ${result.hash}`);
        if (result.pin) {
          console.log(`  SHA:  ${result.pin.sha}`);
        }
      }
      process.exit(0);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  // --- recipe publish -------------------------------------------------------

  if (parsed.subcommand === 'recipe-publish') {
    try {
      const { publishRecipe } = await import('./recipe-publish.js');
      const result = await publishRecipe({
        name: parsed.name,
        category: parsed.category,
        description: parsed.description,
        version: parsed.version,
        author: parsed.author,
        dryRun: parsed.dryRun,
        manifestPath: parsed.manifestPath,
      });
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
      }
      process.exit(0);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  // --- audit verify --------------------------------------------------------

  if (parsed.subcommand === 'audit-verify') {
    const auditPath = parsed.auditPath || '.guardrail/audit.jsonl';
    const { verifyAuditChain } = await import('./audit.js');

    const result = verifyAuditChain(auditPath);

    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.valid) {
      console.log(`Audit chain verified: ${result.entries} entries, no tampering detected.`);
    } else {
      console.error(`Audit chain broken: ${result.error}`);
    }
    process.exit(result.valid ? 0 : STATUS_EXIT_CODES.audit_chain_broken);
  }

  // --- audit query -----------------------------------------------------------

  if (parsed.subcommand === 'audit-query') {
    const auditPath = parsed.auditPath || '.guardrail/audit.jsonl';
    const { queryAuditLog, verifyAuditChain } = await import('./audit.js');

    // Verify chain first
    const chainResult = verifyAuditChain(auditPath);
    const entries = queryAuditLog(auditPath, parsed.auditFilters);

    if (parsed.json) {
      console.log(JSON.stringify({ chainValid: chainResult.valid, entries }, null, 2));
    } else {
      if (!chainResult.valid) {
        console.error(`Warning: audit chain is broken — ${chainResult.error}\n`);
      }
      if (entries.length === 0) {
        console.log('No matching entries.');
      } else {
        for (const entry of entries) {
          console.log(`${entry.timestamp} [${entry.event}] trace=${entry.trace_id ?? '-'} manifest=${entry.manifest_hash?.slice(0, 12) ?? '-'}...`);
        }
        console.log(`\n${entries.length} entries found.`);
      }
    }
    process.exit(0);
  }

  // --- workflow lint --------------------------------------------------------

  if (parsed.subcommand === 'workflow-lint') {
    if (!parsed.definition) {
      console.error('Error: --definition <path> is required for workflow lint');
      process.exit(1);
    }

    const { loadWorkflowDefinition, lintWorkflowDefinition, normalizeWorkflowDefinition } = await import('./workflow.js');

    let def;
    try {
      def = loadWorkflowDefinition(parsed.definition);
      normalizeWorkflowDefinition(def, dirname(resolve(parsed.definition)), {
        recipeSearchDirs: parsed.recipeSearchDirs,
      });
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }

    const { errors, warnings } = lintWorkflowDefinition(def);

    if (errors.length === 0 && warnings.length === 0) {
      console.log('No issues found.');
      process.exit(0);
    }

    if (errors.length > 0) {
      console.error(`${errors.length} error${errors.length > 1 ? 's' : ''} (block approval):\n`);
      for (const e of errors) {
        console.error(`  ✗ ${e}`);
      }
    }
    if (warnings.length > 0) {
      console.error(`${warnings.length} warning${warnings.length > 1 ? 's' : ''}:\n`);
      for (const w of warnings) {
        console.error(`  ⚠ ${w}`);
      }
    }
    process.exit(errors.length > 0 ? 1 : 0);
  }

  // --- workflow run ---------------------------------------------------------

  if (parsed.subcommand === 'workflow') {
    if (!parsed.definition) {
      console.error('Error: --definition <path> is required for workflow run');
      process.exit(1);
    }

    if (parsed.nonInteractive && parsed.manifest === null) {
      console.error('Error: --non-interactive requires --approved-manifest <path>');
      process.exit(10);
    }

    const { runWorkflowSupervisor } = await import('./workflow-supervisor.js');

    const wantStructuredResult = parsed.json || parsed.jsonStream;

    const result = await runWorkflowSupervisor({
      definitionPath: parsed.definition,
      manifestPath: parsed.manifest || '.guardrail/workflows/default.approved.json',
      nonInteractive: parsed.nonInteractive,
      jsonOutput: parsed.json || parsed.jsonStream,
      trustClass: parsed.trust,
      recipeSearchDirs: parsed.recipeSearchDirs,
      allowUnverified: parsed.allowUnverified || false,
      progressSink: parsed.jsonStream ? (event) => process.stdout.write(`${JSON.stringify(event)}\n`) : null,
    });

    if (wantStructuredResult) {
      console.log(JSON.stringify(result, null, parsed.json ? 2 : 0));
    }

    const exitCode = STATUS_EXIT_CODES[result.status] ?? 1;
    process.exit(exitCode);
  }

  // --- run --recipe ---------------------------------------------------------

  if (parsed.subcommand === 'run' && parsed.recipeId) {
    try {
      if (parsed.dryRunOnly) {
        const { runRecipeById } = await import('./recipe-runner.js');
        const result = await runRecipeById(parsed.recipeId, {
          inputs: parsed.inputs,
          allowUnverified: parsed.allowUnverified || false,
          dryRunOnly: true,
          cwd: process.cwd(),
        });
        if (parsed.json || parsed.jsonStream) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Recipe: ${result.recipe.name} v${result.recipe.version}`);
          console.log(`  Steps: ${result.steps.length}`);
          console.log(`  Safe:  ${result.safe ? 'YES' : 'NO — blocked steps detected'}`);
          for (const step of result.steps) {
            const icon = step.dangerous || !step.inScope ? '✗' : '✓';
            console.log(`  ${icon} ${step.id}: ${step.command} ${step.args.join(' ')}`);
          }
        }
        process.exit(result.status === 'dry_run' ? 0 : 1);
      }

      if (parsed.nonInteractive && parsed.manifest === null) {
        console.error('Error: --non-interactive requires --approved-manifest <path>');
        process.exit(10);
      }

      const { runRecipeSupervisor } = await import('./recipe-supervisor.js');
      const result = await runRecipeSupervisor({
        specifier: parsed.recipeId,
        inputs: parsed.inputs,
        allowUnverified: parsed.allowUnverified || false,
        cwd: process.cwd(),
        envAllow: parsed.envAllow,
        manifestPath: parsed.manifest || null,
        nonInteractive: parsed.nonInteractive,
        jsonOutput: parsed.json || parsed.jsonStream,
        trustClass: parsed.trust,
        progressSink: parsed.jsonStream ? (event) => process.stdout.write(`${JSON.stringify(event)}\n`) : null,
      });

      if (parsed.json || parsed.jsonStream) {
        console.log(JSON.stringify(result, null, 2));
      }
      const exitCode = STATUS_EXIT_CODES[result.status] ?? 1;
      process.exit(exitCode);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  // --- run --template ------------------------------------------------------

  if (parsed.subcommand === 'run' && parsed.template !== null) {
    if (parsed.nonInteractive && parsed.manifest === null) {
      console.error('Error: --non-interactive requires --approved-manifest <path>');
      process.exit(10);
    }

    const { runTemplateSupervisor } = await import('./template-supervisor.js');

    const result = await runTemplateSupervisor({
      templatePath: parsed.template,
      inputs: parsed.inputs,
      manifestPath: parsed.manifest || null,
      nonInteractive: parsed.nonInteractive,
      jsonOutput: parsed.json || parsed.jsonStream,
      envAllow: parsed.envAllow,
      progressSink: parsed.jsonStream ? (event) => process.stdout.write(`${JSON.stringify(event)}\n`) : null,
    });

    if (parsed.json || parsed.jsonStream) {
      console.log(JSON.stringify(result, null, 2));
    }

    const exitCode = STATUS_EXIT_CODES[result.status] ?? 1;
    process.exit(exitCode);
  }

  // --- run -----------------------------------------------------------------

  // Validate --non-interactive requires --approved-manifest
  if (parsed.nonInteractive && parsed.manifest === null) {
    console.error(
      'Error: --non-interactive requires --approved-manifest <path>'
    );
    process.exit(10);
  }

  const options = {
    manifestPath: parsed.manifest ?? DEFAULT_MANIFEST_PATH,
    nonInteractive: parsed.nonInteractive,
    jsonOutput: parsed.json || parsed.jsonStream,
    trustClass: parsed.trust,
    validator: parsed.validator,
    updateSource: parsed.updateSource,
    cwd: process.cwd(),
    progressSink: parsed.jsonStream ? (event) => process.stdout.write(`${JSON.stringify(event)}\n`) : null,
  };

  if (parsed.shell !== null) {
    options.shell = parsed.shell;
    options.command = parsed.shell;
    options.args = [];
  } else {
    options.command = parsed.command;
    options.args = parsed.args;
  }

  const result = await runSupervisor(options);

  if (parsed.json || parsed.jsonStream) {
    console.log(JSON.stringify(result, null, 2));
  }

  const exitCode = STATUS_EXIT_CODES[result.status] ?? 1;
  process.exit(exitCode);
}

// Only run main() when executed directly (not when imported for testing)
import { resolve as _resolvePath } from 'node:path';
import { fileURLToPath as _fileURLToPath } from 'node:url';
const _thisFile = _fileURLToPath(import.meta.url);
const _entryFile = process.argv[1] ? _resolvePath(process.argv[1]) : '';
if (_thisFile === _entryFile) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}

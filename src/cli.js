#!/usr/bin/env node

import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
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

function defaultLaneKeyPath(laneId, guardrailRepo = '.') {
  let repoPath = resolve(process.cwd(), guardrailRepo);
  try {
    repoPath = realpathSync(repoPath);
  } catch {}
  const repoId = createHash('sha256')
    .update(repoPath)
    .digest('hex')
    .slice(0, 16);
  return resolve(repoPath, '.guardrail', 'host-lanes', repoId, `${laneId}.key`);
}

function defaultLaneHostStateDir(guardrailRepo = '.') {
  let repoPath = resolve(process.cwd(), guardrailRepo);
  try {
    repoPath = realpathSync(repoPath);
  } catch {}
  return resolve(repoPath, '.guardrail', 'host-lanes');
}

function normalizeLaneCliOptions(raw = {}) {
  const laneId = raw.id || raw.laneId || '';
  const laneDir = raw.laneDir || (laneId ? defaultLaneDir(laneId) : '');
  const guardrailRepo = raw.guardrailRepo || '.';
  const keyPath = raw.keyPath || (laneId ? defaultLaneKeyPath(laneId, guardrailRepo) : '');
  const hostStateDir = raw.hostStateDir || defaultLaneHostStateDir(guardrailRepo);
  const promptFiles = Array.isArray(raw.promptFiles)
    ? raw.promptFiles
    : (typeof raw.promptFiles === 'string' && raw.promptFiles.trim() ? [raw.promptFiles] : []);
  return {
    ...raw,
    laneId,
    laneDir,
    keyPath,
    tool: raw.tool || 'claude',
    sessionName: raw.sessionName || laneId || '',
    guardrailRepo,
    workingDir: raw.workingDir || '.',
    scopeType: raw.scopeType || 'none',
    scopeMode: raw.scopeMode || 'warn',
    scopePaths: raw.scopePaths || [],
    resourceMode: raw.resourceMode || raw.scopeMode || 'warn',
    resources: raw.resources || [],
    promptFiles,
    hostStateDir,
  };
}

function derivePromptFileReportArtifact(promptText = '') {
  if (typeof promptText !== 'string' || !promptText.trim()) return '';
  const match = promptText.match(/Declared report artifact:\s*\n-\s*`([^`]+)`/m);
  return match ? match[1].trim() : '';
}

function formatLaneScope(status = {}) {
  const scopeType = status.scopeType || 'none';
  if (scopeType === 'none') return 'none';
  const paths = Array.isArray(status.scopePaths) ? status.scopePaths : [];
  const details = paths.length > 0 ? ` ${paths.join(', ')}` : '';
  return `${scopeType}/${status.scopeMode || 'warn'}${details}`;
}

function formatLaneResources(status = {}) {
  const details = Array.isArray(status.resourceDetails) ? status.resourceDetails : [];
  if (details.length > 0) {
    return `${status.resourceMode || 'warn'} ${details.map((detail) => `${detail.raw}${detail.source === 'discovered' ? ' [auto]' : ''}`).join(', ')}`;
  }
  const resources = Array.isArray(status.resources) ? status.resources : [];
  if (resources.length === 0) return 'none';
  return `${status.resourceMode || 'warn'} ${resources.join(', ')}`;
}

function formatLaneTransportSummary(status = {}) {
  const summary = status.transportSummary;
  if (!summary || typeof summary !== 'object') return 'n/a';
  const entries = Object.entries(summary)
    .filter(([, value]) => value !== null && value !== undefined && value !== '' && (!Array.isArray(value) || value.length > 0))
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : value}`);
  return entries.length > 0 ? entries.join(' ') : 'n/a';
}

function buildLaneRefArg(status = {}) {
  if (status.laneId) return `--id ${status.laneId}`;
  if (status.laneDir) return `--lane-dir ${status.laneDir}`;
  return '';
}

function buildLaneRecommendedCommand(status = {}) {
  const ref = buildLaneRefArg(status);
  const toolSuffix = status.tool && status.tool !== 'claude' ? ` --tool ${status.tool}` : '';
  switch (status.recommendedAction) {
    case 'start':
      return ref ? `guardrail lane start ${ref}${toolSuffix}` : 'guardrail lane start --id <lane-id>';
    case 'send':
      return ref ? `guardrail lane send ${ref} --prompt "<message>"` : 'guardrail lane send --id <lane-id> --prompt "<message>"';
    case 'result':
      if (status.currentRequestId) return `guardrail lane wait ${ref} --request-id ${status.currentRequestId}`;
      if (status.lastRequestId) return `guardrail lane result ${ref} --request-id ${status.lastRequestId}`;
      return `guardrail lane result ${ref}`;
    case 'cleanup':
      return `guardrail lane cleanup ${ref}`;
    default:
      return null;
  }
}

function readAiProgressSnapshot(stateDir) {
  const resolvedStateDir = resolve(stateDir);
  const stateFile = resolve(resolvedStateDir, 'ai-progress-state.json');
  const progressFile = resolve(resolvedStateDir, 'ai-progress.ndjson');

  let state = null;
  if (existsSync(stateFile)) {
    try {
      state = JSON.parse(readFileSync(stateFile, 'utf8'));
    } catch {
      state = null;
    }
  }

  let events = [];
  if (existsSync(progressFile)) {
    events = readFileSync(progressFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  return {
    stateDir: resolvedStateDir,
    state,
    events,
  };
}

function resolveRecipeProgressStateDir(rawStateDir, runId) {
  if (rawStateDir) return resolve(rawStateDir);
  if (!runId) return '';

  const candidate = resolve(process.cwd(), '.guardrail');
  const snapshot = readAiProgressSnapshot(candidate);
  if (snapshot.state?.runId === runId) return candidate;
  return '';
}

function isTerminalAiProgressState(status) {
  return status === 'completed' || status === 'failed';
}

function printRecipeProgressText(snapshot, startIndex = 0, options = {}) {
  const { state, events } = snapshot;
  const { includeHeader = true } = options;

  if (includeHeader && state) {
    console.log(`Status:  ${state.status ?? 'unknown'}`);
    console.log(`Run ID:  ${state.runId ?? 'unknown'}`);
    if (state.lastPhase) console.log(`Phase:   ${state.lastPhase}`);
    if (state.sessionName) console.log(`Session: ${state.sessionName}`);
    if (state.lastMessage) console.log(`Last:    ${state.lastMessage}`);
    if (state.continuationCommand) {
      console.log('');
      console.log(`To continue: ${state.continuationCommand}`);
    }
  }

  const nextEvents = events.slice(startIndex);
  if ((includeHeader && events.length > 0) || nextEvents.length > 0) {
    if (includeHeader) {
      console.log('');
      console.log(`Checkpoints (${events.length}):`);
    }
    for (const evt of nextEvents) {
      const ts = evt.timestamp ? String(evt.timestamp).slice(0, 19) : '';
      const phase = evt.phase ? ` phase=${evt.phase}` : '';
      const msg = evt.message ? ` ${evt.message}` : '';
      console.log(`  [${ts}] ${evt.event ?? 'unknown'}${phase}${msg}`);
    }
  }
}

function laneHasSelectionFilter(laneOpts = {}) {
  return Boolean(
    laneOpts.all === true
    || laneOpts.laneId
    || laneOpts.laneDir
    || laneOpts.filterLaneId
    || laneOpts.filterSessionName
    || laneOpts.status
    || laneOpts.toolFilter
    || laneOpts.scopeTypeFilter
    || laneOpts.scopeModeFilter
    || laneOpts.resourceFilter
    || laneOpts.repoFilter
    || laneOpts.alive !== undefined
    || laneOpts.hasConflicts !== undefined
  );
}

function buildLaneInspectBundle(laneOpts, status, getResidentLaneResult, getResidentLaneLogs, getResidentLaneHistory) {
  const requestId = status.currentRequestId || status.lastCompletedRequestId || status.lastRequestId || null;
  return {
    status: {
      ...status,
      recommendedCommand: buildLaneRecommendedCommand(status),
    },
    latestResult: getResidentLaneResult({
      ...laneOpts,
      requestId: laneOpts.requestId || requestId || undefined,
    }),
    logs: getResidentLaneLogs({
      ...laneOpts,
      tail: laneOpts.tail || 40,
    }),
    history: buildLaneHistoryBundle(getResidentLaneHistory({
      ...laneOpts,
      limit: laneOpts.limit || 10,
      requestId: laneOpts.requestId || requestId || undefined,
    })),
  };
}

function buildLaneHistoryBundle(history) {
  return {
    ...history,
    entries: history.entries.map((entry) => ({
      timestamp: entry.timestamp,
      event: entry.event,
      lane_id: entry.lane_id || null,
      lane_dir: entry.lane_dir || null,
      request_id: entry.request_id || null,
      session_name: entry.session_name || null,
      tool: entry.tool || null,
      status: entry.status || null,
      reason: entry.reason || null,
      exit_code: entry.exit_code ?? null,
    })),
  };
}

function lanePortfolioAuditPath(laneOpts = {}) {
  return resolve(laneOpts.hostStateDir || resolve(homedir(), '.guardrail'), 'resident-lane-portfolio.jsonl');
}

function buildLanePortfolioBundle(timeline) {
  return {
    ...timeline,
    entries: timeline.entries.map((entry) => ({
      timestamp: entry.timestamp,
      source: entry.source || null,
      event: entry.event,
      lane_id: entry.lane_id || null,
      lane_dir: entry.lane_dir || null,
      guardrail_repo: entry.guardrail_repo || null,
      request_id: entry.request_id || null,
      session_name: entry.session_name || null,
      tool: entry.tool || null,
      status: entry.status || null,
      reason: entry.reason || entry.prune_reason || null,
      failure_stage: entry.failure_stage || null,
      scope_conflict_count: entry.scope_conflict_count ?? null,
      resource_conflict_count: entry.resource_conflict_count ?? null,
      tombstone_path: entry.tombstone_path || null,
    })),
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
  } catch (err) {
    if (err?.code === 'EPERM') {
      return true;
    }
    return false;
  }
}

function isLaneExpiredError(err) {
  return err?.code === 'ENOENT'
    || err?.code === 'ENXIO'
    || err?.code === 'EPIPE';
}

function buildLaneExpiredResponse() {
  return {
    status: 'error',
    reason: 'lane_expired',
    message: 'The resident lane has idled out. Run `guardrail lane start` to initialize a new session.',
    ok: false,
    exitCode: 1,
  };
}

function buildLaneFailedResponse(status) {
  return {
    status: 'error',
    reason: 'lane_failed',
    message: 'The resident lane failed before it could process a request.',
    failureReason: status.failureReason || null,
    failureStage: status.failureStage || null,
    logPath: status.logPath || null,
    ok: false,
    exitCode: 1,
  };
}

function buildLaneStartFailureResponse(err) {
  const details = err?.details || {};
  return {
    status: 'error',
    reason: err?.code === 'LANE_BOOT_FAILED' ? 'lane_boot_failed' : 'lane_start_failed',
    message: err?.message || 'Resident lane failed to start.',
    failureReason: details.failureReason || err?.message || null,
    failureStage: details.failureStage || null,
    statePath: details.statePath || null,
    logPath: details.logPath || null,
    pid: details.pid ?? null,
    scopeConflicts: Array.isArray(details.scopeConflicts) ? details.scopeConflicts : [],
    resourceConflicts: Array.isArray(details.resourceConflicts) ? details.resourceConflicts : [],
  };
}

async function appendLaneAuditEntry(laneOpts, event, details = {}) {
  try {
    const { createAuditLog } = await import('./audit.js');
    const guardrailRepo = resolve(laneOpts.guardrailRepo || '.');
    const entry = {
      event,
      trace_id: `lane:${laneOpts.laneId || laneOpts.sessionName || 'resident'}`,
      guardrail_repo: guardrailRepo,
      lane_id: laneOpts.laneId || null,
      lane_dir: laneOpts.laneDir || null,
      tool: laneOpts.tool || 'claude',
      session_name: laneOpts.sessionName || null,
      session_id: laneOpts.sessionId || null,
      ...details,
    };
    const auditLog = createAuditLog(resolve(guardrailRepo, '.guardrail', 'audit.jsonl'));
    auditLog.append(entry);
    createAuditLog(lanePortfolioAuditPath(laneOpts)).append(entry);
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
  lane run-sequence [flags]             Supervise prompt files sequentially through one resident lane
  lane chat [flags]                     Send one message and wait like a guarded chat turn
  lane result [flags]                   Read the latest or named resident lane result
  lane wait [flags]                     Wait for a resident lane request to complete
  lane status [flags]                   Show resident lane status and recovery hints
  lane inspect [flags]                  Show status, latest result, and bounded logs together
  lane history [flags]                  Query resident-lane audit history
  lane portfolio [flags]                Query the portfolio-wide resident-lane timeline
  lane logs [flags]                     Read the bounded resident lane log tail
  lane stop [flags]                     Stop a resident interactive lane
  lane extend [flags]                   Extend a live lane: --idle-timeout-ms, --health-timeout-ms, --heartbeat
  lane cleanup [flags]                  Remove one resident lane's local artifacts
  lane batch [flags]                    Preview or apply stop/cleanup actions across filtered lanes
  lane list [flags]                     List resident lanes in this Guardrail repo
  lane prune [flags]                    Classify and optionally remove dead resident-lane artifacts
  lane adapters                         List bundled resident lane adapters
  repo status [--path <repo>]          Show tracked and untracked repo changes
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
  recipe compose --transport <id> --exec <id> --output <path>   Generate a composed recipe artifact
  recipe inspect <packed.json>          Inspect a packaged recipe (verify hash)
  recipe install <path|url|github://>   Install a recipe to local registry
                                        or install <category/id@version> --registry <root>
  recipe registry export <output-dir>   Export a static self-hosted recipe registry snapshot
  recipe registry list <registry>       Inspect a self-hosted recipe registry snapshot
  recipe versions <id>                  List installed versions of a recipe
  recipe publish --name <n> --category <c> [--manifest <path>] [--description <d>] [--dry-run]
  adapter run --tool <name> -- <cmd>    Run a command through an adapter profile
  adapter probe --tool <name>           Probe an MCP stdio profile for discovery only
  adapter mcp tools --tool <name>       List MCP tools for a stdio profile under Guardrail
  adapter mcp call --tool <name>        Perform one bounded MCP tools/call over stdio
  adapter mcp batch --tool <name>       Perform a bounded ordered MCP tools/call batch over stdio
  adapter shim --tool <n> --commands <c>  Create PATH shims for adapter interception
  adapter profile install <source>      Install an adapter profile (path/url/github:// or bare name with --index/--index-key)
  adapter profile discover [tool]       Discover tools from trusted signed adapter indexes
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
  guardrail lane start --id codex-live --tool codex
  guardrail lane start --id lint-live --tool local-exec --command node --arg scripts/lint-worker.js
  guardrail lane start --id wrapper-live --tool prompt-wrapper --wrapper-command ./scripts/my-wrapper.js --wrapper-arg mode=review
  guardrail lane send --id claude-live --prompt "2x3=?"
  guardrail lane run-sequence --id claude-live --prompt-file docs/references/p1.md --prompt-file docs/references/p2.md
  guardrail lane run-sequence --id claude-live --prompt-file docs/references/p1.md --stop-when-done
  guardrail lane chat --id claude-live --prompt "hello"
  guardrail lane result --id claude-live
  guardrail lane wait --id claude-live --request-id req-123
  guardrail lane result --id claude-live --request-id req-123
  guardrail lane inspect --id claude-live --tail 60
  guardrail lane history --id claude-live --limit 20
  guardrail lane portfolio --all-repos --limit 30 --json
  guardrail lane logs --id claude-live --tail 60
  guardrail lane stop --id claude-live
  guardrail lane cleanup --id claude-live
  guardrail lane batch --action cleanup --status failed --dry-run --json
  guardrail lane list --json
  guardrail lane list --all-repos --resource-filter git-branch:main --json
  guardrail lane prune --json
  guardrail lane prune --include-failed --dry-run --json
  guardrail repo status --path .
  guardrail adapter mcp tools --tool cline
  guardrail adapter mcp batch --tool cline --calls-json '[{"tool":"echo","params":{"text":"hi"}}]'
  guardrail template lint --template ./templates/npm-publish.json
  guardrail template create --from-manifest .guardrail/approved.json --name npm-publish
  guardrail template list --json
  guardrail template explain --template ./templates/npm-publish.json
  guardrail template simulate --template ./templates/npm-publish.json --input package_dir=packages/my-lib
  guardrail recipe compose --transport cmux-claude-exec --exec claude-exec --output .guardrail/recipes/cmux-direct.recipe.json
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

  if (sub !== 'run' && sub !== 'demo' && sub !== 'pack' && sub !== 'recipe' && sub !== 'audit' && sub !== 'list' && sub !== 'create' && sub !== 'profile' && sub !== 'policy' && sub !== 'metrics' && sub !== 'approve' && sub !== 'export' && sub !== 'marketplace' && sub !== 'verify' && sub !== 'adapter' && sub !== 'lane' && sub !== 'repo' && sub !== 'session') {
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

  // --- session subcommand ---------------------------------------------------

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

  // --- repo subcommand ------------------------------------------------------

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

    // D0y: recipe progress and recipe continue
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
      if (!result.stateDir) return { error: 'usage' };
      if (!result.prompt) return { error: 'usage' };
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
    const { assertValidResidentLaneTool, launchResidentLane, normalizeResidentLaneOptions: validateResidentLaneOptions } = await import('./resident-lane.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    if (!laneOpts.laneId && !laneOpts.laneDir) {
      console.error('Error: --id <lane-id> or --lane-dir <path> is required for lane start');
      process.exit(1);
    }
    if (!laneOpts.sessionName) {
      console.error('Error: --session-name <name> or --id <lane-id> is required for lane start');
      process.exit(1);
    }
    try {
      assertValidResidentLaneTool(laneOpts);
      validateResidentLaneOptions(laneOpts, resolve(laneOpts.guardrailRepo || '.'));
    } catch (err) {
      console.error(err.message);
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
      try {
        summary = await launchResidentLane({
          ...laneOpts,
          authFd: keyFd ?? '',
        });
      } catch (err) {
        const failure = buildLaneStartFailureResponse(err);
        await appendLaneAuditEntry(laneOpts, 'lane_start', {
          status: 'error',
          reason: failure.reason,
          pid: failure.pid,
          failure_stage: failure.failureStage,
        });
        if (parsed.json) {
          console.log(JSON.stringify(failure, null, 2));
        } else {
          console.error(failure.message);
          if (failure.failureStage) console.error(`Failure stage: ${failure.failureStage}`);
          if (failure.logPath) console.error(`Log path: ${failure.logPath}`);
          if (failure.statePath) console.error(`State path: ${failure.statePath}`);
          if (failure.scopeConflicts.length > 0) {
            console.error('Scope conflicts:');
            for (const conflict of failure.scopeConflicts) {
              console.error(`  ${conflict.laneId || conflict.laneDir} (${conflict.enforcement})`);
            }
          }
          if (failure.resourceConflicts.length > 0) {
            console.error('Resource conflicts:');
            for (const conflict of failure.resourceConflicts) {
              console.error(`  ${conflict.laneId || conflict.laneDir} (${conflict.enforcement})`);
            }
          }
        }
        process.exit(1);
      }
    } finally {
      if (keyFd !== null) closeSync(keyFd);
    }
      await appendLaneAuditEntry(laneOpts, 'lane_start', {
        reused: !!summary.reused,
        pid: summary.pid ?? null,
        auth_mode: summary.authMode ?? 'none',
        scope_type: summary.scopeType ?? 'none',
        scope_mode: summary.scopeMode ?? 'warn',
        scope_conflict_count: Array.isArray(summary.scopeConflicts) ? summary.scopeConflicts.length : 0,
        resource_mode: summary.resourceMode ?? 'warn',
        resource_count: Array.isArray(summary.resources) ? summary.resources.length : 0,
        resource_conflict_count: Array.isArray(summary.resourceConflicts) ? summary.resourceConflicts.length : 0,
        status: 'success',
      });
    if (parsed.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`Lane started: ${summary.sessionName}`);
      if (laneOpts.laneId) console.log(`  Lane id:       ${laneOpts.laneId}`);
      console.log(`  Tool:          ${summary.tool || summary.adapterId || laneOpts.tool || 'claude'}`);
      console.log(`  Transport:     ${formatLaneTransportSummary(summary)}`);
      console.log(`  Scope:         ${formatLaneScope(summary)}`);
      console.log(`  Resources:     ${formatLaneResources(summary)}`);
      console.log(`  Lane dir:      ${summary.laneDir}`);
      if (summary.keyPath) console.log(`  Key path:      ${summary.keyPath}`);
      console.log(`  Request FIFO:  ${summary.requestFifo}`);
      console.log(`  Response FIFO: ${summary.responseFifo}`);
      console.log(`  State path:    ${summary.statePath}`);
      console.log(`  PID:           ${summary.pid}`);
      if (summary.logPath) console.log(`  Log path:      ${summary.logPath}`);
      if (summary.reused) {
        console.log('  Reused:        yes');
      }
      if (Array.isArray(summary.scopeConflicts) && summary.scopeConflicts.length > 0) {
        console.log('  Scope conflicts:');
        for (const conflict of summary.scopeConflicts) {
          console.log(`    ${conflict.laneId || conflict.laneDir} (${conflict.enforcement})`);
        }
      }
      if (Array.isArray(summary.resourceConflicts) && summary.resourceConflicts.length > 0) {
        console.log('  Resource conflicts:');
        for (const conflict of summary.resourceConflicts) {
          console.log(`    ${conflict.laneId || conflict.laneDir} (${conflict.enforcement})`);
        }
      }
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'lane-send' || parsed.subcommand === 'lane-chat') {
    const { sendResidentLaneMessage } = await import('./resident-lane-client.js');
    const {
      assertValidResidentLaneTool,
      getResidentLaneResult,
      getResidentLaneStatus,
      waitForResidentLaneResult,
    } = await import('./resident-lane.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    const chatMode = parsed.subcommand === 'lane-chat';
    if (!laneOpts.laneId && !laneOpts.laneDir) {
      console.error(`Error: --id <lane-id> or --lane-dir <path> is required for lane ${chatMode ? 'chat' : 'send'}`);
      process.exit(1);
    }
    if (!laneOpts.prompt) {
      console.error(`Error: --prompt <text> is required for lane ${chatMode ? 'chat' : 'send'}`);
      process.exit(1);
    }
    try {
      assertValidResidentLaneTool(laneOpts);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    const preflightStatus = getResidentLaneStatus(laneOpts);
    if (preflightStatus.status === 'failed') {
      const failed = buildLaneFailedResponse(preflightStatus);
      await appendLaneAuditEntry(laneOpts, 'lane_send', {
        request_id: laneOpts.requestId || null,
        status: 'error',
        reason: failed.reason,
      });
      if (parsed.json) {
        console.log(JSON.stringify(failed, null, 2));
      } else {
        console.error(failed.message);
        if (failed.failureReason) console.error(`Failure reason: ${failed.failureReason}`);
        if (failed.failureStage) console.error(`Failure stage: ${failed.failureStage}`);
        if (failed.logPath) console.error(`Log path: ${failed.logPath}`);
      }
      process.exit(1);
    }
    if (laneOpts.keyPath && !existsSync(laneOpts.keyPath)) {
      const expired = buildLaneExpiredResponse();
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
        ...(laneOpts.reportArtifact ? ['--report-artifact', laneOpts.reportArtifact] : []),
        ...(laneOpts.completionMode ? ['--completion-mode', laneOpts.completionMode] : []),
        '--timeout-ms', laneOpts.timeoutMs || '30000',
        ...(keyFd !== null ? ['--auth-fd', String(keyFd)] : []),
      ]);
    } catch (err) {
      if (err?.code === 'LANE_TIMEOUT') {
        const status = getResidentLaneStatus(laneOpts);
        const result = getResidentLaneResult({ ...laneOpts, requestId });
        if (result.status === 'completed') {
          response = result.result;
        } else if (!status.alive && status.status !== 'busy') {
          response = buildLaneExpiredResponse();
        } else {
          response = {
            status: 'pending',
            reason: 'request_still_running',
            message: 'Resident lane request is still running. Use `guardrail lane wait` or `guardrail lane inspect` instead of restarting it.',
            requestId,
            currentRequestId: status.currentRequestId,
            currentRequestStartedAt: status.currentRequestStartedAt,
            lastActivityAt: status.lastActivityAt,
            resultPath: result.resultPath,
            ok: false,
            exitCode: 0,
          };
        }
      } else if (isLaneExpiredError(err)) {
        response = buildLaneExpiredResponse();
      } else {
        throw err;
      }
    } finally {
      if (keyFd !== null) closeSync(keyFd);
    }

    if (response?.status === 'pending' && (chatMode || laneOpts.wait === true || laneOpts.wait === 'true')) {
      response = await waitForResidentLaneResult({
        ...laneOpts,
        requestId,
      });
    }

    await appendLaneAuditEntry(laneOpts, chatMode ? 'lane_chat' : 'lane_send', {
      request_id: requestId,
      status: response.status === 'pending'
        ? 'pending'
        : ((response.ok || response.status === 'completed') ? 'success' : 'error'),
      reason: response.reason || response.error || null,
      exit_code: response.exitCode ?? null,
    });

    if (parsed.json) {
      console.log(JSON.stringify(response, null, 2));
    } else if (response.ok || response.status === 'completed') {
      const stdout = response.stdout ?? response.result?.stdout ?? '';
      process.stdout.write(stdout);
      const completedRequestId = response.requestId ?? response.result?.requestId ?? requestId;
      const completedResultPath = response.resultPath ?? null;
      if (completedRequestId) console.log(`Request id: ${completedRequestId}`);
      if (completedResultPath) console.log(`Result path: ${completedResultPath}`);
    } else if (response.status === 'pending') {
      console.log(response.message);
      if (response.requestId) console.log(`Request id: ${response.requestId}`);
      if (response.resultPath) console.log(`Result path: ${response.resultPath}`);
      console.log(`Next command: ${buildLaneRecommendedCommand({
        ...laneOpts,
        recommendedAction: 'result',
        currentRequestId: response.requestId,
        lastRequestId: response.requestId,
      })}`);
    } else {
      console.error(response.error || response.stderr || 'Resident lane request failed');
    }

    process.exit(response.ok || response.status === 'pending' || response.status === 'completed' ? 0 : (response.exitCode || 1));
  }

  if (parsed.subcommand === 'lane-run-sequence') {
    const { sendResidentLaneMessage } = await import('./resident-lane-client.js');
    const {
      assertValidResidentLaneTool,
      getResidentLaneResult,
      getResidentLaneStatus,
      stopResidentLane,
      waitForResidentLaneResult,
    } = await import('./resident-lane.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    const promptFiles = Array.isArray(laneOpts.promptFiles) ? laneOpts.promptFiles : [];
    if (!laneOpts.laneId && !laneOpts.laneDir) {
      console.error('Error: --id <lane-id> or --lane-dir <path> is required for lane run-sequence');
      process.exit(1);
    }
    if (promptFiles.length === 0) {
      console.error('Error: lane run-sequence requires at least one --prompt-file <path>');
      process.exit(1);
    }
    try {
      assertValidResidentLaneTool(laneOpts);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    const outputs = [];
    const waitForSequenceStep = async (requestId) => {
      for (;;) {
        const waited = await waitForResidentLaneResult({
          ...laneOpts,
          requestId,
          timeoutMs: laneOpts.timeoutMs || '5000',
        });
        if (waited.status !== 'pending') return waited;
      }
    };
    for (let index = 0; index < promptFiles.length; index += 1) {
      const promptFile = resolve(promptFiles[index]);
      const prompt = readFileSync(promptFile, 'utf8');
      const reportArtifact = derivePromptFileReportArtifact(prompt);
      const completionMode = reportArtifact ? 'artifact' : 'direct';
      const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const preflightStatus = getResidentLaneStatus(laneOpts);
      if (preflightStatus.status === 'failed') {
        const failed = buildLaneFailedResponse(preflightStatus);
        await appendLaneAuditEntry(laneOpts, 'lane_run_sequence', {
          request_id: requestId,
          status: 'error',
          reason: failed.reason,
          step_index: index,
          prompt_file: promptFile,
        });
        if (parsed.json) {
          process.stdout.write(`${JSON.stringify({ ok: false, step: index, promptFile, error: failed }, null, 2)}\n`);
        } else {
          console.error(`Lane sequence failed before step ${index + 1}: ${failed.reason}`);
        }
        process.exit(1);
      }
      if (laneOpts.keyPath && !existsSync(laneOpts.keyPath)) {
        const expired = buildLaneExpiredResponse();
        await appendLaneAuditEntry(laneOpts, 'lane_run_sequence', {
          request_id: requestId,
          status: 'error',
          reason: expired.reason,
          step_index: index,
          prompt_file: promptFile,
        });
        if (parsed.json) {
          process.stdout.write(`${JSON.stringify({ ok: false, step: index, promptFile, error: expired }, null, 2)}\n`);
        } else {
          console.error(`Lane sequence expired before step ${index + 1}`);
        }
        process.exit(1);
      }

      const keyFd = laneOpts.keyPath ? openSync(laneOpts.keyPath, 'r') : null;
      let response;
      try {
        response = await sendResidentLaneMessage([
          '--lane-dir', laneOpts.laneDir,
          '--request-id', requestId,
          '--prompt', prompt,
          ...(reportArtifact ? ['--report-artifact', reportArtifact] : []),
          '--completion-mode', completionMode,
          '--timeout-ms', laneOpts.timeoutMs || '30000',
          ...(keyFd !== null ? ['--auth-fd', String(keyFd)] : []),
        ]);
      } catch (err) {
        if (err?.code === 'LANE_TIMEOUT') {
          const status = getResidentLaneStatus(laneOpts);
          const result = getResidentLaneResult({ ...laneOpts, requestId });
          if (result.status === 'completed') {
            response = result.result;
          } else if (!status.alive && status.status !== 'busy' && status.status !== 'stalled') {
            response = buildLaneExpiredResponse();
          } else {
            response = {
              ok: false,
              status: 'pending',
              requestId,
              resultPath: result.resultPath || null,
            };
          }
        } else {
          throw err;
        }
      } finally {
        if (keyFd !== null) closeSync(keyFd);
      }

      if (response?.status === 'pending') {
        response = await waitForSequenceStep(requestId);
      }

      await appendLaneAuditEntry(laneOpts, 'lane_run_sequence', {
        request_id: requestId,
        status: (response.ok || response.status === 'completed') ? 'success' : 'error',
        reason: response.reason || response.error || null,
        exit_code: response.exitCode ?? null,
        step_index: index,
        prompt_file: promptFile,
      });

      if (!(response.ok || response.status === 'completed')) {
        const failurePayload = {
          ok: false,
          step: index,
          promptFile,
          requestId,
          response,
          outputs,
        };
        if (parsed.json) {
          process.stdout.write(`${JSON.stringify(failurePayload, null, 2)}\n`);
        } else {
          console.error(`Lane sequence failed at step ${index + 1}: ${promptFile}`);
          if (response.reason) console.error(`Reason: ${response.reason}`);
        }
        process.exit(response.exitCode || 1);
      }

      outputs.push({
        step: index,
        promptFile,
        requestId: response.requestId ?? response.result?.requestId ?? requestId,
        stdout: response.stdout ?? response.result?.stdout ?? '',
        resultPath: response.resultPath ?? response.result?.resultPath ?? null,
      });
    }

    const payload = { ok: true, count: outputs.length, outputs };
    if (laneOpts.stopWhenDone === true || laneOpts.stopWhenDone === 'true') {
      const stopped = stopResidentLane(laneOpts);
      payload.stoppedLane = true;
      payload.stop = stopped;
    }
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      for (const output of outputs) {
        process.stdout.write(output.stdout || '');
        if (output.requestId) console.log(`Request id: ${output.requestId}`);
        if (output.resultPath) console.log(`Result path: ${output.resultPath}`);
      }
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'lane-result') {
    const { getResidentLaneResult } = await import('./resident-lane.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    if (!laneOpts.laneId && !laneOpts.laneDir) {
      console.error('Error: --id <lane-id> or --lane-dir <path> is required for lane result');
      process.exit(1);
    }
    const result = getResidentLaneResult(laneOpts);
    await appendLaneAuditEntry(laneOpts, 'lane_result', {
      request_id: result.requestId || null,
      status: result.status,
      reason: result.reason || null,
    });
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.status === 'completed') {
      process.stdout.write(result.result?.stdout || '');
      if (result.requestId) console.log(`Request id: ${result.requestId}`);
      if (result.resultPath) console.log(`Result path: ${result.resultPath}`);
    } else {
      console.log(result.message);
      if (result.requestId) console.log(`Request id: ${result.requestId}`);
      if (result.resultPath) console.log(`Result path: ${result.resultPath}`);
    }
    process.exit(result.status === 'missing' ? 1 : 0);
  }

  if (parsed.subcommand === 'lane-wait') {
    const { waitForResidentLaneResult } = await import('./resident-lane.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    if (!laneOpts.laneId && !laneOpts.laneDir) {
      console.error('Error: --id <lane-id> or --lane-dir <path> is required for lane wait');
      process.exit(1);
    }
    const result = await waitForResidentLaneResult(laneOpts);
    await appendLaneAuditEntry(laneOpts, 'lane_wait', {
      request_id: result.requestId || null,
      status: result.status,
      reason: result.reason || null,
    });
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.status === 'completed') {
      process.stdout.write(result.result?.stdout || '');
      if (result.requestId) console.log(`Request id: ${result.requestId}`);
      if (result.resultPath) console.log(`Result path: ${result.resultPath}`);
    } else {
      console.log(result.message);
      if (result.requestId) console.log(`Request id: ${result.requestId}`);
      if (result.resultPath) console.log(`Result path: ${result.resultPath}`);
      if (result.failureReason) console.log(`Failure reason: ${result.failureReason}`);
      if (result.failureStage) console.log(`Failure stage: ${result.failureStage}`);
      if (result.logPath) console.log(`Log path: ${result.logPath}`);
    }
    process.exit(result.status === 'completed' ? 0 : (result.status === 'pending' ? 0 : 1));
  }

  if (parsed.subcommand === 'lane-stop') {
    const { stopResidentLane } = await import('./resident-lane.js');
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

  if (parsed.subcommand === 'lane-revoke') {
    const { revokeResidentLane } = await import('./resident-lane.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    if (!laneOpts.laneId && !laneOpts.laneDir) {
      console.error('Error: --id <lane-id> or --lane-dir <path> is required for lane revoke');
      process.exit(1);
    }
    const result = revokeResidentLane(laneOpts);
    await appendLaneAuditEntry(laneOpts, 'lane_revoked', {
      status: 'revoked',
      revoked: true,
      actor: laneOpts.actor || 'operator',
      reason: laneOpts.reason || null,
    });
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Lane revoked: ${laneOpts.laneId || laneOpts.laneDir}`);
      if (laneOpts.reason) console.log(`  Reason: ${laneOpts.reason}`);
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'lane-kill') {
    const { killResidentLane } = await import('./resident-lane.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    if (!laneOpts.laneId && !laneOpts.laneDir) {
      console.error('Error: --id <lane-id> or --lane-dir <path> is required for lane kill');
      process.exit(1);
    }
    const result = killResidentLane(laneOpts);
    await appendLaneAuditEntry(laneOpts, 'lane_emergency_stop', {
      status: 'killed',
      killed: true,
      revoked: true,
      actor: laneOpts.actor || 'operator',
      reason: laneOpts.reason || null,
    });
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Lane killed (break-glass): ${laneOpts.laneId || laneOpts.laneDir}`);
      if (laneOpts.reason) console.log(`  Reason: ${laneOpts.reason}`);
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'session-revoke') {
    const { defaultSessionContractPath, revokeSessionContract } = await import('./agent-session.js');
    const { createAuditLog } = await import('./audit.js');
    const sessionOpts = parsed.sessionOpts || {};
    if (!sessionOpts.recipe) {
      console.error('Error: --recipe <id> is required for session revoke');
      process.exit(1);
    }
    const guardrailRepo = resolve(sessionOpts.guardrailRepo || process.cwd());
    const stateDir = sessionOpts.stateDir
      ? resolve(guardrailRepo, sessionOpts.stateDir)
      : resolve(guardrailRepo, '.guardrail');
    const contractPath = defaultSessionContractPath(stateDir, sessionOpts.recipe, sessionOpts.sessionName || null);
    let revoked;
    try {
      revoked = revokeSessionContract(contractPath, {
        actor: sessionOpts.actor || 'operator',
        reason: sessionOpts.reason || '',
      });
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    const auditLog = createAuditLog(resolve(guardrailRepo, '.guardrail', 'audit.jsonl'));
    auditLog.append({
      event: 'session_revoked',
      trace_id: `session:${sessionOpts.recipe}:${sessionOpts.sessionName || 'default'}`,
      recipe: sessionOpts.recipe,
      session_name: sessionOpts.sessionName || null,
      actor: sessionOpts.actor || 'operator',
      reason: sessionOpts.reason || null,
      contract_path: contractPath,
    });
    if (parsed.json) {
      console.log(JSON.stringify({ revoked: true, contractPath, revokedAt: revoked.revokedAt }, null, 2));
    } else {
      console.log(`Session revoked: ${sessionOpts.recipe}/${sessionOpts.sessionName || 'default'}`);
      if (sessionOpts.reason) console.log(`  Reason: ${sessionOpts.reason}`);
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'lane-extend') {
    const { extendResidentLane, getResidentLaneStatus } = await import('./resident-lane-core.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    if (!laneOpts.laneId && !laneOpts.laneDir) {
      console.error('Error: --id <lane-id> or --lane-dir <path> is required for lane extend');
      process.exit(1);
    }
    const updates = {
      idleTimeoutMs: laneOpts.idleTimeoutMs,
      healthTimeoutMs: laneOpts.healthTimeoutMs,
      heartbeat: laneOpts.heartbeat === true,
    };
    let control;
    try {
      control = extendResidentLane(laneOpts.laneDir, updates);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    await appendLaneAuditEntry(laneOpts, 'lane_extend', {
      status: 'success',
      idle_timeout_ms: control.idleTimeoutMs ?? null,
      health_timeout_ms: control.healthTimeoutMs ?? null,
      heartbeat_at: control.heartbeatAt ?? null,
    });
    const status = getResidentLaneStatus(laneOpts);
    const payload = { laneId: laneOpts.laneId, laneDir: laneOpts.laneDir, control, status: status?.status || null };
    if (parsed.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Lane extended: ${laneOpts.laneId || laneOpts.laneDir}`);
      if (control.idleTimeoutMs != null) console.log(`  idleTimeoutMs:   ${control.idleTimeoutMs}`);
      if (control.healthTimeoutMs != null) console.log(`  healthTimeoutMs: ${control.healthTimeoutMs}`);
      if (control.heartbeatAt) console.log(`  heartbeatAt:     ${control.heartbeatAt}`);
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'lane-cleanup') {
    const { cleanupResidentLane } = await import('./resident-lane.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    if (!laneOpts.laneId && !laneOpts.laneDir && !laneOpts.filterLaneId && !laneOpts.filterSessionName) {
      console.error('Error: provide --id <lane-id>, --lane-dir <path>, or one narrowing lane filter for lane cleanup');
      process.exit(1);
    }
    const result = cleanupResidentLane(laneOpts);
    await appendLaneAuditEntry(laneOpts, 'lane_cleanup', {
      status: result.cleaned ? 'success' : 'error',
      reason: result.status,
      stopped_live_lane: !!result.stoppedLiveLane,
      cleaned_lane_dir: result.lane?.laneDir || null,
      cleanup_reason: result.lane?.cleanupReason || null,
      tombstone_path: result.lane?.tombstonePath || null,
    });
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.cleaned) {
      console.log(`Lane cleaned: ${result.lane.laneId || result.lane.laneDir}`);
      console.log(`  Status before cleanup: ${result.lane.status}`);
      console.log(`  Live before cleanup:   ${result.lane.aliveBeforeCleanup ? 'yes' : 'no'}`);
    } else {
      console.error(result.message);
      if (Array.isArray(result.matches) && result.matches.length > 0) {
        console.error('Matches:');
        for (const match of result.matches) {
          console.error(`  ${match.laneId || match.laneDir} (${match.status})`);
        }
      }
      process.exit(1);
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'lane-batch') {
    const { cleanupResidentLane, listResidentLanes, stopResidentLane } = await import('./resident-lane.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    const action = String(laneOpts.action || '').trim();
    if (!['stop', 'cleanup'].includes(action)) {
      console.error('Error: lane batch requires --action stop|cleanup');
      process.exit(1);
    }
    if (!laneHasSelectionFilter(laneOpts)) {
      console.error('Error: lane batch requires at least one lane selector or --all');
      process.exit(1);
    }

    const listing = listResidentLanes(laneOpts);
    const targets = listing.lanes;
    if (laneOpts.dryRun === true || laneOpts.dryRun === 'true') {
      const preview = {
        action,
        dryRun: true,
        count: targets.length,
        lanes: targets.map((lane) => ({
          laneId: lane.laneId || null,
          laneDir: lane.laneDir,
          tool: lane.tool || lane.adapterId || null,
          status: lane.status,
          alive: !!lane.alive,
        })),
      };
      if (parsed.json) {
        console.log(JSON.stringify(preview, null, 2));
      } else {
        console.log(`Batch ${action} preview (${targets.length} lane(s))`);
        for (const lane of preview.lanes) {
          console.log(`  ${lane.laneId || lane.laneDir}: ${lane.status}${lane.alive ? ' (alive)' : ''}`);
        }
      }
      process.exit(0);
    }

    const results = [];
    for (const lane of targets) {
      const targetOpts = {
        ...laneOpts,
        laneId: lane.laneId || '',
        laneDir: lane.laneDir,
        keyPath: lane.keyPath || '',
        tool: lane.tool || lane.adapterId || laneOpts.tool || 'claude',
        sessionName: lane.sessionName || lane.laneId || laneOpts.sessionName || '',
        sessionId: lane.sessionId || laneOpts.sessionId || '',
      };
      if (action === 'stop') {
        if (!lane.alive) {
          results.push({
            laneId: lane.laneId || null,
            laneDir: lane.laneDir,
            status: 'skipped',
            reason: 'lane_not_alive',
          });
          continue;
        }
        const stopped = stopResidentLane(targetOpts);
        await appendLaneAuditEntry(targetOpts, 'lane_stop', {
          status: stopped?.stopped ? 'success' : 'error',
          stopped: !!stopped?.stopped,
          reason: stopped?.stopped ? null : 'stop_failed',
        });
        results.push({
          laneId: lane.laneId || null,
          laneDir: lane.laneDir,
          status: stopped?.stopped ? 'success' : 'error',
          stopped: !!stopped?.stopped,
        });
        continue;
      }

      const cleaned = cleanupResidentLane(targetOpts);
      await appendLaneAuditEntry(targetOpts, 'lane_cleanup', {
        status: cleaned.cleaned ? 'success' : 'error',
        reason: cleaned.status,
        stopped_live_lane: !!cleaned.stoppedLiveLane,
        cleaned_lane_dir: cleaned.lane?.laneDir || lane.laneDir,
        cleanup_reason: cleaned.lane?.cleanupReason || null,
        tombstone_path: cleaned.lane?.tombstonePath || null,
      });
      results.push({
        laneId: lane.laneId || null,
        laneDir: lane.laneDir,
        status: cleaned.cleaned ? 'success' : 'error',
        reason: cleaned.lane?.cleanupReason || cleaned.status || null,
        cleaned: !!cleaned.cleaned,
      });
    }

    await appendLaneAuditEntry(laneOpts, 'lane_batch', {
      status: results.every((entry) => entry.status === 'success' || entry.status === 'skipped') ? 'success' : 'error',
      action,
      total_matches: targets.length,
      success_count: results.filter((entry) => entry.status === 'success').length,
      skipped_count: results.filter((entry) => entry.status === 'skipped').length,
      error_count: results.filter((entry) => entry.status === 'error').length,
    });

    const payload = {
      action,
      dryRun: false,
      count: targets.length,
      results,
    };
    if (parsed.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Batch ${action} complete (${targets.length} lane(s))`);
      for (const entry of results) {
        console.log(`  ${entry.laneId || entry.laneDir}: ${entry.status}${entry.reason ? ` (${entry.reason})` : ''}`);
      }
    }
    process.exit(results.some((entry) => entry.status === 'error') ? 1 : 0);
  }

  if (parsed.subcommand === 'lane-list') {
    const { listResidentLanes } = await import('./resident-lane.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    const listing = listResidentLanes(laneOpts);
    const enrichedListing = {
      ...listing,
      lanes: listing.lanes.map((lane) => ({
        ...lane,
        recommendedCommand: buildLaneRecommendedCommand(lane),
      })),
    };
    if (parsed.json) {
      console.log(JSON.stringify(enrichedListing, null, 2));
    } else {
      console.log(`Lane registry: ${enrichedListing.registryDir}`);
      console.log(`  Total:   ${enrichedListing.counts.total || 0}`);
      for (const [status, count] of Object.entries(enrichedListing.counts)) {
        if (status === 'total') continue;
        console.log(`  ${status}:`.padEnd(11) + ` ${count}`);
      }
      const activeFilters = [
        laneOpts.status ? `status=${Array.isArray(laneOpts.status) ? laneOpts.status.join(',') : laneOpts.status}` : null,
        laneOpts.toolFilter ? `tool=${Array.isArray(laneOpts.toolFilter) ? laneOpts.toolFilter.join(',') : laneOpts.toolFilter}` : null,
        laneOpts.alive !== undefined ? `alive=${laneOpts.alive}` : null,
        laneOpts.hasConflicts !== undefined ? `hasConflicts=${laneOpts.hasConflicts}` : null,
        laneOpts.filterLaneId ? `laneId=${laneOpts.filterLaneId}` : null,
        laneOpts.filterSessionName ? `sessionName=${laneOpts.filterSessionName}` : null,
        laneOpts.scopeTypeFilter ? `scopeType=${laneOpts.scopeTypeFilter}` : null,
        laneOpts.scopeModeFilter ? `scopeMode=${laneOpts.scopeModeFilter}` : null,
        laneOpts.resourceFilter ? `resources=${Array.isArray(laneOpts.resourceFilter) ? laneOpts.resourceFilter.join(',') : laneOpts.resourceFilter}` : null,
        laneOpts.allRepos ? 'allRepos=true' : null,
      ].filter(Boolean);
      if (activeFilters.length > 0) {
        console.log(`  Filters: ${activeFilters.join(' ')}`);
      }
      if (enrichedListing.lanes.length > 0) {
        console.log('');
        for (const lane of enrichedListing.lanes) {
          const name = lane.laneId || lane.sessionName || lane.laneDir;
          console.log(`${name}: ${lane.status}${lane.alive ? ' (alive)' : ''}`);
          console.log(`  Tool:          ${lane.tool ?? lane.adapterId ?? 'claude'}`);
          console.log(`  Transport:     ${formatLaneTransportSummary(lane)}`);
          console.log(`  Scope:         ${formatLaneScope(lane)}`);
          console.log(`  Resources:     ${formatLaneResources(lane)}`);
          console.log(`  Repo:          ${lane.guardrailRepo ?? 'n/a'}`);
          console.log(`  Lane dir:      ${lane.laneDir}`);
          console.log(`  Session:       ${lane.sessionName ?? 'n/a'}`);
          console.log(`  Request:       ${lane.currentRequestId ?? lane.lastRequestId ?? 'n/a'}`);
          console.log(`  Last result:   ${lane.lastResultPath ?? 'n/a'}`);
          console.log(`  Action:        ${lane.recommendedAction}`);
          console.log(`  Next command:  ${lane.recommendedCommand ?? 'n/a'}`);
          const totalConflicts = (lane.scopeConflicts?.length || 0) + (lane.resourceConflicts?.length || 0);
          if (totalConflicts > 0) {
            console.log(`  Conflicts:     ${totalConflicts}`);
          }
        }
      }
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'lane-adapters') {
    const { listResidentLaneAdapters } = await import('./resident-lane.js');
    const adapters = listResidentLaneAdapters();
    if (parsed.json) {
      console.log(JSON.stringify({ adapters }, null, 2));
    } else {
      console.log('Resident lane adapters:');
      for (const adapter of adapters) {
        console.log(`  ${adapter.id} - ${adapter.description}`);
        if (adapter.source) {
          console.log(`    Source: ${adapter.source}`);
        }
        if (Array.isArray(adapter.capabilities) && adapter.capabilities.length > 0) {
          console.log(`    Capabilities: ${adapter.capabilities.join(', ')}`);
        }
      }
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'lane-inspect') {
    const { getResidentLaneHistory, getResidentLaneLogs, getResidentLaneResult, getResidentLaneStatus } = await import('./resident-lane.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    if (!laneOpts.laneId && !laneOpts.laneDir) {
      console.error('Error: --id <lane-id> or --lane-dir <path> is required for lane inspect');
      process.exit(1);
    }
    const status = getResidentLaneStatus(laneOpts);
    const bundle = buildLaneInspectBundle(laneOpts, status, getResidentLaneResult, getResidentLaneLogs, getResidentLaneHistory);
    if (parsed.json) {
      console.log(JSON.stringify(bundle, null, 2));
    } else {
      console.log(`Lane status: ${bundle.status.status}`);
      console.log(`  Tool:               ${bundle.status.tool ?? bundle.status.adapterId ?? 'claude'}`);
      console.log(`  Transport:          ${formatLaneTransportSummary(bundle.status)}`);
      console.log(`  Scope:              ${formatLaneScope(bundle.status)}`);
      console.log(`  Resources:          ${formatLaneResources(bundle.status)}`);
      console.log(`  Request:            ${bundle.status.currentRequestId ?? bundle.status.lastRequestId ?? 'n/a'}`);
      console.log(`  Last result:        ${bundle.status.lastResultPath ?? 'n/a'}`);
      console.log(`  Action:             ${bundle.status.recommendedAction}`);
      console.log(`  Next command:       ${bundle.status.recommendedCommand ?? 'n/a'}`);
      if (bundle.latestResult?.status) {
        console.log(`  Result status:      ${bundle.latestResult.status}`);
      }
      if (bundle.logs?.text) {
        console.log('');
        console.log(`Lane log tail (${bundle.logs.tailLines} lines):`);
        process.stdout.write(`${bundle.logs.text}${bundle.logs.text.endsWith('\n') ? '' : '\n'}`);
      }
      if (bundle.history?.entries?.length > 0) {
        console.log('');
        console.log(`Lane history (${bundle.history.entries.length}/${bundle.history.totalMatches} entries, chain=${bundle.history.chainValid ? 'valid' : 'broken'}):`);
        for (const entry of bundle.history.entries) {
          console.log(`  ${entry.timestamp} ${entry.event} request=${entry.request_id ?? 'n/a'} status=${entry.status ?? 'n/a'} reason=${entry.reason ?? 'n/a'}`);
        }
      }
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'lane-history') {
    const { getResidentLaneHistory } = await import('./resident-lane.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    if (!laneOpts.laneId && !laneOpts.laneDir) {
      console.error('Error: --id <lane-id> or --lane-dir <path> is required for lane history');
      process.exit(1);
    }
    const history = buildLaneHistoryBundle(getResidentLaneHistory(laneOpts));
    if (parsed.json) {
      console.log(JSON.stringify(history, null, 2));
    } else {
      console.log(`Lane audit: ${history.auditPath}`);
      console.log(`  Entries: ${history.count}/${history.totalMatches}`);
      console.log(`  Chain:   ${history.chainValid ? 'valid' : 'broken'}`);
      for (const entry of history.entries) {
        console.log(`  ${entry.timestamp} ${entry.event} request=${entry.request_id ?? 'n/a'} status=${entry.status ?? 'n/a'} reason=${entry.reason ?? 'n/a'} exit=${entry.exit_code ?? 'n/a'}`);
      }
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'lane-portfolio') {
    const { getResidentLaneTimeline } = await import('./resident-lane.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    const timeline = buildLanePortfolioBundle(getResidentLaneTimeline(laneOpts));
    if (parsed.json) {
      console.log(JSON.stringify(timeline, null, 2));
    } else {
      console.log(`Lane portfolio scope: ${timeline.scope}`);
      console.log(`  Audit path:     ${timeline.auditPath}`);
      console.log(`  Chain valid:    ${timeline.chainValid ? 'yes' : 'no'}`);
      console.log(`  Live lanes:     ${timeline.liveLaneCount}`);
      console.log(`  Matched events: ${timeline.totalMatches}`);
      const eventSummary = Object.entries(timeline.eventCounts || {}).map(([event, count]) => `${event}=${count}`).join(' ');
      if (eventSummary) console.log(`  Events:         ${eventSummary}`);
      if (timeline.entries.length > 0) {
        console.log('');
        for (const entry of timeline.entries) {
          console.log(`${entry.timestamp} ${entry.event} ${entry.lane_id || entry.lane_dir || 'unknown'}${entry.source ? ` [${entry.source}]` : ''}`);
          console.log(`  Repo:    ${entry.guardrail_repo || 'n/a'}`);
          console.log(`  Tool:    ${entry.tool || 'n/a'}`);
          console.log(`  Status:  ${entry.status || 'n/a'}`);
          if (entry.reason) console.log(`  Reason:  ${entry.reason}`);
          if (entry.tombstone_path) console.log(`  Tombstone: ${entry.tombstone_path}`);
        }
      }
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'lane-logs') {
    const { getResidentLaneLogs } = await import('./resident-lane.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    if (!laneOpts.laneId && !laneOpts.laneDir) {
      console.error('Error: --id <lane-id> or --lane-dir <path> is required for lane logs');
      process.exit(1);
    }
    const logs = getResidentLaneLogs(laneOpts);
    if (parsed.json) {
      console.log(JSON.stringify(logs, null, 2));
    } else {
      console.log(`Lane log: ${logs.logPath ?? 'n/a'}`);
      if (logs.text) {
        process.stdout.write(`${logs.text}${logs.text.endsWith('\n') ? '' : '\n'}`);
      } else {
        console.log('(no log output recorded)');
      }
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'lane-prune') {
    const { pruneResidentLanes } = await import('./resident-lane.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    laneOpts.dryRun = parsed.dryRun === true;
    const result = pruneResidentLanes(laneOpts);
    if (!result.dryRun) {
      for (const lane of result.pruned) {
        await appendLaneAuditEntry({
          ...laneOpts,
          laneId: lane.laneId || null,
          laneDir: lane.laneDir,
          tool: lane.tool || null,
        }, 'lane_prune', {
          status: 'success',
          pruned_status: lane.status,
          prune_reason: lane.cleanupReason || null,
          tombstone_path: lane.tombstonePath || null,
        });
      }
    }
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Lane registry: ${result.registryDir}`);
      if (result.dryRun) {
        console.log('  Mode: dry-run');
      }
      console.log(`  Candidates: ${result.candidates.length}`);
      console.log(`  Pruned: ${result.pruned.length}`);
      console.log(`  Skipped: ${result.skipped.length}`);
      const visible = result.dryRun ? result.candidates : result.pruned;
      for (const lane of visible) {
        console.log(`  - ${lane.laneId || lane.laneDir} (${lane.status}; ${lane.reason || lane.cleanupReason || 'n/a'})`);
      }
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'lane-status') {
    const { getResidentLaneStatus } = await import('./resident-lane.js');
    const laneOpts = normalizeLaneCliOptions(parsed.laneOpts);
    if (!laneOpts.laneId && !laneOpts.laneDir) {
      console.error('Error: --id <lane-id> or --lane-dir <path> is required for lane status');
      process.exit(1);
    }
    const status = getResidentLaneStatus(laneOpts);
    const enrichedStatus = {
      ...status,
      recommendedCommand: buildLaneRecommendedCommand(status),
    };
    if (parsed.json) {
      console.log(JSON.stringify(enrichedStatus, null, 2));
    } else {
      console.log(`Lane status: ${enrichedStatus.status}`);
      console.log(`  Tool:               ${enrichedStatus.tool ?? enrichedStatus.adapterId ?? 'claude'}`);
      console.log(`  Transport:          ${formatLaneTransportSummary(enrichedStatus)}`);
      console.log(`  Scope:              ${formatLaneScope(enrichedStatus)}`);
      console.log(`  Resources:          ${formatLaneResources(enrichedStatus)}`);
      if (laneOpts.laneId) console.log(`  Lane id:            ${laneOpts.laneId}`);
      console.log(`  Lane dir:           ${enrichedStatus.laneDir}`);
      if (enrichedStatus.sessionName) console.log(`  Session name:       ${enrichedStatus.sessionName}`);
      if (enrichedStatus.sessionId) console.log(`  Session id:         ${enrichedStatus.sessionId}`);
      console.log(`  Alive:              ${enrichedStatus.alive ? 'yes' : 'no'}`);
      console.log(`  PID:                ${enrichedStatus.pid ?? 'n/a'}`);
      console.log(`  Last request id:    ${enrichedStatus.lastRequestId ?? 'n/a'}`);
      console.log(`  Current request id: ${enrichedStatus.currentRequestId ?? 'n/a'}`);
      console.log(`  Request started at: ${enrichedStatus.currentRequestStartedAt ?? 'n/a'}`);
      console.log(`  Last completed id:  ${enrichedStatus.lastCompletedRequestId ?? 'n/a'}`);
      console.log(`  Last completed at:  ${enrichedStatus.lastCompletedAt ?? 'n/a'}`);
      console.log(`  Last result path:   ${enrichedStatus.lastResultPath ?? 'n/a'}`);
      console.log(`  Failure reason:     ${enrichedStatus.failureReason ?? 'n/a'}`);
      console.log(`  Failure stage:      ${enrichedStatus.failureStage ?? 'n/a'}`);
      console.log(`  Log path:           ${enrichedStatus.logPath ?? 'n/a'}`);
      console.log(`  Last activity at:   ${enrichedStatus.lastActivityAt ?? 'n/a'}`);
      console.log(`  Key present:        ${enrichedStatus.keyPresent ? 'yes' : 'no'}`);
      console.log(`  Request FIFO:       ${enrichedStatus.requestFifoPresent ? 'present' : 'missing'}`);
      console.log(`  Response FIFO:      ${enrichedStatus.responseFifoPresent ? 'present' : 'missing'}`);
      console.log(`  Recommended action: ${enrichedStatus.recommendedAction}`);
      console.log(`  Next command:       ${enrichedStatus.recommendedCommand ?? 'n/a'}`);
      if (Array.isArray(enrichedStatus.scopeConflicts) && enrichedStatus.scopeConflicts.length > 0) {
        console.log('  Scope conflicts:');
        for (const conflict of enrichedStatus.scopeConflicts) {
          console.log(`    ${conflict.laneId || conflict.laneDir} (${conflict.enforcement})`);
        }
      }
      if (Array.isArray(enrichedStatus.resourceConflicts) && enrichedStatus.resourceConflicts.length > 0) {
        console.log('  Resource conflicts:');
        for (const conflict of enrichedStatus.resourceConflicts) {
          console.log(`    ${conflict.laneId || conflict.laneDir} (${conflict.enforcement})`);
        }
      }
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'repo-status') {
    const { getRepoStatusSummary } = await import('./repo-status.js');
    const summary = getRepoStatusSummary(parsed.repoOpts?.path || '.');
    if (parsed.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`Repo status: ${summary.clean ? 'clean' : 'changes present'}`);
      console.log(`  Repo path:  ${summary.repoPath}`);
      console.log(`  Branch:     ${summary.branch ?? 'detached'}`);
      if (summary.upstream) {
        console.log(`  Upstream:   ${summary.upstream}`);
        console.log(`  Ahead:      ${summary.ahead}`);
        console.log(`  Behind:     ${summary.behind}`);
      }
      console.log(`  Staged:     ${summary.staged.length}`);
      console.log(`  Unstaged:   ${summary.unstaged.length}`);
      console.log(`  Untracked:  ${summary.untracked.length}`);
      if (summary.staged.length > 0) {
        console.log('  Staged paths:');
        for (const entry of summary.staged) console.log(`    ${entry.path} (${entry.indexStatus}${entry.worktreeStatus})`);
      }
      if (summary.unstaged.length > 0) {
        console.log('  Unstaged paths:');
        for (const entry of summary.unstaged) console.log(`    ${entry.path} (${entry.indexStatus}${entry.worktreeStatus})`);
      }
      if (summary.untracked.length > 0) {
        console.log('  Untracked paths:');
        for (const path of summary.untracked) console.log(`    ${path}`);
      }
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

  if (parsed.subcommand === 'policy-simulate') {
    const { simulatePolicy, formatSimulationResult } = await import('./policy-simulate.js');
    const opts = parsed.policyOpts || {};
    let contract;
    if (opts.contractFile) {
      try {
        contract = JSON.parse(readFileSync(opts.contractFile, 'utf8'));
      } catch (err) {
        console.error(`Error reading contract file: ${err.message}`);
        process.exit(1);
      }
    } else if (opts.contract) {
      try {
        contract = JSON.parse(opts.contract);
      } catch (err) {
        console.error(`Error parsing contract JSON: ${err.message}`);
        process.exit(1);
      }
    } else {
      console.error('Error: --contract <json> or --contract-file <path> is required');
      process.exit(1);
    }
    const simOptions = {};
    if (opts.trustClass) simOptions.trustClass = opts.trustClass;
    if (opts.projectRoot) simOptions.projectRoot = opts.projectRoot;
    const result = simulatePolicy({ contract, options: simOptions, principal: opts.principal });
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatSimulationResult(result));
    }
    process.exit(result.allowed ? 0 : 1);
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
      if (parsed.registry) {
        const { installFromRegistry } = await import('./recipe-install.js');
        result = await installFromRegistry(source, parsed.registry, { force: parsed.force });
      } else if (source.startsWith('github://')) {
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

  if (parsed.subcommand === 'recipe-compose') {
    try {
      const { composeRecipeArtifact } = await import('./recipe-compose.js');
      const result = composeRecipeArtifact({
        transportSpecifier: parsed.transportRecipe,
        execSpecifier: parsed.execRecipe,
        transportStepId: parsed.transportStep || null,
        searchDirs: parsed.recipeSearchDirs || [],
        outputPath: parsed.outputPath,
        name: parsed.name,
        category: parsed.category,
        description: parsed.description,
        version: parsed.version,
      });
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Wrote composed recipe: ${result.outputPath}`);
        console.log(`  Transport: ${result.transport.specifier}`);
        console.log(`  Exec:      ${result.exec.specifier}`);
        console.log(`  Recipe id: ${result.recipe.id}`);
      }
      process.exit(0);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  if (parsed.subcommand === 'recipe-registry-export') {
    try {
      const { exportRecipeRegistry } = await import('./recipe-registry.js');
      const { buildRecipeSearchDirs } = await import('./recipe-runner.js');
      const searchDirs = buildRecipeSearchDirs({
        explicitSearchDirs: parsed.recipeSearchDirs || [],
        projectRoot: process.cwd(),
        basePath: process.cwd(),
        includeDefaults: true,
      });
      const result = exportRecipeRegistry(parsed.outputPath, searchDirs);
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Exported recipe registry snapshot to ${result.outputDir}`);
        console.log(`  Recipes: ${result.count}`);
        console.log(`  Generated: ${result.generatedAt}`);
      }
      process.exit(0);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  if (parsed.subcommand === 'recipe-registry-list') {
    try {
      const { listRegistryRecipes } = await import('./recipe-install.js');
      const result = await listRegistryRecipes(parsed.registry, {});
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Recipe registry: ${result.registry}`);
        console.log(`  Recipes: ${result.count}`);
        if (result.generated_at) {
          console.log(`  Generated: ${result.generated_at}`);
        }
        for (const recipe of result.recipes) {
          console.log(`  ${recipe.category}/${recipe.id}@${recipe.latest_version}`);
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

  // --- recipe progress (D0y) -----------------------------------------------

  if (parsed.subcommand === 'recipe-progress') {
    const stateDir = resolveRecipeProgressStateDir(parsed.stateDir, parsed.runId);
    if (!stateDir) {
      console.error('Error: recipe progress requires --state-dir <dir> or a matching --run-id <id>');
      process.exit(1);
    }
    let snapshot = readAiProgressSnapshot(stateDir);

    if (parsed.follow) {
      let lastStateSignature = JSON.stringify(snapshot.state ?? null);
      let lastEventCount = snapshot.events.length;

      if (parsed.json) {
        console.log(JSON.stringify({
          stateDir,
          state: snapshot.state,
          events: snapshot.events,
        }));
      } else if (!snapshot.state && snapshot.events.length === 0) {
        console.log(`Waiting for AI progress data in ${stateDir}...`);
      } else {
        printRecipeProgressText(snapshot);
      }

      while (true) {
        if (isTerminalAiProgressState(snapshot.state?.status)) break;
        await delay(1000);
        const nextSnapshot = readAiProgressSnapshot(stateDir);
        const nextStateSignature = JSON.stringify(nextSnapshot.state ?? null);
        const nextEventCount = nextSnapshot.events.length;
        const stateChanged = nextStateSignature !== lastStateSignature;
        const newEvents = nextEventCount > lastEventCount
          ? nextSnapshot.events.slice(lastEventCount)
          : [];

        if (parsed.json) {
          if (stateChanged || newEvents.length > 0) {
            console.log(JSON.stringify({
              stateDir,
              state: nextSnapshot.state,
              events: newEvents,
            }));
          }
        } else {
          if (stateChanged && nextSnapshot.state) {
            console.log('');
            console.log(`Status:  ${nextSnapshot.state.status ?? 'unknown'}`);
            if (nextSnapshot.state.lastPhase) console.log(`Phase:   ${nextSnapshot.state.lastPhase}`);
            if (nextSnapshot.state.lastMessage) console.log(`Last:    ${nextSnapshot.state.lastMessage}`);
            if (nextSnapshot.state.continuationCommand) {
              console.log(`To continue: ${nextSnapshot.state.continuationCommand}`);
            }
          }
          if (newEvents.length > 0) {
            printRecipeProgressText(
              { state: nextSnapshot.state, events: nextSnapshot.events },
              lastEventCount,
              { includeHeader: false },
            );
          }
        }

        snapshot = nextSnapshot;
        lastStateSignature = nextStateSignature;
        lastEventCount = nextEventCount;
      }
    } else if (parsed.json) {
      console.log(JSON.stringify({ stateDir, state: snapshot.state, events: snapshot.events }, null, 2));
    } else {
      if (!snapshot.state && snapshot.events.length === 0) {
        console.log(`No AI progress data found in ${stateDir}`);
        process.exit(0);
      }
      printRecipeProgressText(snapshot);
    }
    process.exit(0);
  }

  // --- recipe continue (D0y) -----------------------------------------------

  if (parsed.subcommand === 'recipe-continue') {
    const stateDir = parsed.stateDir || '';
    const prompt = parsed.prompt || '';

    const { join: pathJoin } = await import('node:path');
    const stateFile = pathJoin(stateDir, 'ai-progress-state.json');

    let state = null;
    if (existsSync(stateFile)) {
      try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { /* ignore */ }
    }

    if (!state) {
      console.error(`Error: no progress state found in ${stateDir}`);
      process.exit(1);
    }

    const eligibleStates = new Set(['waiting_for_review', 'waiting_for_input', 'drift_warning', 'stalled', 'running']);
    if (!eligibleStates.has(state.status)) {
      console.error(`Error: run is in state "${state.status}" which is not continuation-eligible`);
      process.exit(1);
    }

    // Resume the same bounded session using persisted identity.
    const { runClaudeExec } = await import('./claude-exec-wrapper.js');
    try {
      await runClaudeExec({
        prompt,
        sessionName: state.sessionName ?? '',
        sessionId: state.sessionId ?? '',
        lifecycle: 'continue',
        workingDir: state.workingDir ?? '',
        guardrailProgressFile: state.progressArtifact ?? '',
        guardrailProgressStateFile: stateFile,
      });
    } catch (err) {
      console.error(`Error: continuation failed: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
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
        envAllow: parsed.envAllow,
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
      envAllow: parsed.envAllow,
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

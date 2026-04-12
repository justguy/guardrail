import * as claudeLane from './claude-resident-lane.js';
import * as codexLane from './codex-resident-lane.js';
import * as localExecLane from './local-exec-resident-lane.js';
import * as promptWrapperLane from './prompt-wrapper-resident-lane.js';
import * as sshPromptWrapperLane from './ssh-prompt-wrapper-resident-lane.js';
export {
  cleanupResidentLane,
  createLaneBootError,
  getResidentLaneHistory,
  getResidentLaneTimeline,
  getResidentLaneLogs,
  getResidentLaneResult,
  getResidentLaneStatus,
  lanePaths,
  laneResultPath,
  listResidentLanes,
  pruneResidentLanes,
  readSecretFromFd,
  signLaneRequest,
  stableRepoOwnerId,
  stopResidentLane,
  revokeResidentLane,
  killResidentLane,
  trackLaneRequestId,
  validateLaneRequest,
  waitForResidentLaneResult,
  waitForResidentLaneBootstrap,
} from './resident-lane-core.js';

const ADAPTERS = {
  claude: claudeLane,
  codex: codexLane,
  'local-exec': localExecLane,
  'prompt-wrapper': promptWrapperLane,
  'ssh-prompt-wrapper': sshPromptWrapperLane,
};

function selectedTool(rawOptions = {}) {
  return rawOptions.tool || rawOptions.adapterId || 'claude';
}

export function assertValidResidentLaneTool(rawOptions = {}) {
  const tool = selectedTool(rawOptions);
  if (!ADAPTERS[tool]) {
    const supported = Object.keys(ADAPTERS).sort().join(', ');
    throw new Error(`Unknown resident lane tool "${tool}". Supported tools: ${supported}`);
  }
  return tool;
}

function selectedAdapter(rawOptions = {}) {
  return ADAPTERS[assertValidResidentLaneTool(rawOptions)];
}

export function listResidentLaneAdapters() {
  return Object.values(ADAPTERS).map((adapter) => adapter.residentLaneAdapterMetadata).filter(Boolean);
}

export function parseResidentLaneArgs(argv) {
  const parsed = claudeLane.parseResidentLaneArgs(argv);
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1] ?? '';
    switch (flag) {
      case '--tool':
        parsed.tool = value;
        i += 1;
        break;
      case '--profile':
        parsed.profile = value;
        i += 1;
        break;
      case '--sandbox':
        parsed.sandbox = value;
        i += 1;
        break;
      case '--image-files':
        parsed.imageFiles = value;
        i += 1;
        break;
      case '--color':
        parsed.color = value;
        i += 1;
        break;
      case '--oss':
        parsed.oss = value;
        i += 1;
        break;
      case '--local-provider':
        parsed.localProvider = value;
        i += 1;
        break;
      case '--skip-git-repo-check':
        parsed.skipGitRepoCheck = value;
        i += 1;
        break;
      case '--ephemeral':
        parsed.ephemeral = value;
        i += 1;
        break;
      case '--full-auto':
        parsed.fullAuto = value;
        i += 1;
        break;
      case '--resource-mode':
        parsed.resourceMode = value;
        i += 1;
        break;
      case '--resource':
      case '--resources':
        if (!parsed.resources) {
          parsed.resources = [];
        }
        parsed.resources.push(value);
        i += 1;
        break;
      case '--wrapper-command':
        parsed.wrapperCommand = value;
        i += 1;
        break;
      case '--ssh-target':
        parsed.sshTarget = value;
        i += 1;
        break;
      case '--remote-working-dir':
        parsed.remoteWorkingDir = value;
        i += 1;
        break;
      case '--command':
        parsed.command = value;
        i += 1;
        break;
      case '--arg':
      case '--args':
        if (!parsed.commandArgs) {
          parsed.commandArgs = [];
        }
        parsed.commandArgs.push(value);
        i += 1;
        break;
      case '--wrapper-arg':
      case '--wrapper-args':
        if (!parsed.wrapperArgs) {
          parsed.wrapperArgs = [];
        }
        parsed.wrapperArgs.push(value);
        i += 1;
        break;
      case '--ssh-arg':
      case '--ssh-args':
        if (!parsed.sshArgs) {
          parsed.sshArgs = [];
        }
        parsed.sshArgs.push(value);
        i += 1;
        break;
      default:
        break;
    }
  }
  return parsed;
}

export function normalizeResidentLaneOptions(rawOptions, baseCwd = process.cwd()) {
  return selectedAdapter(rawOptions).normalizeResidentLaneOptions(rawOptions, baseCwd);
}

export async function runLaneRequest(options, request, state, deps = {}) {
  return selectedAdapter(options).runLaneRequest(options, request, state, deps);
}

export async function launchResidentLane(rawOptions, deps = {}) {
  return selectedAdapter(rawOptions).launchResidentLane(rawOptions, deps);
}

export function launchResidentLaneDaemonHelper(rawOptions) {
  return selectedAdapter(rawOptions).launchResidentLaneDaemonHelper(rawOptions);
}

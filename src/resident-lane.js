import * as claudeLane from './claude-resident-lane.js';
import * as codexLane from './codex-resident-lane.js';

const ADAPTERS = {
  claude: claudeLane,
  codex: codexLane,
};

const ADAPTER_METADATA = {
  claude: {
    id: 'claude',
    name: 'Claude',
    description: 'Resident lane adapter for Claude CLI execution.',
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    description: 'Resident lane adapter for Codex CLI execution.',
  },
};

function selectedTool(rawOptions = {}) {
  return rawOptions.tool || rawOptions.adapterId || 'claude';
}

function selectedAdapter(rawOptions = {}) {
  return ADAPTERS[selectedTool(rawOptions)] || ADAPTERS.claude;
}

export function listResidentLaneAdapters() {
  return Object.values(ADAPTER_METADATA);
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

export {
  createLaneBootError,
  getResidentLaneLogs,
  getResidentLaneResult,
  getResidentLaneStatus,
  lanePaths,
  laneResultPath,
  listResidentLanes,
  pruneResidentLanes,
  readSecretFromFd,
  signLaneRequest,
  stopResidentLane,
  trackLaneRequestId,
  validateLaneRequest,
  waitForResidentLaneResult,
  waitForResidentLaneBootstrap,
} from './claude-resident-lane.js';

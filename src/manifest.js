import { writeFileSync, readFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { deepEqual, pretty } from './shared.js';

// ---------------------------------------------------------------------------
// Default paths (relative to project root)
// ---------------------------------------------------------------------------

export const DEFAULT_MANIFEST_PATH = '.guardrail/approved.json';
export const DEFAULT_STATE_PATH    = '.guardrail/state.json';
export const DEFAULT_LOG_DIR       = '.guardrail/logs/';

// ---------------------------------------------------------------------------
// Manifest version
// ---------------------------------------------------------------------------

const MANIFEST_VERSION = 1;

// ---------------------------------------------------------------------------
// Fields compared for drift detection
// ---------------------------------------------------------------------------

const CONTRACT_DIFF_FIELDS = [
  'command', 'args', 'cwd', 'mode', 'shell', 'shellFeatures',
  'allowedBinaries', 'writablePaths', 'readablePaths',
  'envPolicy', 'childProcessPolicy', 'retryPolicy', 'timeoutMs',
  'updatePolicy',
];

// ---------------------------------------------------------------------------
// createManifest
// ---------------------------------------------------------------------------

/**
 * Build a new manifest object with the current timestamp.
 *
 * @param {object} contract        - Normalised contract object.
 * @param {string} contractHash    - SHA-256 hex digest of the contract.
 * @param {object} riskAssessment  - Risk assessment block.
 * @param {object} workflow        - Workflow configuration.
 * @param {string} projectRoot     - Absolute path to the project root.
 * @returns {object} A complete manifest ready to persist.
 */
export function createManifest(contract, contractHash, riskAssessment, workflow, projectRoot) {
  return {
    version: MANIFEST_VERSION,
    tool: 'guardrail',
    approvedAt: new Date().toISOString(),
    projectRoot,
    contractHash,
    contract,
    riskAssessment: {
      trustClass:                riskAssessment.trustClass   ?? 'unknown',
      riskLevel:                 riskAssessment.riskLevel    ?? 'red',
      reasons:                   riskAssessment.reasons      ?? [],
      requiresStrongConfirmation: riskAssessment.requiresStrongConfirmation ?? false,
      acknowledgedBy:            riskAssessment.acknowledgedBy ?? null,
      acknowledgedAt:            riskAssessment.acknowledgedAt ?? null,
    },
    workflow: {
      validator:    workflow.validator    ?? 'exit_code',
      updateSource: workflow.updateSource ?? 'none',
    },
  };
}

// ---------------------------------------------------------------------------
// saveManifest  (atomic write-to-temp-then-rename)
// ---------------------------------------------------------------------------

/**
 * Persist a manifest to disk atomically.
 *
 * The target directory (typically `.guardrail/`) is created if absent.
 * A temporary file is written first, then renamed into place so that
 * readers never see a partially-written file.
 *
 * @param {object} manifest - The manifest object.
 * @param {string} filePath - Destination file path.
 */
export function saveManifest(manifest, filePath) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const tmpPath = join(dir, `.tmp-${randomBytes(8).toString('hex')}.json`);

  writeFileSync(tmpPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  renameSync(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// loadManifest
// ---------------------------------------------------------------------------

/**
 * Load a manifest from disk.
 *
 * @param {string} filePath - Path to the manifest JSON file.
 * @returns {object|null} The parsed manifest, or `null` if the file does not exist.
 * @throws {Error} If the file exists but cannot be parsed.
 */
export function loadManifest(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }

  try {
    return JSON.parse(raw);
  } catch (parseErr) {
    throw new Error(`Corrupt manifest at ${filePath}: ${parseErr.message}`);
  }
}

// ---------------------------------------------------------------------------
// diffManifests
// ---------------------------------------------------------------------------

/**
 * Return a human-readable array of strings describing what changed between
 * a candidate manifest and an approved manifest.
 *
 * @param {object} candidate - The manifest produced from the current contract.
 * @param {object} approved  - The previously approved manifest.
 * @returns {string[]} One entry per changed field.
 */
export function diffManifests(candidate, approved) {
  const diffs = [];

  if (!deepEqual(candidate.projectRoot, approved.projectRoot)) {
    diffs.push(
      `projectRoot: ${pretty(approved.projectRoot)} -> ${pretty(candidate.projectRoot)}`,
    );
  }

  // --- Contract fields ---
  const cContract = candidate.contract ?? {};
  const aContract = approved.contract  ?? {};

  for (const field of CONTRACT_DIFF_FIELDS) {
    if (!deepEqual(cContract[field], aContract[field])) {
      diffs.push(
        `contract.${field}: ${pretty(aContract[field])} -> ${pretty(cContract[field])}`,
      );
    }
  }

  // --- Workflow ---
  const cWorkflow = candidate.workflow ?? {};
  const aWorkflow = approved.workflow  ?? {};

  for (const field of ['validator', 'updateSource']) {
    if (!deepEqual(cWorkflow[field], aWorkflow[field])) {
      diffs.push(
        `workflow.${field}: ${pretty(aWorkflow[field])} -> ${pretty(cWorkflow[field])}`,
      );
    }
  }

  // --- Risk assessment ---
  const cRisk = candidate.riskAssessment ?? {};
  const aRisk = approved.riskAssessment  ?? {};

  for (const field of ['trustClass', 'riskLevel', 'reasons', 'requiresStrongConfirmation']) {
    if (!deepEqual(cRisk[field], aRisk[field])) {
      diffs.push(
        `riskAssessment.${field}: ${pretty(aRisk[field])} -> ${pretty(cRisk[field])}`,
      );
    }
  }

  // --- Contract hash ---
  if (candidate.contractHash !== approved.contractHash) {
    diffs.push(
      `contractHash: ${pretty(approved.contractHash)} -> ${pretty(candidate.contractHash)}`,
    );
  }

  return diffs;
}

// ---------------------------------------------------------------------------
// compareManifests
// ---------------------------------------------------------------------------

/**
 * Compare a candidate manifest against an approved one.
 *
 * The manifests match when:
 *   - contractHash values are identical, AND
 *   - riskAssessment.riskLevel and riskAssessment.reasons are identical.
 *
 * A full diff is always computed so callers can inspect individual changes.
 *
 * @param {object} candidate - Manifest derived from the current contract.
 * @param {object} approved  - Previously approved manifest.
 * @returns {{ matches: boolean, diffs: string[] }}
 */
export function compareManifests(candidate, approved) {
  const diffs = diffManifests(candidate, approved);

  return {
    matches: diffs.length === 0,
    diffs,
  };
}

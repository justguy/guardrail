/**
 * model-gateway.js — Single decision point for Guardrail AI provider routing.
 *
 * Owns: tool → wrapper file mapping, tool-specific arg construction.
 * Does NOT own: generic args (prompt, model, working-dir) shared by all tools.
 *
 * This is the future BYOM / allowlist seam. Any new AI provider plugs in here:
 *   1. Add to SUPPORTED_AI_TOOLS
 *   2. Add wrapperFile entry in AI_WRAPPER_FILES
 *   3. Add buildArgs entry in AI_TOOL_ARG_BUILDERS
 *
 * All call sites that previously branched on `tool === 'codex'` inline now
 * delegate here instead.
 */

import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

// --- Registry ----------------------------------------------------------------

/**
 * Canonical set of AI tool identifiers supported by the gateway.
 * Validated at routing time; anything else is an unsupported-tool error.
 */
export const SUPPORTED_AI_TOOLS = new Set(['claude', 'codex']);

/**
 * Map from tool identifier → wrapper filename (relative to src/).
 * Source-of-truth for which script handles a given AI provider.
 */
export const AI_WRAPPER_FILES = {
  claude: 'claude-exec-wrapper.js',
  codex: 'codex-exec-wrapper.js',
};

// --- Routing -----------------------------------------------------------------

/**
 * Resolve the absolute path to the wrapper script for a given tool.
 *
 * @param {string} tool — tool identifier ('claude' | 'codex')
 * @param {string} guardrailRepo — absolute path to the guardrail repo root
 * @returns {string} absolute path to the wrapper script
 * @throws {Error} if tool is not a supported AI tool
 */
export function resolveAIWrapperFile(tool, guardrailRepo) {
  const fileName = AI_WRAPPER_FILES[tool];
  if (!fileName) {
    throw new Error(`model-gateway: unsupported AI tool "${tool}". Supported: ${[...SUPPORTED_AI_TOOLS].join(', ')}`);
  }
  return resolve(guardrailRepo, 'src', fileName);
}

// --- Tool-specific arg builders ----------------------------------------------

/**
 * Build the tool-specific portion of wrapper args (flags unique to one
 * provider). Generic flags (--prompt, --model, --working-dir, --session-*)
 * are NOT built here; callers append them separately.
 *
 * @param {string} tool
 * @param {object} options — normalised lane options
 * @param {object} extra — { lifecycle, progressLaneDir, requestId, reportArtifact, completionMode }
 * @returns {string[]} args to splice into the full wrapper argv
 */
export function buildAIToolArgs(tool, options, extra = {}) {
  if (!SUPPORTED_AI_TOOLS.has(tool)) {
    throw new Error(`model-gateway: unsupported AI tool "${tool}"`);
  }
  if (tool === 'codex') {
    return buildCodexToolArgs(options);
  }
  return buildClaudeToolArgs(options, extra);
}

function buildCodexToolArgs(options) {
  const args = [];
  if (options.profile) args.push('--profile', options.profile);
  if (options.sandbox) args.push('--sandbox', options.sandbox);
  if (options.imageFiles && options.imageFiles.length > 0) {
    args.push('--image-files', options.imageFiles.join(','));
  }
  if (options.color) args.push('--color', options.color);
  if (options.oss) args.push('--oss', 'true');
  if (options.localProvider) args.push('--local-provider', options.localProvider);
  if (options.skipGitRepoCheck) args.push('--skip-git-repo-check', 'true');
  if (options.ephemeral) args.push('--ephemeral', 'true');
  if (options.fullAuto) args.push('--full-auto', 'true');
  return args;
}

function buildClaudeToolArgs(options, extra = {}) {
  const args = [];
  if (options.effort) args.push('--effort', options.effort);
  if (options.permissionMode) args.push('--permission-mode', options.permissionMode);
  if (options.outputFormat) args.push('--output-format', options.outputFormat);
  if (options.maxBudgetUsd) args.push('--max-budget-usd', options.maxBudgetUsd);
  if (options.allowedTools) args.push('--allowed-tools', options.allowedTools);
  if (options.systemPrompt) args.push('--system-prompt', options.systemPrompt);

  // Progress contract — D0y channel (Claude-only)
  const {
    progressLaneDir,
    requestId,
    reportArtifact,
    completionMode,
  } = extra;
  if (progressLaneDir && requestId) {
    const progressDir = resolve(progressLaneDir, 'progress');
    mkdirSync(progressDir, { recursive: true });
    const progressFile = join(progressDir, `${requestId}.ndjson`);
    const progressStateFile = join(progressDir, `${requestId}.json`);
    args.push('--guardrail-progress-file', progressFile);
    args.push('--guardrail-progress-state-file', progressStateFile);
    args.push('--guardrail-heartbeat-seconds', '60');
  }
  if (reportArtifact) args.push('--guardrail-report-artifact', reportArtifact);
  if (completionMode) args.push('--guardrail-completion-mode', completionMode);
  return args;
}

/**
 * Returns true if the tool supports the no-session-persistence flag.
 * Codex does not; Claude does.
 */
export function toolSupportsNoSessionPersistence(tool) {
  return tool !== 'codex';
}

/**
 * Returns true if the tool supports the D0y progress contract
 * (guardrail-progress-file / state-file).
 */
export function toolSupportsProgressContract(tool) {
  return tool !== 'codex';
}

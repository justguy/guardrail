import { writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync, renameSync, chmodSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

const SHIM_DIR = join(homedir(), '.guardrail', 'shims');

function resolveGuardrailExe() {
  const script = resolve(process.argv[1]);
  if (process.argv[0] === process.execPath) {
    return `"${process.execPath}" "${script}"`;
  }
  return `"${script}"`;
}

function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function tempPath(dir) {
  const hex = randomBytes(8).toString('hex');
  return join(dir, `.shim-tmp-${hex}`);
}

/**
 * Create a PATH shim that intercepts `commandName` and routes through Guardrail.
 * @param {string} commandName - CLI command to intercept (e.g. "npm")
 * @param {string} toolName - adapter tool name (e.g. "aider")
 * @param {object} [opts]
 * @param {string} [opts.shimDir] - override shim directory
 * @returns {{ created: boolean, path: string }}
 */
function createShim(commandName, toolName, opts = {}) {
  if (!commandName || typeof commandName !== 'string') {
    throw new Error('createShim: commandName is required');
  }
  if (!toolName || typeof toolName !== 'string') {
    throw new Error('createShim: toolName is required');
  }

  const dir = opts.shimDir || SHIM_DIR;
  ensureDir(dir);

  const guardrailExe = resolveGuardrailExe();
  const shimPath = join(dir, commandName);

  const content = [
    '#!/usr/bin/env bash',
    `# Guardrail shim for: ${commandName} (tool: ${toolName})`,
    '# Do not edit — managed by guardrail adapter shim',
    `REAL="$(which -a ${commandName} | grep -v "$HOME/.guardrail/shims" | head -1)"`,
    'if [ -z "$REAL" ]; then',
    `  echo "guardrail shim: no real binary found for ${commandName}" >&2`,
    '  exit 127',
    'fi',
    `exec ${guardrailExe} adapter run --tool ${toolName} -- "$REAL" "$@"`,
    '',
  ].join('\n');

  const tmp = tempPath(dir);
  try {
    writeFileSync(tmp, content, { mode: 0o644 });
    chmodSync(tmp, 0o755);
  } catch (err) {
    try { unlinkSync(tmp); } catch (_) { /* ignore cleanup error */ }
    throw err;
  }

  renameSync(tmp, shimPath);
  return { created: true, path: shimPath };
}

/**
 * Remove a shim for `commandName`.
 * @param {string} commandName
 * @param {object} [opts]
 * @param {string} [opts.shimDir]
 * @returns {{ removed: boolean, path: string }}
 */
function removeShim(commandName, opts = {}) {
  if (!commandName || typeof commandName !== 'string') {
    throw new Error('removeShim: commandName is required');
  }

  const dir = opts.shimDir || SHIM_DIR;
  const shimPath = join(dir, commandName);

  if (!existsSync(shimPath)) {
    return { removed: false, path: shimPath };
  }

  unlinkSync(shimPath);
  return { removed: true, path: shimPath };
}

/**
 * List all shims in the shim directory.
 * Parses the comment header to extract command and tool names.
 * @param {object} [opts]
 * @param {string} [opts.shimDir]
 * @returns {Array<{ command: string, tool: string, path: string }>}
 */
function listShims(opts = {}) {
  const dir = opts.shimDir || SHIM_DIR;

  if (!existsSync(dir)) {
    return [];
  }

  const entries = readdirSync(dir);
  const shims = [];

  for (const name of entries) {
    if (name.startsWith('.')) continue;

    const shimPath = join(dir, name);
    let tool = 'unknown';

    try {
      const content = readFileSync(shimPath, 'utf8');
      const match = content.match(/^# Guardrail shim for: .+ \(tool: (.+)\)$/m);
      if (match) {
        tool = match[1];
      }
    } catch (_) {
      /* unreadable file — skip or report unknown */
    }

    shims.push({ command: name, tool, path: shimPath });
  }

  return shims;
}

/**
 * Returns the export line to prepend the shim directory to PATH.
 * @param {object} [opts]
 * @param {string} [opts.shimDir]
 * @returns {string}
 */
function getInstallPathExport(opts = {}) {
  const dir = opts.shimDir || '$HOME/.guardrail/shims';
  return `export PATH="${dir}:$PATH"`;
}

const MARKER_START = '# >>> guardrail shim PATH (do not edit) >>>';
const MARKER_END = '# <<< guardrail shim PATH <<<';

/**
 * Write the shim PATH export block to the user's shell rc file.
 * @param {object} [opts]
 * @param {boolean} opts.write - must be true to actually write
 * @param {string} [opts.shimDir]
 * @param {string} [opts.rcPath] - override rc file path
 * @returns {{ written: boolean, rcPath: string, alreadyPresent: boolean }}
 */
function writeShellRc(opts = {}) {
  if (opts.write !== true) {
    throw new Error('writeShellRc: opts.write must be true (explicit opt-in required)');
  }

  const rcPath = opts.rcPath || detectRcPath();
  if (!rcPath) {
    throw new Error('writeShellRc: unable to detect shell rc file (set opts.rcPath)');
  }

  let existing = '';
  if (existsSync(rcPath)) {
    existing = readFileSync(rcPath, 'utf8');
  }

  if (existing.includes(MARKER_START)) {
    return { written: false, rcPath, alreadyPresent: true };
  }

  const exportLine = getInstallPathExport(opts);
  const block = [
    '',
    MARKER_START,
    exportLine,
    MARKER_END,
    '',
  ].join('\n');

  const dir = dirname(rcPath);
  ensureDir(dir);

  const tmp = tempPath(dir);
  try {
    writeFileSync(tmp, existing + block, { mode: 0o644 });
    renameSync(tmp, rcPath);
  } catch (err) {
    try { unlinkSync(tmp); } catch (_) { /* ignore */ }
    throw err;
  }

  return { written: true, rcPath, alreadyPresent: false };
}

function detectRcPath() {
  const shell = process.env.SHELL || '';
  if (shell.endsWith('/zsh')) {
    return join(homedir(), '.zshrc');
  }
  if (shell.endsWith('/bash')) {
    return join(homedir(), '.bashrc');
  }
  // Fallback: try zsh then bash
  const zshrc = join(homedir(), '.zshrc');
  if (existsSync(zshrc)) return zshrc;
  const bashrc = join(homedir(), '.bashrc');
  if (existsSync(bashrc)) return bashrc;
  return null;
}

export {
  createShim,
  removeShim,
  listShims,
  getInstallPathExport,
  writeShellRc,
  SHIM_DIR,
};

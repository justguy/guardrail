import { spawn } from 'node:child_process';
import { buildEnvFromPolicy } from './shared.js';

const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB
const SIGKILL_GRACE_MS = 5000;

const VALID_PROTOCOL_TYPES = new Set([
  'LOG',
  'SUCCESS',
  'VALIDATION_FAILED_REQUIRE_UPDATE',
  'ERROR',
]);

/**
 * Parse a single NDJSON line from worker stdout.
 * @param {string} line - A single line of text.
 * @returns {{ valid: boolean, message: object|null, error: string|null }}
 */
export function parseNdjsonLine(line) {
  const trimmed = line.trim();
  if (trimmed === '') {
    return { valid: false, message: null, error: 'Empty line' };
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return { valid: false, message: null, error: `Malformed JSON: ${err.message}` };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { valid: false, message: null, error: 'JSON value is not an object' };
  }

  if (!parsed.type) {
    return { valid: false, message: null, error: 'Missing "type" field' };
  }

  if (!VALID_PROTOCOL_TYPES.has(parsed.type)) {
    return { valid: false, message: null, error: `Unknown message type: ${parsed.type}` };
  }

  return { valid: true, message: parsed, error: null };
}

// Environment building delegated to shared.js (buildEnvFromPolicy)
const buildEnv = buildEnvFromPolicy;

/**
 * Launch a worker process according to the contract and options.
 *
 * @param {object} contract - The worker contract.
 * @param {string|string[]} contract.command - Command (string for shell mode, or [cmd, ...args] for structured).
 * @param {string[]} [contract.args] - Arguments for structured mode.
 * @param {boolean} [contract.shell] - Whether to use shell mode.
 * @param {string} [contract.cwd] - Working directory.
 * @param {object} [contract.envPolicy] - Environment policy.
 * @param {object} [options] - Launch options.
 * @param {number} [options.timeoutMs] - Timeout in milliseconds.
 * @param {'exit_code'|'ndjson'} [options.validatorMode] - Validator mode.
 * @param {function} [options.onStdout] - Callback for each stdout chunk.
 * @param {function} [options.onStderr] - Callback for each stderr chunk.
 * @param {AbortSignal} [options.signal] - AbortSignal for cancellation.
 * @returns {Promise<object>} WorkerResult
 */
export function launchWorker(contract, options = {}) {
  const {
    timeoutMs,
    validatorMode = 'exit_code',
    onStdout,
    onStderr,
    signal,
  } = options;

  return new Promise((resolve) => {
    const env = buildEnv(contract.envPolicy);

    // Determine spawn arguments based on mode
    let child;
    try {
      if (contract.shell) {
        // Shell mode: command is the shell text
        child = spawn(contract.command, [], {
          shell: true,
          cwd: contract.cwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } else {
        // Structured mode: command + args, no shell
        const cmd = Array.isArray(contract.command) ? contract.command[0] : contract.command;
        const args = Array.isArray(contract.command)
          ? contract.command.slice(1)
          : (contract.args || []);
        child = spawn(cmd, args, {
          shell: false,
          cwd: contract.cwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      }
    } catch (err) {
      // Synchronous spawn failure (rare, but possible)
      return resolve({
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: err.message,
        timedOut: false,
        protocolMessages: [],
        protocolErrors: [],
      });
    }

    const result = {
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      protocolMessages: [],
      protocolErrors: [],
    };

    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timeoutTimer = null;
    let killTimer = null;

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      resolve(result);
    }

    // --- ENOENT and spawn errors ---
    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        result.stderr += `Command not found: ${err.message}\n`;
      } else {
        result.stderr += `Spawn error: ${err.message}\n`;
      }
      // The 'close' event may or may not fire after 'error'.
      // We finish on 'close', but set a safety net.
      setTimeout(() => finish(), 100);
    });

    // --- Stdout handling ---
    let stdoutLineBuffer = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();

      if (onStdout) {
        onStdout(text);
      }

      // Enforce max buffer
      if (stdoutBytes < MAX_BUFFER_BYTES) {
        const remaining = MAX_BUFFER_BYTES - stdoutBytes;
        result.stdout += text.slice(0, remaining);
      }
      stdoutBytes += Buffer.byteLength(chunk);

      // NDJSON parsing in ndjson mode
      if (validatorMode === 'ndjson') {
        stdoutLineBuffer += text;
        const lines = stdoutLineBuffer.split('\n');
        // Keep the last (possibly incomplete) segment in the buffer
        stdoutLineBuffer = lines.pop();

        for (const line of lines) {
          if (line.trim() === '') continue;
          const parsed = parseNdjsonLine(line);
          if (parsed.valid) {
            result.protocolMessages.push(parsed.message);
          } else {
            result.protocolErrors.push({ line, error: parsed.error });
          }
        }
      }
    });

    // --- Stderr handling ---
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();

      if (onStderr) {
        onStderr(text);
      }

      if (stderrBytes < MAX_BUFFER_BYTES) {
        const remaining = MAX_BUFFER_BYTES - stderrBytes;
        result.stderr += text.slice(0, remaining);
      }
      stderrBytes += Buffer.byteLength(chunk);
    });

    // --- Process exit ---
    child.on('close', (code, sig) => {
      // Flush remaining NDJSON buffer
      if (validatorMode === 'ndjson' && stdoutLineBuffer.trim() !== '') {
        const parsed = parseNdjsonLine(stdoutLineBuffer);
        if (parsed.valid) {
          result.protocolMessages.push(parsed.message);
        } else {
          result.protocolErrors.push({ line: stdoutLineBuffer, error: parsed.error });
        }
        stdoutLineBuffer = '';
      }

      result.exitCode = code;
      result.signal = sig || null;
      finish();
    });

    // --- Timeout enforcement ---
    if (timeoutMs != null && timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        if (settled) return;
        result.timedOut = true;

        // SIGTERM first
        try { child.kill('SIGTERM'); } catch { /* already dead */ }

        // SIGKILL after grace period
        killTimer = setTimeout(() => {
          if (settled) return;
          try { child.kill('SIGKILL'); } catch { /* already dead */ }
        }, SIGKILL_GRACE_MS);
      }, timeoutMs);
    }

    // --- AbortSignal handling ---
    if (signal) {
      if (signal.aborted) {
        // Already aborted before we started
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        killTimer = setTimeout(() => {
          if (settled) return;
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }, SIGKILL_GRACE_MS);
      } else {
        const onAbort = () => {
          if (settled) return;
          try { child.kill('SIGTERM'); } catch { /* ignore */ }
          killTimer = setTimeout(() => {
            if (settled) return;
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
          }, SIGKILL_GRACE_MS);
        };
        signal.addEventListener('abort', onAbort, { once: true });

        // Clean up listener when done
        const origFinish = finish;
        finish = function () {
          signal.removeEventListener('abort', onAbort);
          origFinish();
        };
      }
    }
  });
}

/**
 * adapter-stdin.js — stdin-json protocol handler for the Guardrail adapter system.
 *
 * Reads JSON input from argv or stdin, routes through the adapter engine,
 * and writes the rendered response to stdout.
 */

import { readFileSync } from 'node:fs';
import { resolve as _resolvePath } from 'node:path';
import { fileURLToPath as _fileURLToPath } from 'node:url';
import { runAdapter } from './adapter-engine.js';
import { resolveProfile, loadProfile } from './adapter-profile.js';

// --- Constants ---------------------------------------------------------------

const MAX_INPUT_BYTES = 5 * 1024 * 1024; // 5 MB
const EXIT_PROTOCOL_ERROR = 19;

// --- Structured error --------------------------------------------------------

function makeError(message, code) {
  return { error: true, message, code: code ?? 'ADAPTER_STDIN_ERROR' };
}

// --- Input parsing -----------------------------------------------------------

/**
 * Read and parse JSON input from argv[2] (file path) or stdin.
 *
 * @param {string[]} argv - argument vector (argv[2] may be a JSON file path)
 * @param {object}   [opts]
 * @param {number}   [opts.maxBytes]  - max input size (default 5 MB)
 * @param {Function} [opts.stdinFn]   - override for reading stdin (testing)
 * @returns {Promise<object>} parsed JSON object
 * @throws on invalid JSON or oversized input
 */
export async function parseStdinInput(argv, opts) {
  const maxBytes = opts?.maxBytes ?? MAX_INPUT_BYTES;
  let raw;

  if (argv && argv[2]) {
    // Read from file path supplied as argv[2]
    raw = readFileSync(argv[2], 'utf8');
  } else {
    // Read from stdin
    raw = await (opts?.stdinFn ?? readStdin)();
  }

  if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
    throw Object.assign(
      new Error(`Input exceeds maximum size of ${maxBytes} bytes`),
      { code: 'INPUT_TOO_LARGE' },
    );
  }

  try {
    return JSON.parse(raw);
  } catch (e) {
    throw Object.assign(
      new Error(`Invalid JSON input: ${e.message}`),
      { code: 'INVALID_JSON' },
    );
  }
}

// --- stdin reader (default) --------------------------------------------------

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(chunks.join('')));
    process.stdin.on('error', reject);
  });
}

// --- Main adapter flow -------------------------------------------------------

/**
 * Full stdin-json adapter flow: parse → run adapter → write result → exit.
 *
 * @param {string}   profile - profile name or path
 * @param {string[]} argv    - argument vector
 * @param {object}   [opts]
 * @param {Function} [opts.runAdapterFn] - override for runAdapter (testing)
 * @param {object}   [opts.stdout]       - writable stream for output
 * @param {number}   [opts.maxBytes]     - max input size
 * @param {Function} [opts.stdinFn]      - override for reading stdin
 * @returns {Promise<{ exitCode: number }>}
 */
export async function runStdinAdapter(profile, argv, opts) {
  const out = opts?.stdout ?? process.stdout;
  const adapterFn = opts?.runAdapterFn ?? runAdapter;

  let parsedJson;
  try {
    parsedJson = await parseStdinInput(argv, {
      maxBytes: opts?.maxBytes,
      stdinFn: opts?.stdinFn,
    });
  } catch (err) {
    const resp = makeError(err.message, err.code);
    out.write(JSON.stringify(resp) + '\n');
    return { exitCode: EXIT_PROTOCOL_ERROR };
  }

  try {
    const result = await adapterFn({
      rawInput: parsedJson,
      profilePath: profile,
    });
    const payload = result?.renderedResponse ?? result?.adapterResult ?? null;
    if (typeof payload === 'string') {
      out.write(`${payload}\n`);
    } else {
      out.write(JSON.stringify(payload) + '\n');
    }
    return { exitCode: result?.exitCode ?? 0 };
  } catch (err) {
    const resp = makeError(err.message, 'ADAPTER_RUN_ERROR');
    out.write(JSON.stringify(resp) + '\n');
    return { exitCode: EXIT_PROTOCOL_ERROR };
  }
}

// --- Entrypoint (guarded) ----------------------------------------------------

async function main() {
  const profile = process.argv[2] || process.argv[1] || '';
  const forwardedArgv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];
  const { exitCode } = await runStdinAdapter(profile, forwardedArgv);
  process.exitCode = exitCode;
}

const _thisFile = _fileURLToPath(import.meta.url);
const _entryFile = process.argv[1] ? _resolvePath(process.argv[1]) : '';
if (_thisFile === _entryFile) {
  process.on('unhandledRejection', (err) => {
    process.stderr.write(`adapter-stdin: unhandled rejection: ${err?.message ?? err}\n`);
    process.exitCode = EXIT_PROTOCOL_ERROR;
  });
  main().catch((err) => {
    process.stderr.write(`adapter-stdin: fatal: ${err?.message ?? err}\n`);
    process.exitCode = EXIT_PROTOCOL_ERROR;
  });
}

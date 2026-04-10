import {
  closeSync,
  constants as fsConstants,
  lstatSync,
  openSync,
  readSync,
  writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createHmac } from 'node:crypto';

const MAX_PROMPT_CHARS = 32_000;
const MAX_REQUEST_ID_CHARS = 128;

function parseArgs(argv) {
  const options = {
    laneDir: '',
    requestFifo: '',
    responseFifo: '',
    requestId: '',
    prompt: '',
    authFd: '',
    timeoutMs: '30000',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1] ?? '';
    switch (flag) {
      case '--lane-dir':
        options.laneDir = value;
        i += 1;
        break;
      case '--request-fifo':
        options.requestFifo = value;
        i += 1;
        break;
      case '--response-fifo':
        options.responseFifo = value;
        i += 1;
        break;
      case '--request-id':
        options.requestId = value;
        i += 1;
        break;
      case '--prompt':
        options.prompt = value;
        i += 1;
        break;
      case '--auth-fd':
        options.authFd = value;
        i += 1;
        break;
      case '--timeout-ms':
        options.timeoutMs = value;
        i += 1;
        break;
      default:
        break;
    }
  }

  if (!options.laneDir && (!options.requestFifo || !options.responseFifo)) {
    throw new Error('Provide --lane-dir or both --request-fifo and --response-fifo.');
  }
  if (!options.requestId) throw new Error('Provide --request-id.');
  if (!options.prompt) throw new Error('Provide --prompt.');
  if (options.requestId.length > MAX_REQUEST_ID_CHARS || !/^[A-Za-z0-9._:-]+$/.test(options.requestId)) {
    throw new Error('request_id must match ^[A-Za-z0-9._:-]+$ and be 128 chars or fewer.');
  }
  if (options.prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`prompt must be ${MAX_PROMPT_CHARS} chars or fewer.`);
  }
  return options;
}

function parseOptionalFd(value) {
  if (value === '' || value === undefined || value === null) return null;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 3) {
    throw new Error('auth_fd must be an integer >= 3.');
  }
  return parsed;
}

function readSecretFromFd(fd) {
  if (!Number.isInteger(fd) || fd < 3) return '';
  const chunks = [];
  const buffer = Buffer.alloc(4096);
  for (;;) {
    const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
    if (bytesRead <= 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

function signLaneRequest(request, secret) {
  return createHmac('sha256', secret)
    .update(JSON.stringify({ id: request.id, prompt: request.prompt }))
    .digest('hex');
}

function ensureFifo(path) {
  const stat = lstatSync(path);
  if (!stat.isFIFO()) throw new Error(`${path} is not a FIFO`);
}

function resolveLanePaths(rawOptions, baseCwd = process.cwd()) {
  if (rawOptions.laneDir) {
    const laneDir = resolve(baseCwd, rawOptions.laneDir);
    const requestFifo = join(laneDir, 'requests.fifo');
    const responseFifo = join(laneDir, 'responses.fifo');
    ensureFifo(requestFifo);
    ensureFifo(responseFifo);
    return { laneDir, requestFifo, responseFifo };
  }

  const requestFifo = resolve(baseCwd, rawOptions.requestFifo);
  const responseFifo = resolve(baseCwd, rawOptions.responseFifo);
  ensureFifo(requestFifo);
  ensureFifo(responseFifo);
  return { laneDir: '', requestFifo, responseFifo };
}

export async function sendResidentLaneMessage(rawOptions) {
  const parsed = parseArgs(rawOptions);
  const { requestFifo, responseFifo } = resolveLanePaths(parsed);
  const timeoutMs = Number.parseInt(parsed.timeoutMs, 10);
  const authFd = parseOptionalFd(parsed.authFd);
  const authSecret = authFd ? readSecretFromFd(authFd) : '';
  const requestPayload = {
    id: parsed.requestId,
    prompt: parsed.prompt,
  };
  if (authSecret) {
    requestPayload.signature = signLaneRequest(requestPayload, authSecret);
  }

  const responseFd = openSync(responseFifo, fsConstants.O_RDWR | fsConstants.O_NONBLOCK);
  try {
    const requestFd = openSync(requestFifo, fsConstants.O_WRONLY);
    try {
      writeSync(requestFd, `${JSON.stringify(requestPayload)}\n`, undefined, 'utf8');
    } finally {
      closeSync(requestFd);
    }

    const startedAt = Date.now();
    const chunk = Buffer.alloc(4096);
    let buffer = '';
    for (;;) {
      if ((Date.now() - startedAt) > timeoutMs) {
        throw new Error(`Resident lane timed out after ${timeoutMs}ms`);
      }

      try {
        const bytesRead = readSync(responseFd, chunk, 0, chunk.length, null);
        if (bytesRead > 0) {
          buffer += chunk.toString('utf8', 0, bytesRead);
          while (buffer.includes('\n')) {
            const newlineIndex = buffer.indexOf('\n');
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            if (!line) continue;
            const response = JSON.parse(line);
            if (response.requestId !== parsed.requestId) continue;
            return response;
          }
        }
      } catch (err) {
        if (err?.code !== 'EAGAIN') throw err;
      }

      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  } finally {
    closeSync(responseFd);
  }
}

async function main() {
  const response = await sendResidentLaneMessage(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}

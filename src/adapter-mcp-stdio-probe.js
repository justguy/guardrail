import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_MESSAGE_BYTES = 128 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const CLIENT_PROTOCOL_VERSION = '2024-11-05';

function appendBounded(text, chunk, maxBytes) {
  const next = text + chunk;
  const buf = Buffer.from(next, 'utf8');
  if (buf.byteLength <= maxBytes) return next;
  return buf.subarray(0, maxBytes).toString('utf8');
}

function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8'),
    body,
  ]);
}

class McpFrameReader {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages = [];

    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        if (this.buffer.length > MAX_HEADER_BYTES) {
          throw new Error('MCP stdio probe received an oversized frame header.');
        }
        break;
      }

      const headerText = this.buffer.subarray(0, headerEnd).toString('utf8');
      const headers = headerText.split('\r\n');
      let contentLength = null;
      for (const line of headers) {
        const match = /^content-length:\s*(\d+)$/i.exec(line.trim());
        if (match) {
          contentLength = Number.parseInt(match[1], 10);
          break;
        }
      }

      if (!Number.isInteger(contentLength) || contentLength < 0) {
        throw new Error('MCP stdio probe received a frame without a valid Content-Length header.');
      }
      if (contentLength > MAX_MESSAGE_BYTES) {
        throw new Error(`MCP stdio probe received an oversized frame body (${contentLength} bytes).`);
      }

      const messageEnd = headerEnd + 4 + contentLength;
      if (this.buffer.length < messageEnd) {
        break;
      }

      const payload = this.buffer.subarray(headerEnd + 4, messageEnd).toString('utf8');
      let message;
      try {
        message = JSON.parse(payload);
      } catch (err) {
        throw new Error(`MCP stdio probe received invalid JSON: ${err.message}`);
      }
      messages.push(message);
      this.buffer = this.buffer.subarray(messageEnd);
    }

    return messages;
  }
}

function summarizeProbeSuccess(transport, initializeResult, toolsResult) {
  const allToolNames = Array.isArray(toolsResult?.tools)
    ? toolsResult.tools.filter((tool) => tool && typeof tool.name === 'string').map((tool) => tool.name.slice(0, 256))
    : [];
  const toolList = allToolNames.slice(0, 100);

  return {
    ok: true,
    transport: {
      type: transport.type,
      command: transport.command,
      args: Array.isArray(transport.args) ? transport.args : [],
      cwd: transport.cwd || null,
    },
    server: {
      protocolVersion: initializeResult?.protocolVersion || null,
      serverInfo: initializeResult?.serverInfo || null,
      capabilities: initializeResult?.capabilities || null,
      toolCount: allToolNames.length,
      toolsTruncated: allToolNames.length > toolList.length,
      tools: toolList,
    },
  };
}

function summarizeProbeFailure(code, reason, detail = null) {
  return {
    ok: false,
    code,
    reason,
    detail: detail || null,
  };
}

export async function runMcpStdioProbe(transport, options = {}) {
  const timeoutMs = Number.parseInt(options.timeoutMs, 10) || DEFAULT_TIMEOUT_MS;
  const reader = new McpFrameReader();
  let stderr = '';

  return await new Promise((resolveProbe) => {
    let settled = false;
    let child;
    const pending = new Map();

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const pendingRequest of pending.values()) {
        pendingRequest.reject(new Error('probe_finished'));
      }
      pending.clear();
      if (child && child.exitCode == null && !child.killed) {
        try {
          child.kill('SIGTERM');
        } catch {}
      }
      resolveProbe(result);
    };

    const fail = (code, reason, detail = null) => {
      finish(summarizeProbeFailure(code, reason, detail || stderr || null));
    };

    try {
      child = spawn(transport.command, Array.isArray(transport.args) ? transport.args : [], {
        cwd: transport.cwd || process.cwd(),
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      finish(summarizeProbeFailure('spawn_failed', `Failed to launch MCP stdio transport: ${err.message}`));
      return;
    }

    const timer = setTimeout(() => {
      fail('timeout', `MCP stdio probe timed out after ${timeoutMs}ms.`);
    }, timeoutMs);

    const handleMessage = (message) => {
      if (settled) return;
      if (message && typeof message === 'object' && message.id !== undefined) {
        const key = String(message.id);
        const pendingRequest = pending.get(key);
        if (!pendingRequest) {
          if (typeof message.method !== 'string') {
            fail('protocol_error', 'MCP stdio probe received a response with a mismatched request_id.');
          }
          return;
        }
        pending.delete(key);
        pendingRequest.resolve(message);
        return;
      }
      if (message && typeof message === 'object' && typeof message.method === 'string') {
        if (message.id !== undefined) {
          fail('protocol_error', `MCP stdio probe received an unexpected server request: ${message.method}`);
        }
      }
    };

    child.stdout.on('data', (chunk) => {
      try {
        const messages = reader.push(chunk);
        for (const message of messages) {
          handleMessage(message);
        }
      } catch (err) {
        fail('protocol_error', err.message);
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr = appendBounded(stderr, chunk.toString('utf8'), MAX_STDERR_BYTES);
    });

    child.on('error', (err) => {
      fail('transport_error', `MCP stdio transport error: ${err.message}`);
    });

    child.on('close', (code) => {
      if (!settled) {
        fail('transport_closed', `MCP stdio transport exited before discovery completed (exit ${code ?? 'null'}).`);
      }
    });

    const request = (id, method, params) => new Promise((resolveRequest, rejectRequest) => {
      pending.set(String(id), { resolve: resolveRequest, reject: rejectRequest });
      try {
        child.stdin.write(encodeFrame({
          jsonrpc: '2.0',
          id,
          method,
          params,
        }));
      } catch (err) {
        pending.delete(String(id));
        rejectRequest(err);
      }
    });

    const sendNotification = (method, params) => {
      child.stdin.write(encodeFrame({
        jsonrpc: '2.0',
        method,
        params,
      }));
    };

    (async () => {
      try {
        const initializeId = 'guardrail:initialize';
        const initializeResponse = await request(initializeId, 'initialize', {
          protocolVersion: CLIENT_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: 'guardrail',
            version: '0.2.0',
          },
        });

        if (String(initializeResponse.id) !== initializeId) {
          throw new Error('MCP stdio probe received an initialize response with a mismatched request_id.');
        }
        if (initializeResponse.error) {
          throw new Error(`MCP initialize failed: ${JSON.stringify(initializeResponse.error)}`);
        }

        sendNotification('notifications/initialized', {});

        const toolsListId = 'guardrail:tools/list';
        const toolsResponse = await request(toolsListId, 'tools/list', {});
        if (String(toolsResponse.id) !== toolsListId) {
          throw new Error('MCP stdio probe received a tools/list response with a mismatched request_id.');
        }
        if (toolsResponse.error) {
          throw new Error(`MCP tools/list failed: ${JSON.stringify(toolsResponse.error)}`);
        }

        finish(summarizeProbeSuccess(transport, initializeResponse.result, toolsResponse.result));
      } catch (err) {
        fail('protocol_error', err.message);
      }
    })();
  });
}

function parseProbeArgs(argv) {
  const result = {
    command: '',
    args: [],
    cwd: '',
    timeoutMs: String(DEFAULT_TIMEOUT_MS),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--command' && i + 1 < argv.length) {
      result.command = argv[++i];
      continue;
    }
    if (token === '--arg' && i + 1 < argv.length) {
      result.args.push(argv[++i]);
      continue;
    }
    if (token === '--cwd' && i + 1 < argv.length) {
      result.cwd = argv[++i];
      continue;
    }
    if (token === '--timeout-ms' && i + 1 < argv.length) {
      result.timeoutMs = argv[++i];
      continue;
    }
    return { error: `Unknown or incomplete flag: ${token}` };
  }
  if (!result.command) {
    return { error: 'Missing required --command <name>.' };
  }
  return { result };
}

async function main() {
  const parsed = parseProbeArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(parsed.error);
    process.exit(2);
    return;
  }
  const outcome = await runMcpStdioProbe({
    type: 'stdio',
    command: parsed.result.command,
    args: parsed.result.args,
    cwd: parsed.result.cwd || process.cwd(),
  }, {
    timeoutMs: parsed.result.timeoutMs,
  });
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}

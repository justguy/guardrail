import { fileURLToPath } from 'node:url';
import { createGuardrailMcpRuntime } from './mcp-runtime.js';
import { encodeMcpFrame, McpServerFrameReader } from './mcp-framing.js';
import { listGuardrailMcpTools } from './mcp-tools.js';

export { createGuardrailMcpRuntime } from './mcp-runtime.js';
export { encodeMcpFrame, McpServerFrameReader } from './mcp-framing.js';
export { listGuardrailMcpTools } from './mcp-tools.js';

const SERVER_PROTOCOL_VERSION = '2024-11-05';

function jsonRpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, data } };
}

export async function handleJsonRpcMessage(runtime, message) {
  if (!message || typeof message !== 'object') return jsonRpcError(null, -32600, 'Invalid Request');
  if (message.id === undefined) return null;
  if (message.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: SERVER_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'guardrail-mcp', version: '1.0.0' },
      },
    };
  }
  if (message.method === 'tools/list') {
    return { jsonrpc: '2.0', id: message.id, result: { tools: listGuardrailMcpTools() } };
  }
  if (message.method === 'resources/list') {
    return { jsonrpc: '2.0', id: message.id, result: { resources: [] } };
  }
  if (message.method === 'resources/templates/list') {
    return { jsonrpc: '2.0', id: message.id, result: { resourceTemplates: [] } };
  }
  if (message.method === 'prompts/list') {
    return { jsonrpc: '2.0', id: message.id, result: { prompts: [] } };
  }
  if (message.method === 'ping') {
    return { jsonrpc: '2.0', id: message.id, result: {} };
  }
  if (message.method === 'tools/call') {
    const params = message.params || {};
    if (typeof params.name !== 'string') return jsonRpcError(message.id, -32602, 'tools/call requires params.name');
    const result = await runtime.callTool(params.name, params.arguments || {});
    return { jsonrpc: '2.0', id: message.id, result };
  }
  return jsonRpcError(message.id, -32601, `Method not found: ${message.method}`);
}

async function processChunk(runtime, reader, output, chunk) {
  let messages;
  try {
    messages = reader.push(chunk);
  } catch (err) {
    output.write(encodeMcpFrame(jsonRpcError(null, -32700, err.message)));
    return;
  }
  for (const message of messages) {
    try {
      const response = await handleJsonRpcMessage(runtime, message);
      if (response) output.write(encodeMcpFrame(response));
    } catch (err) {
      output.write(encodeMcpFrame(jsonRpcError(message?.id ?? null, -32603, err.message)));
    }
  }
}

export async function runGuardrailMcpServer(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const runtime = createGuardrailMcpRuntime(options);
  const reader = new McpServerFrameReader();
  let processing = Promise.resolve();

  return await new Promise((resolveServer) => {
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await processing.catch(() => {});
      await runtime.close();
      resolveServer();
    };

    input.on('data', (chunk) => {
      processing = processing
        .then(() => processChunk(runtime, reader, output, chunk))
        .catch((err) => {
          output.write(encodeMcpFrame(jsonRpcError(null, -32603, err.message)));
        });
    });
    input.on('end', close);
    input.on('close', close);
  });
}

function parseServeArgs(argv) {
  const opts = {};
  const readValue = (arg, index) => {
    if (index + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
    const value = argv[index + 1];
    if (value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--grant') { opts.grantPath = readValue(arg, i); i += 1; }
    else if (arg === '--agent') { opts.agent = readValue(arg, i); i += 1; }
    else if (arg === '--cwd') { opts.cwd = readValue(arg, i); i += 1; }
    else if (arg === '--audit-path') { opts.auditPath = readValue(arg, i); i += 1; }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

async function main() {
  const opts = parseServeArgs(process.argv.slice(2));
  await runGuardrailMcpServer(opts);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}

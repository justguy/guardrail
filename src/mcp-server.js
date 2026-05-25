import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { createGuardrailMcpRuntime } from './mcp-runtime.js';
import { listGuardrailMcpTools } from './mcp-tools.js';

export { createGuardrailMcpRuntime } from './mcp-runtime.js';
export { listGuardrailMcpTools } from './mcp-tools.js';

export function createGuardrailMcpSdkServer(options = {}) {
  const runtime = createGuardrailMcpRuntime(options);
  const server = new Server(
    { name: 'guardrail-mcp', version: '1.0.0' },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      instructions: 'Guardrail delegated MCP server. Tool calls are fail-closed by the active grant.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listGuardrailMcpTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const params = request.params || {};
    return await runtime.callTool(params.name, params.arguments || {});
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));

  return {
    server,
    runtime,
    async close() {
      await server.close().catch(() => {});
      await runtime.close();
    },
  };
}

export async function runGuardrailMcpServer(options = {}) {
  const sdkServer = createGuardrailMcpSdkServer(options);
  const transport = new StdioServerTransport(options.input || process.stdin, options.output || process.stdout);
  await sdkServer.server.connect(transport);
  return sdkServer;
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

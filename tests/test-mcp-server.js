import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { createGuardrailMcpRuntime } from '../src/mcp-server.js';
import { runMcpStdioProbe } from '../src/adapter-mcp-stdio-probe.js';
import { hashRecipe } from '../src/recipe.js';
import { runRecipeSupervisor } from '../src/recipe-supervisor.js';
import { parseArgs } from '../src/cli.js';

function tmpDir() {
  return realpathSync.native(mkdtempSync(join(tmpdir(), 'gr-mcp-')));
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

function baseGrant(overrides = {}) {
  const {
    recipeHash = 'a'.repeat(64),
    gitCommitRecipeHash = 'b'.repeat(64),
    gitPushRecipeHash = 'c'.repeat(64),
    ...rest
  } = overrides;
  const grant = {
    version: 1,
    agent: 'codex',
    repo_path: '.',
    expires_at: '2999-01-01T00:00:00.000Z',
    tools: {
      guardrail_run_recipe: {
        recipes: {
          'mcp-echo': {
            allow_unverified: true,
            recipe_hash: recipeHash,
            inputs: {
              message: { exact: 'hello' },
            },
          },
        },
      },
      guardrail_http_request: {
        hosts: ['127.0.0.1', 'localhost'],
        ports: [4317],
        methods: ['GET'],
        max_body_bytes: 128,
      },
      guardrail_git_status: true,
      guardrail_git_diff: true,
      guardrail_git_commit: {
        recipe_hash: gitCommitRecipeHash,
        allow_unverified: true,
        allowed_paths: ['src', 'tests'],
      },
      guardrail_git_push_feature_branch: {
        recipe_hash: gitPushRecipeHash,
        remote: 'origin',
        branch_pattern: '^(feature|bugfix|chore|docs|refactor|test|ci)/[A-Za-z0-9._/-]{1,96}$',
      },
    },
  };
  return { ...grant, ...rest, tools: rest.tools ?? grant.tools };
}

function makeEchoRecipe(overrides = {}) {
  return {
    id: 'mcp-echo',
    name: 'MCP Echo',
    description: 'Echo through a delegated MCP recipe',
    version: '1.0.0',
    author: 'Guardrail Tests',
    category: 'custom',
    channel: 'community',
    inputs: {
      message: { type: 'string', pattern: '^hello$' },
    },
    steps: [
      {
        id: 'node-echo',
        description: 'print message',
        run: {
          command: process.execPath,
          args: ['-e', 'process.stdout.write(process.argv[1])', '{{inputs.message}}'],
          mode: 'structured',
        },
      },
    ],
    guardrails: {
      constraints: ['delegated MCP test only'],
      invariants: ['structured node execution'],
    },
    approval_required: true,
    risk_level: 'low',
    ...overrides,
  };
}

async function connectSdkClient({ grantPath, cwd }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['src/mcp-server.js', '--grant', grantPath, '--agent', 'codex', '--cwd', cwd],
    cwd: process.cwd(),
    stderr: 'pipe',
  });
  let stderr = '';
  const stderrStream = transport.stderr;
  if (stderrStream) {
    stderrStream.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
  }
  const client = new Client(
    { name: 'guardrail-mcp-test', version: '1.0.0' },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
  } catch (err) {
    await transport.close().catch(() => {});
    throw new Error(`${err.message}${stderr ? `\n${stderr}` : ''}`);
  }

  return { client, stderr: () => stderr };
}

describe('Guardrail MCP server', () => {
  it('reports grant capabilities and help through grant status', async () => {
    const dir = tmpDir();
    const grantPath = join(dir, 'grant.json');
    writeJson(grantPath, baseGrant());
    const runtime = createGuardrailMcpRuntime({ grantPath, cwd: dir, agent: 'codex' });

    const result = await runtime.callTool('guardrail_grant_status');
    const payload = JSON.parse(result.content[0].text);

    assert.equal(payload.ok, true);
    assert.equal(payload.grant.ok, true);
    assert.deepEqual(payload.grant.capabilities.guardrail_http_request.policy.hosts, ['127.0.0.1', 'localhost']);
    assert.deepEqual(payload.grant.capabilities.guardrail_http_request.policy.ports, [4317]);
    assert.equal(payload.grant.capabilities.guardrail_git_commit.policy.recipeHash, 'b'.repeat(64));
    assert.deepEqual(payload.grant.capabilities.guardrail_git_commit.policy.allowedPaths, ['src', 'tests']);
    assert.match(payload.grant.help.discovery, /instead of guessing/);
    assert.equal(payload.server.agent, 'codex');
    await runtime.close();
  });

  it('is discoverable over stdio', async () => {
    const dir = tmpDir();
    const grantPath = join(dir, 'grant.json');
    writeJson(grantPath, baseGrant());

    const probe = await runMcpStdioProbe({
      command: process.execPath,
      args: ['src/mcp-server.js', '--grant', grantPath, '--agent', 'codex', '--cwd', dir],
      cwd: process.cwd(),
    }, { timeoutMs: 5000 });

    assert.equal(probe.ok, true);
    assert.ok(probe.server.tools.some((tool) => tool.name === 'guardrail_run_recipe'));
    assert.ok(probe.server.tools.some((tool) => tool.name === 'guardrail_git_push_feature_branch'));
  });

  it('initializes and discovers tools through the official MCP SDK client', async () => {
    const dir = tmpDir();
    const grantPath = join(dir, 'grant.json');
    writeJson(grantPath, baseGrant());
    const { client, stderr } = await connectSdkClient({ grantPath, cwd: dir });

    try {
      const tools = await client.listTools();
      const resources = await client.listResources();
      const templates = await client.listResourceTemplates();
      const prompts = await client.listPrompts();

      assert.ok(tools.tools.some((tool) => tool.name === 'guardrail_run_recipe'));
      assert.deepEqual(resources.resources, []);
      assert.deepEqual(templates.resourceTemplates, []);
      assert.deepEqual(prompts.prompts, []);
      assert.equal(stderr(), '');
    } finally {
      await client.close();
    }
  });

  it('calls delegated tools through the official MCP SDK client', async () => {
    const dir = tmpDir();
    const grantPath = join(dir, 'grant.json');
    writeJson(grantPath, baseGrant());
    const { client } = await connectSdkClient({ grantPath, cwd: dir });

    try {
      const result = await client.callTool({
        name: 'guardrail_http_request',
        arguments: {
          url: 'https://example.com/',
          method: 'GET',
        },
      });
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.ok, false);
      assert.equal(payload.code, 'delegation_denied');
      assert.equal(payload.tool, 'guardrail_http_request');
      assert.match(payload.correction.expected, /loopback/);
    } finally {
      await client.close();
    }
  });

  it('denies tools outside the active grant', async () => {
    const dir = tmpDir();
    const grantPath = join(dir, 'grant.json');
    writeJson(grantPath, baseGrant());
    const runtime = createGuardrailMcpRuntime({ grantPath, cwd: dir, agent: 'codex' });

    const result = await runtime.callTool('guardrail_http_request', {
      url: 'https://example.com/',
      method: 'GET',
    });

    assert.equal(result.content[0].type, 'text');
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, 'delegation_denied');
    assert.equal(payload.tool, 'guardrail_http_request');
    assert.equal(typeof payload.grantHash, 'string');
    assert.equal(payload.grantHash.length, 64);
    assert.match(payload.correction.expected, /loopback/);
    await runtime.close();
  });

  it('uses delegated approval while preserving recipe supervisor manifests', async () => {
    const dir = tmpDir();
    mkdirSync(join(dir, 'recipes'), { recursive: true });
    const recipe = makeEchoRecipe();
    writeJson(join(dir, 'recipes', 'mcp-echo.recipe.json'), recipe);
    const grantPath = join(dir, 'grant.json');
    writeJson(grantPath, baseGrant({ recipeHash: hashRecipe(recipe) }));

    const runtime = createGuardrailMcpRuntime({ grantPath, cwd: dir, agent: 'codex' });
    const result = await runtime.callTool('guardrail_run_recipe', {
      recipe: 'mcp-echo',
      inputs: { message: 'hello' },
    });

    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, true, JSON.stringify(payload, null, 2));
    assert.equal(payload.result.status, 'success');
    assert.ok(existsSync(join(dir, '.guardrail', 'recipes', 'mcp-echo.approved.json')));

    const replay = await runRecipeSupervisor({
      specifier: 'mcp-echo',
      inputs: { message: 'hello' },
      cwd: dir,
      searchDirs: [join(dir, 'recipes')],
      nonInteractive: true,
      jsonOutput: true,
      allowUnverified: true,
    });
    assert.equal(replay.status, 'approval_required');
    assert.match(replay.reason, /active delegated grant/);
    await runtime.close();
  });

  it('rejects delegated recipe drift after the grant is issued', async () => {
    const dir = tmpDir();
    mkdirSync(join(dir, 'recipes'), { recursive: true });
    const original = makeEchoRecipe();
    const recipePath = join(dir, 'recipes', 'mcp-echo.recipe.json');
    writeJson(recipePath, original);
    const grantPath = join(dir, 'grant.json');
    writeJson(grantPath, baseGrant({ recipeHash: hashRecipe(original) }));

    const runtime = createGuardrailMcpRuntime({ grantPath, cwd: dir, agent: 'codex' });
    const first = await runtime.callTool('guardrail_run_recipe', {
      recipe: 'mcp-echo',
      inputs: { message: 'hello' },
    });
    assert.equal(JSON.parse(first.content[0].text).ok, true);

    writeJson(recipePath, makeEchoRecipe({ description: 'Changed after grant issuance' }));
    const drifted = await runtime.callTool('guardrail_run_recipe', {
      recipe: 'mcp-echo',
      inputs: { message: 'hello' },
    });
    const payload = JSON.parse(drifted.content[0].text);
    assert.equal(payload.ok, false);
    assert.equal(payload.result.status, 'policy_violation');
    assert.match(payload.result.reason, /recipe hash/);
    await runtime.close();
  });

  it('parses mcp serve flags with required values', () => {
    const parsed = parseArgs(['mcp', 'serve', '--grant', 'grant.json', '--agent', 'codex']);
    assert.equal(parsed.subcommand, 'mcp-serve');
    assert.equal(parsed.mcpOpts.grantPath, 'grant.json');
    assert.equal(parsed.mcpOpts.agent, 'codex');

    const missing = parseArgs(['mcp', 'serve', '--grant']);
    assert.equal(missing.error, 'usage');
    const consumedFlag = parseArgs(['mcp', 'serve', '--grant', '--agent', 'codex']);
    assert.equal(consumedFlag.error, 'usage');
  });
});

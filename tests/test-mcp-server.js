import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { createGuardrailMcpRuntime } from '../src/mcp-server.js';
import { runMcpStdioProbe } from '../src/adapter-mcp-stdio-probe.js';
import { hashRecipe } from '../src/recipe.js';
import { runRecipeSupervisor } from '../src/recipe-supervisor.js';
import { hashTemplateExecution, validateUserInputs, computeEnvIntersection } from '../src/template.js';
import { parseArgs } from '../src/cli.js';
import { approveRequest, loadRequest, saveRequest } from '../src/approval-queue.js';

function tmpDir() {
  return realpathSync.native(mkdtempSync(join(tmpdir(), 'gr-mcp-')));
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

function testGrantPath() {
  return join(tmpDir(), 'grant.json');
}

function createTestRuntime(options) {
  return createGuardrailMcpRuntime(options);
}

function baseGrant(overrides = {}) {
  const {
    recipeHash = 'a'.repeat(64),
    templateHash = 'd'.repeat(64),
    ...rest
  } = overrides;
  const grant = {
    version: 1,
    agent: 'codex',
    repo_path: '.',
    expires_at: '2999-01-01T00:00:00.000Z',
    tools: {
      guardrail_recipe_describe: {
        recipes: true,
      },
      guardrail_recipe_prepare: {
        recipes: {
          'mcp-echo': {
            inputs: {
              message: { exact: 'hello' },
            },
          },
        },
      },
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
      guardrail_template_describe: {
        templates: true,
      },
      guardrail_template_prepare: {
        templates: {
          'mcp-template': {
            inputs: {
              target: { exact: 'src' },
            },
          },
        },
      },
      guardrail_run_template: {
        templates: {
          'mcp-template': {
            template_hash: templateHash,
            inputs: {
              target: { exact: 'src' },
            },
          },
        },
      },
      guardrail_template: {
        actions: {
          describe: {
            templates: true,
          },
          prepare: {
            templates: {
              'mcp-template': {
                inputs: {
                  target: { exact: 'src' },
                },
              },
            },
          },
          request_approval: {
            templates: {
              'mcp-template': {
                inputs: {
                  target: { exact: 'src' },
                },
              },
            },
          },
          run: {
            templates: {
              'mcp-template': {
                template_hash: templateHash,
                inputs: {
                  target: { exact: 'src' },
                },
              },
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

function makeTemplate(overrides = {}) {
  return {
    version: 1,
    kind: 'template',
    name: 'mcp-template',
    description: 'Run a delegated MCP template',
    trust_class: 'reviewed_internal',
    risk: 'green',
    risk_reasons: [],
    inputs: {
      target: { type: 'string', pattern: '^src$' },
    },
    run: {
      command: process.execPath,
      args: ['-e', 'process.stdout.write(process.argv[1])', '{{inputs.target}}'],
      mode: 'structured',
      env: { allow: [] },
    },
    idempotent: true,
    ...overrides,
  };
}

function templateExecutionHash(template, inputs = { target: 'src' }, envAllow = []) {
  const validation = validateUserInputs(template.inputs, inputs);
  assert.equal(validation.valid, true, validation.errors.join('\n'));
  const env = computeEnvIntersection(template.requires_env || [], envAllow);
  return hashTemplateExecution(template, validation.values, env.intersection);
}

async function connectSdkClient({ grantPath, cwd, capabilities = {}, elicitationHandler = null }) {
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
    { capabilities },
  );
  if (elicitationHandler) {
    client.setRequestHandler(ElicitRequestSchema, elicitationHandler);
  }

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
    const grantPath = testGrantPath();
    writeJson(grantPath, baseGrant());
    const runtime = createTestRuntime({ grantPath, cwd: dir, agent: 'codex' });

    const result = await runtime.callTool('guardrail_grant_status');
    const payload = JSON.parse(result.content[0].text);

    assert.equal(payload.ok, true);
    assert.equal(payload.grant.ok, true);
    assert.deepEqual(payload.grant.capabilities.guardrail_http_request.policy.hosts, ['127.0.0.1', 'localhost']);
    assert.deepEqual(payload.grant.capabilities.guardrail_http_request.policy.ports, [4317]);
    assert.equal(payload.grant.capabilities.guardrail_run_recipe.policy.recipes[0].recipeHash, 'a'.repeat(64));
    assert.equal(payload.grant.capabilities.guardrail_run_template.policy.templates[0].templateHash, 'd'.repeat(64));
    assert.equal(payload.grant.capabilities.guardrail_template.policy.actions.run.policy.templates[0].templateHash, 'd'.repeat(64));
    assert.ok(payload.grant.toolInventory.callableTools.includes('guardrail_template'));
    assert.equal(payload.grant.tools.some((tool) => tool.startsWith('guardrail_git_')), false);
    assert.match(payload.grant.help.discovery, /instead of guessing/);
    assert.match(payload.grant.help.grantLocation, /outside the delegated repo_path/);
    assert.match(payload.grant.help.grantLocation, /per-repo\/per-agent/);
    assert.equal(payload.server.agent, 'codex');
    await runtime.close();
  });

  it('does not advertise grant-only stale tools as callable through grant status', async () => {
    const dir = tmpDir();
    const grantPath = testGrantPath();
    writeJson(grantPath, {
      ...baseGrant(),
      tools: {
        ...baseGrant().tools,
        guardrail_git_status: { repo_paths: ['.'] },
      },
    });
    const runtime = createTestRuntime({ grantPath, cwd: dir, agent: 'codex' });

    const result = await runtime.callTool('guardrail_grant_status');
    const payload = JSON.parse(result.content[0].text);

    assert.ok(payload.grant.grantDeclaredTools.includes('guardrail_git_status'));
    assert.ok(payload.grant.toolInventory.grantOnlyTools.includes('guardrail_git_status'));
    assert.equal(payload.grant.tools.includes('guardrail_git_status'), false);
    assert.equal('guardrail_git_status' in payload.grant.capabilities, false);
    assert.match(payload.grant.help.staleGrantEntries, /not exposed by this MCP server/);
    await runtime.close();
  });

  it('reports parent template as exposed but unavailable when the grant omits it', async () => {
    const dir = tmpDir();
    const grantPath = testGrantPath();
    const { guardrail_template, ...toolsWithoutParentTemplate } = baseGrant().tools;
    writeJson(grantPath, baseGrant({ tools: toolsWithoutParentTemplate }));
    const runtime = createTestRuntime({ grantPath, cwd: dir, agent: 'codex' });

    const result = await runtime.callTool('guardrail_grant_status');
    const payload = JSON.parse(result.content[0].text);

    assert.equal(guardrail_template.actions.run.templates['mcp-template'].template_hash, 'd'.repeat(64));
    assert.ok(payload.grant.toolInventory.exposedButNotGrantedTools.includes('guardrail_template'));
    assert.equal(payload.grant.tools.includes('guardrail_template'), false);
    assert.equal('guardrail_template' in payload.grant.capabilities, false);
    assert.match(payload.grant.help.moreInfo, /exposedButNotGrantedTools/);
    await runtime.close();
  });

  it('is discoverable over stdio', async () => {
    const root = tmpDir();
    const dir = join(root, 'repo');
    mkdirSync(dir, { recursive: true });
    const grantPath = join(root, 'grant.json');
    writeJson(grantPath, baseGrant());

    const probe = await runMcpStdioProbe({
      command: process.execPath,
      args: ['src/mcp-server.js', '--grant', grantPath, '--agent', 'codex', '--cwd', dir],
      cwd: process.cwd(),
    }, { timeoutMs: 30000 });

    let tools;
    if (probe.ok) {
      tools = probe.server.tools;
    } else if (probe.code === 'timeout') {
      const { client } = await connectSdkClient({ grantPath, cwd: dir });
      try {
        tools = (await client.listTools()).tools;
      } finally {
        await client.close();
      }
    } else {
      assert.equal(probe.ok, true, JSON.stringify(probe, null, 2));
    }

    assert.ok(tools.some((tool) => tool.name === 'guardrail_run_recipe'));
    assert.ok(tools.some((tool) => tool.name === 'guardrail_template_prepare'));
    assert.ok(tools.some((tool) => tool.name === 'guardrail_template'));
    assert.ok(tools.some((tool) => tool.name === 'guardrail_run_template'));
    assert.equal(tools.some((tool) => tool.name.startsWith('guardrail_git_')), false);
    const parentTemplate = tools.find((tool) => tool.name === 'guardrail_template');
    assert.equal('oneOf' in parentTemplate.inputSchema, false);
    assert.deepEqual(parentTemplate.inputSchema.properties.action.enum, ['describe', 'prepare', 'request_approval', 'run']);
  });

  it('initializes and discovers tools through the official MCP SDK client', async () => {
    const root = tmpDir();
    const dir = join(root, 'repo');
    mkdirSync(dir, { recursive: true });
    const grantPath = join(root, 'grant.json');
    writeJson(grantPath, baseGrant());
    const { client, stderr } = await connectSdkClient({ grantPath, cwd: dir });

    try {
      const tools = await client.listTools();
      const resources = await client.listResources();
      const templates = await client.listResourceTemplates();
      const prompts = await client.listPrompts();

      assert.ok(tools.tools.some((tool) => tool.name === 'guardrail_run_recipe'));
      assert.ok(tools.tools.some((tool) => tool.name === 'guardrail_recipe_prepare'));
      assert.ok(tools.tools.some((tool) => tool.name === 'guardrail_template_prepare'));
      assert.ok(tools.tools.some((tool) => tool.name === 'guardrail_template'));
      assert.deepEqual(resources.resources, []);
      assert.deepEqual(templates.resourceTemplates, []);
      assert.deepEqual(prompts.prompts, []);
      assert.equal(stderr(), '');
    } finally {
      await client.close();
    }
  });

  it('reports repo-local grant rejection through the stdio server', async () => {
    const dir = tmpDir();
    const grantPath = join(dir, 'grant.json');
    writeJson(grantPath, baseGrant());
    const { client } = await connectSdkClient({ grantPath, cwd: dir });

    try {
      const result = await client.callTool({
        name: 'guardrail_grant_status',
        arguments: {},
      });
      const payload = JSON.parse(result.content[0].text);

      assert.equal(payload.ok, true);
      assert.equal(payload.grant.ok, false);
      assert.match(payload.grant.errors.join(' '), /outside the delegated repo_path/);
      assert.match(payload.grant.errors.join(' '), /operator-controlled location/);
    } finally {
      await client.close();
    }
  });

  it('calls delegated tools through the official MCP SDK client', async () => {
    const root = tmpDir();
    const dir = join(root, 'repo');
    mkdirSync(dir, { recursive: true });
    const grantPath = join(root, 'grant.json');
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
    const grantPath = testGrantPath();
    writeJson(grantPath, baseGrant());
    const runtime = createTestRuntime({ grantPath, cwd: dir, agent: 'codex' });

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

  it('prepares recipes and templates without executing them', async () => {
    const dir = tmpDir();
    mkdirSync(join(dir, 'recipes'), { recursive: true });
    mkdirSync(join(dir, '.guardrail', 'templates'), { recursive: true });
    const recipe = makeEchoRecipe();
    const template = makeTemplate();
    writeJson(join(dir, 'recipes', 'mcp-echo.recipe.json'), recipe);
    writeJson(join(dir, '.guardrail', 'templates', 'mcp-template.json'), template);
    const grantPath = testGrantPath();
    writeJson(grantPath, baseGrant({ recipeHash: hashRecipe(recipe), templateHash: templateExecutionHash(template) }));

    const runtime = createTestRuntime({ grantPath, cwd: dir, agent: 'codex' });
    const recipeResult = await runtime.callTool('guardrail_recipe_prepare', {
      recipe: 'mcp-echo',
      inputs: { message: 'hello' },
    });
    const recipePayload = JSON.parse(recipeResult.content[0].text);
    assert.equal(recipePayload.ok, true);
    assert.equal(recipePayload.recipe.recipeHash, hashRecipe(recipe));
    assert.equal(recipePayload.dryRun.steps[0].args[2], 'hello');
    assert.equal(recipePayload.setup.grantSnippet.tools.guardrail_run_recipe.recipes['mcp-echo'].recipe_hash, hashRecipe(recipe));

    const templateResult = await runtime.callTool('guardrail_template_prepare', {
      template: 'mcp-template',
      inputs: { target: 'src' },
    });
    const templatePayload = JSON.parse(templateResult.content[0].text);
    assert.equal(templatePayload.ok, true);
    assert.equal(templatePayload.template.templateHash, templateExecutionHash(template));
    assert.match(templatePayload.simulation.output, /No processes were spawned/);
    assert.equal(templatePayload.setup.grantSnippet.tools.guardrail_run_template.templates['mcp-template'].template_hash, templateExecutionHash(template));
    assert.equal(templatePayload.setup.grantSnippet.tools.guardrail_template.actions.run.templates['mcp-template'].template_hash, templateExecutionHash(template));

    const parentDescribe = await runtime.callTool('guardrail_template', {
      action: 'describe',
    });
    const parentDescribePayload = JSON.parse(parentDescribe.content[0].text);
    assert.equal(parentDescribePayload.ok, true);
    assert.equal(parentDescribePayload.mode, 'list');

    const parentPrepare = await runtime.callTool('guardrail_template', {
      action: 'prepare',
      template: 'mcp-template',
      inputs: { target: 'src' },
    });
    const parentPreparePayload = JSON.parse(parentPrepare.content[0].text);
    assert.equal(parentPreparePayload.ok, true);
    assert.equal(parentPreparePayload.template.templateHash, templateExecutionHash(template));

    const parentBadArgs = await runtime.callTool('guardrail_template', {
      action: 'prepare',
      template: 'mcp-template',
      inputs: { target: 'src' },
      approval_request_id: 'not-valid-for-prepare',
    });
    const parentBadArgsPayload = JSON.parse(parentBadArgs.content[0].text);
    assert.equal(parentBadArgsPayload.ok, false);
    assert.equal(parentBadArgsPayload.code, 'delegation_denied');
    await runtime.close();
  });

  it('routes recipe execution through CLI approval requests', async () => {
    const dir = tmpDir();
    const approvalStateDir = tmpDir();
    mkdirSync(join(dir, 'recipes'), { recursive: true });
    const recipe = makeEchoRecipe();
    writeJson(join(dir, 'recipes', 'mcp-echo.recipe.json'), recipe);
    const grantPath = testGrantPath();
    writeJson(grantPath, {
      ...baseGrant(),
      tools: {
        guardrail_recipe_request_approval: { recipes: true, allow_unverified: true },
        guardrail_run_recipe: { recipes: true, allow_unverified: true },
      },
    });

    const runtime = createTestRuntime({ grantPath, cwd: dir, agent: 'codex', approvalStateDir });
    const requestResult = await runtime.callTool('guardrail_recipe_request_approval', {
      recipe: 'mcp-echo',
      inputs: { message: 'hello' },
      allow_unverified: true,
    });
    const requestPayload = JSON.parse(requestResult.content[0].text);
    assert.equal(requestPayload.ok, true, JSON.stringify(requestPayload, null, 2));
    assert.equal(requestPayload.request.status, 'pending');
    assert.match(requestPayload.commands.approve, /guardrail approve/);
    assert.match(requestPayload.commands.approve, /--state-dir/);

    const blocked = await runtime.callTool('guardrail_run_recipe', {
      recipe: 'mcp-echo',
      inputs: { message: 'hello' },
      allow_unverified: true,
      approval_request_id: requestPayload.request.id,
    });
    const blockedPayload = JSON.parse(blocked.content[0].text);
    assert.equal(blockedPayload.ok, false);
    assert.equal(blockedPayload.code, 'approval_request_denied');

    const request = loadRequest(requestPayload.request.id, approvalStateDir);
    approveRequest(request, 'human');
    saveRequest(request, approvalStateDir);

    const approved = await runtime.callTool('guardrail_run_recipe', {
      recipe: 'mcp-echo',
      inputs: { message: 'hello' },
      allow_unverified: true,
      approval_request_id: requestPayload.request.id,
    });
    const approvedPayload = JSON.parse(approved.content[0].text);
    assert.equal(approvedPayload.ok, true, JSON.stringify(approvedPayload, null, 2));
    assert.equal(approvedPayload.result.status, 'success');
    assert.ok(existsSync(join(dir, '.guardrail', 'recipes', 'mcp-echo.approved.json')));
    await runtime.close();
  });

  it('routes template execution through CLI approval requests', async () => {
    const dir = tmpDir();
    const approvalStateDir = tmpDir();
    mkdirSync(join(dir, '.guardrail', 'templates'), { recursive: true });
    const template = makeTemplate();
    writeJson(join(dir, '.guardrail', 'templates', 'mcp-template.json'), template);
    const grantPath = testGrantPath();
    writeJson(grantPath, {
      ...baseGrant(),
      tools: {
        guardrail_template_request_approval: { templates: true },
        guardrail_run_template: { templates: true },
      },
    });

    const runtime = createTestRuntime({ grantPath, cwd: dir, agent: 'codex', approvalStateDir });
    const requestResult = await runtime.callTool('guardrail_template_request_approval', {
      template: 'mcp-template',
      inputs: { target: 'src' },
    });
    const requestPayload = JSON.parse(requestResult.content[0].text);
    assert.equal(requestPayload.ok, true, JSON.stringify(requestPayload, null, 2));
    assert.equal(requestPayload.request.status, 'pending');
    assert.match(requestPayload.commands.approve, /guardrail approve/);

    const request = loadRequest(requestPayload.request.id, approvalStateDir);
    approveRequest(request, 'human');
    saveRequest(request, approvalStateDir);

    const approved = await runtime.callTool('guardrail_run_template', {
      template: 'mcp-template',
      inputs: { target: 'src' },
      approval_request_id: requestPayload.request.id,
    });
    const approvedPayload = JSON.parse(approved.content[0].text);
    assert.equal(approvedPayload.ok, true, JSON.stringify(approvedPayload, null, 2));
    assert.equal(approvedPayload.result.status, 'success');
    assert.ok(existsSync(join(dir, '.guardrail', 'templates', 'mcp-template.approved.json')));
    await runtime.close();
  });

  it('routes parent template actions through CLI approval requests', async () => {
    const dir = tmpDir();
    const approvalStateDir = tmpDir();
    mkdirSync(join(dir, '.guardrail', 'templates'), { recursive: true });
    const template = makeTemplate();
    writeJson(join(dir, '.guardrail', 'templates', 'mcp-template.json'), template);
    const grantPath = testGrantPath();
    writeJson(grantPath, {
      ...baseGrant(),
      tools: {
        guardrail_template: {
          actions: {
            request_approval: { templates: true },
            run: { templates: true },
          },
        },
      },
    });

    const runtime = createTestRuntime({ grantPath, cwd: dir, agent: 'codex', approvalStateDir });
    const requestResult = await runtime.callTool('guardrail_template', {
      action: 'request_approval',
      template: 'mcp-template',
      inputs: { target: 'src' },
    });
    const requestPayload = JSON.parse(requestResult.content[0].text);
    assert.equal(requestPayload.ok, true, JSON.stringify(requestPayload, null, 2));
    assert.equal(requestPayload.request.status, 'pending');
    assert.equal(requestPayload.request.tool, 'guardrail_run_template');

    const request = loadRequest(requestPayload.request.id, approvalStateDir);
    approveRequest(request, 'human');
    saveRequest(request, approvalStateDir);

    const approved = await runtime.callTool('guardrail_template', {
      action: 'run',
      template: 'mcp-template',
      inputs: { target: 'src' },
      approval_request_id: requestPayload.request.id,
    });
    const approvedPayload = JSON.parse(approved.content[0].text);
    assert.equal(approvedPayload.ok, true, JSON.stringify(approvedPayload, null, 2));
    assert.equal(approvedPayload.result.status, 'success');
    assert.ok(existsSync(join(dir, '.guardrail', 'templates', 'mcp-template.approved.json')));
    await runtime.close();
  });

  it('fails closed when host elicitation is unavailable for unpinned recipe execution', async () => {
    const dir = tmpDir();
    mkdirSync(join(dir, 'recipes'), { recursive: true });
    const recipe = makeEchoRecipe();
    writeJson(join(dir, 'recipes', 'mcp-echo.recipe.json'), recipe);
    const grantPath = testGrantPath();
    writeJson(grantPath, {
      ...baseGrant(),
      tools: {
        guardrail_run_recipe: { recipes: true, allow_unverified: true },
      },
    });

    const runtime = createTestRuntime({ grantPath, cwd: dir, agent: 'codex' });
    const result = await runtime.callTool('guardrail_run_recipe', {
      recipe: 'mcp-echo',
      inputs: { message: 'hello' },
      allow_unverified: true,
      host_approval: 'approve',
    });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, 'host_approval_unavailable');
    assert.equal(payload.approvalSubject.tool, 'guardrail_run_recipe');
    assert.equal(payload.approvalSubject.recipe_hash, hashRecipe(recipe));
    assert.deepEqual(payload.approvalSubject.inputs, { message: 'hello' });
    assert.ok(!existsSync(join(dir, '.guardrail', 'recipes', 'mcp-echo.approved.json')));
    await runtime.close();
  });

  it('fails closed on malformed host elicitation approval responses', async () => {
    const dir = tmpDir();
    mkdirSync(join(dir, 'recipes'), { recursive: true });
    const recipe = makeEchoRecipe();
    writeJson(join(dir, 'recipes', 'mcp-echo.recipe.json'), recipe);
    const grantPath = testGrantPath();
    writeJson(grantPath, {
      ...baseGrant(),
      tools: {
        guardrail_run_recipe: { recipes: true, allow_unverified: true },
      },
    });

    const runtime = createTestRuntime({ grantPath, cwd: dir, agent: 'codex' });
    const result = await runtime.callTool('guardrail_run_recipe', {
      recipe: 'mcp-echo',
      inputs: { message: 'hello' },
      allow_unverified: true,
    }, {
      elicitInput: async () => ({ action: 'accept', content: { decision: 'maybe' } }),
    });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, 'host_approval_invalid');
    assert.equal(payload.approvalSubject.tool, 'guardrail_run_recipe');
    assert.ok(!existsSync(join(dir, '.guardrail', 'recipes', 'mcp-echo.approved.json')));
    await runtime.close();
  });

  it('routes unpinned recipe execution through MCP host elicitation', async () => {
    const root = tmpDir();
    const dir = join(root, 'repo');
    mkdirSync(join(dir, 'recipes'), { recursive: true });
    const recipe = makeEchoRecipe();
    writeJson(join(dir, 'recipes', 'mcp-echo.recipe.json'), recipe);
    const grantPath = join(root, 'grant.json');
    writeJson(grantPath, {
      ...baseGrant(),
      tools: {
        guardrail_run_recipe: { recipes: true, allow_unverified: true },
      },
    });
    const prompts = [];
    const { client } = await connectSdkClient({
      grantPath,
      cwd: dir,
      capabilities: { elicitation: { form: {} } },
      elicitationHandler: async (request) => {
        prompts.push(request.params);
        return { action: 'accept', content: { decision: 'approve' } };
      },
    });

    try {
      const result = await client.callTool({
        name: 'guardrail_run_recipe',
        arguments: {
          recipe: 'mcp-echo',
          inputs: { message: 'hello' },
          allow_unverified: true,
        },
      });
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.ok, true, JSON.stringify(payload, null, 2));
      assert.equal(payload.result.status, 'success');
      assert.equal(prompts.length, 1);
      assert.deepEqual(prompts[0].requestedSchema.properties.decision.enum, ['approve', 'decline']);
      const subject = JSON.parse(prompts[0].message.slice(prompts[0].message.indexOf('{')));
      assert.equal(subject.tool, 'guardrail_run_recipe');
      assert.equal(subject.repo_path, dir);
      assert.equal(subject.recipe, 'mcp-echo');
      assert.equal(subject.recipe_hash, hashRecipe(recipe));
      assert.deepEqual(subject.inputs, { message: 'hello' });
      assert.match(subject.manifest_path, /mcp-echo\.approved\.json$/);
      assert.equal(subject.risk.level, 'low');
      assert.ok(Array.isArray(subject.setup.requires_env));
      assert.ok(Array.isArray(subject.setup.requires_auth));
      assert.ok(Array.isArray(subject.setup.dry_run_steps));
      assert.ok(existsSync(join(dir, '.guardrail', 'recipes', 'mcp-echo.approved.json')));
    } finally {
      await client.close();
    }
  });

  it('routes unpinned template execution through MCP host elicitation and fails closed on decline', async () => {
    const dir = tmpDir();
    mkdirSync(join(dir, '.guardrail', 'templates'), { recursive: true });
    const template = makeTemplate({ requires_env: ['NPM_TOKEN'], risk: 'yellow', risk_reasons: ['uses env'] });
    writeJson(join(dir, '.guardrail', 'templates', 'mcp-template.json'), template);
    const grantPath = testGrantPath();
    writeJson(grantPath, {
      ...baseGrant(),
      tools: {
        guardrail_template: {
          actions: {
            run: { templates: true },
          },
        },
      },
    });

    const runtime = createTestRuntime({ grantPath, cwd: dir, agent: 'codex' });
    const prompts = [];
    const approved = await runtime.callTool('guardrail_template', {
      action: 'run',
      template: 'mcp-template',
      inputs: { target: 'src' },
      env_allow: ['NPM_TOKEN'],
    }, {
      elicitInput: async (params) => {
        prompts.push(params);
        return { action: 'accept', content: { decision: 'approve' } };
      },
    });
    const approvedPayload = JSON.parse(approved.content[0].text);
    assert.equal(approvedPayload.ok, true, JSON.stringify(approvedPayload, null, 2));
    assert.equal(approvedPayload.result.status, 'success');
    const subject = JSON.parse(prompts[0].message.slice(prompts[0].message.indexOf('{')));
    assert.equal(subject.tool, 'guardrail_run_template');
    assert.equal(subject.template_name, 'mcp-template');
    assert.equal(subject.template_hash, templateExecutionHash(template, { target: 'src' }, ['NPM_TOKEN']));
    assert.deepEqual(subject.inputs, { target: 'src' });
    assert.deepEqual(subject.env_allow, ['NPM_TOKEN']);
    assert.match(subject.manifest_path, /mcp-template\.approved\.json$/);
    assert.ok(subject.risk);
    assert.ok(Array.isArray(subject.setup.simulation_steps));

    const declinedDir = tmpDir();
    mkdirSync(join(declinedDir, '.guardrail', 'templates'), { recursive: true });
    writeJson(join(declinedDir, '.guardrail', 'templates', 'mcp-template.json'), template);
    const declinedRuntime = createTestRuntime({ grantPath, cwd: declinedDir, agent: 'codex' });
    const declined = await declinedRuntime.callTool('guardrail_template', {
      action: 'run',
      template: 'mcp-template',
      inputs: { target: 'src' },
      env_allow: ['NPM_TOKEN'],
    }, {
      elicitInput: async () => ({ action: 'decline' }),
    });
    const declinedPayload = JSON.parse(declined.content[0].text);
    assert.equal(declinedPayload.ok, false);
    assert.equal(declinedPayload.code, 'host_approval_denied');
    assert.ok(!existsSync(join(declinedDir, '.guardrail', 'templates', 'mcp-template.approved.json')));
    await runtime.close();
    await declinedRuntime.close();
  });

  it('uses delegated approval while preserving recipe supervisor manifests', async () => {
    const dir = tmpDir();
    mkdirSync(join(dir, 'recipes'), { recursive: true });
    const recipe = makeEchoRecipe();
    writeJson(join(dir, 'recipes', 'mcp-echo.recipe.json'), recipe);
    const grantPath = testGrantPath();
    writeJson(grantPath, baseGrant({ recipeHash: hashRecipe(recipe) }));

    const runtime = createTestRuntime({ grantPath, cwd: dir, agent: 'codex' });
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

  it('uses delegated approval while preserving template supervisor manifests', async () => {
    const dir = tmpDir();
    mkdirSync(join(dir, '.guardrail', 'templates'), { recursive: true });
    const template = makeTemplate();
    const templatePath = join(dir, '.guardrail', 'templates', 'mcp-template.json');
    writeJson(templatePath, template);
    const grantPath = testGrantPath();
    writeJson(grantPath, baseGrant({ templateHash: templateExecutionHash(template) }));

    const runtime = createTestRuntime({ grantPath, cwd: dir, agent: 'codex' });
    const result = await runtime.callTool('guardrail_run_template', {
      template: 'mcp-template',
      inputs: { target: 'src' },
    });

    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, true, JSON.stringify(payload, null, 2));
    assert.equal(payload.result.status, 'success');
    assert.ok(existsSync(join(dir, '.guardrail', 'templates', 'mcp-template.approved.json')));
    await runtime.close();
  });

  it('executes delegated templates from the delegated repo path', async () => {
    const dir = tmpDir();
    mkdirSync(join(dir, '.guardrail', 'templates'), { recursive: true });
    mkdirSync(join(dir, 'artifacts'), { recursive: true });
    const template = makeTemplate({
      run: {
        command: process.execPath,
        args: [
          '-e',
          'require("node:fs").writeFileSync("artifacts/template-cwd.txt", process.cwd())',
        ],
        mode: 'structured',
        env: { allow: [] },
      },
    });
    writeJson(join(dir, '.guardrail', 'templates', 'mcp-template.json'), template);
    const grantPath = testGrantPath();
    writeJson(grantPath, baseGrant({ templateHash: templateExecutionHash(template) }));

    const runtime = createTestRuntime({ grantPath, cwd: dir, agent: 'codex' });
    const result = await runtime.callTool('guardrail_run_template', {
      template: 'mcp-template',
      inputs: { target: 'src' },
    });

    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, true, JSON.stringify(payload, null, 2));
    assert.equal(payload.result.status, 'success');
    assert.equal(readFileSync(join(dir, 'artifacts', 'template-cwd.txt'), 'utf8'), dir);
    await runtime.close();
  });

  it('rejects delegated recipe drift after the grant is issued', async () => {
    const dir = tmpDir();
    mkdirSync(join(dir, 'recipes'), { recursive: true });
    const original = makeEchoRecipe();
    const recipePath = join(dir, 'recipes', 'mcp-echo.recipe.json');
    writeJson(recipePath, original);
    const grantPath = testGrantPath();
    writeJson(grantPath, baseGrant({ recipeHash: hashRecipe(original) }));

    const runtime = createTestRuntime({ grantPath, cwd: dir, agent: 'codex' });
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

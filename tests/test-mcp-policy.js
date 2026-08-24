import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describeDelegatedGrant, loadDelegatedGrant, evaluateDelegatedTool } from '../src/delegated-policy.js';
import { listGuardrailMcpTools } from '../src/mcp-tools.js';

function tmpDir() {
  return realpathSync.native(mkdtempSync(join(tmpdir(), 'gr-mcp-policy-')));
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

function testGrantPath() {
  return join(tmpDir(), 'grant.json');
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
            inputs: { message: { exact: 'hello' } },
          },
        },
      },
      guardrail_run_recipe: {
        recipes: {
          'mcp-echo': {
            allow_unverified: true,
            recipe_hash: recipeHash,
            inputs: { message: { exact: 'hello' } },
          },
        },
      },
      guardrail_template_describe: {
        templates: true,
      },
      guardrail_template_prepare: {
        templates: {
          'mcp-template': {
            inputs: { target: { exact: 'src' } },
            env_allow: ['NPM_TOKEN'],
          },
        },
      },
      guardrail_run_template: {
        templates: {
          'mcp-template': {
            template_hash: templateHash,
            inputs: { target: { exact: 'src' } },
            env_allow: ['NPM_TOKEN'],
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
                inputs: { target: { exact: 'src' } },
                env_allow: ['NPM_TOKEN'],
              },
            },
          },
          request_approval: {
            templates: {
              'mcp-template': {
                inputs: { target: { exact: 'src' } },
                env_allow: ['NPM_TOKEN'],
              },
            },
          },
          run: {
            templates: {
              'mcp-template': {
                template_hash: templateHash,
                inputs: { target: { exact: 'src' } },
                env_allow: ['NPM_TOKEN'],
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

describe('delegated MCP policy', () => {
  it('describes grant capabilities and help for agent discovery', () => {
    const dir = tmpDir();
    const grantPath = testGrantPath();
    writeJson(grantPath, baseGrant());
    const grantState = loadDelegatedGrant(grantPath, { cwd: dir });

    const status = describeDelegatedGrant(grantState, { now: '2026-01-01T00:00:00.000Z' });

    assert.equal(status.ok, true);
    assert.ok(status.tools.includes('guardrail_http_request'));
    assert.deepEqual(status.capabilities.guardrail_http_request.policy.hosts, ['127.0.0.1', 'localhost']);
    assert.deepEqual(status.capabilities.guardrail_http_request.policy.ports, [4317]);
    assert.deepEqual(status.capabilities.guardrail_http_request.policy.methods, ['GET']);
    assert.equal(status.capabilities.guardrail_http_request.policy.maxBodyBytes, 128);
    assert.equal(status.capabilities.guardrail_run_recipe.policy.recipes[0].recipeHash, 'a'.repeat(64));
    assert.equal(status.capabilities.guardrail_recipe_describe.policy.recipes, 'all');
    assert.equal(status.capabilities.guardrail_run_template.policy.templates[0].templateHash, 'd'.repeat(64));
    assert.equal(status.capabilities.guardrail_template.policy.actions.run.policy.templates[0].templateHash, 'd'.repeat(64));
    assert.equal(status.capabilities.guardrail_template.policy.actions.run.legacyAlias, 'guardrail_run_template');
    assert.deepEqual(status.capabilities.guardrail_template_prepare.policy.templates[0].envAllow, ['NPM_TOKEN']);
    assert.equal(status.tools.some((tool) => tool.startsWith('guardrail_git_')), false);
    assert.ok(status.toolInventory.callableTools.includes('guardrail_template'));
    assert.match(status.help.discovery, /guardrail_grant_status/);
    assert.match(status.help.moreInfo, /recipe\/template describe and prepare/);
  });

  it('uses a flat parent template schema for MCP client compatibility', () => {
    const tools = listGuardrailMcpTools();
    const parent = tools.find((tool) => tool.name === 'guardrail_template');

    assert.ok(parent);
    assert.equal(parent.inputSchema.type, 'object');
    assert.equal('oneOf' in parent.inputSchema, false);
    assert.deepEqual(parent.inputSchema.properties.action.enum, ['describe', 'prepare', 'request_approval', 'run']);
    assert.deepEqual(parent.inputSchema.required, ['action']);
    assert.equal(parent.inputSchema.additionalProperties, false);
  });

  it('separates callable MCP tools from stale grant-only entries', () => {
    const dir = tmpDir();
    const grantPath = testGrantPath();
    writeJson(grantPath, baseGrant({
      tools: {
        ...baseGrant().tools,
        guardrail_git_status: { repo_paths: ['.'] },
      },
    }));
    const grantState = loadDelegatedGrant(grantPath, { cwd: dir });

    const status = describeDelegatedGrant(grantState, { now: '2026-01-01T00:00:00.000Z' });

    assert.equal(status.ok, true);
    assert.ok(status.grantDeclaredTools.includes('guardrail_git_status'));
    assert.ok(status.toolInventory.grantOnlyTools.includes('guardrail_git_status'));
    assert.equal(status.tools.includes('guardrail_git_status'), false);
    assert.equal('guardrail_git_status' in status.capabilities, false);
    assert.match(status.help.staleGrantEntries, /not exposed by this MCP server/);
  });

  it('reports exposed tools that are unavailable under the active grant', () => {
    const dir = tmpDir();
    const grantPath = testGrantPath();
    const { guardrail_template, ...toolsWithoutParentTemplate } = baseGrant().tools;
    writeJson(grantPath, baseGrant({ tools: toolsWithoutParentTemplate }));
    const grantState = loadDelegatedGrant(grantPath, { cwd: dir });

    const status = describeDelegatedGrant(grantState, { now: '2026-01-01T00:00:00.000Z' });

    assert.equal(status.ok, true);
    assert.equal(guardrail_template.actions.run.templates['mcp-template'].template_hash, 'd'.repeat(64));
    assert.ok(status.toolInventory.exposedButNotGrantedTools.includes('guardrail_template'));
    assert.equal(status.tools.includes('guardrail_template'), false);
    assert.equal('guardrail_template' in status.capabilities, false);
    assert.match(status.help.moreInfo, /exposedButNotGrantedTools/);
  });

  it('loads a grant and allows constrained tool calls', () => {
    const dir = tmpDir();
    const grantPath = testGrantPath();
    writeJson(grantPath, baseGrant());
    const grantState = loadDelegatedGrant(grantPath, { cwd: dir });

    assert.equal(grantState.ok, true);
    const allowed = evaluateDelegatedTool(
      { grantState, cwd: dir, agent: 'codex' },
      'guardrail_run_recipe',
      { recipe: 'mcp-echo', inputs: { message: 'hello' }, repo_path: '.' },
    );
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.allowUnverified, true);

    const preparedRecipe = evaluateDelegatedTool(
      { grantState, cwd: dir, agent: 'codex' },
      'guardrail_recipe_prepare',
      { recipe: 'mcp-echo', inputs: { message: 'hello' }, repo_path: '.' },
    );
    assert.equal(preparedRecipe.allowed, true);

    const preparedTemplate = evaluateDelegatedTool(
      { grantState, cwd: dir, agent: 'codex' },
      'guardrail_template_prepare',
      { template: 'mcp-template', inputs: { target: 'src' }, env_allow: ['NPM_TOKEN'], repo_path: '.' },
    );
    assert.equal(preparedTemplate.allowed, true);

    const templateRun = evaluateDelegatedTool(
      { grantState, cwd: dir, agent: 'codex' },
      'guardrail_run_template',
      { template: 'mcp-template', inputs: { target: 'src' }, env_allow: ['NPM_TOKEN'], repo_path: '.' },
    );
    assert.equal(templateRun.allowed, true);
    assert.equal(templateRun.templateHash, 'd'.repeat(64));

    const parentTemplatePrepare = evaluateDelegatedTool(
      { grantState, cwd: dir, agent: 'codex' },
      'guardrail_template',
      { action: 'prepare', template: 'mcp-template', inputs: { target: 'src' }, env_allow: ['NPM_TOKEN'], repo_path: '.' },
    );
    assert.equal(parentTemplatePrepare.allowed, true);
    assert.equal(parentTemplatePrepare.action, 'prepare');

    const parentTemplateRun = evaluateDelegatedTool(
      { grantState, cwd: dir, agent: 'codex' },
      'guardrail_template',
      { action: 'run', template: 'mcp-template', inputs: { target: 'src' }, env_allow: ['NPM_TOKEN'], repo_path: '.' },
    );
    assert.equal(parentTemplateRun.allowed, true);
    assert.equal(parentTemplateRun.action, 'run');
    assert.equal(parentTemplateRun.templateHash, 'd'.repeat(64));

    const badTemplateAction = evaluateDelegatedTool(
      { grantState, cwd: dir, agent: 'codex' },
      'guardrail_template',
      { action: 'delete', template: 'mcp-template', repo_path: '.' },
    );
    assert.equal(badTemplateAction.allowed, false);
    assert.match(badTemplateAction.reason, /action/);
  });

  it('allows run tools through an approved CLI request id without hash-pinning the grant', () => {
    const dir = tmpDir();
    const grantPath = testGrantPath();
    writeJson(grantPath, baseGrant({
      tools: {
        guardrail_run_recipe: { recipes: true, allow_unverified: true },
        guardrail_run_template: { templates: true },
      },
    }));
    const grantState = loadDelegatedGrant(grantPath, { cwd: dir });
    const context = { grantState, cwd: dir, agent: 'codex' };

    const recipeRun = evaluateDelegatedTool(context, 'guardrail_run_recipe', {
      recipe: 'mcp-echo',
      inputs: { message: 'hello' },
      allow_unverified: true,
      approval_request_id: 'req-123',
    });
    assert.equal(recipeRun.allowed, true);
    assert.equal(recipeRun.approvalMode, 'approval_request');
    assert.equal(recipeRun.approvalRequestId, 'req-123');
    assert.equal(recipeRun.recipeHash, null);

    const templateRun = evaluateDelegatedTool(context, 'guardrail_run_template', {
      template: 'mcp-template',
      inputs: { target: 'src' },
      approval_request_id: 'req-456',
    });
    assert.equal(templateRun.allowed, true);
    assert.equal(templateRun.approvalMode, 'approval_request');
    assert.equal(templateRun.approvalRequestId, 'req-456');
    assert.equal(templateRun.templateHash, null);
  });

  it('requires host elicitation for unpinned delegated run tools without CLI approval', () => {
    const dir = tmpDir();
    const grantPath = testGrantPath();
    writeJson(grantPath, baseGrant({
      tools: {
        guardrail_run_recipe: { recipes: true, allow_unverified: true },
        guardrail_run_template: { templates: true },
      },
    }));
    const grantState = loadDelegatedGrant(grantPath, { cwd: dir });
    const context = { grantState, cwd: dir, agent: 'codex' };

    const recipeRun = evaluateDelegatedTool(context, 'guardrail_run_recipe', {
      recipe: 'mcp-echo',
      inputs: { message: 'hello' },
      allow_unverified: true,
    });
    assert.equal(recipeRun.allowed, true);
    assert.equal(recipeRun.approvalMode, 'host_elicitation');
    assert.equal(recipeRun.recipeHash, null);

    const templateRun = evaluateDelegatedTool(context, 'guardrail_run_template', {
      template: 'mcp-template',
      inputs: { target: 'src' },
    });
    assert.equal(templateRun.allowed, true);
    assert.equal(templateRun.approvalMode, 'host_elicitation');
    assert.equal(templateRun.templateHash, null);
  });

  it('denies undelegated inputs, remote HTTP, env widening, and resource widening', () => {
    const dir = tmpDir();
    const grantPath = testGrantPath();
    writeJson(grantPath, baseGrant());
    const grantState = loadDelegatedGrant(grantPath, { cwd: dir });
    const context = { grantState, cwd: dir, agent: 'codex' };

    const badInput = evaluateDelegatedTool(context, 'guardrail_run_recipe', {
      recipe: 'mcp-echo',
      inputs: { message: 'goodbye' },
    });
    assert.equal(badInput.allowed, false);
    assert.match(badInput.reason, /outside delegated constraints/);

    const remote = evaluateDelegatedTool(context, 'guardrail_http_request', {
      url: 'https://example.com/',
      method: 'GET',
    });
    assert.equal(remote.allowed, false);
    assert.match(remote.reason, /loopback/);
    assert.match(remote.correction.expected, /loopback/);

    const envWidening = evaluateDelegatedTool(context, 'guardrail_run_template', {
      template: 'mcp-template',
      inputs: { target: 'src' },
      env_allow: ['NPM_TOKEN', 'AWS_SECRET_ACCESS_KEY'],
    });
    assert.equal(envWidening.allowed, false);
    assert.match(envWidening.reason, /env_allow/);

    const longHttp = evaluateDelegatedTool(context, 'guardrail_http_request', {
      url: 'http://127.0.0.1:4317/',
      method: 'GET',
      timeout_ms: 6000,
    });
    assert.equal(longHttp.allowed, false);
    assert.match(longHttp.reason, /timeout_ms/);
    assert.match(longHttp.correction.expected, /5000 or less/);
  });

  it('denies expired grants, agent mismatch, and symlink repo escape', () => {
    const dir = tmpDir();
    const outside = tmpDir();
    symlinkSync(outside, join(dir, 'outside-link'), 'dir');
    const grantPath = testGrantPath();

    writeJson(grantPath, baseGrant({ expires_at: '2000-01-01T00:00:00.000Z' }));
    const expiredGrant = loadDelegatedGrant(grantPath, { cwd: dir });
    const expired = evaluateDelegatedTool(
      { grantState: expiredGrant, cwd: dir, agent: 'codex' },
      'guardrail_recipe_describe',
      { repo_path: '.' },
    );
    assert.equal(expired.allowed, false);
    assert.match(expired.reason, /expired/);

    writeJson(grantPath, baseGrant({ agent: 'other-agent' }));
    const agentGrant = loadDelegatedGrant(grantPath, { cwd: dir });
    const wrongAgent = evaluateDelegatedTool(
      { grantState: agentGrant, cwd: dir, agent: 'codex' },
      'guardrail_recipe_describe',
      { repo_path: '.' },
    );
    assert.equal(wrongAgent.allowed, false);
    assert.match(wrongAgent.reason, /other-agent/);

    writeJson(grantPath, baseGrant());
    const symlinkGrant = loadDelegatedGrant(grantPath, { cwd: dir });
    const escape = evaluateDelegatedTool(
      { grantState: symlinkGrant, cwd: dir, agent: 'codex' },
      'guardrail_recipe_describe',
      { repo_path: 'outside-link' },
    );
    assert.equal(escape.allowed, false);
    assert.match(escape.reason, /outside delegated root/);
  });

  it('rejects grants stored inside the delegated repo root by default', () => {
    const dir = tmpDir();
    const grantPath = join(dir, 'grant.json');
    writeJson(grantPath, baseGrant());

    const grantState = loadDelegatedGrant(grantPath, { cwd: dir });

    assert.equal(grantState.ok, false);
    assert.match(grantState.errors.join(' '), /outside the delegated repo_path/);
    assert.match(grantState.errors.join(' '), /operator-controlled location/);
  });

  it('rejects repo-local grants even when the grant narrows repo_path', () => {
    const dir = tmpDir();
    mkdirSync(join(dir, 'src'), { recursive: true });
    const grantPath = join(dir, 'grant.json');
    writeJson(grantPath, baseGrant({ repo_path: 'src' }));

    const grantState = loadDelegatedGrant(grantPath, { cwd: dir });

    assert.equal(grantState.ok, false);
    assert.match(grantState.errors.join(' '), /outside the MCP server working directory/);
    assert.match(grantState.errors.join(' '), /operator-controlled location/);
  });

  it('rejects repo-local grant symlinks even when their target is outside the repo', () => {
    const dir = tmpDir();
    const outside = tmpDir();
    const targetPath = join(outside, 'grant.json');
    const grantPath = join(dir, 'grant-link.json');
    writeJson(targetPath, baseGrant());
    symlinkSync(targetPath, grantPath);

    const grantState = loadDelegatedGrant(grantPath, { cwd: dir });

    assert.equal(grantState.ok, false);
    assert.match(grantState.errors.join(' '), /outside the (delegated repo_path|MCP server working directory)/);
    assert.match(grantState.errors.join(' '), /operator-controlled location/);
  });
});

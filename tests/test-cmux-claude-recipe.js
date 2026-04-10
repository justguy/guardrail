import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { loadRecipe } from '../src/recipe.js';
import { runRecipeSupervisor } from '../src/recipe-supervisor.js';
import {
  parseWrapperArgs,
  decodeExecContract,
  renderExecCommand,
  buildWrappedSurfaceCommand,
  parseWorkspaceRef,
  parseSurfaceRef,
  extractExecExitCode,
  runCmuxClaudeRecipe,
} from '../src/cmux-claude-recipe-wrapper.js';

const HOST_BOUNDARY_WARNING = 'Guardrail does not sandbox host execution; this wrapper relies on the tool/runtime permission model';

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'gr-cmux-recipe-'));
}

function exactSearchDirs(basePath, dirs) {
  return {
    explicitSearchDirs: dirs,
    basePath,
    includeDefaults: false,
    repoConfigPath: false,
    userConfigPath: false,
  };
}

function seedPromptFixture(dir) {
  const promptDir = join(dir, '.guardrail', 'prompts');
  mkdirSync(promptDir, { recursive: true });
  writeFileSync(join(promptDir, 'claude-math-problem.txt'), '2x3=?\n');
}

function encodeContract(contract) {
  return Buffer.from(JSON.stringify(contract), 'utf8').toString('base64');
}

describe('CMUX Claude recipe', () => {
  it('loads the cmux claude exec recipe', () => {
    const recipe = loadRecipe(join(process.cwd(), 'recipes', 'cmux-claude-exec.recipe.json'));
    assert.equal(recipe.id, 'cmux-claude-exec');
    assert.equal(recipe.version, '1.0.0');
    assert.equal(recipe.steps.length, 1);
    assert.equal(recipe.risk_level, 'high');
    assert.ok(Array.isArray(recipe.requires_env));
    assert.ok(recipe.steps[0].composed_recipe);
    assert.equal(recipe.steps[0].composed_recipe.recipe, 'claude-exec');
    assert.equal(recipe.inputs.prompt.approval_mode, 'interactive_message');
    assert.ok(
      recipe.guardrails?.constraints?.some((line) => line.includes('same Guardrail approval unit')),
    );
    assert.ok(
      recipe.guardrails?.constraints?.some((line) => line.includes('bounded auth preflight inside the hosted runtime')),
    );
  });

  it('parses wrapper args by flag name', () => {
    const parsed = parseWrapperArgs([
      '--socket-path', '/tmp/cmux.sock',
      '--workspace-name', 'Claude Smoke',
      '--launch-cwd', '.',
      '--exec-contract-b64', 'eyJjb21tYW5kIjoibm9kZSJ9',
      '--capture-lines', '80',
      '--capture-delay-ms', '500',
      '--poll-interval-ms', '250',
      '--wait-timeout-ms', '3000',
    ]);

    assert.equal(parsed.socketPath, '/tmp/cmux.sock');
    assert.equal(parsed.workspaceName, 'Claude Smoke');
    assert.equal(parsed.launchCwd, '.');
    assert.equal(parsed.execContractB64, 'eyJjb21tYW5kIjoibm9kZSJ9');
    assert.equal(parsed.captureLines, '80');
    assert.equal(parsed.captureDelayMs, '500');
    assert.equal(parsed.pollIntervalMs, '250');
    assert.equal(parsed.waitTimeoutMs, '3000');
  });

  it('decodes the hosted exec contract payload', () => {
    const contract = decodeExecContract(encodeContract({
      command: 'node',
      args: ['./src/claude-exec-wrapper.js', '--prompt', 'Solve it'],
      cwd: '/tmp/work',
      envPolicy: {
        allow: ['HOME', 'PATH'],
        inject: {},
      },
      authPreflight: {
        requirements: [{ type: 'claude_login' }],
      },
    }));

    assert.equal(contract.command, 'node');
    assert.deepEqual(contract.args, ['./src/claude-exec-wrapper.js', '--prompt', 'Solve it']);
    assert.equal(contract.cwd, '/tmp/work');
    assert.deepEqual(contract.authPreflight, { requirements: [{ type: 'claude_login' }] });
  });

  it('renders the hosted exec command with env isolation and exit sentinel', () => {
    const command = buildWrappedSurfaceCommand({
      command: 'node',
      args: ['./src/claude-exec-wrapper.js', '--prompt', "what's 2x3?"],
      cwd: '/tmp/work',
      envPolicy: {
        allow: ['PATH', 'HOME'],
        inject: { CUSTOM_FLAG: 'on' },
      },
    });

    assert.ok(command.includes("cd '/tmp/work' && env -i PATH=\"$PATH\" HOME=\"$HOME\" CUSTOM_FLAG='on' 'node' './src/claude-exec-wrapper.js' '--prompt' 'what'\\''s 2x3?'"));
    assert.ok(command.includes('[guardrail-exec-exit:'));
  });

  it('can parse workspace/surface refs and hosted exit code', () => {
    assert.equal(parseWorkspaceRef('OK workspace:12\n'), 'workspace:12');
    assert.equal(parseSurfaceRef('* surface:17 terminal [focused]\n'), 'surface:17');
    assert.equal(extractExecExitCode('done\n[guardrail-exec-exit:0]\n'), 0);
    assert.equal(extractExecExitCode('done\n[guardrail-exec-exit:auth-0:0]\n', 'auth-0'), 0);
    assert.equal(extractExecExitCode('still running\n'), null);
  });

  it('prints the host-boundary warning and composed exec summary during approval', async () => {
    const dir = resolve(makeTmpDir());
    seedPromptFixture(dir);
    const stdoutChunks = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    const originalIsTTY = process.stdin.isTTY;
    let capturedExecutorOpts = null;

    process.stdout.write = (chunk, encoding, callback) => {
      stdoutChunks.push(String(chunk));
      if (typeof encoding === 'function') encoding();
      if (typeof callback === 'function') callback();
      return true;
    };
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });

    try {
      const result = await runRecipeSupervisor({
        specifier: 'cmux-claude-exec',
        cwd: dir,
        searchDirs: exactSearchDirs(dir, [join(process.cwd(), 'recipes')]),
        allowUnverified: true,
        envAllow: ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TERM_PROGRAM', 'LANG', 'TMPDIR', 'PWD', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR'],
        inputs: {
          socket_path: '/tmp/cmux.sock',
          workspace_name: 'Claude Smoke',
          launch_cwd: '.',
          guardrail_repo: '.',
          prompt: 'Solve the attached problem.',
          input_files: '.guardrail/prompts/claude-math-problem.txt',
          model: 'sonnet',
          effort: 'low',
          mode: 'default',
          output_format: 'text',
          max_budget_usd: '1.00',
          system_prompt: 'Reply in one line.',
          working_dir: '.',
          session_name: 'cmux-smoke',
        },
        promptApprovalFn: async () => false,
        executorFn: async (_recipe, _resolvedInputs, execOpts) => {
          capturedExecutorOpts = execOpts;
          return { status: 'success', stepsExecuted: 1, reason: null };
        },
      });

      assert.equal(result.status, 'approval_denied');
    } finally {
      process.stdout.write = originalWrite;
      Object.defineProperty(process.stdin, 'isTTY', {
        value: originalIsTTY,
        configurable: true,
      });
    }

    const rendered = stdoutChunks.join('');
    assert.ok(rendered.includes('cmux-claude-exec@1.0.0'));
    assert.ok(rendered.includes(HOST_BOUNDARY_WARNING));
    assert.ok(rendered.includes('Composed Exec (launch-cmux-claude-exec)'));
    assert.ok(rendered.includes('Hosted env mode:'));
    assert.ok(rendered.includes('env -i; only approved vars survive'));
    assert.ok(rendered.includes('claude-exec@1.0.0'));
    assert.ok(capturedExecutorOpts === null);
    assert.ok(rendered.includes('Fresh approval required'));
  });

  it('prepares a composed exec record for the executor', async () => {
    const dir = resolve(makeTmpDir());
    seedPromptFixture(dir);
    let capturedExecutorOpts = null;
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });

    let result;
    try {
      result = await runRecipeSupervisor({
        specifier: 'cmux-claude-exec',
        cwd: dir,
        searchDirs: exactSearchDirs(dir, [join(process.cwd(), 'recipes')]),
        allowUnverified: true,
        envAllow: ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TERM_PROGRAM', 'LANG', 'TMPDIR', 'PWD', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR'],
        inputs: {
          socket_path: '/tmp/cmux.sock',
          workspace_name: 'Claude Smoke',
          launch_cwd: '.',
          guardrail_repo: '.',
          prompt: 'Solve the attached problem.',
          input_files: '.guardrail/prompts/claude-math-problem.txt',
          model: 'sonnet',
          effort: 'low',
          mode: 'default',
          output_format: 'text',
          max_budget_usd: '1.00',
          system_prompt: 'Reply in one line.',
          working_dir: '.',
          session_name: 'cmux-smoke',
        },
        promptApprovalFn: async () => true,
        executorFn: async (_recipe, _resolvedInputs, execOpts) => {
          capturedExecutorOpts = execOpts;
          return { status: 'success', stepsExecuted: 1, reason: null };
        },
      });
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: originalIsTTY,
        configurable: true,
      });
    }

    assert.equal(result.status, 'success');
    assert.ok(capturedExecutorOpts);
    assert.ok(capturedExecutorOpts.composedSteps);
    const prepared = capturedExecutorOpts.composedSteps['launch-cmux-claude-exec'];
    assert.ok(prepared);
    assert.equal(prepared.recipe.id, 'claude-exec');
    assert.equal(prepared.resolvedInputs.prompt, 'Solve the attached problem.');
    assert.deepEqual(prepared.resolvedInputs.input_files, ['.guardrail/prompts/claude-math-problem.txt']);
    assert.ok(prepared.envIntersection.includes('CLAUDE_CONFIG_DIR'));
  });

  it('creates workspace, executes hosted contract, polls, and captures pane output', async () => {
    const calls = [];
    const contract = encodeContract({
      command: 'node',
      args: ['./src/claude-exec-wrapper.js', '--prompt', 'Solve it'],
      cwd: '/tmp/work',
      envPolicy: {
        allow: ['PATH', 'HOME'],
        inject: {},
      },
    });

    const runner = async (args, options) => {
      calls.push({ args, options });
      if (args[0] === 'new-workspace') return { stdout: 'OK workspace:9\n', stderr: '' };
      if (args[0] === 'list-panels') return { stdout: '* surface:4 terminal [focused]\n', stderr: '' };
      if (args[0] === 'send') return { stdout: '', stderr: '' };
      if (args[0] === 'capture-pane') return { stdout: '6\n[guardrail-exec-exit:main:0]\n', stderr: '' };
      throw new Error(`unexpected cmux call: ${args[0]}`);
    };

    const result = await runCmuxClaudeRecipe(
      {
        socketPath: '/tmp/cmux.sock',
        workspaceName: 'Claude Smoke',
        launchCwd: '.',
        execContractB64: contract,
        captureLines: 80,
        captureDelayMs: 0,
        pollIntervalMs: 50,
        waitTimeoutMs: 500,
      },
      {
        runner,
        wait: async () => {},
        emitStdout: false,
      },
    );

    assert.equal(result.workspace, 'workspace:9');
    assert.equal(result.surface, 'surface:4');
    assert.equal(result.execExitCode, 0);
    assert.match(result.capture, /\[guardrail-exec-exit:main:0\]/);
    assert.equal(calls[0].args[0], 'new-workspace');
    assert.equal(calls[1].args[0], 'list-panels');
    assert.equal(calls[2].args[0], 'send');
    assert.equal(calls[3].args[0], 'capture-pane');
    assert.equal(calls[0].options.socketPath, '/tmp/cmux.sock');
    assert.ok(calls[2].args.at(-1).includes('[guardrail-exec-exit:'));
  });

  it('fails hosted auth preflight when claude auth status exits zero but reports loggedIn false', async () => {
    const contract = encodeContract({
      command: 'node',
      args: ['./src/claude-exec-wrapper.js', '--prompt', 'Solve it'],
      cwd: '/tmp/work',
      envPolicy: {
        allow: ['PATH', 'HOME'],
        inject: {},
      },
      authPreflight: {
        requirements: [{ type: 'claude_login' }],
      },
    });

    const runner = async (args) => {
      if (args[0] === 'new-workspace') return { stdout: 'OK workspace:9\n', stderr: '' };
      if (args[0] === 'list-panels') return { stdout: '* surface:4 terminal [focused]\n', stderr: '' };
      if (args[0] === 'send') return { stdout: '', stderr: '' };
      if (args[0] === 'capture-pane') {
        return { stdout: '{"loggedIn":false,"authMethod":"none"}\n[guardrail-exec-exit:auth-0:0]\n', stderr: '' };
      }
      throw new Error(`unexpected cmux call: ${args[0]}`);
    };

    await assert.rejects(
      runCmuxClaudeRecipe(
        {
          socketPath: '/tmp/cmux.sock',
          workspaceName: 'Claude Smoke',
          launchCwd: '.',
          execContractB64: contract,
          captureLines: 80,
          captureDelayMs: 0,
          pollIntervalMs: 50,
          waitTimeoutMs: 500,
        },
        {
          runner,
          wait: async () => {},
          emitStdout: false,
        },
      ),
      /missing_auth_prerequisite/,
    );
  });

});

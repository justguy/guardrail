import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadRecipe } from '../src/recipe.js';
import { buildPromptPayload } from '../src/prompt-inputs.js';
import {
  parseWrapperArgs,
  buildCodexExecArgs,
} from '../src/codex-exec-wrapper.js';

function tmpDir() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'gr-codex-recipe-')));
}

describe('Codex recipe', () => {
  it('loads the codex exec recipe', () => {
    const recipe = loadRecipe(join(process.cwd(), 'recipes', 'codex-exec.recipe.json'));
    assert.equal(recipe.id, 'codex-exec');
    assert.equal(recipe.version, '1.0.0');
    assert.equal(recipe.risk_level, 'high');
    assert.equal(recipe.steps.length, 1);
  });

  it('parses wrapper args by flag name', () => {
    const parsed = parseWrapperArgs([
      '--prompt', 'Fix the bug',
      '--input-files', 'src/a.js,src/b.js',
      '--sandbox', 'workspace-write',
      '--json', 'true',
      '--full-auto', 'false',
    ]);
    assert.equal(parsed.prompt, 'Fix the bug');
    assert.equal(parsed.inputFiles, 'src/a.js,src/b.js');
    assert.equal(parsed.sandbox, 'workspace-write');
    assert.equal(parsed.json, 'true');
    assert.equal(parsed.fullAuto, 'false');
  });

  it('builds prompt payload from inline prompt and input files', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'context.txt'), 'Injected context\n');
    writeFileSync(join(dir, 'notes.md'), 'More context\n');

    const payload = buildPromptPayload({
      prompt: 'Inline instruction',
      inputFiles: ['context.txt', 'notes.md'],
      baseDir: dir,
    });

    assert.match(payload, /Inline instruction/);
    assert.match(payload, /<input_file path="context.txt">/);
    assert.match(payload, /Injected context/);
    assert.match(payload, /<input_file path="notes.md">/);
    assert.match(payload, /More context/);
  });

  it('builds codex exec args from normalized options', () => {
    const args = buildCodexExecArgs({
      model: 'gpt-5-codex',
      profile: 'default',
      sandbox: 'workspace-write',
      workingDir: '/tmp/project',
      addDirs: ['/tmp/project/docs'],
      imageFiles: ['/tmp/project/diagram.png'],
      json: true,
      outputLastMessageFile: '/tmp/project/last.txt',
      outputSchemaFile: '/tmp/project/schema.json',
      color: 'never',
      oss: true,
      localProvider: 'ollama',
      skipGitRepoCheck: true,
      ephemeral: true,
      fullAuto: false,
    });

    assert.deepEqual(args, [
      'exec',
      '--model', 'gpt-5-codex',
      '--profile', 'default',
      '--sandbox', 'workspace-write',
      '--cd', '/tmp/project',
      '--add-dir', '/tmp/project/docs',
      '--image', '/tmp/project/diagram.png',
      '--json',
      '--output-last-message', '/tmp/project/last.txt',
      '--output-schema', '/tmp/project/schema.json',
      '--color', 'never',
      '--oss',
      '--local-provider', 'ollama',
      '--skip-git-repo-check',
      '--ephemeral',
      '-',
    ]);
  });
});

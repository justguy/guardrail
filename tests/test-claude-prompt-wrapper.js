import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildClaudeArgs,
  buildInteractivePromptInput,
  progressEventRequestsExit,
  resolveInteractiveSubmitSequence,
} from '../src/claude-prompt-wrapper.js';

describe('Claude prompt wrapper', () => {
  it('does not forward the interactive prompt as a trailing Claude CLI arg', () => {
    const args = buildClaudeArgs({
      model: 'sonnet',
      effort: 'low',
      permissionMode: 'dontAsk',
      allowedTools: 'Bash Read',
      sessionName: 'lane',
      sessionId: '11111111-1111-4111-8111-111111111111',
      addDirs: ['/tmp/a', '/tmp/b'],
      systemPrompt: 'Follow the packet exactly.',
      promptPayload: 'This should not be forwarded positionally.',
    });

    assert.deepEqual(args, [
      '--model', 'sonnet',
      '--effort', 'low',
      '--permission-mode', 'dontAsk',
      '--allowed-tools', 'Bash Read',
      '--name', 'lane',
      '--session-id', '11111111-1111-4111-8111-111111111111',
      '--add-dir', '/tmp/a',
      '--add-dir', '/tmp/b',
      '--append-system-prompt', 'Follow the packet exactly.',
    ]);
  });

  it('builds the interactive prompt body without the submit keystrokes', () => {
    const input = buildInteractivePromptInput('line one\nline two');
    assert.equal(input, 'line one\nline two');
  });

  it('allows the interactive submit sequence to be overridden for PTY probes', () => {
    assert.equal(resolveInteractiveSubmitSequence({}), '\r\r');
    assert.equal(resolveInteractiveSubmitSequence({ GUARDRAIL_SUBMIT_SEQUENCE_OVERRIDE: '' }), '');
    assert.equal(resolveInteractiveSubmitSequence({ GUARDRAIL_SUBMIT_SEQUENCE_OVERRIDE: '\r' }), '\r');
  });

  it('requests interactive exit on completion and soft-state progress sentinels', () => {
    assert.equal(progressEventRequestsExit({ phase: 'complete' }), true);
    assert.equal(progressEventRequestsExit({ phase: 'completed' }), true);
    assert.equal(progressEventRequestsExit({ event: 'ai_question' }), true);
    assert.equal(progressEventRequestsExit({ status: 'waiting_for_review' }), true);
    assert.equal(progressEventRequestsExit({ phase: 'implementation_started' }), false);
  });
});

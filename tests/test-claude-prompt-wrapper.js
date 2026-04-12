import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildClaudeArgs,
  buildInteractivePromptInput,
  EXPECT_INTERACTIVE_SCRIPT,
  progressEventRequestsExit,
  resolveInteractiveSubmitDelayMs,
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

  it('allows the interactive submit delay to be overridden for PTY probes', () => {
    assert.equal(resolveInteractiveSubmitDelayMs({}), '300');
    assert.equal(resolveInteractiveSubmitDelayMs({ GUARDRAIL_SUBMIT_DELAY_MS_OVERRIDE: '1000' }), '1000');
  });

  it('preserves an explicitly empty submit sequence in the expect wrapper', () => {
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /if \{\[info exists env\(GUARDRAIL_SUBMIT_SEQUENCE\)\]\} \{/);
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /if \{\!\[info exists env\(GUARDRAIL_SUBMIT_SEQUENCE\)\]\} \{/);
  });

  it('wraps interactive prompt delivery in one explicit bracketed-paste envelope', () => {
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /proc send_bracketed_paste \{log_file text\} \{/);
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /send_logged \$log_file "stdin" "\\033\\\[200~"/);
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /send_logged \$log_file "stdin" \$text/);
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /send_logged \$log_file "stdin" "\\033\\\[201~"/);
  });

  it('can log outbound paste and submit bytes for interactive PTY forensics', () => {
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /proc append_hex_log \{file_path label text\} \{/);
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /proc send_logged \{file_path label text\} \{/);
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /GUARDRAIL_PTY_SEND_HEX_LOG/);
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /send_logged \$send_hex_log "stdin" \$submit_sequence/);
  });

  it('only allows prompt-repaint completion after assistant output has appeared', () => {
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /set recent_buffer ""/);
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /set assistant_response_seen 0/);
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /set post_submit_bytes 0/);
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /proc turn_completion_seen \{text\} \{/);
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /proc assistant_output_seen \{text\} \{/);
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /if \{\!\$assistant_response_seen && \[assistant_output_seen \$recent_buffer\]\} \{/);
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /if \{\[turn_completion_seen \$recent_buffer\]\} \{/);
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /Claude is waiting for your input/);
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /if \{\$assistant_response_seen && \[ready_beacon_seen \$recent_buffer\]\} \{/);
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /exit 0/);
  });

  it('requests interactive exit on completion and soft-state progress sentinels', () => {
    assert.equal(progressEventRequestsExit({ phase: 'complete' }), true);
    assert.equal(progressEventRequestsExit({ phase: 'completed' }), true);
    assert.equal(progressEventRequestsExit({ event: 'ai_question' }), true);
    assert.equal(progressEventRequestsExit({ status: 'waiting_for_review' }), true);
    assert.equal(progressEventRequestsExit({ phase: 'implementation_started' }), false);
  });
});

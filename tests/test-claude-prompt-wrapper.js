import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildClaudeArgs,
  buildInteractivePromptInput,
  EXPECT_INTERACTIVE_SCRIPT,
  interactiveCompletionSatisfied,
  progressEventRequestsExit,
  reportArtifactRequestsExit,
  resolveInteractiveSubmitDelayMs,
  resolveInteractiveSubmitSequence,
  shouldTreatSentinelDrivenExitAsSuccess,
  stderrLooksLikeInteractiveWrapperFailure,
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
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /proc append_event_log \{file_path label\} \{/);
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /proc send_logged \{file_path label text\} \{/);
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /GUARDRAIL_PTY_SEND_HEX_LOG/);
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /GUARDRAIL_PTY_EVENT_LOG/);
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /send_logged \$send_hex_log "stdin" \$submit_sequence/);
  });

  it('waits for a post-paste submit-ready beacon before sending the submit sequence', () => {
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /proc submit_ready_beacon_seen \{text\} \{/);
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /string first \{\[Pasted text\} \$cleaned/);
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /set submit_sent 0/);
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /append post_paste_buffer \$chunk/);
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /if \{\[submit_ready_beacon_seen \$post_paste_buffer\]\} \{/);
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /send_logged \$send_hex_log "stdin" \$submit_sequence/);
  });

  it('falls back to sending submit on 1s quiet timeout when beacon has not fired', () => {
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /if \{\$prompt_sent && !\$submit_sent\} \{/);
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /append_event_log \$event_log "submit_fallback"/);
  });

  it('falls back to pasting after 2s of startup quiet when ready beacon has not fired', () => {
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /set startup_quiet_ticks 0/);
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /if \{!\$prompt_sent && \[string length \$startup_buffer\] > 0\} \{/);
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /incr startup_quiet_ticks/);
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /if \{\$startup_quiet_ticks >= 2\} \{/);
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /append_event_log \$event_log "startup_beacon_fallback"/);
  });

  it('fails closed on internal expect or Tcl wrapper errors', () => {
    assert.equal(stderrLooksLikeInteractiveWrapperFailure('missing "\nin expression "foo"\ninvoked from within'), true);
    assert.equal(stderrLooksLikeInteractiveWrapperFailure('while executing\n"bad command"'), true);
    assert.equal(stderrLooksLikeInteractiveWrapperFailure('[guardrail-ai-progress] {"event":"ai_checkpoint"}'), false);
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
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /Thinking\|Beaming\|Schlepping\|Planning\|Searching\|Reading\|Writing\|Seasoning/);
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /if \{\$assistant_response_seen && \[ready_beacon_seen \$recent_buffer\]\} \{/);
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /exit 0/);
  });

  it('uses terminal completion heuristics for all modes except artifact (ne "artifact" guard)', () => {
    // Regression: was `eq "direct"` which silently stalled when completionMode was empty or unset.
    // Must be `ne "artifact"` so direct turns and unspecified modes exit via Tcl-side heuristics.
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /if \{\$env\(GUARDRAIL_COMPLETION_MODE\) ne "artifact"\} \{/);
    assert.doesNotMatch(EXPECT_INTERACTIVE_SCRIPT, /if \{\$env\(GUARDRAIL_COMPLETION_MODE\) eq "direct"\} \{/);
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /if \{\[turn_completion_seen \$recent_buffer\]\} \{/);
    assert.match(EXPECT_INTERACTIVE_SCRIPT, /if \{\$assistant_response_seen && \[ready_beacon_seen \$recent_buffer\]\} \{/);
  });

  it('requests interactive exit on completion and soft-state progress sentinels', () => {
    assert.equal(progressEventRequestsExit({ phase: 'complete' }), true);
    assert.equal(progressEventRequestsExit({ phase: 'completed' }), true);
    assert.equal(progressEventRequestsExit({ event: 'ai_question' }), true);
    assert.equal(progressEventRequestsExit({ status: 'waiting_for_review' }), true);
    assert.equal(progressEventRequestsExit({ phase: 'implementation_started' }), false);
  });

  it('treats COMPLETE and NEEDS_REVIEW report artifacts as artifact completion sentinels', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrail-report-artifact-'));
    const reportPath = path.join(dir, 'REPORT_demo.md');
    try {
      fs.writeFileSync(reportPath, 'Status: COMPLETE\nObjective: demo\n', 'utf8');
      assert.equal(reportArtifactRequestsExit(reportPath), true);
      assert.equal(interactiveCompletionSatisfied({ completionMode: 'artifact', reportArtifact: reportPath }), true);

      fs.writeFileSync(reportPath, 'Status: NEEDS_REVIEW\nObjective: demo\n', 'utf8');
      assert.equal(reportArtifactRequestsExit(reportPath), true);
      assert.equal(interactiveCompletionSatisfied({ completionMode: 'artifact', reportArtifact: reportPath }), true);

      fs.writeFileSync(reportPath, 'Status: STARTED\nObjective: demo\n', 'utf8');
      assert.equal(reportArtifactRequestsExit(reportPath), false);
      assert.equal(interactiveCompletionSatisfied({ completionMode: 'artifact', reportArtifact: reportPath }), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats soft review/input states as sufficient artifact completion for wrapper exit', () => {
    assert.equal(interactiveCompletionSatisfied({
      completionMode: 'artifact',
      reportArtifact: '/tmp/missing-report.md',
      currentSoftState: 'waiting_for_review',
    }), true);
    assert.equal(interactiveCompletionSatisfied({
      completionMode: 'artifact',
      reportArtifact: '/tmp/missing-report.md',
      currentSoftState: 'waiting_for_input',
    }), true);
  });

  it('treats sentinel-driven 143 exits as success but not arbitrary signal exits', () => {
    assert.equal(shouldTreatSentinelDrivenExitAsSuccess({
      code: 143,
      signal: null,
      exitRequested: true,
      exitRequestReason: 'Guardrail interactive wrapper requested exit after report-artifact sentinel',
    }), true);
    assert.equal(shouldTreatSentinelDrivenExitAsSuccess({
      code: 143,
      signal: 'SIGTERM',
      exitRequested: true,
      exitRequestReason: 'Guardrail interactive wrapper requested exit after progress sentinel (completed)',
    }), true);
    assert.equal(shouldTreatSentinelDrivenExitAsSuccess({
      code: 143,
      signal: null,
      exitRequested: false,
      exitRequestReason: 'Guardrail interactive wrapper hit hard wall-clock timeout',
    }), false);
    assert.equal(shouldTreatSentinelDrivenExitAsSuccess({
      code: 143,
      signal: null,
      exitRequested: true,
      exitRequestReason: 'Guardrail interactive wrapper hit hard wall-clock timeout',
    }), false);
  });
});

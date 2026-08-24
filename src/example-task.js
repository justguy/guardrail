#!/usr/bin/env node
// Simulated task for guardrail demo
// Exits with code 1 and emits NDJSON protocol messages

const messages = [
  { type: 'LOG', payload: { message: 'Running test suite...' } },
  { type: 'LOG', payload: { message: 'Test 1: passed' } },
  { type: 'LOG', payload: { message: 'Test 2: passed' } },
  { type: 'LOG', payload: { message: 'Test 3: FAILED - missing dependency' } },
  {
    type: 'VALIDATION_FAILED_REQUIRE_UPDATE',
    payload: {
      validationSignature: '<sha256>',
      reason: 'Missing dependency detected during test run',
      proposedUpdate: {
        action: 'run_script',
        summary: 'Install missing dependencies',
        command: 'npm',
        args: ['install'],
        cwd: process.cwd(),
        patch: null
      }
    }
  }
];

for (const msg of messages) {
  console.log(JSON.stringify(msg));
}
process.exit(1);

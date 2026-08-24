# Contributing

## Development

Use Node.js 20 or later and install dependencies with `npm ci`. Run `npm test`
before proposing behavioral changes. For package-boundary changes, also run
`npm run pack:check`.

## Pull Requests

Keep changes focused, include tests for changed behavior, and explain any
user-facing or security-relevant impact. Do not commit local `.guardrail/`,
agent-session, or credential material.

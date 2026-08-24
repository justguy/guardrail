#!/bin/bash
# Guardrail Blocked Demo — shows dangerous commands being blocked
# Run: bash demos/demo-blocked.sh
cd "$(dirname "$0")/.."
node src/cli.js demo blocked

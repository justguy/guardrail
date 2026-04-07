#!/bin/bash
# Guardrail Drift Demo — shows scope expansion being blocked
# Run: bash demos/demo-drift.sh
cd "$(dirname "$0")/.."
echo "n" | node src/cli.js demo drift

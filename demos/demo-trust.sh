#!/bin/bash
# Guardrail Trust Demo — shows channel enforcement for verified vs community
# Run: bash demos/demo-trust.sh
cd "$(dirname "$0")/.."
node src/cli.js demo trust

#!/bin/bash
# Guardrail Recipe Demo — shows recipe dry-run and risk assessment
# Run: bash demos/demo-recipe.sh
cd "$(dirname "$0")/.."
node src/cli.js demo recipe

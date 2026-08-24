# Guardrail Demo Pack

Runnable demos that show Guardrail's core behaviors. Each demo is non-destructive and requires no external setup.

## Available Demos

| Demo | Command | What It Shows |
|------|---------|---------------|
| Drift Detection | `guardrail demo drift` | Blocks silent scope expansion (npm test -> npm install) |
| Recipe Execution | `guardrail demo recipe` | Dry-run, risk assessment, and guardrail checks |
| Trust & Channels | `guardrail demo trust` | Verified vs community recipe enforcement |
| Blocked Execution | `guardrail demo blocked` | Dangerous commands blocked at runtime |

## Running

```bash
# List all demos
node src/cli.js demo list

# Run a specific demo
node src/cli.js demo drift
node src/cli.js demo recipe
node src/cli.js demo trust
node src/cli.js demo blocked
```

## Self-Verification

Run a quick self-test to verify Guardrail is working:

```bash
node src/cli.js verify
node src/cli.js verify --json
```

## What Each Demo Proves

### Drift Detection
- Approves `npm test`
- Worker proposes `npm install` (scope expansion)
- Guardrail blocks the widened scope
- User must re-approve

### Recipe Execution
- Loads a recipe by ID
- Shows dry-run with resolved arguments
- Displays risk classification and channel trust

### Trust & Channels
- Community recipe: blocked by default
- Same recipe with `--allow-unverified`: allowed with warning
- Verified recipe: allowed automatically

### Blocked Execution
- `rm -rf /`: blocked (recursive force delete)
- `sudo rm`: blocked (elevated delete)
- `chmod 777`: blocked (world-writable permissions)
- `dd of=/dev/sda`: blocked (raw device write)

Writing this in Node.js makes infinitely more sense, especially since Guardrail itself is built in Node. Building the adapter in the same ecosystem means you can eventually bypass the CLI entirely and just import Guardrail’s execution engine directly as a library if you want to optimize for speed.

But for the simplest, most robust OpenClaw integration using the CLI, here is the Node/npm architecture.

### Step 1: The Project Setup (`package.json`)
Create a new npm package for the adapter. This makes it incredibly easy for users to install globally.

```json
{
  "name": "openclaw-guardrail-adapter",
  "version": "1.0.0",
  "description": "Enterprise security adapter replacing OpenClaw's raw shell with Guardrail's contract engine.",
  "main": "adapter.js",
  "bin": {
    "guardrail-exec": "./adapter.js"
  },
  "dependencies": {},
  "engines": {
    "node": ">=18.0.0"
  }
}
```

### Step 2: The Node Adapter (`adapter.js`)
This script uses Node's native `child_process.spawnSync` to invoke Guardrail, intercept the JSON output, and feed it back to OpenClaw. 

Make sure to add the shebang at the top so it runs as an executable.

```javascript
#!/usr/bin/env node

const { spawnSync } = require('child_process');

function executeSafely(command, args = []) {
  // Construct the Guardrail CLI invocation
  // We use --json for structured logs and --agent-mode to prevent human prompts
  const guardrailArgs = [
    'run',
    '--json',
    '--agent-mode',
    '--',
    command,
    ...args
  ];

  try {
    // Execute the Guardrail process
    // We assume Guardrail is installed globally or accessible in the PATH
    const result = spawnSync('guardrail', guardrailArgs, {
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024 * 5 // 5MB buffer for large outputs
    });

    // Exit Code 0: Execution succeeded under contract
    if (result.status === 0) {
      return JSON.stringify({
        status: 'success',
        stdout: result.stdout ? result.stdout.trim() : '',
        stderr: result.stderr ? result.stderr.trim() : ''
      });
    }

    // Exit Code 10 or 12: Drift Detected or Flagged (Guardrail blocked it)
    if (result.status === 10 || result.status === 12) {
      try {
        const driftProposal = JSON.parse(result.stdout);
        return JSON.stringify({
          status: 'blocked',
          reason: 'contract_violation',
          guardrail_feedback: driftProposal
        });
      } catch (e) {
        return JSON.stringify({
          status: 'error',
          message: 'Guardrail blocked execution but returned malformed JSON.'
        });
      }
    }

    // Other failures (e.g., script crashed, timeout)
    return JSON.stringify({
      status: 'failed',
      exit_code: result.status,
      stderr: result.stderr ? result.stderr.trim() : ''
    });

  } catch (error) {
    return JSON.stringify({ status: 'system_error', message: error.message });
  }
}

// OpenClaw passes arguments as a JSON string via the first argument
const inputStr = process.argv[2];

if (!inputStr) {
  console.log(JSON.stringify({ status: 'error', message: 'No input provided by agent.' }));
  process.exit(1);
}

try {
  const inputData = JSON.parse(inputStr);
  // Ensure we have a command to run
  if (!inputData.command) {
    console.log(JSON.stringify({ status: 'error', message: 'Missing "command" in input.' }));
    process.exit(1);
  }
  
  const output = executeSafely(inputData.command, inputData.args || []);
  console.log(output); // Output MUST be printed to stdout for OpenClaw to read it

} catch (e) {
  console.log(JSON.stringify({ status: 'error', message: 'Invalid JSON input from agent.' }));
  process.exit(1);
}
```

### Step 3: The Skill Definition (`SKILL.md`)
Place this in the OpenClaw skills directory. It maps the LLM's intent to your Node binary. Notice that the `run` command now points to the executable we defined in the `package.json`.

```markdown
# Tool: guardrail_exec

**Description:**
You are restricted from using raw shell execution. To interact with the system, run files, or execute commands, you MUST use the `guardrail_exec` tool. This tool enforces security contracts. 

**Usage Rules:**
1. **Never chain commands.** Provide a single binary and a list of arguments.
2. **Structured Mode.** Do not use bash operators (`&&`, `|`, `>`). 
3. **Handle Rejections:** If `guardrail_exec` returns a `blocked` status, READ the `guardrail_feedback` JSON payload. Do not blindly retry. Adjust your arguments to fit the approved contract, or request human approval via dry-run.

**Execution:**
The tool is executed by passing a JSON string to the `guardrail-exec` binary.

**Parameters:**
* `command` (string): The binary or script to run (e.g., "npm", "git", "node").
* `args` (list of strings): The exact arguments to pass (e.g., ["run", "build"]).
```

### The Beauty of the NPM Route

By packaging this via npm, the installation for any developer is frictionless. They literally just run:
`npm install -g guardrail openclaw-guardrail-adapter`

Once the agent executes `guardrail-exec '{"command": "npm", "args": ["install", "express"]}'`, your Node script seamlessly catches it, fires up Guardrail, blocks it if it hits the `Yellow` risk bucket, and feeds the rejection straight back into the LLM's context window.

This perfectly sets up your Phase 6 "Capability-Based UX". When the agent gets stuck and asks the human for help, the human sees exactly what the agent tried to do and why Guardrail flagged it.
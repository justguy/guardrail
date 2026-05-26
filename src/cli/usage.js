export const USAGE = `Usage: guardrail <command> [options]

Commands:
  run [flags] -- <command> [args...]    Run a command under Guardrail
  run --shell "<script>"                Run a shell script under Guardrail
  run --recipe <id[@ver]> --input k=v     Run a recipe by ID (optional @version)
  run --template <path> --input k=v     Run a template under Guardrail
  lane start [flags]                    Start a resident interactive lane
  lane send [flags]                     Send one message through a resident lane
  lane run-sequence [flags]             Supervise prompt files sequentially through one resident lane
  lane chat [flags]                     Send one message and wait like a guarded chat turn
  lane result [flags]                   Read the latest or named resident lane result
  lane wait [flags]                     Wait for a resident lane request to complete
  lane status [flags]                   Show resident lane status and recovery hints
  lane inspect [flags]                  Show status, latest result, and bounded logs together
  lane history [flags]                  Query resident-lane audit history
  lane portfolio [flags]                Query the portfolio-wide resident-lane timeline
  lane logs [flags]                     Read the bounded resident lane log tail
  lane stop [flags]                     Stop a resident interactive lane
  lane extend [flags]                   Extend a live lane: --idle-timeout-ms, --health-timeout-ms, --heartbeat
  lane cleanup [flags]                  Remove one resident lane's local artifacts
  lane batch [flags]                    Preview or apply stop/cleanup actions across filtered lanes
  lane list [flags]                     List resident lanes in this Guardrail repo
  lane prune [flags]                    Classify and optionally remove dead resident-lane artifacts
  lane adapters                         List bundled resident lane adapters
  repo status [--path <repo>]          Show tracked and untracked repo changes
  mcp serve --grant <path>              Start Guardrail's delegated stdio MCP server
  workflow run [flags]                  Run a workflow definition under Guardrail
  workflow lint --definition <path>     Lint a workflow definition for issues
  template lint --template <path>       Lint a template for issues
  template explain --template <path>    Explain what a template does
  template schema --template <path>     Show template input schema
  template simulate --template <path>   Simulate a template run (no execution)
  template diff --template <path>       Show diff from approved hash
  template create --from-manifest <p>   Create a starter template from an approved manifest
  template list [--templates-dir <p>]   List local templates
  template publish --template <path>    Publish a template through the recipe pipeline
  list [--category X] [--search Q]      List and filter available recipes
  pack <recipe.json> [--output <path>]   Package a recipe for distribution
  recipe validate <recipe.json>         Validate a recipe file
  recipe compose --transport <id> --exec <id> --output <path>   Generate a composed recipe artifact
  recipe inspect <packed.json>          Inspect a packaged recipe (verify hash)
  recipe install <path|url|github://>   Install a recipe to local registry
                                        or install <category/id@version> --registry <root>
  recipe registry export <output-dir>   Export a static self-hosted recipe registry snapshot
  recipe registry list <registry>       Inspect a self-hosted recipe registry snapshot
  recipe versions <id>                  List installed versions of a recipe
  recipe publish --name <n> --category <c> [--manifest <path>] [--description <d>] [--dry-run]
  adapter run --tool <name> -- <cmd>    Run a command through an adapter profile
  adapter probe --tool <name>           Probe an MCP stdio profile for discovery only
  adapter mcp tools --tool <name>       List MCP tools for a stdio profile under Guardrail
  adapter mcp call --tool <name>        Perform one bounded MCP tools/call over stdio
  adapter mcp batch --tool <name>       Perform a bounded ordered MCP tools/call batch over stdio
  adapter shim --tool <n> --commands <c>  Create PATH shims for adapter interception
  adapter profile install <source>      Install an adapter profile (path/url/github:// or bare name with --index/--index-key)
  adapter profile discover [tool]       Discover tools from trusted signed adapter indexes
  adapter profile index verify <path> --index-key <pubkey.pem>  Verify a signed adapter profile index file
  adapter profile list                  List adapter profiles
  adapter profile show <tool>           Show adapter profile details
  create --name <n> --category <c>      Generate a recipe skeleton
  profile create|use|list|show          Manage user profiles
  key revoke <name> --state-dir <dir>   Revoke a stored key without deleting it
  policy list|inspect|validate          Manage and enforce policies
  metrics [--path <file>]               View execution metrics
  approve list [--state-dir <dir>]      List pending approval requests
  approve <id> [--state-dir <dir>]      Approve a pending request
  audit verify [--path <file>]           Verify audit log chain integrity
  audit query [--trace-id X] [filters]  Query audit log entries
  verify                                Run quick self-test verification
  demo drift|recipe|trust|blocked       Run a built-in demo scenario

Flags:
  --shell <text>              Shell mode with script text
  --template <path>           Template file path
  --input <key=value>         Template input (repeatable)
  --env-allow <var>           Env var to allow for recipe/template runtime handshakes (repeatable)
  --manifest <path>           Custom manifest path
  --approved-manifest <path>  Approved manifest path (CI)
  --non-interactive           Never prompt, fail on missing approval
  --json                      Emit JSON output
  --json-stream               Emit machine-readable progress stream (and structured result) for supported modes
  --trust <class>             Override trust class
  --validator <mode>          Validator mode: exit_code | ndjson
  --update-source <source>    Update source: none | worker_proposal | demo
  --definition <path>         Workflow definition file path
  --recipe-search-dir <path>  Extra recipe directory for workflow recipe_ref resolution (repeatable)
  --allow-unverified          Allow community/unsigned workflow recipes
  --env-allow <var>           Env var to allow for adapter auth/credential plumbing (repeatable)
  --help                      Show this help
  --version                   Show version

MCP delegated approval:
  Call guardrail_grant_status first, then use recipe/template describe or prepare.
  For templates, prefer the omnitool-style parent guardrail_template action tool.
  Actions: describe, prepare, request_approval, run; legacy template tools are aliases.
  Unpinned run tools require MCP host form elicitation approval or a CLI approval_request_id.
  Hosts without elicitation fail closed with host_approval_unavailable; normal args cannot self-approve.

Examples:
  guardrail run -- npm test
  guardrail run "npm test"
  guardrail run --shell "npm test && npm run lint"
  guardrail run --template ./templates/npm-publish.json --input package_dir=packages/my-lib --input tag=beta
  guardrail lane start --id claude-live
  guardrail lane start --id codex-live --tool codex
  guardrail lane start --id lint-live --tool local-exec --command node --arg scripts/lint-worker.js
  guardrail lane start --id wrapper-live --tool prompt-wrapper --wrapper-command ./scripts/my-wrapper.js --wrapper-arg mode=review
  guardrail lane send --id claude-live --prompt "2x3=?"
  guardrail lane run-sequence --id claude-live --prompt-file docs/references/p1.md --prompt-file docs/references/p2.md
  guardrail lane run-sequence --id claude-live --prompt-file docs/references/p1.md --stop-when-done
  guardrail lane chat --id claude-live --prompt "hello"
  guardrail lane result --id claude-live
  guardrail lane wait --id claude-live --request-id req-123
  guardrail lane result --id claude-live --request-id req-123
  guardrail lane inspect --id claude-live --tail 60
  guardrail lane history --id claude-live --limit 20
  guardrail lane portfolio --all-repos --limit 30 --json
  guardrail lane logs --id claude-live --tail 60
  guardrail lane stop --id claude-live
  guardrail lane cleanup --id claude-live
  guardrail lane batch --action cleanup --status failed --dry-run --json
  guardrail lane list --json
  guardrail lane list --all-repos --resource-filter git-branch:main --json
  guardrail lane prune --json
  guardrail lane prune --include-failed --dry-run --json
  guardrail repo status --path .
  guardrail mcp serve --grant ~/.guardrail/mcp-grants/codex.json --agent codex
  guardrail adapter mcp tools --tool cline
  guardrail adapter mcp batch --tool cline --calls-json '[{"tool":"echo","params":{"text":"hi"}}]'
  guardrail template lint --template ./templates/npm-publish.json
  guardrail template create --from-manifest .guardrail/approved.json --name npm-publish
  guardrail template list --json
  guardrail template explain --template ./templates/npm-publish.json
  guardrail template simulate --template ./templates/npm-publish.json --input package_dir=packages/my-lib
  guardrail recipe compose --transport cmux-claude-exec --exec claude-exec --output .guardrail/recipes/cmux-direct.recipe.json
  guardrail run --non-interactive --approved-manifest .guardrail/approved.json -- npm test
  guardrail demo drift`;

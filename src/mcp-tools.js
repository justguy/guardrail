export function jsonText(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

export function errorResult(code, message, data = {}) {
  return jsonText({ ok: false, code, message, ...data });
}

function toolDefinition(name, description, properties = {}, required = []) {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
  };
}

export function listGuardrailMcpTools() {
  return [
    toolDefinition('guardrail_grant_status', 'Describe the active delegated Guardrail grant.'),
    toolDefinition('guardrail_run_recipe', 'Run a delegated Guardrail recipe through the recipe supervisor.', {
      recipe: { type: 'string' },
      inputs: { type: 'object' },
      repo_path: { type: 'string' },
      manifest_path: { type: 'string' },
      allow_unverified: { type: 'boolean' },
    }, ['recipe']),
    toolDefinition('guardrail_service_start', 'Start a grant-declared local service.', {
      service_id: { type: 'string' },
      repo_path: { type: 'string' },
    }, ['service_id']),
    toolDefinition('guardrail_service_stop', 'Stop a grant-declared local service.', {
      service_id: { type: 'string' },
      repo_path: { type: 'string' },
    }, ['service_id']),
    toolDefinition('guardrail_service_status', 'Read status for a grant-declared local service.', {
      service_id: { type: 'string' },
      repo_path: { type: 'string' },
    }, ['service_id']),
    toolDefinition('guardrail_http_request', 'Perform a delegated bounded HTTP request.', {
      url: { type: 'string' },
      method: { type: 'string' },
      headers: { type: 'object' },
      body: { type: 'string' },
      timeout_ms: { type: 'number' },
      repo_path: { type: 'string' },
    }, ['url']),
    toolDefinition('guardrail_git_status', 'Return a read-only git status summary for a delegated repository path.', {
      repo_path: { type: 'string' },
    }),
    toolDefinition('guardrail_git_diff', 'Return a bounded read-only git diff for a delegated repository path.', {
      repo_path: { type: 'string' },
      cached: { type: 'boolean' },
      stat: { type: 'boolean' },
      paths: { type: 'array', items: { type: 'string' } },
      max_bytes: { type: 'number' },
    }),
    toolDefinition('guardrail_git_commit', 'Run the delegated git-commit recipe.', {
      repo_path: { type: 'string' },
      paths: { type: 'array', items: { type: 'string' } },
      message_file: { type: 'string' },
      manifest_path: { type: 'string' },
      allow_unverified: { type: 'boolean' },
    }, ['paths', 'message_file']),
    toolDefinition('guardrail_git_push_feature_branch', 'Run the delegated git-push recipe for a topic branch.', {
      repo_path: { type: 'string' },
      remote: { type: 'string' },
      branch: { type: 'string' },
      manifest_path: { type: 'string' },
      allow_unverified: { type: 'boolean' },
    }, ['branch']),
  ];
}

export function jsonText(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

export function errorResult(code, message, data = {}) {
  return jsonText({
    ok: false,
    code,
    message,
    ...data,
    correction: data.correction ?? {
      expected: 'Call guardrail_grant_status to inspect available tools, policy limits, and correction guidance before retrying.',
    },
  });
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

function schemaToolDefinition(name, description, inputSchema) {
  return { name, description, inputSchema };
}

const TEMPLATE_ACTION_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['describe', 'prepare', 'request_approval', 'run'],
      description: 'Template action to perform. Use describe to inspect, prepare to validate without execution, request_approval for CLI fallback approval, or run for supervisor execution.',
    },
    template: {
      type: 'string',
      description: 'Template name or repo-relative template path. Required for prepare, request_approval, and run.',
    },
    inputs: {
      type: 'object',
      description: 'Template input values for prepare, request_approval, or run.',
    },
    env_allow: {
      type: 'array',
      items: { type: 'string' },
      description: 'Explicit environment variable allow-list for the template env handshake.',
    },
    repo_path: { type: 'string' },
    templates_dir: { type: 'string' },
    manifest_path: {
      type: 'string',
      description: 'Optional approved manifest path for request_approval or run.',
    },
    expires_in_seconds: {
      type: 'number',
      description: 'Optional CLI approval request expiry for request_approval.',
    },
    approval_request_id: {
      type: 'string',
      description: 'Previously approved CLI approval request id for run.',
    },
  },
  required: ['action'],
  additionalProperties: false,
};

export function listGuardrailMcpTools() {
  return [
    toolDefinition('guardrail_grant_status', 'Describe the active delegated Guardrail grant, tool capabilities, policy limits, and correction guidance.'),
    toolDefinition('guardrail_recipe_describe', 'Describe available Guardrail recipes or one recipe without executing it.', {
      recipe: { type: 'string' },
      repo_path: { type: 'string' },
      search_dirs: { type: 'array', items: { type: 'string' } },
    }),
    toolDefinition('guardrail_recipe_prepare', 'Resolve recipe inputs and return dry-run, setup, and grant guidance without executing it.', {
      recipe: { type: 'string' },
      inputs: { type: 'object' },
      repo_path: { type: 'string' },
      search_dirs: { type: 'array', items: { type: 'string' } },
      allow_unverified: { type: 'boolean' },
    }, ['recipe']),
    toolDefinition('guardrail_recipe_request_approval', 'Create a pending CLI approval request for a prepared recipe execution without executing it.', {
      recipe: { type: 'string' },
      inputs: { type: 'object' },
      repo_path: { type: 'string' },
      search_dirs: { type: 'array', items: { type: 'string' } },
      allow_unverified: { type: 'boolean' },
      manifest_path: { type: 'string' },
      expires_in_seconds: { type: 'number' },
    }, ['recipe']),
    toolDefinition('guardrail_run_recipe', 'Run a delegated Guardrail recipe through the recipe supervisor.', {
      recipe: { type: 'string' },
      inputs: { type: 'object' },
      repo_path: { type: 'string' },
      manifest_path: { type: 'string' },
      allow_unverified: { type: 'boolean' },
      approval_request_id: { type: 'string' },
    }, ['recipe']),
    toolDefinition('guardrail_template_describe', 'Describe available Guardrail templates or one template without executing it.', {
      template: { type: 'string' },
      repo_path: { type: 'string' },
      templates_dir: { type: 'string' },
    }),
    toolDefinition('guardrail_template_prepare', 'Validate template inputs and return simulation, setup, and grant guidance without executing it.', {
      template: { type: 'string' },
      inputs: { type: 'object' },
      env_allow: { type: 'array', items: { type: 'string' } },
      repo_path: { type: 'string' },
      templates_dir: { type: 'string' },
    }, ['template']),
    toolDefinition('guardrail_template_request_approval', 'Create a pending CLI approval request for a prepared template execution without executing it.', {
      template: { type: 'string' },
      inputs: { type: 'object' },
      env_allow: { type: 'array', items: { type: 'string' } },
      repo_path: { type: 'string' },
      templates_dir: { type: 'string' },
      manifest_path: { type: 'string' },
      expires_in_seconds: { type: 'number' },
    }, ['template']),
    toolDefinition('guardrail_run_template', 'Run a delegated Guardrail template through the template supervisor.', {
      template: { type: 'string' },
      inputs: { type: 'object' },
      env_allow: { type: 'array', items: { type: 'string' } },
      repo_path: { type: 'string' },
      templates_dir: { type: 'string' },
      manifest_path: { type: 'string' },
      approval_request_id: { type: 'string' },
    }, ['template']),
    schemaToolDefinition(
      'guardrail_template',
      'Omnitool-style parent Guardrail template tool. Set action to describe, prepare, request_approval, or run. Legacy guardrail_template_* and guardrail_run_template tools remain callable compatibility aliases.',
      TEMPLATE_ACTION_SCHEMA,
    ),
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
  ];
}

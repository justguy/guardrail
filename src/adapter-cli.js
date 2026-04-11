// ---------------------------------------------------------------------------
// Adapter CLI — subcommand parsing and routing
// ---------------------------------------------------------------------------

function readFlagValue(argv, index) {
  if (index + 1 >= argv.length) return { error: 'usage' };
  return { value: argv[index + 1], nextIndex: index + 2 };
}

function parseFlags(argv, startIndex, result, handlers) {
  let i = startIndex;
  while (i < argv.length) {
    const handler = handlers[argv[i]];
    if (!handler) return { error: 'usage' };
    const next = handler(result, argv, i);
    if (!next || next.error) return { error: 'usage' };
    i = next.nextIndex;
  }
  return result;
}

function valueFlag(field, transform = (value) => value) {
  return (result, argv, index) => {
    const next = readFlagValue(argv, index);
    if (next.error) return next;
    result[field] = transform(next.value);
    return next;
  };
}

function repeatedValueFlag(field, transform = (value) => value) {
  return (result, argv, index) => {
    const next = readFlagValue(argv, index);
    if (next.error) return next;
    result[field].push(transform(next.value));
    return next;
  };
}

function parseRunArgs(argv, startIndex, result) {
  let i = startIndex;
  while (i < argv.length) {
    if (argv[i] === '--') {
      i += 1;
      if (i < argv.length) {
        result.command = argv[i];
        result.args = argv.slice(i + 1);
      }
      return result;
    }
    const handler = {
      '--tool': valueFlag('tool'),
      '--profile': valueFlag('profilePath'),
      '--env-allow': repeatedValueFlag('envAllow'),
      '--mcp-tool': valueFlag('mcpTool'),
      '--params-json': valueFlag('paramsJson'),
      '--calls-json': valueFlag('callsJson'),
      '--timeout-ms': valueFlag('timeoutMs'),
      '--json': (parsed, _argv, index) => { parsed.json = true; return { nextIndex: index + 1 }; },
    }[argv[i]];
    if (!handler) return { error: 'usage' };
    const next = handler(result, argv, i);
    if (next.error) return next;
    i = next.nextIndex;
  }
  return result;
}

function parseMcpCallArgs(argv, startIndex, result) {
  return parseFlags(argv, startIndex, result, {
    '--tool': valueFlag('tool'),
    '--profile': valueFlag('profilePath'),
    '--mcp-tool': valueFlag('mcpTool'),
    '--params-json': valueFlag('paramsJson'),
    '--env-allow': repeatedValueFlag('envAllow'),
    '--timeout-ms': valueFlag('timeoutMs'),
    '--json': (parsed, _argv, index) => { parsed.json = true; return { nextIndex: index + 1 }; },
  });
}

function parseMcpToolsArgs(argv, startIndex, result) {
  return parseFlags(argv, startIndex, result, {
    '--tool': valueFlag('tool'),
    '--profile': valueFlag('profilePath'),
    '--env-allow': repeatedValueFlag('envAllow'),
    '--timeout-ms': valueFlag('timeoutMs'),
    '--json': (parsed, _argv, index) => { parsed.json = true; return { nextIndex: index + 1 }; },
  });
}

function parseMcpBatchArgs(argv, startIndex, result) {
  return parseFlags(argv, startIndex, result, {
    '--tool': valueFlag('tool'),
    '--profile': valueFlag('profilePath'),
    '--calls-json': valueFlag('callsJson'),
    '--env-allow': repeatedValueFlag('envAllow'),
    '--timeout-ms': valueFlag('timeoutMs'),
    '--json': (parsed, _argv, index) => { parsed.json = true; return { nextIndex: index + 1 }; },
  });
}

/**
 * Parse adapter subcommand arguments.
 *
 * Supported commands:
 *   adapter run --tool <name> [--profile <path>] [--env-allow <VAR>] -- <command> [args...]
 *   adapter run --tool <name> --mcp-tool <tool> [--params-json <json>] [--env-allow <VAR>] [--timeout-ms <ms>]
 *   adapter run --tool <name> --calls-json <json> [--env-allow <VAR>] [--timeout-ms <ms>]
 *   adapter probe --tool <name> [--profile <path>] [--env-allow <VAR>] [--timeout-ms <ms>]
 *   adapter mcp tools --tool <name> [--profile <path>] [--env-allow <VAR>] [--timeout-ms <ms>]
 *   adapter mcp call --tool <name> --mcp-tool <tool> [--params-json <json>] [--env-allow <VAR>] [--timeout-ms <ms>]
 *   adapter mcp batch --tool <name> --calls-json <json> [--env-allow <VAR>] [--timeout-ms <ms>]
 *   adapter shim --tool <name> --commands <cmd1,cmd2> [--list] [--remove <cmd>] [--install-path [--write]]
 *   adapter profile install <path|url|github://|bare-name> [--index <path>] [--index-key <pubkey.pem>]
 *   adapter profile index verify <path> [--index-key <pubkey.pem>]
 *   adapter profile list
 *   adapter profile show <tool>
 */
export function parseAdapterArgs(argv) {
  const result = { subcommand: null };
  if (argv.length === 0) return { error: 'usage' };

  const action = argv[0];

  if (action === 'run') {
    return parseRunArgs(argv, 1, {
      subcommand: 'adapter-run',
      tool: null,
      profilePath: null,
      envAllow: [],
      mcpTool: null,
      paramsJson: '{}',
      callsJson: null,
      timeoutMs: null,
      json: false,
      command: null,
      args: [],
    });
  }

  if (action === 'probe') {
    return parseFlags(argv, 1, {
      subcommand: 'adapter-probe',
      tool: null,
      profilePath: null,
      envAllow: [],
      timeoutMs: null,
      json: false,
    }, {
      '--tool': valueFlag('tool'),
      '--profile': valueFlag('profilePath'),
      '--env-allow': repeatedValueFlag('envAllow'),
      '--timeout-ms': valueFlag('timeoutMs'),
      '--json': (parsed, _argv, index) => { parsed.json = true; return { nextIndex: index + 1 }; },
    });
  }

  if (action === 'mcp') {
    if (argv.length < 2) return { error: 'usage' };
    if (argv[1] === 'tools') {
      return parseMcpToolsArgs(argv, 2, {
        subcommand: 'adapter-mcp-tools',
        tool: null,
        profilePath: null,
        envAllow: [],
        timeoutMs: null,
        json: false,
      });
    }
    if (argv[1] === 'call') {
      return parseMcpCallArgs(argv, 2, {
        subcommand: 'adapter-mcp-call',
        tool: null,
        profilePath: null,
        mcpTool: null,
        paramsJson: '{}',
        envAllow: [],
        timeoutMs: null,
        json: false,
      });
    }
    if (argv[1] === 'batch') {
      return parseMcpBatchArgs(argv, 2, {
        subcommand: 'adapter-mcp-batch',
        tool: null,
        profilePath: null,
        callsJson: '[]',
        envAllow: [],
        timeoutMs: null,
        json: false,
      });
    }
    return { error: 'usage' };
  }

  if (action === 'shim') {
    return parseFlags(argv, 1, {
      subcommand: 'adapter-shim',
      tool: null,
      commands: [],
      list: false,
      remove: null,
      installPath: false,
      write: false,
    }, {
      '--tool': valueFlag('tool'),
      '--commands': valueFlag('commands', (value) => value.split(',')),
      '--list': (parsed, _argv, index) => { parsed.list = true; return { nextIndex: index + 1 }; },
      '--remove': valueFlag('remove'),
      '--install-path': (parsed, _argv, index) => { parsed.installPath = true; return { nextIndex: index + 1 }; },
      '--write': (parsed, _argv, index) => { parsed.write = true; return { nextIndex: index + 1 }; },
    });
  }

  if (action === 'profile') {
    if (argv.length < 2) return { error: 'usage' };
    const profileAction = argv[1];

    if (profileAction === 'install') {
      if (argv.length < 3) return { error: 'usage' };
      return parseFlags(argv, 3, {
        subcommand: 'adapter-profile-install',
        source: argv[2],
        force: false,
        indexPath: null,
        indexKeyPath: null,
      }, {
        '--force': (parsed, _argv, index) => {
          parsed.force = true;
          return { nextIndex: index + 1 };
        },
        '--index': valueFlag('indexPath'),
        '--index-key': valueFlag('indexKeyPath'),
      });
    }

    if (profileAction === 'list') {
      return { subcommand: 'adapter-profile-list' };
    }

    if (profileAction === 'discover') {
      return parseFlags(argv, 3, {
        subcommand: 'adapter-profile-discover',
        toolName: argv[2] && !argv[2].startsWith('--') ? argv[2] : null,
        json: false,
      }, {
        '--json': (parsed, _argv, index) => {
          parsed.json = true;
          return { nextIndex: index + 1 };
        },
      });
    }

    if (profileAction === 'index') {
      if (argv[2] !== 'verify' || argv.length < 4) return { error: 'usage' };
      return parseFlags(argv, 4, {
        subcommand: 'adapter-profile-index-verify',
        indexPath: argv[3],
        indexKeyPath: null,
      }, {
        '--index-key': valueFlag('indexKeyPath'),
      });
    }

    if (profileAction === 'show' && argv.length >= 3) {
      return { subcommand: 'adapter-profile-show', tool: argv[2] };
    }

    return { error: 'usage' };
  }

  return { error: 'usage' };
}

function formatProbeResult(result, jsonOutput) {
  if (jsonOutput) {
    return JSON.stringify(result.ok ? result : {
      ok: false,
      adapterResult: result.adapterResult,
      ...(result.probe ? { probe: result.probe } : {}),
    }, null, 2);
  }

  if (!result.ok) {
    return result.adapterResult?.guardrail?.reason || 'Adapter probe failed.';
  }

  const lines = [
    `MCP stdio probe succeeded for ${result.probe.tool}`,
    `  Transport:         ${result.probe.transport.type}`,
    `  Command:           ${result.probe.transport.command}`,
    `  Protocol version:  ${result.probe.server.protocolVersion || '<unknown>'}`,
  ];
  if (result.probe.server.serverInfo?.name) {
    const version = result.probe.server.serverInfo.version ? ` v${result.probe.server.serverInfo.version}` : '';
    lines.push(`  Server:            ${result.probe.server.serverInfo.name}${version}`);
  }
  lines.push(`  Tools discovered:  ${result.probe.server.toolCount}`);
  for (const toolName of result.probe.server.toolNames || []) {
    lines.push(`    - ${toolName}`);
  }
  return lines.join('\n');
}

function formatMcpToolsResult(result, jsonOutput) {
  if (jsonOutput) {
    return JSON.stringify(result.ok ? result : {
      ok: false,
      adapterResult: result.adapterResult,
      ...(result.probe ? { probe: result.probe } : {}),
    }, null, 2);
  }

  if (!result.ok) {
    return result.adapterResult?.guardrail?.reason || 'MCP tool discovery failed.';
  }

  const lines = [
    `MCP tools discovered for ${result.probe.tool}`,
    `  Transport:         ${result.probe.transport.type}`,
    `  Tool count:        ${result.probe.server.toolCount}`,
  ];
  for (const tool of result.probe.server.tools || []) {
    lines.push(`  - ${tool.name}`);
    if (tool.description) lines.push(`    ${tool.description}`);
  }
  return lines.join('\n');
}

function formatAdapterProfileIndexVerify(result, jsonOutput) {
  if (jsonOutput) {
    return JSON.stringify(result, null, 2);
  }

  if (!result.valid) {
    return `Adapter profile index verification failed: ${(result.errors || []).join('; ') || result.reason || 'unknown error'}`;
  }

  return [
    `Adapter profile index verified: ${result.path}`,
    `  Entries: ${result.entryCount}`,
    `  Tools:   ${result.tools.join(', ')}`,
  ].join('\n');
}

function formatAdapterProfileDiscover(result, jsonOutput) {
  if (jsonOutput) {
    return JSON.stringify(result, null, 2);
  }

  if (result.indexCount === 0) {
    return 'No trusted signed adapter indexes configured.';
  }

  const lines = [
    `Trusted adapter indexes: ${result.indexCount}`,
    `Matching tools: ${result.matchCount}`,
  ];
  for (const index of result.indexes) {
    lines.push(`- ${index.indexPath}${index.keyId ? ` (${index.keyId})` : ''}`);
    for (const tool of index.tools) {
      lines.push(`    ${tool.tool} -> ${tool.source}`);
    }
  }
  if (result.ambiguous && result.toolName) {
    lines.push('');
    lines.push(`"${result.toolName}" is ambiguous across trusted indexes. Pass --index/--index-key to install from one explicitly.`);
  }
  return lines.join('\n');
}

function formatMcpCallResult(result, jsonOutput) {
  if (jsonOutput) {
    return JSON.stringify(result, null, 2);
  }

  if (!result.ok) {
    return result.adapterResult?.guardrail?.reason || result.call?.reason || 'MCP tool call failed.';
  }

  const call = result.call || {};
  const rendered = typeof call.result === 'string'
    ? call.result
    : JSON.stringify(call.result, null, 2);

  return [
    `MCP tool call succeeded for ${call.tool}`,
    rendered,
  ].join('\n');
}

function formatMcpBatchResult(result, jsonOutput) {
  if (jsonOutput) {
    return JSON.stringify(result, null, 2);
  }

  if (!result.ok) {
    return result.adapterResult?.guardrail?.reason || result.batch?.reason || 'MCP tool batch failed.';
  }

  const batch = result.batch || {};
  const lines = [
    `MCP tool batch succeeded (${batch.callCount || 0} calls)`,
  ];
  for (const call of batch.calls || []) {
    const rendered = typeof call.result === 'string'
      ? call.result
      : JSON.stringify(call.result, null, 2);
    lines.push(`- ${call.tool}`);
    lines.push(rendered);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Adapter CLI dispatcher
// ---------------------------------------------------------------------------

export async function runAdapterCli(adapterArgv, options = {}) {
  const parsed = parseAdapterArgs(adapterArgv);

  if (parsed.error) {
    console.error('Usage: guardrail adapter <run|probe|shim|profile> [options]');
    console.error('');
    console.error('  adapter run --tool <name> [--env-allow VAR] -- <command> [args...]');
    console.error('  adapter run --tool <name> --mcp-tool <tool> [--params-json JSON] [--env-allow VAR] [--timeout-ms MS]');
    console.error('  adapter run --tool <name> --calls-json JSON [--env-allow VAR] [--timeout-ms MS]');
    console.error('  adapter probe --tool <name> [--env-allow VAR] [--timeout-ms MS]');
    console.error('  adapter mcp tools --tool <name> [--env-allow VAR] [--timeout-ms MS]');
    console.error('  adapter mcp call --tool <name> --mcp-tool <tool> [--params-json JSON] [--env-allow VAR] [--timeout-ms MS]');
    console.error('  adapter mcp batch --tool <name> --calls-json JSON [--env-allow VAR] [--timeout-ms MS]');
    console.error('  adapter shim --tool <name> --commands <cmd1,cmd2>');
    console.error('  adapter shim --list');
    console.error('  adapter shim --remove <command>');
    console.error('  adapter shim --install-path [--write]');
    console.error('  adapter profile install <path|url|github://|bare-name> [--index path] [--index-key pubkey.pem]');
    console.error('  adapter profile discover [tool-name] [--json]');
    console.error('  adapter profile index verify <path> --index-key <pubkey.pem>');
    console.error('  adapter profile list');
    console.error('  adapter profile show <tool>');
    process.exit(1);
    return;
  }

  if (parsed.subcommand === 'adapter-run') {
    if (!parsed.tool && !parsed.profilePath) {
      console.error('Error: No tool specified. Use --tool <name> or --profile <path>.');
      console.error('Available tools: guardrail adapter profile list');
      process.exit(1);
      return;
    }

    const { runAdapter, ADAPTER_REASON_CODES } = await import('./adapter-engine.js');
    try {
      let parsedParams = {};
      let parsedCalls = null;
      if (parsed.paramsJson != null) {
        try {
          parsedParams = JSON.parse(parsed.paramsJson || '{}');
        } catch (err) {
          console.error(`Error: --params-json must be valid JSON: ${err.message}`);
          process.exit(1);
          return;
        }
        if (parsedParams == null || typeof parsedParams !== 'object' || Array.isArray(parsedParams)) {
          console.error('Error: --params-json must decode to a JSON object.');
          process.exit(1);
          return;
        }
      }
      if (parsed.callsJson != null) {
        try {
          parsedCalls = JSON.parse(parsed.callsJson);
        } catch (err) {
          console.error(`Error: --calls-json must be valid JSON: ${err.message}`);
          process.exit(1);
          return;
        }
        if (!Array.isArray(parsedCalls) || parsedCalls.length === 0) {
          console.error('Error: --calls-json must decode to a non-empty JSON array.');
          process.exit(1);
          return;
        }
      }

      const result = await runAdapter({
        tool: parsed.tool,
        profilePath: parsed.profilePath,
        command: parsed.command,
        args: parsed.args,
        envAllow: parsed.envAllow || [],
        mcpTool: parsed.mcpTool,
        params: parsedParams,
        calls: parsedCalls,
        timeoutMs: parsed.timeoutMs || 5000,
      });

      const code = result?.adapterResult?.guardrail?.code;
      if (code === ADAPTER_REASON_CODES.MCP_BLOCKED) {
        console.error(`Error: ${result.adapterResult.guardrail.reason}`);
        const transportType = result?.adapterResult?.guardrail?.reason?.match(/Declared transport: ([^.]+)\./)?.[1];
        if (transportType) {
          console.error(`Declared MCP transport: ${transportType}`);
        }
        process.exit(1);
        return;
      }
      if (
        code === ADAPTER_REASON_CODES.PROFILE_NOT_FOUND
        || code === ADAPTER_REASON_CODES.PROFILE_INVALID
      ) {
        console.error(result.adapterResult.guardrail.reason);
        process.exit(1);
        return;
      }

      const output = !!parsed.json || !!options.jsonOutput
        ? JSON.stringify({
          adapterResult: result.adapterResult,
          renderedResponse: result.renderedResponse,
          ...(result.mcpCall ? { mcpCall: result.mcpCall } : {}),
          ...(result.mcpBatch ? { mcpBatch: result.mcpBatch } : {}),
        }, null, 2)
        : (typeof result.renderedResponse === 'string'
          ? result.renderedResponse
          : result.renderedResponse != null
            ? JSON.stringify(result.renderedResponse, null, 2)
            : (result.adapterResult?.guardrail?.reason || 'Adapter run failed.'));
      if (!!parsed.json || !!options.jsonOutput) {
        console.log(output);
      } else if (result.exitCode === 0) {
        console.log(output);
      } else {
        console.error(output);
      }
      process.exit(result.exitCode);
    } catch (err) {
      console.error(err.message);
      process.exit(19);
    }
    return;
  }

  if (parsed.subcommand === 'adapter-probe') {
    if (!parsed.tool && !parsed.profilePath) {
      console.error('Error: No tool specified. Use --tool <name> or --profile <path>.');
      console.error('Available tools: guardrail adapter profile list');
      process.exit(1);
      return;
    }

    const { probeAdapterMcpStdio } = await import('./adapter-engine.js');
    const jsonOutput = !!parsed.json || !!options.jsonOutput;
    const result = await probeAdapterMcpStdio({
      tool: parsed.tool,
      profilePath: parsed.profilePath,
      envAllow: parsed.envAllow || [],
      timeoutMs: parsed.timeoutMs || 5000,
    });

    if (!result.ok) {
      const output = formatProbeResult(result, jsonOutput);
      if (jsonOutput) {
        console.log(output);
      } else {
        console.error(output);
      }
      process.exit(result.exitCode || 1);
      return;
    }

    console.log(formatProbeResult(result, jsonOutput));
    process.exit(0);
    return;
  }

  if (parsed.subcommand === 'adapter-mcp-tools') {
    if (!parsed.tool && !parsed.profilePath) {
      console.error('Error: No tool specified. Use --tool <name> or --profile <path>.');
      console.error('Available tools: guardrail adapter profile list');
      process.exit(1);
      return;
    }

    const { probeAdapterMcpStdio } = await import('./adapter-engine.js');
    const jsonOutput = !!parsed.json || !!options.jsonOutput;
    const result = await probeAdapterMcpStdio({
      tool: parsed.tool,
      profilePath: parsed.profilePath,
      envAllow: parsed.envAllow || [],
      timeoutMs: parsed.timeoutMs || 5000,
    });

    if (!result.ok) {
      const output = formatMcpToolsResult(result, jsonOutput);
      if (jsonOutput) {
        console.log(output);
      } else {
        console.error(output);
      }
      process.exit(result.exitCode || 1);
      return;
    }

    console.log(formatMcpToolsResult(result, jsonOutput));
    process.exit(0);
    return;
  }

  if (parsed.subcommand === 'adapter-mcp-call') {
    if (!parsed.tool && !parsed.profilePath) {
      console.error('Error: No tool specified. Use --tool <name> or --profile <path>.');
      console.error('Available tools: guardrail adapter profile list');
      process.exit(1);
      return;
    }
    if (!parsed.mcpTool) {
      console.error('Error: --mcp-tool <name> is required.');
      process.exit(1);
      return;
    }

    let params = {};
    try {
      params = JSON.parse(parsed.paramsJson || '{}');
    } catch (err) {
      console.error(`Error: --params-json must be valid JSON: ${err.message}`);
      process.exit(1);
      return;
    }
    if (params == null || typeof params !== 'object' || Array.isArray(params)) {
      console.error('Error: --params-json must decode to a JSON object.');
      process.exit(1);
      return;
    }

    const { callAdapterMcpTool } = await import('./adapter-engine.js');
    const jsonOutput = !!parsed.json || !!options.jsonOutput;
    const result = await callAdapterMcpTool({
      tool: parsed.tool,
      profilePath: parsed.profilePath,
      mcpTool: parsed.mcpTool,
      params,
      envAllow: parsed.envAllow || [],
      timeoutMs: parsed.timeoutMs || 5000,
    });

    const output = formatMcpCallResult(result, jsonOutput);
    if (!result.ok) {
      if (jsonOutput) {
        console.log(output);
      } else {
        console.error(output);
      }
      process.exit(result.exitCode || 1);
      return;
    }

    console.log(output);
    process.exit(result.exitCode || 0);
    return;
  }

  if (parsed.subcommand === 'adapter-mcp-batch') {
    if (!parsed.tool && !parsed.profilePath) {
      console.error('Error: No tool specified. Use --tool <name> or --profile <path>.');
      console.error('Available tools: guardrail adapter profile list');
      process.exit(1);
      return;
    }

    let calls = [];
    try {
      calls = JSON.parse(parsed.callsJson || '[]');
    } catch (err) {
      console.error(`Error: --calls-json must be valid JSON: ${err.message}`);
      process.exit(1);
      return;
    }
    if (!Array.isArray(calls) || calls.length === 0) {
      console.error('Error: --calls-json must decode to a non-empty JSON array.');
      process.exit(1);
      return;
    }

    const { callAdapterMcpToolBatch } = await import('./adapter-engine.js');
    const jsonOutput = !!parsed.json || !!options.jsonOutput;
    const result = await callAdapterMcpToolBatch({
      tool: parsed.tool,
      profilePath: parsed.profilePath,
      calls,
      envAllow: parsed.envAllow || [],
      timeoutMs: parsed.timeoutMs || 5000,
    });

    const output = formatMcpBatchResult(result, jsonOutput);
    if (!result.ok) {
      if (jsonOutput) {
        console.log(output);
      } else {
        console.error(output);
      }
      process.exit(result.exitCode || 1);
      return;
    }

    console.log(output);
    process.exit(result.exitCode || 0);
    return;
  }

  if (parsed.subcommand === 'adapter-shim') {
    const { createShim, removeShim, listShims, getInstallPathExport, writeShellRc } = await import('./adapter-shim.js');

    if (parsed.list) {
      const shims = listShims();
      if (shims.length === 0) {
        console.log('No shims installed.');
      } else {
        for (const s of shims) {
          console.log(`  ${s.command} -> ${s.tool} (${s.path})`);
        }
      }
      process.exit(0);
      return;
    }

    if (parsed.remove) {
      const result = removeShim(parsed.remove);
      if (result.removed) {
        console.log(`Removed shim: ${parsed.remove}`);
      } else {
        console.error(`Shim not found: ${parsed.remove}`);
        process.exit(1);
      }
      return;
    }

    if (parsed.installPath) {
      const exportLine = getInstallPathExport();
      console.log(exportLine);
      if (parsed.write) {
        const result = writeShellRc({ write: true });
        if (result.alreadyPresent) {
          console.log(`Already present in ${result.rcPath}`);
        } else if (result.written) {
          console.log(`Written to ${result.rcPath}`);
        }
      }
      process.exit(0);
      return;
    }

    if (!parsed.tool) {
      console.error('Error: --tool is required for shim creation.');
      process.exit(1);
      return;
    }

    if (parsed.commands.length === 0) {
      console.error('Error: --commands is required for shim creation.');
      process.exit(1);
      return;
    }

    for (const cmd of parsed.commands) {
      const result = createShim(cmd, parsed.tool);
      console.log(`Created shim: ${cmd} -> ${parsed.tool} (${result.path})`);
    }
    process.exit(0);
    return;
  }

  if (parsed.subcommand === 'adapter-profile-install') {
    const { installAdapterProfile } = await import('./adapter-profile-install.js');
    try {
      const result = await installAdapterProfile(parsed.source, {
        force: parsed.force,
        indexPath: parsed.indexPath,
        indexKeyPath: parsed.indexKeyPath,
      });
      console.log(`Installed adapter profile "${result.tool}" v${result.version}`);
      console.log(`  Path: ${result.path}`);
      console.log(`  Hash: ${result.hash}`);
      process.exit(0);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    return;
  }

  if (parsed.subcommand === 'adapter-profile-discover') {
    const { discoverTrustedAdapterProfiles } = await import('./adapter-profile-install.js');
    try {
      const result = discoverTrustedAdapterProfiles({
        toolName: parsed.toolName,
      });
      console.log(formatAdapterProfileDiscover(result, !!parsed.json || !!options.jsonOutput));
      process.exit(0);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    return;
  }

  if (parsed.subcommand === 'adapter-profile-index-verify') {
    const { loadAdapterProfileIndex, verifyAdapterProfileIndex } = await import('./adapter-profile-index.js');
    const { existsSync, readFileSync } = await import('node:fs');
    try {
      if (!parsed.indexKeyPath) {
        console.error('Error: --index-key <pubkey.pem> is required for adapter profile index verification.');
        process.exit(1);
        return;
      }
      if (!existsSync(parsed.indexKeyPath)) {
        console.error(`Adapter profile index public key not found: ${parsed.indexKeyPath}`);
        process.exit(1);
        return;
      }
      const index = loadAdapterProfileIndex(parsed.indexPath);
      const publicKeyPem = readFileSync(parsed.indexKeyPath, 'utf8');
      const verify = verifyAdapterProfileIndex(index, publicKeyPem);
      const payload = {
        valid: verify.valid,
        path: parsed.indexPath,
        entryCount: Object.keys(index.profiles || {}).length,
        tools: Object.keys(index.profiles || {}),
        errors: verify.errors || [],
        ...(verify.reason ? { reason: verify.reason } : {}),
      };
      const output = formatAdapterProfileIndexVerify(payload, !!options.jsonOutput);
      if (payload.valid) {
        console.log(output);
        process.exit(0);
      } else {
        console.error(output);
        process.exit(1);
      }
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    return;
  }

  if (parsed.subcommand === 'adapter-profile-list') {
    const { listProfiles } = await import('./adapter-profile.js');
    const profiles = listProfiles();
    if (profiles.length === 0) {
      console.log('No adapter profiles found.');
    } else {
      console.log('Adapter profiles:');
      for (const p of profiles) {
        const source = p.bundled ? '(bundled)' : '(installed)';
        console.log(`  ${p.tool} v${p.version} [${p.protocol}] ${source}`);
      }
    }
    process.exit(0);
    return;
  }

  if (parsed.subcommand === 'adapter-profile-show') {
    const { resolveProfile } = await import('./adapter-profile.js');
    try {
      const profile = resolveProfile(parsed.tool);
      console.log(JSON.stringify(profile, null, 2));
      process.exit(0);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }
}

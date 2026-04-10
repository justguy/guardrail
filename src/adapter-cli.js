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
    }[argv[i]];
    if (!handler) return { error: 'usage' };
    const next = handler(result, argv, i);
    if (next.error) return next;
    i = next.nextIndex;
  }
  return result;
}

/**
 * Parse adapter subcommand arguments.
 *
 * Supported commands:
 *   adapter run --tool <name> [--profile <path>] [--env-allow <VAR>] -- <command> [args...]
 *   adapter probe --tool <name> [--profile <path>] [--env-allow <VAR>] [--timeout-ms <ms>]
 *   adapter shim --tool <name> --commands <cmd1,cmd2> [--list] [--remove <cmd>] [--install-path [--write]]
 *   adapter profile install <path|url|github://>
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
      }, {
        '--force': (parsed, _argv, index) => {
          parsed.force = true;
          return { nextIndex: index + 1 };
        },
      });
    }

    if (profileAction === 'list') {
      return { subcommand: 'adapter-profile-list' };
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
  for (const toolName of result.probe.server.tools || []) {
    lines.push(`    - ${toolName}`);
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
    console.error('  adapter probe --tool <name> [--env-allow VAR] [--timeout-ms MS]');
    console.error('  adapter shim --tool <name> --commands <cmd1,cmd2>');
    console.error('  adapter shim --list');
    console.error('  adapter shim --remove <command>');
    console.error('  adapter shim --install-path [--write]');
    console.error('  adapter profile install <path|url|github://>');
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
      const result = await runAdapter({
        tool: parsed.tool,
        profilePath: parsed.profilePath,
        command: parsed.command,
        args: parsed.args,
        envAllow: parsed.envAllow || [],
      });

      const code = result?.adapterResult?.guardrail?.code;
      if (code === ADAPTER_REASON_CODES.MCP_BLOCKED) {
        console.error('Error: MCP protocol is not yet supported in v0.2.');
        const transportType = result?.adapterResult?.guardrail?.reason?.match(/Declared transport: ([^.]+)\./)?.[1];
        if (transportType) {
          console.error(`Declared MCP transport: ${transportType}`);
        }
        console.error('');
        console.error('For Cline integration now, use the env-shim path or install a shim-oriented profile.');
        console.error('See: docs/adapter-implementation-plan.md#mcp-roadmap');
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

      const output = typeof result.renderedResponse === 'string'
        ? result.renderedResponse
        : JSON.stringify(result.renderedResponse, null, 2);
      console.log(output);
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
      const result = await installAdapterProfile(parsed.source, { force: parsed.force });
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

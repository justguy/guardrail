import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Adapter CLI — subcommand parsing and routing
// ---------------------------------------------------------------------------

/**
 * Parse adapter subcommand arguments.
 *
 * Supported commands:
 *   adapter run --tool <name> [--profile <path>] [--env-allow <VAR>] -- <command> [args...]
 *   adapter shim --tool <name> --commands <cmd1,cmd2> [--list] [--remove <cmd>] [--install-path [--write]]
 *   adapter profile install <path|url|github://>
 *   adapter profile list
 *   adapter profile show <tool>
 */
export function parseAdapterArgs(argv) {
  const result = { subcommand: null };
  let i = 0;

  if (i >= argv.length) return { error: 'usage' };

  const action = argv[i++];

  // --- adapter run ---
  if (action === 'run') {
    result.subcommand = 'adapter-run';
    result.tool = null;
    result.profilePath = null;
    result.envAllow = [];
    result.command = null;
    result.args = [];

    while (i < argv.length) {
      if (argv[i] === '--tool' && i + 1 < argv.length) { result.tool = argv[++i]; i++; continue; }
      if (argv[i] === '--profile' && i + 1 < argv.length) { result.profilePath = argv[++i]; i++; continue; }
      if (argv[i] === '--env-allow' && i + 1 < argv.length) { result.envAllow.push(argv[++i]); i++; continue; }
      if (argv[i] === '--') {
        i++;
        if (i < argv.length) {
          result.command = argv[i++];
          result.args = argv.slice(i);
        }
        break;
      }
      return { error: 'usage' };
    }

    return result;
  }

  // --- adapter shim ---
  if (action === 'shim') {
    result.subcommand = 'adapter-shim';
    result.tool = null;
    result.commands = [];
    result.list = false;
    result.remove = null;
    result.installPath = false;
    result.write = false;

    while (i < argv.length) {
      if (argv[i] === '--tool' && i + 1 < argv.length) { result.tool = argv[++i]; i++; continue; }
      if (argv[i] === '--commands' && i + 1 < argv.length) { result.commands = argv[++i].split(','); i++; continue; }
      if (argv[i] === '--list') { result.list = true; i++; continue; }
      if (argv[i] === '--remove' && i + 1 < argv.length) { result.remove = argv[++i]; i++; continue; }
      if (argv[i] === '--install-path') { result.installPath = true; i++; continue; }
      if (argv[i] === '--write') { result.write = true; i++; continue; }
      return { error: 'usage' };
    }

    return result;
  }

  // --- adapter profile ---
  if (action === 'profile') {
    if (i >= argv.length) return { error: 'usage' };
    const profileAction = argv[i++];

    if (profileAction === 'install') {
      result.subcommand = 'adapter-profile-install';
      if (i >= argv.length) return { error: 'usage' };
      result.source = argv[i++];
      while (i < argv.length) {
        if (argv[i] === '--force') { result.force = true; i++; continue; }
        return { error: 'usage' };
      }
      return result;
    }

    if (profileAction === 'list') {
      result.subcommand = 'adapter-profile-list';
      return result;
    }

    if (profileAction === 'show') {
      result.subcommand = 'adapter-profile-show';
      if (i >= argv.length) return { error: 'usage' };
      result.tool = argv[i++];
      return result;
    }

    return { error: 'usage' };
  }

  return { error: 'usage' };
}

// ---------------------------------------------------------------------------
// Adapter CLI dispatcher
// ---------------------------------------------------------------------------

/**
 * Run the adapter CLI from parsed arguments.
 * Called by main() in cli.js when subcommand === 'adapter'.
 */
export async function runAdapterCli(adapterArgv) {
  const parsed = parseAdapterArgs(adapterArgv);

  if (parsed.error) {
    console.error('Usage: guardrail adapter <run|shim|profile> [options]');
    console.error('');
    console.error('  adapter run --tool <name> [--env-allow VAR] -- <command> [args...]');
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

  // --- adapter run ---
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

      // MCP gate: adapter-result carries the structured block; the CLI keeps
      // the user-facing error message shape and the historical exit-1 for
      // shell scripts that pipe `guardrail adapter run --tool cline ...`.
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
      // PROFILE_NOT_FOUND / PROFILE_INVALID: keep the legacy behaviour of
      // printing the reason to stderr and exiting with 1 rather than the
      // adapter-result exit code, so existing shell scripts don't break.
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

  // --- adapter shim ---
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

  // --- adapter profile install ---
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

  // --- adapter profile list ---
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

  // --- adapter profile show ---
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
    return;
  }
}

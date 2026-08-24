import { spawn } from 'node:child_process';
import { buildEnvFromPolicy } from './shared.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the process identified by `pid` is still alive.
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 = existence check, no signal sent
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait for a child process to exit, with a timeout.
 * Resolves with { exited: true, code, signal } or { exited: false }.
 */
function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ exited: false });
      }
    }, timeoutMs);

    child.on('exit', (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ exited: true, code, signal });
      }
    });

    // If the process is already dead by the time we attach, the 'exit' event
    // may have already fired. Check explicitly.
    if (child.exitCode !== null || child.signalCode !== null) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ exited: true, code: child.exitCode, signal: child.signalCode });
      }
    }
  });
}

/**
 * Strip the ChildProcess reference from a handle to produce a
 * JSON-serializable snapshot.
 */
function serializeHandle(handle) {
  if (!handle) return null;
  const { process: _proc, ...rest } = handle;
  return rest;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a service registry scoped to a fixed set of declared services.
 *
 * @param {Array<object>} declaredServices - Service definition objects from
 *   the workflow. Each must have at least an `id` field.
 * @returns {object} Registry API.
 */
export function createServiceRegistry(declaredServices = []) {
  // Build a lookup of declared service definitions keyed by id.
  const declarations = new Map();
  for (const def of declaredServices) {
    if (!def || !def.id) {
      throw new Error('Every declared service must have an "id" field.');
    }
    declarations.set(def.id, def);
  }

  /** @type {Map<string, object>} Active handles keyed by service id. */
  const handles = new Map();

  // -----------------------------------------------------------------------
  // startService
  // -----------------------------------------------------------------------

  async function startService(serviceDefinition) {
    if (!serviceDefinition || !serviceDefinition.id) {
      return { success: false, handle: null, error: 'Service definition must include an "id".' };
    }

    const { id } = serviceDefinition;

    // Must be declared in the workflow.
    if (!declarations.has(id)) {
      return { success: false, handle: null, error: `Service "${id}" is not declared in the workflow.` };
    }

    // If already running, refuse — caller should restart explicitly.
    if (handles.has(id) && isRunning(id)) {
      return { success: false, handle: null, error: `Service "${id}" is already running.` };
    }

    const startDef = serviceDefinition.start || {};
    const command = startDef.command;
    const args = startDef.args || [];
    const cwd = startDef.cwd || process.cwd();
    const timeoutMs = startDef.timeoutMs ?? 2000;

    if (!command) {
      return { success: false, handle: null, error: `Service "${id}" has no start command.` };
    }

    const env = buildEnvFromPolicy(startDef.envPolicy);

    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        detached: false,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch (err) {
      return { success: false, handle: null, error: `Failed to spawn service "${id}": ${err.message}` };
    }

    // Wait briefly to detect an immediate crash.
    const crashCheckMs = Math.min(timeoutMs, 2000);
    const result = await waitForExit(child, crashCheckMs);

    if (result.exited) {
      const handle = {
        id,
        pid: child.pid ?? null,
        process: child,
        command,
        args,
        cwd,
        startedAt: new Date().toISOString(),
        status: 'failed',
      };
      handles.set(id, handle);
      return {
        success: false,
        handle: serializeHandle(handle),
        error: `Service "${id}" exited immediately (code=${result.code}, signal=${result.signal}).`,
      };
    }

    const handle = {
      id,
      pid: child.pid,
      process: child,
      command,
      args,
      cwd,
      startedAt: new Date().toISOString(),
      status: 'running',
    };

    // Track unexpected exits so the handle status stays accurate.
    child.on('exit', () => {
      if (handle.status === 'running') {
        handle.status = 'failed';
      }
    });

    handles.set(id, handle);

    return { success: true, handle: serializeHandle(handle), error: null };
  }

  // -----------------------------------------------------------------------
  // stopService
  // -----------------------------------------------------------------------

  async function stopService(serviceId) {
    if (!declarations.has(serviceId)) {
      return { success: false, error: `Service "${serviceId}" is not declared in the workflow.` };
    }

    const handle = handles.get(serviceId);
    if (!handle) {
      return { success: false, error: `No handle found for service "${serviceId}".` };
    }

    if (handle.status === 'stopped') {
      return { success: true, error: null };
    }

    // If the process is already dead, just mark it and return.
    if (!isProcessAlive(handle.pid)) {
      handle.status = 'stopped';
      return { success: true, error: null };
    }

    const stopDef = declarations.get(serviceId).stop || {};
    const signal = stopDef.signal || 'SIGTERM';
    const killAfterMs = stopDef.killAfterMs ?? 5000;

    try {
      handle.process.kill(signal);
    } catch {
      // Process may have died between the alive check and the kill call.
      handle.status = 'stopped';
      return { success: true, error: null };
    }

    const result = await waitForExit(handle.process, killAfterMs);

    if (!result.exited) {
      // Escalate to SIGKILL.
      try {
        handle.process.kill('SIGKILL');
      } catch {
        // Already gone — that's fine.
      }
      // Give SIGKILL a moment to take effect.
      await waitForExit(handle.process, 2000);
    }

    handle.status = 'stopped';
    return { success: true, error: null };
  }

  // -----------------------------------------------------------------------
  // restartService
  // -----------------------------------------------------------------------

  async function restartService(serviceId, serviceDefinition) {
    if (!declarations.has(serviceId)) {
      return { success: false, handle: null, error: `Service "${serviceId}" is not declared in the workflow.` };
    }

    const def = serviceDefinition || declarations.get(serviceId);

    // Stop if currently running.
    if (handles.has(serviceId)) {
      const stopResult = await stopService(serviceId);
      if (!stopResult.success) {
        return { success: false, handle: null, error: `Failed to stop service before restart: ${stopResult.error}` };
      }
    }

    return startService(def);
  }

  // -----------------------------------------------------------------------
  // getService
  // -----------------------------------------------------------------------

  function getService(serviceId) {
    const handle = handles.get(serviceId);
    return handle ? serializeHandle(handle) : null;
  }

  // -----------------------------------------------------------------------
  // isRunning
  // -----------------------------------------------------------------------

  function isRunning(serviceId) {
    const handle = handles.get(serviceId);
    if (!handle) return false;
    if (handle.status !== 'running') return false;
    if (handle.process.killed) return false;
    return isProcessAlive(handle.pid);
  }

  // -----------------------------------------------------------------------
  // cleanupAll
  // -----------------------------------------------------------------------

  async function cleanupAll() {
    const ids = [...handles.keys()];
    const results = [];
    for (const id of ids) {
      if (isRunning(id)) {
        results.push(await stopService(id));
      } else {
        // Mark stale handles as stopped.
        const h = handles.get(id);
        if (h && h.status !== 'stopped') h.status = 'stopped';
      }
    }
    return results;
  }

  // -----------------------------------------------------------------------
  // getState
  // -----------------------------------------------------------------------

  /**
   * Return a serializable snapshot of every tracked handle (no process refs).
   */
  function getState() {
    const state = {};
    for (const [id, handle] of handles) {
      // Refresh status before serializing.
      if (handle.status === 'running' && !isProcessAlive(handle.pid)) {
        handle.status = 'failed';
      }
      state[id] = serializeHandle(handle);
    }
    return state;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    startService,
    stopService,
    restartService,
    getService,
    isRunning,
    cleanupAll,
    getState,
  };
}

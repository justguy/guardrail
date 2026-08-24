import { existsSync, readFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function handleProgressSubcommand(parsed, deps = {}) {
  const {
    isTerminalAiProgressState,
    printRecipeProgressText,
    readAiProgressSnapshot,
    resolveRecipeProgressStateDir,
  } = deps;

  if (parsed.subcommand === 'recipe-progress') {
    const stateDir = resolveRecipeProgressStateDir(parsed.stateDir, parsed.runId);
    if (!stateDir) {
      console.error('Error: recipe progress requires --state-dir <dir> or a matching --run-id <id>');
      process.exit(1);
    }
    let snapshot = readAiProgressSnapshot(stateDir);

    if (parsed.follow) {
      let lastStateSignature = JSON.stringify(snapshot.state ?? null);
      let lastEventCount = snapshot.events.length;

      if (parsed.json) {
        console.log(JSON.stringify({
          stateDir,
          state: snapshot.state,
          events: snapshot.events,
        }));
      } else if (!snapshot.state && snapshot.events.length === 0) {
        console.log(`Waiting for AI progress data in ${stateDir}...`);
      } else {
        printRecipeProgressText(snapshot);
      }

      while (true) {
        if (isTerminalAiProgressState(snapshot.state?.status)) break;
        await delay(1000);
        const nextSnapshot = readAiProgressSnapshot(stateDir);
        const nextStateSignature = JSON.stringify(nextSnapshot.state ?? null);
        const nextEventCount = nextSnapshot.events.length;
        const stateChanged = nextStateSignature !== lastStateSignature;
        const newEvents = nextEventCount > lastEventCount
          ? nextSnapshot.events.slice(lastEventCount)
          : [];

        if (parsed.json) {
          if (stateChanged || newEvents.length > 0) {
            console.log(JSON.stringify({
              stateDir,
              state: nextSnapshot.state,
              events: newEvents,
            }));
          }
        } else {
          if (stateChanged && nextSnapshot.state) {
            console.log('');
            console.log(`Status:  ${nextSnapshot.state.status ?? 'unknown'}`);
            if (nextSnapshot.state.lastPhase) console.log(`Phase:   ${nextSnapshot.state.lastPhase}`);
            if (nextSnapshot.state.lastMessage) console.log(`Last:    ${nextSnapshot.state.lastMessage}`);
            if (nextSnapshot.state.continuationCommand) {
              console.log(`To continue: ${nextSnapshot.state.continuationCommand}`);
            }
          }
          if (newEvents.length > 0) {
            printRecipeProgressText(
              { state: nextSnapshot.state, events: nextSnapshot.events },
              lastEventCount,
              { includeHeader: false },
            );
          }
        }

        snapshot = nextSnapshot;
        lastStateSignature = nextStateSignature;
        lastEventCount = nextEventCount;
      }
    } else if (parsed.json) {
      console.log(JSON.stringify({ stateDir, state: snapshot.state, events: snapshot.events }, null, 2));
    } else {
      if (!snapshot.state && snapshot.events.length === 0) {
        console.log(`No AI progress data found in ${stateDir}`);
        process.exit(0);
      }
      printRecipeProgressText(snapshot);
    }
    process.exit(0);
  }

  if (parsed.subcommand === 'recipe-continue') {
    const stateDir = parsed.stateDir || '';
    const prompt = parsed.prompt || '';
    const stateFile = pathJoin(stateDir, 'ai-progress-state.json');

    let state = null;
    if (existsSync(stateFile)) {
      try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { /* ignore */ }
    }

    if (!state) {
      console.error(`Error: no progress state found in ${stateDir}`);
      process.exit(1);
    }

    const eligibleStates = new Set(['waiting_for_review', 'waiting_for_input', 'drift_warning', 'stalled', 'running']);
    if (!eligibleStates.has(state.status)) {
      console.error(`Error: run is in state "${state.status}" which is not continuation-eligible`);
      process.exit(1);
    }

    const { runClaudeExec } = await import('../claude-exec-wrapper.js');
    try {
      await runClaudeExec({
        prompt,
        sessionName: state.sessionName ?? '',
        sessionId: state.sessionId ?? '',
        lifecycle: 'continue',
        workingDir: state.workingDir ?? '',
        guardrailProgressFile: state.progressArtifact ?? '',
        guardrailProgressStateFile: stateFile,
      });
    } catch (err) {
      console.error(`Error: continuation failed: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  return false;
}

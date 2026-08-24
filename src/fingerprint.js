import { hostname, platform, arch, release } from 'node:os';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Environment fingerprinting (I-A, Directive 1)
// ---------------------------------------------------------------------------

/**
 * Capture a deterministic snapshot of the execution environment.
 * Included in audit log entries for forensic reconstruction.
 * Not used for enforcement — environments change.
 *
 * @returns {object} Environment fingerprint.
 */
export function captureFingerprint() {
  return {
    os:          platform(),
    arch:        arch(),
    hostname:    hostname(),
    osRelease:   release(),
    nodeVersion: process.version,
    cwd:         resolve(process.cwd()),
    envVarNames: Object.keys(process.env).sort(),
    capturedAt:  new Date().toISOString(),
  };
}

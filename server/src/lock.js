import { openSync, writeSync, closeSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ChaosError } from './errors.js';

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Cross-process "one scenario at a time" lock (server and CLI share it).
 * A lock left by a dead process is taken over.
 */
export function acquireRunLock(
  file,
  runId,
  { pid = process.pid, isAlive = alive, unlink = unlinkSync } = {},
) {
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx');
      writeSync(fd, JSON.stringify({ pid, runId }));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(file);
        } catch {
          /* already gone */
        }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let holder = {};
      try {
        holder = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        /* unreadable: treat as stale */
      }
      if (holder.pid && isAlive(holder.pid)) {
        throw new ChaosError('RUN_IN_PROGRESS', `Run ${holder.runId} is in progress`, 409, {
          runId: holder.runId,
        });
      }
      unlink(file);
    }
  }
  throw new ChaosError('RUN_IN_PROGRESS', 'Could not acquire the run lock', 409);
}

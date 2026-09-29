import { appendFileSync, readFileSync, mkdirSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Append-only injection journal (JSON lines, fsynced). An injection is
 * "pending" until a revert_ok event is written; pending injections are
 * reverted when Chaos starts.
 */
export function createJournal({ file, clock = { now: Date.now } }) {
  mkdirSync(dirname(file), { recursive: true });

  function append(event) {
    const line = JSON.stringify({ ts: new Date(clock.now()).toISOString(), ...event }) + '\n';
    appendFileSync(file, line);
    // Write-capable descriptor: Windows refuses fsync on a read-only one (EPERM).
    const fd = openSync(file, 'a');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  function readEvents() {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    return text
      .split('\n')
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return []; // torn last line after a crash
        }
      });
  }

  function aggregate() {
    const byId = new Map();
    for (const e of readEvents()) {
      if (e.event === 'inject_start') {
        byId.set(e.id, {
          id: e.id,
          actor: e.actor,
          runId: e.runId,
          target: e.target,
          project: e.project,
          service: e.service,
          fault: e.fault,
          params: e.params,
          startedAt: e.ts,
          state: null,
          injected: false,
          revertedAt: null,
          revertOk: null,
          error: null,
        });
        continue;
      }
      const entry = byId.get(e.id);
      if (!entry) continue;
      if (e.event === 'checkpoint') entry.state = e.state;
      else if (e.event === 'injected') {
        entry.injected = true;
        entry.state = e.state;
      } else {
        entry.revertedAt = e.ts;
        entry.revertOk = e.ok;
        entry.error = e.error ?? null;
        entry.revertedBy = e.by;
      }
    }
    return [...byId.values()];
  }

  return {
    file,
    begin({ actor, runId, target, project, service, fault, params }) {
      const id = randomUUID();
      append({ event: 'inject_start', id, actor, runId, target, project, service, fault, params });
      return id;
    },
    checkpoint(id, state) {
      append({ event: 'checkpoint', id, state });
    },
    injected(id, state) {
      append({ event: 'injected', id, state });
    },
    reverted(id, ok, { error, by = 'runner' } = {}) {
      append({ event: 'revert', id, ok, error, by });
    },
    entries({ limit = 200 } = {}) {
      return aggregate().reverse().slice(0, limit);
    },
    pending() {
      return aggregate().filter((e) => e.revertOk !== true);
    },
  };
}

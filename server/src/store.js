import { mkdirSync, writeFileSync, renameSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ChaosError } from './errors.js';

const ID = /^[\w-]+$/;

/** Stores run reports as one JSON file each (atomic rename). */
export function createStore({ dir }) {
  mkdirSync(dir, { recursive: true });
  const path = (id) => {
    if (!ID.test(id)) throw new ChaosError('RUN_UNKNOWN', `Unknown run ${id}`, 404);
    return join(dir, `${id}.json`);
  };
  return {
    save(report) {
      const file = path(report.id);
      writeFileSync(`${file}.tmp`, JSON.stringify(report));
      renameSync(`${file}.tmp`, file);
    },
    get(id) {
      try {
        return JSON.parse(readFileSync(path(id), 'utf8'));
      } catch (e) {
        if (e instanceof ChaosError) throw e;
        throw new ChaosError('RUN_UNKNOWN', `Unknown run ${id}`, 404);
      }
    },
    list() {
      return readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
          return {
            id: r.id,
            scenario: r.scenario.name,
            target: r.target,
            status: r.status,
            score: r.score,
            actor: r.actor,
            startedAt: r.startedAt,
            endedAt: r.endedAt,
          };
        })
        .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    },
  };
}

import { findTarget } from './targets.js';

/**
 * Reverts every injection the journal still marks as pending (Chaos
 * crashed or was killed mid-run). Called once at startup.
 */
export async function recoverPending({
  journal,
  catalog,
  targets,
  drivers,
  clock,
  log = () => {},
}) {
  const results = [];
  for (const entry of journal.pending()) {
    let ok = false;
    let error;
    try {
      const target = findTarget(targets(), entry.target);
      if (entry.project && entry.project !== target.project) {
        throw new Error(`project changed (${entry.project} -> ${target.project}): manual cleanup`);
      }
      const service = target.services.find((s) => s.name === entry.service);
      const fault = catalog.get(entry.fault);
      const d = drivers(target);
      const ctx = {
        target,
        service,
        ...d,
        clock,
        detach: async () => {},
      };
      await fault.revert(ctx, entry.state);
      ok = true;
    } catch (e) {
      error = e.message;
    }
    journal.reverted(entry.id, ok, { error, by: 'recovery' });
    log(`recovery: ${entry.fault} on ${entry.target}/${entry.service}: ${ok ? 'reverted' : error}`);
    results.push({ id: entry.id, fault: entry.fault, ok, error });
  }
  return results;
}

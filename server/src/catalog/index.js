// The catalog: one file per fault, one line per fault here. The runner only
// ever reaches faults through this list.
import latency from './faults/latency.js';
import connectionReset from './faults/connection-reset.js';
import bandwidth from './faults/bandwidth.js';
import servicePause from './faults/service-pause.js';
import serviceKill from './faults/service-kill.js';
import egressBlock from './faults/egress-block.js';
import browserOffline from './faults/browser-offline.js';
import browserSlowApi from './faults/browser-slow-api.js';
import browserMissingChunk from './faults/browser-missing-chunk.js';
import diskPressure from './faults/disk-pressure.js';
import { ChaosError } from '../errors.js';

export const FAULTS = Object.freeze([
  latency,
  connectionReset,
  bandwidth,
  servicePause,
  serviceKill,
  egressBlock,
  browserOffline,
  browserSlowApi,
  browserMissingChunk,
  diskPressure,
]);

export function createCatalog(faults = FAULTS) {
  const byKey = new Map(faults.map((f) => [f.key, f]));
  if (byKey.size !== faults.length) throw new Error('Duplicate fault key in catalog');

  function get(key) {
    const f = byKey.get(key);
    if (!f) throw new ChaosError('FAULT_UNKNOWN', `Unknown fault ${key}`);
    return f;
  }

  /** Why a fault cannot run on a service (empty array = compatible). */
  function incompatibilities(fault, target, service) {
    const why = [];
    if (!fault.roles.includes(service.role)) why.push(`role ${service.role} not supported`);
    for (const req of fault.requires) {
      const ok = req === 'frontendUrl' ? !!target.frontendUrl : !!service[req];
      if (!ok) why.push(`requires ${req}`);
    }
    return why;
  }

  function describe() {
    return faults.map(
      ({ key, kind, title, description, roles, requires, maxDurationS, params }) => ({
        key,
        kind,
        title,
        description,
        roles,
        requires,
        maxDurationS,
        params,
      }),
    );
  }

  return { list: faults, get, incompatibilities, describe };
}

import { join } from 'node:path';
import { createScenarioRepo } from '../../src/scenarios.js';
import { createAuth } from '../../src/auth.js';
import { loadConfig } from '../../src/config.js';
import { createApp } from '../../src/app.js';
import { makeRunnerEnv, simFetch, DB_OUTAGE, CACHE_OUTAGE } from './sim.js';

export function makeAppEnv(opts = {}) {
  const env = makeRunnerEnv(opts);
  const scenarios = createScenarioRepo({ dir: join(env.dir, 'scenarios') });
  scenarios.save(DB_OUTAGE);
  scenarios.save(CACHE_OUTAGE);
  const targetsList = opts.targets ?? [env.world.target];
  const ctx = {
    catalog: env.catalog,
    journal: env.journal,
    store: env.store,
    scenarios,
    targets: () => targetsList,
    runner: env.runner,
    clock: env.world.clock,
    fetchImpl: opts.fetchImpl ?? simFetch(env.world),
  };
  const config = loadConfig({
    CHAOS_LOCAL_USER: 'admin',
    CHAOS_LOCAL_PASSWORD: 'correct horse battery',
    ...opts.env,
  });
  const auth = createAuth(config, env.world.clock);
  const app = createApp({ ctx, auth, config: { ...config, ...opts.config } });
  const token =
    config.auth.mode === 'local' ? auth.loginLocal('admin', 'correct horse battery').token : null;
  return { ...env, ctx, app, auth, token, config };
}

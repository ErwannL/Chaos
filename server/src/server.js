import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { createAuth } from './auth.js';
import { createApp } from './app.js';
import { recoverPending } from './recovery.js';

/** Starts the HTTP server after reverting anything a crash left injected. */
export async function startServer({
  env = process.env,
  onSignal = process.on.bind(process),
  exit = process.exit,
  log = (m) => console.log(`[chaos] ${m}`),
  overrides = {},
} = {}) {
  const config = loadConfig(env);
  const ctx = createContext({ ...config, log, ...overrides });
  const auth = createAuth(config, ctx.clock);
  await recoverPending({ ...ctx, log });
  const app = createApp({ ctx, auth, config });
  const server = await new Promise((ok) => {
    const s = app.listen(config.port, config.host, () => ok(s));
  });
  log(`listening on http://${config.host}:${server.address().port} (auth: ${auth.mode})`);

  let stopping = null;
  function shutdown(signal) {
    stopping ??= (async () => {
      log(`${signal}: aborting active run and reverting faults...`);
      await ctx.runner.abortAll();
      await new Promise((ok) => server.close(ok));
      exit(0);
    })();
    return stopping;
  }
  onSignal('SIGINT', () => shutdown('SIGINT'));
  onSignal('SIGTERM', () => shutdown('SIGTERM'));
  return { server, ctx, config, shutdown };
}

/** Builds the CLI context from the environment. */
export function cliContext(env = process.env, overrides = {}) {
  return createContext({
    dataDir: resolve(env.CHAOS_DATA_DIR ?? 'data'),
    targetsFile: resolve(env.CHAOS_TARGETS_FILE ?? 'chaos.targets.yaml'),
    scenariosDir: resolve(env.CHAOS_SCENARIOS_DIR ?? 'scenarios'),
    dockerSocket: env.DOCKER_SOCKET ?? '/var/run/docker.sock',
    log: () => {},
    ...overrides,
  });
}

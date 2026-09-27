import { createApp } from './app.js';
import { createDb, createCache } from './adapters.js';

/** Boots the demo API: retries DB init until MySQL is ready. */
export async function start({
  env = process.env,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = console.log,
} = {}) {
  const db = createDb(env);
  const cache = createCache(env);
  cache.connect().catch((e) => log(`redis: ${e.message}`));
  for (let i = 1; ; i++) {
    try {
      await db.init();
      break;
    } catch (e) {
      log(`db init attempt ${i}: ${e.message}`);
      if (i >= Number(env.DB_INIT_ATTEMPTS ?? 60)) throw e;
      await sleep(1000);
    }
  }
  const app = createApp({
    db,
    cache,
    bugCacheNoFallback: env.DEMO_BUG_CACHE_NO_FALLBACK === '1',
    metricsToken: env.METRICS_TOKEN,
  });
  const port = Number(env.PORT ?? 3000);
  const server = await new Promise((ok) => {
    const s = app.listen(port, () => ok(s));
  });
  log(`demo api on :${port} (bug=${env.DEMO_BUG_CACHE_NO_FALLBACK === '1'})`);
  return server;
}

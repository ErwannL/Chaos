import express from 'express';

/** Rejects if `promise` does not settle within `ms`. */
export function withTimeout(promise, ms, what) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

/**
 * Demo API. `db` and `cache` are injected adapters. With `bugCacheNoFallback`
 * the cache does NOT fall back to the database: a Redis outage becomes a 500
 * (the deliberate bug Chaos must catch).
 */
export function createApp({
  db,
  cache,
  bugCacheNoFallback = false,
  metricsToken,
  timeoutMs = 1000,
}) {
  const app = express();
  const counters = new Map();
  const up = { db: 1, cache: 1 };

  app.use((req, res, next) => {
    res.on('finish', () => {
      const key = `${req.path}|${res.statusCode}`;
      counters.set(key, (counters.get(key) ?? 0) + 1);
    });
    next();
  });

  async function dbOk() {
    try {
      await withTimeout(db.ping(), timeoutMs, 'db');
      up.db = 1;
    } catch {
      up.db = 0;
    }
    return up.db === 1;
  }

  async function cacheOk() {
    try {
      await withTimeout(cache.ping(), timeoutMs, 'cache');
      up.cache = 1;
    } catch {
      up.cache = 0;
    }
    return up.cache === 1;
  }

  app.get('/livez', (_req, res) => res.json({ ok: true }));

  app.get('/health', async (_req, res) => {
    const ok = await dbOk();
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'unavailable', db: ok });
  });

  app.get('/api/status', async (_req, res) => {
    const [d, c] = await Promise.all([dbOk(), cacheOk()]);
    res.json({
      status: d && c ? 'ok' : d ? 'degraded' : 'down',
      components: { db: { status: d ? 'up' : 'down' }, cache: { status: c ? 'up' : 'degraded' } },
    });
  });

  app.get('/api/items', async (_req, res) => {
    let cached;
    try {
      cached = await withTimeout(cache.get('items'), timeoutMs, 'cache');
    } catch (e) {
      if (bugCacheNoFallback) {
        return res.status(500).json({ error: `cache error: ${e.message}` });
      }
    }
    if (cached) return res.json({ source: 'cache', items: JSON.parse(cached) });
    try {
      const items = await withTimeout(db.items(), timeoutMs, 'db');
      withTimeout(cache.set('items', JSON.stringify(items), 5), timeoutMs, 'cache').catch(() => {});
      res.json({ source: 'db', items });
    } catch (e) {
      res.status(503).json({ error: `database unavailable: ${e.message}` });
    }
  });

  app.get('/metrics', (req, res) => {
    if (metricsToken && req.get('authorization') !== `Bearer ${metricsToken}`) {
      return res.status(401).send('unauthorized\n');
    }
    const lines = [
      '# HELP http_requests_total Requests by route and status.',
      '# TYPE http_requests_total counter',
      ...[...counters].map(([k, v]) => {
        const [route, status] = k.split('|');
        return `http_requests_total{route="${route}",status="${status}"} ${v}`;
      }),
      '# TYPE demo_db_up gauge',
      `demo_db_up ${up.db}`,
      '# TYPE demo_cache_up gauge',
      `demo_cache_up ${up.cache}`,
    ];
    res.type('text/plain').send(`${lines.join('\n')}\n`);
  });

  return app;
}

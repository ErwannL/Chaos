import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp, withTimeout } from '../src/app.js';

function fakes() {
  const state = { dbUp: true, cacheUp: true, store: new Map(), hang: false };
  const fail = (what) => Promise.reject(new Error(`${what} down`));
  const db = {
    ping: () => (state.hang ? new Promise(() => {}) : state.dbUp ? Promise.resolve() : fail('db')),
    items: () => (state.dbUp ? Promise.resolve([{ id: 1, name: 'a' }]) : fail('db')),
  };
  const cache = {
    ping: () => (state.cacheUp ? Promise.resolve('PONG') : fail('cache')),
    get: (k) => (state.cacheUp ? Promise.resolve(state.store.get(k) ?? null) : fail('cache')),
    set: (k, v) => (state.cacheUp ? Promise.resolve(state.store.set(k, v)) : fail('cache')),
  };
  return { state, db, cache };
}

describe('demo api', () => {
  it('livez always 200, health follows the DB', async () => {
    const f = fakes();
    const app = createApp({ ...f, timeoutMs: 20 });
    expect((await request(app).get('/livez')).status).toBe(200);
    expect((await request(app).get('/health')).status).toBe(200);
    f.state.dbUp = false;
    expect((await request(app).get('/health')).status).toBe(503);
    f.state.dbUp = true;
    f.state.hang = true;
    expect((await request(app).get('/health')).status).toBe(503);
  });

  it('status reports each component', async () => {
    const f = fakes();
    const app = createApp(f);
    expect((await request(app).get('/api/status')).body).toEqual({
      status: 'ok',
      components: { db: { status: 'up' }, cache: { status: 'up' } },
    });
    f.state.cacheUp = false;
    expect((await request(app).get('/api/status')).body.status).toBe('degraded');
    f.state.dbUp = false;
    expect((await request(app).get('/api/status')).body).toEqual({
      status: 'down',
      components: { db: { status: 'down' }, cache: { status: 'degraded' } },
    });
  });

  it('items: DB then cache, falls back to DB when Redis is down', async () => {
    const f = fakes();
    const app = createApp(f);
    expect((await request(app).get('/api/items')).body.source).toBe('db');
    await new Promise((r) => setTimeout(r, 5));
    expect((await request(app).get('/api/items')).body.source).toBe('cache');
    f.state.cacheUp = false;
    const r = await request(app).get('/api/items');
    expect(r.status).toBe(200);
    expect(r.body.source).toBe('db');
    f.state.dbUp = false;
    expect((await request(app).get('/api/items')).status).toBe(503);
  });

  it('BUG mode: a Redis outage becomes a 500', async () => {
    const f = fakes();
    const app = createApp({ ...f, bugCacheNoFallback: true });
    expect((await request(app).get('/api/items')).status).toBe(200);
    f.state.cacheUp = false;
    const r = await request(app).get('/api/items');
    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/cache error/);
  });

  it('metrics require the token when configured', async () => {
    const f = fakes();
    const app = createApp({ ...f, metricsToken: 'tok' });
    await request(app).get('/livez');
    expect((await request(app).get('/metrics')).status).toBe(401);
    const m = await request(app).get('/metrics').set('authorization', 'Bearer tok');
    expect(m.text).toContain('http_requests_total{route="/livez",status="200"} 1');
    expect(m.text).toContain('demo_db_up 1');
    expect((await request(createApp(f)).get('/metrics')).status).toBe(200);
  });

  it('withTimeout rejects slow promises', async () => {
    await expect(withTimeout(new Promise(() => {}), 5, 'x')).rejects.toThrow('x timed out');
    expect(await withTimeout(Promise.resolve(1), 5, 'x')).toBe(1);
  });
});

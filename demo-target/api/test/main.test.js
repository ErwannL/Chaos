import { describe, it, expect, vi, beforeEach } from 'vitest';

const pool = { query: vi.fn() };
const client = { connect: vi.fn(), ping: vi.fn(), get: vi.fn(), set: vi.fn(), on: vi.fn() };
let redisOpts;
vi.mock('mysql2/promise', () => ({ default: { createPool: vi.fn(() => pool) } }));
vi.mock('redis', () => ({
  createClient: vi.fn((o) => {
    redisOpts = o;
    return client;
  }),
}));

const { createDb, createCache } = await import('../src/adapters.js');
const { start } = await import('../src/main.js');

beforeEach(() => {
  pool.query.mockReset();
  client.connect.mockReset();
});

describe('adapters', () => {
  it('db seeds an empty table and lists items', async () => {
    const db = createDb({});
    pool.query
      .mockResolvedValueOnce()
      .mockResolvedValueOnce([[{ n: 0 }]])
      .mockResolvedValue();
    await db.init();
    expect(pool.query.mock.calls.filter((c) => c[0].startsWith('INSERT'))).toHaveLength(3);
    pool.query
      .mockReset()
      .mockResolvedValueOnce()
      .mockResolvedValueOnce([[{ n: 3 }]]);
    await db.init();
    expect(pool.query).toHaveBeenCalledTimes(2);
    pool.query.mockResolvedValueOnce([[{ id: 1 }]]);
    expect(await db.items()).toEqual([{ id: 1 }]);
    await db.ping();
    expect(pool.query).toHaveBeenLastCalledWith('SELECT 1');
    createDb({ DB_HOST: 'h', DB_PORT: '1', DB_USER: 'u', DB_PASSWORD: 'p', DB_NAME: 'n' });
  });

  it('cache fails fast and forwards commands', async () => {
    const c = createCache({ REDIS_URL: 'redis://x:1' });
    expect(redisOpts.disableOfflineQueue).toBe(true);
    expect(redisOpts.socket.reconnectStrategy(3)).toBe(600);
    expect(redisOpts.socket.reconnectStrategy(50)).toBe(2000);
    client.on.mock.calls[0][1](new Error('ignored'));
    await c.connect();
    await c.ping();
    await c.get('k');
    await c.set('k', 'v', 5);
    expect(client.set).toHaveBeenCalledWith('k', 'v', { EX: 5 });
    createCache({});
  });
});

describe('start', () => {
  it('retries DB init then listens', async () => {
    const logs = [];
    pool.query
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce()
      .mockResolvedValueOnce([[{ n: 1 }]]);
    client.connect.mockRejectedValueOnce(new Error('no redis'));
    const server = await start({
      env: { PORT: '0', DEMO_BUG_CACHE_NO_FALLBACK: '1' },
      sleep: async () => {},
      log: (m) => logs.push(m),
    });
    server.close();
    expect(logs).toContain('db init attempt 1: ECONNREFUSED');
    expect(logs).toContain('redis: no redis');
    expect(
      logs.some((l) => /bug=true/.test(l)),
      JSON.stringify(logs),
    ).toBe(true);
  });

  it('gives up after DB_INIT_ATTEMPTS', async () => {
    pool.query.mockRejectedValue(new Error('down'));
    client.connect.mockResolvedValue();
    await expect(
      start({ env: { DB_INIT_ATTEMPTS: '2' }, sleep: async () => {}, log: () => {} }),
    ).rejects.toThrow('down');
  });

  it('uses defaults', async () => {
    pool.query
      .mockRejectedValueOnce(new Error('first'))
      .mockResolvedValueOnce()
      .mockResolvedValueOnce([[{ n: 1 }]]);
    client.connect.mockResolvedValue();
    const saved = process.env.PORT;
    delete process.env.PORT; // default port 3000
    const server = await start();
    server.close();
    process.env.PORT = saved;
    if (saved === undefined) delete process.env.PORT;
  });
});

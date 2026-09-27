import mysql from 'mysql2/promise';
import { createClient } from 'redis';

const SEED = ['Résilience', 'Observabilité', 'Réversibilité'];

export function createDb(env) {
  const pool = mysql.createPool({
    host: env.DB_HOST ?? 'localhost',
    port: Number(env.DB_PORT ?? 3306),
    user: env.DB_USER ?? 'demo',
    password: env.DB_PASSWORD ?? 'demo',
    database: env.DB_NAME ?? 'demo',
    connectTimeout: 1000,
    connectionLimit: 5,
  });
  return {
    ping: () => pool.query('SELECT 1'),
    async items() {
      const [rows] = await pool.query('SELECT id, name FROM items ORDER BY id');
      return rows;
    },
    async init() {
      await pool.query(
        'CREATE TABLE IF NOT EXISTS items (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(100))',
      );
      const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM items');
      if (n === 0)
        for (const name of SEED) await pool.query('INSERT INTO items (name) VALUES (?)', [name]);
    },
  };
}

export function createCache(env) {
  const client = createClient({
    url: env.REDIS_URL ?? 'redis://localhost:6379',
    disableOfflineQueue: true, // fail fast while Redis is unreachable
    socket: { connectTimeout: 1000, reconnectStrategy: (n) => Math.min(n * 200, 2000) },
  });
  client.on('error', () => {}); // reconnects on its own; errors surface per call
  return {
    connect: () => client.connect(),
    ping: () => client.ping(),
    get: (k) => client.get(k),
    set: (k, v, ttlS) => client.set(k, v, { EX: ttlS }),
  };
}

export function demoTargetDoc(overrides = {}) {
  return {
    name: 'demo',
    project: 'chaos-demo',
    environment: 'local',
    baseUrl: 'http://127.0.0.1:8081',
    toxiproxy: { url: 'http://127.0.0.1:8474' },
    services: [
      { name: 'mysql', role: 'db', port: 3306, proxy: 'mysql' },
      { name: 'redis', role: 'cache', port: 6379, proxy: 'redis' },
      { name: 'api', role: 'api', port: 3000, diskPath: '/tmp/chaos' },
      { name: 'web', role: 'frontend', port: 80 },
    ],
    probes: {
      health: 'http://127.0.0.1:8081/health',
      liveness: 'http://127.0.0.1:8081/livez',
      status: 'http://127.0.0.1:8081/api/status',
      metrics: { url: 'http://127.0.0.1:8081/metrics', tokenEnv: 'TOKEN_VAR' },
      intervalMs: 1000,
    },
    frontendUrl: 'http://localhost:8080',
    ...overrides,
  };
}

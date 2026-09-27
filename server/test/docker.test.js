import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDockerApi, ScopedDocker } from '../src/drivers/docker.js';
import { createFakeDockerApi, projectContainer } from './helpers/fakes.js';

function setup() {
  const api = createFakeDockerApi({
    containers: [
      projectContainer('c-api', 'chaos-demo', 'api', {
        networks: { 'chaos-demo_backend': { Aliases: ['api'] } },
      }),
      projectContainer('c-other', 'other-project', 'api'),
    ],
    networks: {
      'chaos-demo_backend': { Name: 'chaos-demo_backend', Internal: true, Labels: {} },
    },
  });
  return { api, docker: new ScopedDocker(api, 'chaos-demo') };
}

describe('ScopedDocker (project label guard)', () => {
  it('requires a project', () => {
    expect(() => new ScopedDocker({}, '')).toThrow(/project is required/);
  });

  it('only resolves containers of the declared project', async () => {
    const { docker } = setup();
    expect(await docker.containerFor('api')).toBe('c-api');
    await expect(docker.containerFor('mysql')).rejects.toThrow(/No container/);
  });

  it('drops containers whose labels do not match even if the daemon returns them', async () => {
    const api = createFakeDockerApi({
      containers: [
        projectContainer('c-x', 'chaos-demo', 'api', {
          leakLabels: { 'com.docker.compose.project': 'evil' },
        }),
      ],
    });
    await expect(new ScopedDocker(api, 'chaos-demo').containerFor('api')).rejects.toThrow(
      /No container/,
    );
  });

  it.each(['pause', 'unpause', 'kill', 'start'])(
    'refuses to %s a foreign container',
    async (op) => {
      const { docker, api } = setup();
      await expect(docker[op]('c-other')).rejects.toMatchObject({ code: 'PROJECT_MISMATCH' });
      expect(api.state.calls.some((c) => c.method === 'POST')).toBe(false);
    },
  );

  it('refuses exec, network and state operations on a foreign container', async () => {
    const { docker } = setup();
    await expect(docker.exec('c-other', ['ls'])).rejects.toMatchObject({
      code: 'PROJECT_MISMATCH',
    });
    await expect(docker.connect('n', 'c-other')).rejects.toMatchObject({
      code: 'PROJECT_MISMATCH',
    });
    await expect(docker.disconnect('n', 'c-other')).rejects.toMatchObject({
      code: 'PROJECT_MISMATCH',
    });
    await expect(docker.state('c-other')).rejects.toMatchObject({ code: 'PROJECT_MISMATCH' });
  });

  it('pauses, kills, starts and reports state of its own containers', async () => {
    const { docker, api } = setup();
    await docker.pause('c-api');
    expect(await docker.state('c-api')).toMatchObject({ paused: true, running: true });
    await docker.unpause('c-api');
    await docker.kill('c-api', 'SIGTERM');
    expect(api.state.calls.at(-1).path).toContain('signal=SIGTERM');
    expect((await docker.state('c-api')).running).toBe(false);
    await docker.start('c-api');
    await docker.kill('c-api');
    expect(api.state.calls.at(-1).path).toContain('signal=SIGKILL');
  });

  it('reports docker errors', async () => {
    const { docker, api } = setup();
    await expect(docker.inspect('missing')).rejects.toMatchObject({ code: 'DOCKER_ERROR' });
    api.state.fail = (m) => m === 'POST';
    await expect(docker.pause('c-api')).rejects.toThrow(/pause failed \(500\): boom/);
    api.state.fail = () => true;
    await expect(docker.containerFor('api')).rejects.toThrow(/list containers/);
  });

  it('uses raw text when docker returns no JSON message', async () => {
    const api = { request: async () => ({ status: 500, text: 'raw failure' }) };
    await expect(new ScopedDocker(api, 'p').networkInfo('n')).rejects.toThrow(/raw failure/);
  });

  it('refuses to remove an unlabeled network', async () => {
    const { docker, api } = setup();
    api.state.networks.set('bare', { Name: 'bare' });
    await expect(docker.removeNetwork('bare')).rejects.toMatchObject({ code: 'PROJECT_MISMATCH' });
  });

  it('runs exec commands and returns exit code and output', async () => {
    const { docker, api } = setup();
    api.state.execHandler = (cmd) => ({ exitCode: 3, output: cmd.join(' ') });
    expect(await docker.exec('c-api', ['echo', 'hi'])).toEqual({ exitCode: 3, output: 'echo hi' });
  });

  it('manages networks it owns only', async () => {
    const { docker, api } = setup();
    expect(Object.keys(await docker.networks('c-api'))).toEqual(['chaos-demo_backend']);
    expect((await docker.networkInfo('chaos-demo_backend')).Internal).toBe(true);
    await docker.ensureInternalNetwork('chaos-demo_iso');
    await docker.ensureInternalNetwork('chaos-demo_iso');
    await docker.connect('chaos-demo_iso', 'c-api', ['api']);
    await docker.disconnect('chaos-demo_iso', 'c-api');
    await docker.removeNetwork('chaos-demo_iso');
    await docker.removeNetwork('chaos-demo_iso');
    expect(api.state.networks.has('chaos-demo_iso')).toBe(false);
    await expect(docker.ensureInternalNetwork('chaos-demo_backend')).rejects.toMatchObject({
      code: 'PROJECT_MISMATCH',
    });
    await expect(docker.removeNetwork('chaos-demo_backend')).rejects.toMatchObject({
      code: 'PROJECT_MISMATCH',
    });
  });

  it('handles containers with no network settings', async () => {
    const api = {
      request: async () => ({
        status: 200,
        body: { Config: { Labels: { 'com.docker.compose.project': 'p' } } },
      }),
    };
    const d = new ScopedDocker(api, 'p');
    expect(await d.networks('x')).toEqual({});
    expect(await d.state('x')).toEqual({
      running: false,
      paused: false,
      restartCount: 0,
      startedAt: undefined,
      health: undefined,
    });
  });
});

describe('createDockerApi (unix socket transport)', () => {
  let server;
  afterEach(() => server?.close());

  async function listen(handler) {
    const socketPath = join(mkdtempSync(join(tmpdir(), 'dk-')), 'd.sock');
    server = http.createServer(handler);
    await new Promise((r) => server.listen(socketPath, r));
    return socketPath;
  }

  it('sends JSON and parses JSON or text responses', async () => {
    const socketPath = await listen((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url === '/v1.43/text') return res.end('plain');
        if (req.url === '/v1.43/empty') {
          res.statusCode = 204;
          return res.end();
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ method: req.method, url: req.url, body }));
      });
    });
    const api = createDockerApi({ socketPath });
    const r = await api.request('POST', '/x', { a: 1 });
    expect(r.body).toEqual({ method: 'POST', url: '/v1.43/x', body: '{"a":1}' });
    expect((await api.request('GET', '/text')).text).toBe('plain');
    expect((await api.request('GET', '/text')).body).toBeUndefined();
    expect((await api.request('GET', '/empty')).status).toBe(204);
  });

  it('rejects on socket errors and timeouts', async () => {
    await expect(
      createDockerApi({ socketPath: '/nonexistent.sock' }).request('GET', '/x'),
    ).rejects.toThrow();
    const socketPath = await listen(() => {});
    await expect(
      createDockerApi({ socketPath, timeoutMs: 50 }).request('GET', '/slow'),
    ).rejects.toThrow(/timed out/);
    expect(createDockerApi()).toHaveProperty('request');
  });
});

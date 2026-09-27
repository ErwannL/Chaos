// In-memory stand-ins for the Docker Engine API, Toxiproxy and Playwright.
const PROJECT_LABEL = 'com.docker.compose.project';
const SERVICE_LABEL = 'com.docker.compose.service';

export function createFakeDockerApi({ containers = [], networks = {} } = {}) {
  const state = {
    containers: new Map(
      containers.map((c) => [
        c.id,
        {
          running: true,
          paused: false,
          restartCount: 0,
          networks: {},
          health: undefined,
          autoRestart: false,
          ...c,
        },
      ]),
    ),
    networks: new Map(Object.entries(networks)),
    calls: [],
    execs: new Map(),
    execHandler: () => ({ exitCode: 0, output: '' }),
    fail: null,
  };
  let execSeq = 0;
  const ok = (body, status = 200) => ({ status, body, text: body ? JSON.stringify(body) : '' });
  const notFound = () => ({ status: 404, body: { message: 'not found' }, text: 'not found' });

  async function request(method, path, body) {
    state.calls.push({ method, path, body });
    if (state.fail && state.fail(method, path)) return { status: 500, body: { message: 'boom' } };
    const url = new URL(path, 'http://docker');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] === 'containers' && parts[1] === 'json') {
      const f = JSON.parse(url.searchParams.get('filters'));
      const want = Object.fromEntries(f.label.map((l) => l.split('=')));
      const list = [...state.containers.values()]
        .filter((c) => Object.entries(want).every(([k, v]) => c.labels[k] === v))
        .map((c) => ({ Id: c.id, Labels: c.leakLabels ?? c.labels }));
      return ok(list);
    }
    if (parts[0] === 'containers') {
      const c = state.containers.get(parts[1]);
      if (!c) return notFound();
      const action = parts[2];
      if (method === 'GET' && action === 'json') {
        return ok({
          Id: c.id,
          Config: { Labels: c.labels },
          RestartCount: c.restartCount,
          State: {
            Running: c.running,
            Paused: c.paused,
            StartedAt: 't',
            Health: c.health ? { Status: c.health } : undefined,
          },
          NetworkSettings: { Networks: c.networks },
        });
      }
      if (action === 'pause') c.paused = true;
      else if (action === 'unpause') c.paused = false;
      else if (action === 'kill') {
        c.running = false;
        if (c.autoRestart) {
          c.running = true;
          c.restartCount += 1;
        }
      } else if (action === 'start') {
        c.running = true;
      } else if (action === 'exec') {
        const id = `exec${++execSeq}`;
        state.execs.set(id, { container: c, cmd: body.Cmd });
        return ok({ Id: id }, 201);
      }
      return { status: 204, body: undefined, text: '' };
    }
    if (parts[0] === 'exec') {
      const e = state.execs.get(parts[1]);
      if (parts[2] === 'start') {
        e.result = state.execHandler(e.cmd, e.container);
        return { status: 200, body: undefined, text: e.result.output };
      }
      return ok({ ExitCode: e.result.exitCode });
    }
    if (parts[0] === 'networks' && parts[1] === 'create') {
      state.networks.set(body.Name, {
        Name: body.Name,
        Internal: body.Internal,
        Labels: body.Labels,
      });
      return ok({ Id: body.Name }, 201);
    }
    if (parts[0] === 'networks') {
      const n = state.networks.get(parts[1]);
      if (!n) return notFound();
      if (method === 'GET') return ok(n);
      if (method === 'DELETE') {
        state.networks.delete(parts[1]);
        return { status: 204, text: '' };
      }
      const c = state.containers.get(body.Container);
      if (parts[2] === 'connect') c.networks[parts[1]] = { Aliases: body.EndpointConfig.Aliases };
      else delete c.networks[parts[1]];
      return ok({});
    }
    return notFound();
  }
  return { request, state };
}

export function projectContainer(id, project, service, extra = {}) {
  return { id, labels: { [PROJECT_LABEL]: project, [SERVICE_LABEL]: service }, ...extra };
}

export function createFakeToxiproxy() {
  const proxies = new Map();
  const calls = [];
  const proxy = (name) => {
    if (!proxies.has(name)) proxies.set(name, { enabled: true, toxics: new Map() });
    return proxies.get(name);
  };
  return {
    proxies,
    calls,
    proxy,
    getProxy: async (name) => ({ name, ...proxy(name) }),
    setEnabled: async (name, enabled) => {
      calls.push(['setEnabled', name, enabled]);
      proxy(name).enabled = enabled;
    },
    addToxic: async (name, toxic) => {
      calls.push(['addToxic', name, toxic.name]);
      proxy(name).toxics.set(toxic.name, toxic);
    },
    removeToxic: async (name, toxic) => {
      calls.push(['removeToxic', name, toxic]);
      proxy(name).toxics.delete(toxic);
    },
  };
}

export function createFakeBrowser(snapshot = { blank: false, errorShown: true }) {
  const sessions = [];
  return {
    sessions,
    async open(opts) {
      const s = {
        opts,
        closed: false,
        observe: async () => (typeof snapshot === 'function' ? snapshot(opts) : snapshot),
        close: async () => {
          s.closed = true;
        },
      };
      sessions.push(s);
      return s;
    },
  };
}

/** Deterministic clock: sleep advances time instantly. */
export function createFakeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    sleep: async (ms, signal) => {
      if (signal?.aborted) return;
      t += ms;
      await Promise.resolve();
    },
  };
}

/** Reads the probes a target declares, plus scenario routes and containers. */

function componentsFrom(json, path) {
  let node = json;
  for (const key of path.split('.').filter(Boolean)) node = node?.[key];
  const out = {};
  const norm = (v) =>
    String(typeof v === 'object' && v !== null ? (v.status ?? v.state) : v).toLowerCase();
  if (Array.isArray(node)) {
    // `name` (générique) ou `key` (Orqea : clef immuable du composant).
    for (const c of node) {
      const id = c?.name ?? c?.key;
      if (id) out[id] = norm(c);
    }
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) out[k] = norm(v);
  }
  return out;
}

export function createProber({ target, fetchImpl = globalThis.fetch, clock, docker }) {
  const { probes } = target;
  const timeoutMs = probes.timeoutMs;

  async function http(probe, url, { headers, parse } = {}) {
    const started = clock.now();
    const sample = { ts: started, probe, status: null };
    try {
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      sample.status = res.status;
      if (parse) sample.data = await parse(res);
      else await res.arrayBuffer().catch(() => {});
    } catch (e) {
      sample.error = e.name === 'TimeoutError' ? 'timeout' : String(e.message ?? e);
    }
    sample.latencyMs = clock.now() - started;
    return sample;
  }

  function routeUrl(route) {
    return new URL(route, target.baseUrl).toString();
  }

  async function container(service) {
    const ts = clock.now();
    try {
      const id = await docker.containerFor(service);
      return { ts, probe: `container:${service}`, ...(await docker.state(id)) };
    } catch (e) {
      return { ts, probe: `container:${service}`, running: false, error: e.message };
    }
  }

  const tasks = {
    health: () => probes.health && http('health', probes.health),
    liveness: () => probes.liveness && http('liveness', probes.liveness),
    status: () =>
      probes.status &&
      http('status', probes.status.url, {
        parse: async (res) => {
          const json = await res.json().catch(() => null);
          return { components: componentsFrom(json, probes.status.componentsPath) };
        },
      }),
    metrics: () =>
      probes.metrics &&
      http('metrics', probes.metrics.url, {
        headers: probes.metrics.token ? { authorization: `Bearer ${probes.metrics.token}` } : {},
        parse: async (res) => ({
          series: (await res.text()).split('\n').filter((l) => l && !l.startsWith('#')).length,
        }),
      }),
    logs: () => {
      if (!probes.logs) return null;
      const { url, selector, errorFilter = '|~ "(?i)error"' } = probes.logs;
      const q = `sum(count_over_time(${selector} ${errorFilter} [${Math.ceil(probes.intervalMs / 1000)}s]))`;
      const full = `${url.replace(/\/$/, '')}/loki/api/v1/query?query=${encodeURIComponent(q)}`;
      return http('logs', full, {
        parse: async (res) => {
          const json = await res.json().catch(() => null);
          return { errors: Number(json?.data?.result?.[0]?.value?.[1] ?? 0) };
        },
      });
    },
  };

  return {
    /** One round of samples: target probes + routes + containers. */
    async sample({ routes = [], services = [], include = Object.keys(tasks) } = {}) {
      const jobs = include.map((k) => tasks[k]()).filter(Boolean);
      for (const r of routes) jobs.push(http(`route:${r}`, routeUrl(r)));
      for (const s of services) jobs.push(container(s));
      return Promise.all(jobs);
    },
    routeUrl,
  };
}

export const _test = { componentsFrom };

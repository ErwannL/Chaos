import { ChaosError } from '../errors.js';

/** Thin client for the Toxiproxy HTTP API. */
export function createToxiproxy({ url, fetchImpl = globalThis.fetch }) {
  const base = url.replace(/\/$/, '');
  async function call(method, path, body, okMissing = false) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (okMissing && res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text();
      throw new ChaosError('TOXIPROXY_ERROR', `${method} ${path} -> ${res.status}: ${text}`, 502);
    }
    return res.status === 204 ? null : res.json();
  }
  const p = (proxy) => `/proxies/${encodeURIComponent(proxy)}`;
  return {
    getProxy: (proxy) => call('GET', p(proxy)),
    setEnabled: (proxy, enabled) => call('POST', p(proxy), { enabled }),
    addToxic: (proxy, toxic) => call('POST', `${p(proxy)}/toxics`, toxic),
    removeToxic: (proxy, name) =>
      call('DELETE', `${p(proxy)}/toxics/${encodeURIComponent(name)}`, undefined, true),
  };
}

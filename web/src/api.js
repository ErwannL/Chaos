const KEY = 'chaos.session';

export const session = {
  get: () => sessionStorage.getItem(KEY),
  set: (t) => sessionStorage.setItem(KEY, t),
  clear: () => sessionStorage.removeItem(KEY),
};

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `HTTP ${status}`);
    this.status = status;
    this.code = body?.error?.code;
    this.details = body?.error?.details;
  }
}

function headers(extra = {}) {
  const t = session.get();
  return { ...(t ? { authorization: `Bearer ${t}` } : {}), ...extra };
}

async function checked(res) {
  if (res.status === 401) {
    session.clear();
    window.dispatchEvent(new Event('chaos:logout'));
  }
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
  return res;
}

/** JSON call to the Chaos API with the session bearer token. */
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: headers(body === undefined ? {} : { 'content-type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await checked(res)).json();
}

/** Authenticated download (the HTML report needs the bearer token). */
export async function download(path, filename) {
  const blob = await (await checked(await fetch(path, { headers: headers() }))).blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function downloadJson(data, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
  );
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Parses a text/event-stream body; calls onEvent for each JSON event. */
export async function streamRun(id, onEvent, signal) {
  const res = await checked(
    await fetch(`/runs/${encodeURIComponent(id)}`, {
      headers: headers({ accept: 'text/event-stream' }),
      signal,
    }),
  );
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (data) onEvent(JSON.parse(data.slice(6)));
    }
  }
}

/** Reads `#sso=<jwt>` from the URL fragment and removes it from history. */
export function takeSsoFromHash(loc = window.location, hist = window.history) {
  const m = /(?:^#|&)sso=([^&]+)/.exec(loc.hash);
  if (!m) return null;
  hist.replaceState(null, '', loc.pathname + loc.search);
  return decodeURIComponent(m[1]);
}

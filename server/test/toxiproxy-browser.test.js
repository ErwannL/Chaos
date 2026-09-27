import { describe, it, expect, vi } from 'vitest';
import { createToxiproxy } from '../src/drivers/toxiproxy.js';
import { createBrowserDriver, _test } from '../src/drivers/browser.js';

describe('toxiproxy client', () => {
  function fakeFetch(status = 200, body = {}) {
    return vi.fn(async () => ({
      status,
      ok: status < 400,
      json: async () => body,
      text: async () => 'err',
    }));
  }

  it('calls the toxiproxy API', async () => {
    const f = fakeFetch(200, { name: 'mysql' });
    const tp = createToxiproxy({ url: 'http://127.0.0.1:8474/', fetchImpl: f });
    expect(await tp.getProxy('mysql')).toEqual({ name: 'mysql' });
    await tp.setEnabled('mysql', false);
    expect(f.mock.calls[1]).toEqual([
      'http://127.0.0.1:8474/proxies/mysql',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"enabled":false}',
      },
    ]);
    await tp.addToxic('mysql', { name: 't' });
    expect(f.mock.calls[2][0]).toBe('http://127.0.0.1:8474/proxies/mysql/toxics');
  });

  it('treats a missing toxic as already removed and 204 as empty', async () => {
    expect(
      await createToxiproxy({ url: 'http://x', fetchImpl: fakeFetch(404) }).removeToxic('p', 't'),
    ).toBeNull();
    expect(
      await createToxiproxy({ url: 'http://x', fetchImpl: fakeFetch(204) }).removeToxic('p', 't'),
    ).toBeNull();
  });

  it('raises on API errors', async () => {
    const tp = createToxiproxy({ url: 'http://x', fetchImpl: fakeFetch(500) });
    await expect(tp.getProxy('p')).rejects.toMatchObject({ code: 'TOXIPROXY_ERROR' });
    await expect(tp.setEnabled('p', true)).rejects.toThrow(/500: err/);
  });
});

function fakePlaywright({
  gotoFails = false,
  evaluateFails = false,
  newContextFails = false,
} = {}) {
  const log = [];
  const routes = [];
  const page = {
    route: async (matcher, handler) => routes.push({ matcher, handler }),
    goto: async (url) => {
      log.push(['goto', url]);
      if (gotoFails) throw new Error('nav');
    },
    evaluate: async (fn, arg) => {
      if (evaluateFails) throw new Error('page crashed');
      return { fn: typeof fn, arg };
    },
  };
  const context = {
    newPage: async () => page,
    setOffline: async (v) => log.push(['offline', v]),
  };
  const browser = {
    newContext: async () => {
      if (newContextFails) throw new Error('ctx');
      return context;
    },
    close: async () => log.push(['close']),
  };
  return { launch: async () => browser, log, routes };
}

describe('browser driver', () => {
  it('opens the page offline and observes it', async () => {
    const pw = fakePlaywright();
    const s = await createBrowserDriver({ launch: pw.launch }).open({
      url: 'http://f',
      offline: true,
    });
    expect(pw.log).toEqual([
      ['goto', 'http://f'],
      ['offline', true],
    ]);
    expect(await s.observe()).toEqual({ fn: 'function', arg: _test.ERROR_SELECTOR });
    await s.close();
    expect(pw.log.at(-1)).toEqual(['close']);
  });

  it('delays and blocks matching requests', async () => {
    vi.useFakeTimers();
    const pw = fakePlaywright({ gotoFails: true });
    await createBrowserDriver({ launch: pw.launch }).open({
      url: 'http://f',
      delayPattern: '/api/',
      delayMs: 10,
      blockPattern: 'chunk\\.js$',
    });
    const [delay, block] = pw.routes;
    expect(delay.matcher(new URL('http://f/api/x'))).toBe(true);
    expect(block.matcher(new URL('http://f/a.js'))).toBe(false);
    const route = { continue: vi.fn(async () => {}), abort: vi.fn() };
    const p = delay.handler(route);
    await vi.advanceTimersByTimeAsync(10);
    await p;
    expect(route.continue).toHaveBeenCalled();
    const failing = { continue: vi.fn(async () => Promise.reject(new Error('closed'))) };
    const p2 = delay.handler(failing);
    await vi.advanceTimersByTimeAsync(10);
    await p2;
    block.handler(route);
    expect(route.abort).toHaveBeenCalledWith('failed');
    vi.useRealTimers();
  });

  it('reports a crashed page as blank', async () => {
    const pw = fakePlaywright({ evaluateFails: true });
    const s = await createBrowserDriver({ launch: pw.launch }).open({ url: 'http://f' });
    expect(await s.observe()).toEqual({ blank: true, errorShown: false, error: 'page crashed' });
  });

  it('closes the browser when opening fails', async () => {
    const pw = fakePlaywright({ newContextFails: true });
    await expect(
      createBrowserDriver({ launch: pw.launch }).open({ url: 'http://f' }),
    ).rejects.toThrow('ctx');
    expect(pw.log).toEqual([['close']]);
    expect(createBrowserDriver()).toHaveProperty('open');
  });

  it('snapshot script detects blank pages and error messages', () => {
    const run = (html) => {
      globalThis.document = {
        body: { innerText: html.text },
        querySelector: () => html.err,
      };
      const r = _test.snapshotScript('[role=alert]');
      delete globalThis.document;
      return r;
    };
    expect(run({ text: '  ', err: null })).toMatchObject({
      blank: true,
      errorShown: false,
      errorText: null,
    });
    expect(run({ text: 'Oops', err: { textContent: ' DB down ' } })).toMatchObject({
      blank: false,
      errorShown: true,
      errorText: 'DB down',
    });
    expect(run({ text: 'x', err: { textContent: null } })).toMatchObject({
      errorShown: false,
      errorText: '',
    });
    globalThis.document = { body: null, querySelector: () => null };
    expect(_test.snapshotScript('x').blank).toBe(true);
    delete globalThis.document;
  });
});

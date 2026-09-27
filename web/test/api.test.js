import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  api,
  session,
  download,
  downloadJson,
  streamRun,
  takeSsoFromHash,
  ApiError,
} from '../src/api.js';
import { json, mockFetch, sseBody } from './helpers.jsx';

beforeEach(() => {
  sessionStorage.clear();
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});

describe('api client', () => {
  it('sends the bearer token and JSON bodies', async () => {
    const f = mockFetch({
      'POST /plan': (opts) =>
        json({ got: JSON.parse(opts.body), auth: opts.headers.authorization }),
    });
    session.set('tok');
    expect(await api('/plan', { method: 'POST', body: { a: 1 } })).toEqual({
      got: { a: 1 },
      auth: 'Bearer tok',
    });
    expect(f.mock.calls[0][1].headers['content-type']).toBe('application/json');
  });

  it('raises ApiError with code and details; 401 logs out', async () => {
    mockFetch({
      'GET /x': json({ error: { code: 'NOPE', message: 'no', details: { d: 1 } } }, 403),
    });
    await expect(api('/x')).rejects.toMatchObject({
      status: 403,
      code: 'NOPE',
      details: { d: 1 },
      message: 'no',
    });
    session.set('tok');
    const spy = vi.fn();
    window.addEventListener('chaos:logout', spy);
    mockFetch({
      'GET /x': { ok: false, status: 401, json: async () => Promise.reject(new Error('no body')) },
    });
    const e = await api('/x').catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.message).toBe('HTTP 401');
    expect(session.get()).toBeNull();
    expect(spy).toHaveBeenCalled();
  });

  it('downloads files with authentication', async () => {
    mockFetch({ 'GET /runs/r1/report.html': () => json({}) });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await download('/runs/r1/report.html?lang=fr', 'r.html');
    downloadJson({ a: 1 }, 'r.json');
    expect(click).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    click.mockRestore();
  });

  it('parses a server-sent event stream', async () => {
    mockFetch({
      'GET /runs/r1': () => ({
        ok: true,
        status: 200,
        body: sseBody([{ type: 'status' }, { type: 'finished' }]),
      }),
    });
    const events = [];
    await streamRun('r1', (e) => events.push(e.type));
    expect(events).toEqual(['status', 'finished']);
  });

  it('takes the SSO token from the URL fragment and scrubs it', () => {
    const hist = { replaceState: vi.fn() };
    expect(takeSsoFromHash({ hash: '#sso=a.b.c', pathname: '/', search: '?x' }, hist)).toBe(
      'a.b.c',
    );
    expect(hist.replaceState).toHaveBeenCalledWith(null, '', '/?x');
    expect(takeSsoFromHash({ hash: '#other=1&sso=t%2B', pathname: '/', search: '' }, hist)).toBe(
      't+',
    );
    expect(takeSsoFromHash({ hash: '', pathname: '/', search: '' }, hist)).toBeNull();
    expect(takeSsoFromHash()).toBeNull();
  });
});

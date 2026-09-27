import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from '../src/App.jsx';
import { session } from '../src/api.js';
import { CATALOG, TARGETS, TYPES, json, mockFetch, sseBody } from './helpers.jsx';

const BASE = {
  'GET /auth/mode': { mode: 'local' },
  'GET /auth/me': { user: { name: 'admin' } },
  'GET /catalog': CATALOG,
  'GET /targets': TARGETS,
  'GET /expectation-types': TYPES,
  'GET /scenarios': [],
  'GET /runs': { active: null, runs: [] },
  'GET /journal': [],
};

beforeEach(() => {
  sessionStorage.clear();
  localStorage.setItem('chaos.lang', 'en');
  localStorage.removeItem('chaos.theme');
  window.history.replaceState(null, '', '/');
});
afterEach(cleanup);

describe('App', () => {
  it('shows the login form without a session', async () => {
    mockFetch(BASE);
    render(<App />);
    expect(await screen.findByText('Log in', { selector: 'button' })).toBeInTheDocument();
  });

  it('exchanges #sso= from the fragment, removes it from the URL, and opens the shell', async () => {
    window.history.replaceState(null, '', '/#sso=jwt.token.sig');
    const f = mockFetch({
      ...BASE,
      'GET /auth/mode': { mode: 'sso' },
      'POST /auth/sso': { token: 'sess', user: { name: 'Ada' } },
    });
    render(<App />);
    expect(await screen.findByText('admin')).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    expect(JSON.parse(f.mock.calls.find((c) => c[0] === '/auth/sso')[1].body)).toEqual({
      token: 'jwt.token.sig',
    });
    expect(session.get()).toBe('sess');
  });

  it('shows SSO rejections', async () => {
    window.history.replaceState(null, '', '/#sso=bad');
    mockFetch({
      ...BASE,
      'GET /auth/mode': () => Promise.reject(new Error('offline')),
      'POST /auth/sso': () =>
        json({ error: { code: 'SSO_REJECTED', message: 'token expired' } }, 401),
    });
    render(<App />);
    expect(await screen.findByText('SSO_REJECTED: token expired')).toBeInTheDocument();
    expect(await screen.findByText('Log in', { selector: 'button' })).toBeInTheDocument();
  });

  it('navigates every page, cancels everything, toggles language and theme, logs out', async () => {
    session.set('tok');
    const f = mockFetch({ ...BASE, 'POST /abort-all': { aborted: null } });
    render(<App />);
    expect(await screen.findByText('demo')).toBeInTheDocument();
    for (const p of ['Catalog', 'Scenarios', 'Reports', 'Journal', 'Targets']) {
      fireEvent.click(screen.getByText(p, { selector: 'button' }));
    }
    fireEvent.click(screen.getByText('⏹ Cancel everything'));
    expect(await screen.findByText('Every fault has been reverted')).toBeInTheDocument();
    expect(f.mock.calls.some((c) => c[0] === '/abort-all' && c[1].method === 'POST')).toBe(true);
    fireEvent.click(screen.getByLabelText('Theme'));
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    fireEvent.click(screen.getByLabelText('Theme'));
    expect(localStorage.getItem('chaos.theme')).toBe('dark');
    fireEvent.click(screen.getByText('FR'));
    expect(await screen.findByText('Tout annuler', { exact: false })).toBeInTheDocument();
    fireEvent.click(screen.getByText('EN'));
    fireEvent.click(screen.getByText('Log out'));
    expect(await screen.findByText('Log in', { selector: 'button' })).toBeInTheDocument();
  });

  it('goes from the catalog to a prefilled scenario, runs it live, then opens its report', async () => {
    session.set('tok');
    mockFetch({
      ...BASE,
      'POST /runs': { id: 'r1' },
      'GET /runs/r1': (o) =>
        o.headers.accept === 'text/event-stream'
          ? {
              ok: true,
              status: 200,
              body: sseBody([
                { type: 'status', ts: 1 },
                { type: 'finished', ts: 2, status: 'passed' },
              ]),
            }
          : json({
              id: 'r1',
              report: {
                id: 'r1',
                scenario: { name: 'x' },
                status: 'passed',
                score: 100,
                windows: [],
                steps: [],
                expectations: [],
                errors: [],
                samples: [],
              },
            }),
    });
    render(<App />);
    fireEvent.click(await screen.findByText('Catalog', { selector: 'button' }));
    fireEvent.click(screen.getAllByText('Try')[0]);
    fireEvent.click(screen.getByText('Try →'));
    expect(await screen.findByDisplayValue('adhoc-latency')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Run', { selector: 'button' }));
    fireEvent.click(await screen.findByText('Reports →'));
    expect(await screen.findByText('Export HTML')).toBeInTheDocument();
  });

  it('reports errors from cancel-everything and metadata loading, and logs out on 401', async () => {
    session.set('tok');
    mockFetch({
      ...BASE,
      'GET /catalog': () => json({ error: { code: 'X', message: 'meta' } }, 500),
      'POST /abort-all': () => json({ error: { code: 'Y', message: 'abort' } }, 500),
    });
    render(<App />);
    expect(await screen.findByText('X: meta')).toBeInTheDocument();
    fireEvent.click(screen.getByText('⏹ Cancel everything'));
    expect(await screen.findByText('Y: abort')).toBeInTheDocument();
    mockFetch({
      ...BASE,
      'POST /abort-all': () => json({ error: { code: 'UNAUTHORIZED', message: 'expired' } }, 401),
    });
    fireEvent.click(screen.getByText('⏹ Cancel everything'));
    await waitFor(() =>
      expect(screen.getByText('Log in', { selector: 'button' })).toBeInTheDocument(),
    );
  });

  it('starts in light theme when saved', async () => {
    localStorage.setItem('chaos.theme', 'light');
    session.set('tok');
    mockFetch(BASE);
    render(<App />);
    expect(await screen.findByText('☾')).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});

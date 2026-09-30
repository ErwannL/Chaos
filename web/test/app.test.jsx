import { readFileSync } from 'node:fs';
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

  it('navigates every page, cancels everything, toggles language and theme, leads back to Orqea (no logout)', async () => {
    session.set('tok');
    const f = mockFetch({ ...BASE, 'POST /abort-all': { aborted: null } });
    render(<App />);
    expect(await screen.findByText('demo')).toBeInTheDocument();
    expect(screen.getByText('by Orqea')).toBeInTheDocument();
    const owner = screen.getByText('Powered by Orqea');
    expect(owner).toHaveAttribute('href', 'https://orqea.dev');
    expect(owner).toHaveAttribute('target', '_top');
    const author = screen.getByRole('link', { name: 'Developed by Erwann Laplante' });
    expect(author).toHaveAttribute('href', 'https://github.com/ErwannL');
    expect(author).toHaveAttribute('rel', 'noreferrer noopener');
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
    expect(screen.queryByText(/log ?out|sign out/i)).toBeNull();
    const back = screen.getByRole('link', { name: 'Back to Orqea' });
    expect(back).toHaveAttribute('href', 'https://orqea.dev');
    expect(back).toHaveAttribute('target', '_top');
  });

  it('uses the Orqea URL of the environment, and hides the way back inside an iframe', async () => {
    session.set('tok');
    mockFetch({
      ...BASE,
      'GET /auth/mode': { mode: 'local', orqeaUrl: 'http://localhost:3002' },
    });
    const top = vi.spyOn(window, 'top', 'get').mockReturnValue(window.self);
    const { unmount } = render(<App />);
    expect(await screen.findByRole('link', { name: 'Back to Orqea' })).toHaveAttribute(
      'href',
      'http://localhost:3002',
    );
    expect(screen.getByText('Powered by Orqea')).toHaveAttribute('href', 'http://localhost:3002');
    unmount();
    top.mockReturnValue({});
    render(<App />);
    expect(await screen.findByText('demo')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Back to Orqea' })).toBeNull();
    top.mockRestore();
  });

  it('the SSO notice offers the way back to Orqea', async () => {
    mockFetch({ ...BASE, 'GET /auth/mode': { mode: 'sso' } });
    render(<App />);
    expect(await screen.findByRole('link', { name: 'Back to Orqea' })).toBeInTheDocument();
  });

  it('animates the logo on keyboard focus too, still under reduced motion', () => {
    const css = readFileSync('src/index.css', 'utf8');
    expect(css).toContain(':is(header, form, .brand-head):focus-within .logo-hover .logo-animated');
    expect(css).toContain('prefers-reduced-motion: reduce');
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

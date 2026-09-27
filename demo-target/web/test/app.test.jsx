import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import App from '../src/App.jsx';
import ErrorBoundary from '../src/ErrorBoundary.jsx';

afterEach(cleanup);

const ok = (body) => Promise.resolve({ ok: true, status: 200, json: async () => body });
const STATUS = { status: 'ok', components: { db: { status: 'up' } } };
function api({ items = { items: [{ id: 1, name: 'Résilience' }] }, fail } = {}) {
  return vi.fn((url) => {
    if (fail) return fail(url);
    return ok(url.includes('items') ? items : STATUS);
  });
}

describe('demo frontend', () => {
  it('lists items and the lazy status panel', async () => {
    render(<App fetchImpl={api()} search="" />);
    expect(await screen.findByText('Résilience')).toBeInTheDocument();
    expect(await screen.findByText(/État du service : ok/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows an error message (not a blank page) when the API fails', async () => {
    render(<App fetchImpl={api({ fail: () => Promise.resolve({ ok: false, status: 503 }) })} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Service indisponible : HTTP 503');
  });

  it('says so when the browser is offline', async () => {
    const spy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    render(
      <App fetchImpl={api({ fail: () => Promise.reject(new TypeError('Failed to fetch')) })} />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('hors ligne');
    spy.mockRestore();
  });

  it('warns when the API is slow and refreshes periodically', async () => {
    vi.useFakeTimers();
    let resolve;
    const fetchImpl = vi.fn(() => new Promise((r) => (resolve = r)));
    const { unmount } = render(<App fetchImpl={fetchImpl} intervalMs={10_000} />);
    await act(async () => vi.advanceTimersByTime(3100));
    expect(screen.getByRole('status')).toHaveTextContent('lentement');
    await act(async () => {
      resolve({ ok: true, json: async () => ({ items: [], ...STATUS }) });
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(2);
    unmount();
    vi.useRealTimers();
  });

  it('ignores responses that arrive after unmount', async () => {
    let resolve;
    let reject;
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(() => new Promise((r) => (resolve = r)))
      .mockImplementationOnce(() => new Promise((_r, j) => (reject = j)));
    const { unmount } = render(<App fetchImpl={fetchImpl} />);
    unmount();
    await act(async () => {
      resolve({ ok: true, json: async () => ({}) });
      reject(new Error('late'));
    });
    const { unmount: u2 } = render(<App fetchImpl={vi.fn(() => ok({ items: [] }))} />);
    u2();
    await act(async () => {});
  });

  it('error boundary replaces a crashed subtree with a message', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Boom() {
      throw new Error('chunk failed');
    }
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('chunk failed');
    spy.mockRestore();
  });

  it('bug=noboundary renders the panel without a boundary', async () => {
    render(<App fetchImpl={api()} search="?bug=noboundary" />);
    expect(await screen.findByText(/État du service/)).toBeInTheDocument();
  });

  it('uses the global fetch and location by default', async () => {
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((u) => ok(u.includes('items') ? { items: [] } : STATUS));
    render(<App />);
    expect(await screen.findByText(/État du service/)).toBeInTheDocument();
    f.mockRestore();
  });
});

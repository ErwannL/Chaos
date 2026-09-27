import { lazy, Suspense, useEffect, useState } from 'react';
import ErrorBoundary from './ErrorBoundary.jsx';

const StatusPanel = lazy(() => import('./StatusPanel.jsx'));
const SLOW_MS = 3000;

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Demo shop. `?bug=noboundary` removes the error boundary so a missing chunk
 * gives a blank screen (to show a browser scenario failing).
 */
export default function App({
  fetchImpl = (u) => fetch(u),
  intervalMs = 2000,
  search = window.location.search,
}) {
  const [items, setItems] = useState(null);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    let alive = true;
    async function refresh() {
      const slowTimer = setTimeout(() => alive && setSlow(true), SLOW_MS);
      try {
        const [i, s] = await Promise.all([
          getJson('/api/items', fetchImpl),
          getJson('/api/status', fetchImpl),
        ]);
        if (!alive) return;
        setItems(i.items);
        setStatus(s);
        setError(null);
      } catch (e) {
        if (alive) setError(navigator.onLine === false ? 'Vous êtes hors ligne.' : e.message);
      } finally {
        clearTimeout(slowTimer);
        if (alive) setSlow(false);
      }
    }
    refresh();
    const t = setInterval(refresh, intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [fetchImpl, intervalMs]);

  const panel = (
    <Suspense fallback={<p>Chargement…</p>}>
      <StatusPanel status={status} />
    </Suspense>
  );

  return (
    <main>
      <h1>Demo Shop</h1>
      {error && <div role="alert">Service indisponible : {error}</div>}
      {slow && <p role="status">Le service répond lentement…</p>}
      {items === null && !error && <p>Chargement…</p>}
      {items && (
        <ul className="card">
          {items.map((it) => (
            <li key={it.id}>{it.name}</li>
          ))}
        </ul>
      )}
      {search.includes('bug=noboundary') ? panel : <ErrorBoundary>{panel}</ErrorBoundary>}
    </main>
  );
}

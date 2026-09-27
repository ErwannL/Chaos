import { useEffect, useState } from 'react';
import { api, streamRun } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { Badge, Button, Card, ErrorBox, VERDICT_TONE } from '../components/ui.jsx';
import ProbeChart from '../components/ProbeChart.jsx';

/** Folds SSE events into what the live view shows. */
export function reduceEvents(events) {
  const samples = [];
  const windows = [];
  let phase = null;
  let status = 'running';
  const log = [];
  for (const e of events) {
    if (e.type === 'samples') samples.push(...e.samples);
    else log.push(e);
    if (e.type === 'phase') phase = e.phase;
    if (e.type === 'inject') {
      phase = 'fault';
      windows.push({ fault: `${e.fault} → ${e.service}`, start: e.ts, end: null });
    }
    if (e.type === 'revert' && windows.length) windows.at(-1).end = e.ts;
    if (e.type === 'finished') status = e.status;
  }
  const active = windows.find((w) => w.end === null);
  return { samples, windows, phase, status, log, active };
}

export default function RunView({ id, onReport }) {
  const { t } = useI18n();
  const [events, setEvents] = useState([]);
  const [error, setError] = useState(null);
  useEffect(() => {
    const ctrl = new AbortController();
    setEvents([]);
    streamRun(id, (e) => setEvents((prev) => [...prev, e]), ctrl.signal).catch((e) => {
      if (e.name !== 'AbortError') setError(e);
    });
    return () => ctrl.abort();
  }, [id]);
  const view = reduceEvents(events);
  const done = view.status !== 'running';
  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-wrap items-center gap-3">
        <h2 className="font-semibold">
          {t('live')} · <code className="text-xs">{id}</code>
        </h2>
        <Badge tone={VERDICT_TONE[view.status]}>{view.status}</Badge>
        <span className="text-sm">
          {t('phase')}: {view.phase ?? '…'}
        </span>
        <span className="text-sm">
          {t('activeFault')}:{' '}
          {view.active ? <Badge tone="amber">{view.active.fault}</Badge> : t('none')}
        </span>
        {done ? (
          <Button kind="primary" onClick={() => onReport(id)}>
            {t('reports')} →
          </Button>
        ) : (
          <Button
            kind="danger"
            onClick={() =>
              api(`/runs/${encodeURIComponent(id)}/abort`, { method: 'POST' }).catch(setError)
            }
          >
            {t('abort')}
          </Button>
        )}
      </Card>
      <ErrorBox error={error} />
      <Card>
        <ProbeChart samples={view.samples} windows={view.windows} />
      </Card>
      <Card>
        <h3 className="mb-2 font-semibold">{t('events')}</h3>
        <ol className="font-mono text-xs">
          {view.log.map((e, i) => (
            <li key={i}>
              {new Date(e.ts).toLocaleTimeString()} {e.type}{' '}
              {e.fault ?? e.phase ?? e.status ?? e.message ?? ''}
              {e.type === 'revert' && (e.ok ? ' ✓' : ` ✗ ${e.error}`)}
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}

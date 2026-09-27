import { useEffect, useState } from 'react';
import { api, download, downloadJson } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { useApi } from '../useApi.js';
import { Badge, Button, Card, ErrorBox, VERDICT_TONE } from '../components/ui.jsx';
import ProbeChart from '../components/ProbeChart.jsx';

function Detail({ id, onBack }) {
  const { t, lang } = useI18n();
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    api(`/runs/${encodeURIComponent(id)}`).then((r) => setReport(r.report), setError);
  }, [id]);
  if (error) return <ErrorBox error={error} />;
  if (!report) return <p>{t('loading')}</p>;
  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-wrap items-center gap-3">
        <Button onClick={onBack}>← {t('back')}</Button>
        <h2 className="font-semibold">{report.scenario.name}</h2>
        <Badge tone={VERDICT_TONE[report.status]}>{report.status}</Badge>
        <span className="text-2xl font-bold">{report.score ?? '—'}</span>
        <span className="text-sm text-neutral-500">
          {report.target} · {t('actor')}: {report.actor} · {report.startedAt}
        </span>
        <Button onClick={() => downloadJson(report, `chaos-${report.id}.json`)}>
          {t('exportJson')}
        </Button>
        <Button
          onClick={() =>
            download(
              `/runs/${report.id}/report.html?lang=${lang}`,
              `chaos-${report.id}.html`,
            ).catch(setError)
          }
        >
          {t('exportHtml')}
        </Button>
      </Card>
      <Card>
        <ProbeChart samples={report.samples} windows={report.windows} />
      </Card>
      <Card>
        <ul className="text-sm">
          {report.steps.map((s) => (
            <li key={s.index}>
              #{s.index} <code>{s.fault}</code> → {s.service} ({s.durationS}s){' '}
              <Badge tone={s.revertOk ? 'green' : 'red'}>
                {s.revertOk ? t('revertOk') : t('revertKo')}
              </Badge>{' '}
              {s.error}
            </li>
          ))}
        </ul>
        {report.errors.map((e) => (
          <p key={e} className="text-sm text-red-500">
            {e}
          </p>
        ))}
      </Card>
      <Card>
        <h3 className="mb-2 font-semibold">{t('expectations')}</h3>
        {report.expectations.map((x, i) => (
          <div key={i} className="border-b border-neutral-800 py-2 text-sm">
            <Badge tone={VERDICT_TONE[x.verdict]}>{t(`verdict_${x.verdict}`)}</Badge>{' '}
            <code>{x.type}</code> — {x.message}
            <details>
              <summary className="cursor-pointer text-neutral-500">
                {t('evidence')} ({x.evidence.length})
              </summary>
              <pre className="overflow-x-auto text-xs text-neutral-500">
                {x.evidence.map((s) => JSON.stringify(s)).join('\n')}
              </pre>
            </details>
          </div>
        ))}
      </Card>
    </div>
  );
}

export default function Reports({ openId, onOpen }) {
  const { t } = useI18n();
  const { data, error } = useApi('/runs');
  if (openId) return <Detail id={openId} onBack={() => onOpen(null)} />;
  return (
    <Card>
      <ErrorBox error={error} />
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="text-neutral-500">
            <th>{t('scenarios')}</th>
            <th>{t('target')}</th>
            <th>{t('status')}</th>
            <th>{t('score')}</th>
            <th>{t('actor')}</th>
            <th>{t('startedAt')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(data?.runs ?? []).map((r) => (
            <tr key={r.id} className="border-t border-neutral-800">
              <td>{r.scenario}</td>
              <td>{r.target}</td>
              <td>
                <Badge tone={VERDICT_TONE[r.status]}>{r.status}</Badge>
              </td>
              <td>{r.score ?? '—'}</td>
              <td>{r.actor}</td>
              <td>{r.startedAt}</td>
              <td>
                <Button onClick={() => onOpen(r.id)}>{t('open')}</Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

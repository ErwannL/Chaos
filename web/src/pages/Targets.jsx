import { useI18n } from '../i18n.jsx';
import { useApi } from '../useApi.js';
import { Badge, Card, ErrorBox } from '../components/ui.jsx';

function probeTone(s) {
  if (s.status === null) return 'red';
  return s.status < 400 ? 'green' : s.status < 500 ? 'amber' : 'red';
}

export default function Targets() {
  const { t } = useI18n();
  const { data, error } = useApi('/targets', 3000);
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <ErrorBox error={error} />
      {(data ?? []).map((target) => (
        <Card key={target.name}>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">{target.name}</h2>
            <Badge tone={target.verdict.allowed ? 'green' : 'red'}>
              {target.verdict.allowed ? t('allowed') : t('refused')}
            </Badge>
          </div>
          <p className="text-sm text-neutral-500">
            {t('environment')}: {target.environment} · {t('project')}: {target.project}
          </p>
          {target.verdict.reasons.map((r) => (
            <p key={r.code} className="text-sm text-red-500">
              {r.code}: {r.message}
            </p>
          ))}
          <h3 className="mt-3 text-sm font-semibold">{t('services')}</h3>
          <ul className="text-sm">
            {target.services.map((s) => (
              <li key={s.name}>
                {s.name} <Badge>{s.role}</Badge>{' '}
                {s.proxy && <Badge tone="amber">proxy {s.proxy}</Badge>}
              </li>
            ))}
          </ul>
          <h3 className="mt-3 text-sm font-semibold">{t('probes')}</h3>
          <div className="flex flex-wrap gap-2">
            {(target.live ?? []).map((s) => (
              <Badge key={s.probe} tone={probeTone(s)}>
                {s.probe}: {s.status ?? s.error}
              </Badge>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}

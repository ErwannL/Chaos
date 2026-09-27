import { useI18n } from '../i18n.jsx';
import { useApi } from '../useApi.js';
import { Badge, Card, ErrorBox } from '../components/ui.jsx';

/** Every injection: who, what, when, and whether the revert succeeded. */
export default function Journal() {
  const { t } = useI18n();
  const { data, error } = useApi('/journal', 5000);
  return (
    <Card>
      <ErrorBox error={error} />
      <table className="w-full text-left text-sm">
        <tbody>
          {(data ?? []).map((e) => (
            <tr key={e.id} className="border-t border-neutral-800">
              <td>{e.startedAt}</td>
              <td>{e.actor}</td>
              <td>
                <code>{e.fault}</code> → {e.target}/{e.service}
              </td>
              <td className="font-mono text-xs">{JSON.stringify(e.params)}</td>
              <td>
                {e.revertOk === null ? (
                  <Badge tone="amber">{t('pending')}</Badge>
                ) : (
                  <Badge tone={e.revertOk ? 'green' : 'red'}>
                    {e.revertOk ? t('revertOk') : t('revertKo')}
                  </Badge>
                )}{' '}
                {e.revertedBy === 'recovery' && <Badge>recovery</Badge>} {e.error}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

import { useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { Badge, Button, Card } from '../components/ui.jsx';
import FaultStep from '../components/FaultStep.jsx';

/** The catalog as served by GET /catalog; every form is generated from it. */
export default function Catalog({ catalog, targets, onTry }) {
  const { t, tr } = useI18n();
  const [open, setOpen] = useState(null);
  const [step, setStep] = useState(null);
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {catalog.map((f) => (
        <Card key={f.key}>
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">{tr(f.title)}</h2>
            <code className="text-xs text-neutral-500">{f.key}</code>
          </div>
          <p className="text-sm text-neutral-500">{tr(f.description)}</p>
          <p className="mt-2 flex flex-wrap gap-1 text-xs">
            {t('roles')}:{' '}
            {f.roles.map((r) => (
              <Badge key={r}>{r}</Badge>
            ))}{' '}
            · {t('maxDuration')}: {f.maxDurationS}s
          </p>
          {open === f.key ? (
            <div className="mt-3 flex flex-col gap-2">
              <FaultStep step={step} onChange={setStep} catalog={catalog} target={targets[0]} />
              <Button kind="primary" onClick={() => onTry(step)}>
                {t('try')} →
              </Button>
            </div>
          ) : (
            <Button
              className="mt-3"
              onClick={() => {
                setOpen(f.key);
                setStep({
                  fault: f.key,
                  service: '',
                  durationS: Math.min(10, f.maxDurationS),
                  params: {},
                });
              }}
            >
              {t('try')}
            </Button>
          )}
        </Card>
      ))}
    </div>
  );
}

import { useState } from 'react';
import { api, session } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { Button, Card, ErrorBox, Field, INPUT } from '../components/ui.jsx';
import { BackToOrqea, Brand } from '../components/brand.jsx';

export default function Login({ mode, onLogin }) {
  const { t } = useI18n();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  if (mode === 'sso')
    return (
      <Card className="mx-auto mt-20 max-w-sm">
        <div className="brand-head flex flex-col items-center gap-3 text-center">
          <Brand centered />
          <p>{t('ssoOnly')}</p>
          <BackToOrqea />
        </div>
      </Card>
    );
  async function submit(e) {
    e.preventDefault();
    try {
      const s = await api('/auth/login', { method: 'POST', body: { username, password } });
      session.set(s.token);
      onLogin(s.user);
    } catch (err) {
      setError(err);
    }
  }
  return (
    <Card className="mx-auto mt-20 max-w-sm">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Brand centered />
        <Field label={t('username')}>
          <input className={INPUT} value={username} onChange={(e) => setUsername(e.target.value)} />
        </Field>
        <Field label={t('password')}>
          <input
            className={INPUT}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <ErrorBox error={error} />
        <Button kind="primary" type="submit">
          {t('login')}
        </Button>
      </form>
    </Card>
  );
}

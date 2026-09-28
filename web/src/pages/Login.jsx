import { useState } from 'react';
import { api, session } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { Button, Card, ErrorBox, Field, INPUT } from '../components/ui.jsx';

export default function Login({ mode, onLogin }) {
  const { t } = useI18n();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  if (mode === 'sso') return <Card className="mx-auto mt-20 max-w-sm">{t('ssoOnly')}</Card>;
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
        <img src="/logo-animated.svg" alt="" className="mx-auto h-20 w-20" />
        <h1 className="text-center text-xl font-bold">Chaos</h1>
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

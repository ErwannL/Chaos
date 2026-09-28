import { useCallback, useEffect, useState } from 'react';
import { api, session, takeSsoFromHash } from './api.js';
import { I18nProvider, useI18n } from './i18n.jsx';
import { Button, ErrorBox } from './components/ui.jsx';
import Login from './pages/Login.jsx';
import Targets from './pages/Targets.jsx';
import Catalog from './pages/Catalog.jsx';
import ScenarioEditor from './pages/ScenarioEditor.jsx';
import RunView from './pages/RunView.jsx';
import Reports from './pages/Reports.jsx';
import Journal from './pages/Journal.jsx';

const PAGES = ['targets', 'catalog', 'scenarios', 'reports', 'journal'];

function Shell({ user, onLogout }) {
  const { t, lang, setLang } = useI18n();
  const [page, setPage] = useState('targets');
  const [runId, setRunId] = useState(null);
  const [reportId, setReportId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [dark, setDark] = useState(() => localStorage.getItem('chaos.theme') !== 'light');

  useEffect(() => {
    Promise.all([api('/catalog'), api('/targets?live=0'), api('/expectation-types')]).then(
      ([catalog, targets, types]) => setMeta({ catalog, targets, types }),
      setError,
    );
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('chaos.theme', dark ? 'dark' : 'light');
  }, [dark]);

  async function abortAll() {
    try {
      await api('/abort-all', { method: 'POST' });
      setNotice(t('abortAllDone'));
    } catch (e) {
      setError(e);
    }
  }

  const go = (p) => {
    setPage(p);
    setRunId(null);
    setReportId(null);
  };

  let content = <p>{t('loading')}</p>;
  if (meta) {
    if (runId) {
      content = (
        <RunView
          id={runId}
          onReport={(id) => {
            go('reports');
            setReportId(id);
          }}
        />
      );
    } else if (page === 'targets') content = <Targets />;
    else if (page === 'catalog') {
      content = (
        <Catalog
          catalog={meta.catalog}
          targets={meta.targets}
          onTry={(step) => {
            setDraft({
              name: `adhoc-${step.fault}`,
              baselineS: 3,
              recoveryS: 10,
              watch: [],
              steps: [step],
              expectations: [],
            });
            go('scenarios');
          }}
        />
      );
    } else if (page === 'scenarios') {
      content = (
        <ScenarioEditor
          key={draft?.name}
          catalog={meta.catalog}
          targets={meta.targets}
          types={meta.types}
          initial={draft}
          onRun={setRunId}
        />
      );
    } else if (page === 'reports') content = <Reports openId={reportId} onOpen={setReportId} />;
    else content = <Journal />;
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-neutral-200 bg-white/90 px-4 py-2 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/90">
        <strong className="mr-4 flex items-center gap-2 text-lg">
          <img src={runId ? '/logo-animated.svg' : '/logo.svg'} alt="" className="h-7 w-7" />
          Chaos
        </strong>
        {PAGES.map((p) => (
          <Button key={p} kind={page === p && !runId ? 'primary' : 'ghost'} onClick={() => go(p)}>
            {t(p)}
          </Button>
        ))}
        <span className="flex-1" />
        <Button onClick={() => setLang(lang === 'fr' ? 'en' : 'fr')}>
          {lang === 'fr' ? 'EN' : 'FR'}
        </Button>
        <Button aria-label={t('theme')} onClick={() => setDark(!dark)}>
          {dark ? '☀' : '☾'}
        </Button>
        <span className="text-sm text-neutral-500">{user.name}</span>
        <Button onClick={onLogout}>{t('logout')}</Button>
        <Button kind="danger" onClick={abortAll}>
          ⏹ {t('abortAll')}
        </Button>
      </header>
      <main className="mx-auto max-w-6xl p-4">
        <ErrorBox error={error} />
        {notice && (
          <p role="status" className="mb-2 text-sm text-green-500">
            {notice}
          </p>
        )}
        {content}
      </main>
    </div>
  );
}

function Root() {
  const [user, setUser] = useState(null);
  const [mode, setMode] = useState(null);
  const [error, setError] = useState(null);
  const logout = useCallback(() => {
    session.clear();
    setUser(null);
  }, []);

  useEffect(() => {
    window.addEventListener('chaos:logout', logout);
    (async () => {
      try {
        const sso = takeSsoFromHash();
        if (sso) {
          const s = await api('/auth/sso', { method: 'POST', body: { token: sso } });
          session.set(s.token);
        }
        if (session.get()) setUser((await api('/auth/me')).user);
      } catch (e) {
        setError(e);
      }
      setMode((await api('/auth/mode').catch(() => ({ mode: 'local' }))).mode);
    })();
    return () => window.removeEventListener('chaos:logout', logout);
  }, [logout]);

  if (user) return <Shell user={user} onLogout={logout} />;
  return (
    <>
      <ErrorBox error={error} />
      {mode && <Login mode={mode} onLogin={setUser} />}
    </>
  );
}

export default function App() {
  return (
    <I18nProvider>
      <Root />
    </I18nProvider>
  );
}

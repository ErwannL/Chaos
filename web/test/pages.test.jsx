import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import Login from '../src/pages/Login.jsx';
import Targets from '../src/pages/Targets.jsx';
import Catalog from '../src/pages/Catalog.jsx';
import ScenarioEditor from '../src/pages/ScenarioEditor.jsx';
import RunView, { reduceEvents } from '../src/pages/RunView.jsx';
import Reports from '../src/pages/Reports.jsx';
import Journal from '../src/pages/Journal.jsx';
import { session } from '../src/api.js';
import {
  CATALOG,
  REPORT,
  TARGETS,
  TYPES,
  json,
  mockFetch,
  renderI18n,
  sseBody,
} from './helpers.jsx';

beforeEach(() => {
  sessionStorage.clear();
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

describe('Login', () => {
  it('logs in with the local account', async () => {
    const onLogin = vi.fn();
    mockFetch({
      'POST /auth/login': (o) =>
        JSON.parse(o.body).password === 'good'
          ? json({ token: 't', user: { name: 'admin' } })
          : json({ error: { code: 'UNAUTHORIZED', message: 'invalid credentials' } }, 401),
    });
    renderI18n(<Login mode="local" onLogin={onLogin} />);
    fireEvent.change(screen.getByLabelText('Utilisateur'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Mot de passe'), { target: { value: 'bad' } });
    fireEvent.click(screen.getByText('Connexion'));
    expect(await screen.findByRole('alert')).toHaveTextContent('invalid credentials');
    fireEvent.change(screen.getByLabelText('Mot de passe'), { target: { value: 'good' } });
    fireEvent.click(screen.getByText('Connexion'));
    await waitFor(() => expect(onLogin).toHaveBeenCalledWith({ name: 'admin' }));
    expect(session.get()).toBe('t');
  });

  it('tells SSO users to come from the console', () => {
    const { container } = renderI18n(<Login mode="sso" />);
    expect(screen.getByText(/console d’administration/)).toBeInTheDocument();
    expect(screen.getByText('par Orqea')).toBeInTheDocument();
    expect(screen.getByText('Propulsé par Orqea')).toHaveAttribute('target', '_top');
    expect(screen.getByText('Propulsé par Orqea').closest('.brand')).toContainElement(
      screen.getByText('par Orqea'),
    );
    expect(screen.getByText('Développé par Erwann Laplante')).toHaveAttribute(
      'href',
      'https://github.com/ErwannL',
    );
    const marks = [...container.querySelectorAll('.logo-hover img')].map((i) =>
      i.getAttribute('src'),
    );
    expect(marks).toEqual(['/logo.svg', '/logo-animated.svg']);
  });

  it('the local login screen is branded too, the logo animating on hover only', () => {
    const { container } = renderI18n(<Login mode="local" onLogin={vi.fn()} />);
    expect(screen.getByText('par Orqea')).toBeInTheDocument();
    expect(screen.getByText('Propulsé par Orqea').closest('.brand')).toContainElement(
      screen.getByText('par Orqea'),
    );
    expect(container.querySelector('.logo-hover')).not.toHaveAttribute('data-animated');
    const css = readFileSync('src/index.css', 'utf8');
    expect(css).toContain('.logo-hover:hover .logo-animated');
    expect(css).toMatch(/prefers-reduced-motion: reduce\)[\s\S]*\.logo-hover/);
  });
});

describe('Targets', () => {
  it('shows verdicts, refusal reasons and live probes, polling', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const f = mockFetch({ 'GET /targets': TARGETS });
    renderI18n(<Targets />);
    expect(await screen.findByText('Autorisée')).toBeInTheDocument();
    expect(screen.getByText('Refusée')).toBeInTheDocument();
    expect(screen.getByText('ENV_PRODUCTION: refused')).toBeInTheDocument();
    expect(screen.getByText('metrics: timeout').className).toMatch(/red/);
    expect(screen.getByText('liveness: 404').className).toMatch(/amber/);
    expect(screen.getByText('status: 503').className).toMatch(/red/);
    await act(async () => vi.advanceTimersByTimeAsync(3100));
    expect(f.mock.calls.length).toBeGreaterThan(1);
    vi.useRealTimers();
  });

  it('shows load errors', async () => {
    mockFetch({ 'GET /targets': () => json({ error: { code: 'X', message: 'down' } }, 500) });
    renderI18n(<Targets />);
    expect(await screen.findByRole('alert')).toHaveTextContent('X: down');
  });
});

describe('Catalog', () => {
  it('renders every fault from the catalog and a generated try-form', () => {
    const onTry = vi.fn();
    renderI18n(<Catalog catalog={CATALOG} targets={TARGETS} onTry={onTry} />, 'en');
    expect(screen.getByText('Network latency')).toBeInTheDocument();
    fireEvent.click(screen.getAllByText('Try')[0]);
    fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'mysql' } });
    fireEvent.click(screen.getByText('Try →'));
    expect(onTry).toHaveBeenCalledWith({
      fault: 'latency',
      service: 'mysql',
      durationS: 10,
      params: {},
    });
  });
});

describe('ScenarioEditor', () => {
  const SAVED = [
    {
      name: 'db-outage',
      baselineS: 3,
      recoveryS: 10,
      watch: ['/api/items'],
      steps: [{ pause: 2 }],
      expectations: [],
      file: 'db-outage.yaml',
    },
    { name: 'broken', invalid: 'bad yaml', file: 'broken.yaml' },
  ];

  function setup(handlers = {}) {
    const onRun = vi.fn();
    const f = mockFetch({ 'GET /scenarios': SAVED, ...handlers });
    renderI18n(
      <ScenarioEditor catalog={CATALOG} targets={TARGETS} types={TYPES} onRun={onRun} />,
      'en',
    );
    return { f, onRun };
  }
  const bodyOf = (f, key) =>
    JSON.parse(f.mock.calls.find((c) => `${c[1]?.method ?? 'GET'} ${c[0]}` === key)[1].body);

  it('builds a scenario from generated forms, saves, plans and runs it', async () => {
    const { f, onRun } = setup({
      'PUT /scenarios/my-scn': (o) => json(JSON.parse(o.body)),
      'POST /plan': {
        ok: false,
        estimatedDurationS: 20,
        errors: [{ code: 'PARAM_INVALID', message: 'bad' }],
        warnings: ['w1'],
        target: {},
      },
      'POST /runs': { id: 'run-9' },
    });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'my-scn' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'desc' } });
    fireEvent.change(screen.getByLabelText('Baseline (s)'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Observe after (s)'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Watched routes (one per line)'), {
      target: { value: '/a\n\n/b' },
    });
    fireEvent.click(screen.getByText('+ Fault'));
    fireEvent.click(screen.getByText('+ Pause'));
    fireEvent.change(screen.getByLabelText('Pause (s)'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'mysql' } });
    fireEvent.change(screen.getByLabelText('latencyMs (ms) [0–30000]'), { target: { value: '' } });
    fireEvent.click(screen.getByText('+ Expectation'));
    fireEvent.click(screen.getByText('+ Expectation'));
    fireEvent.change(screen.getAllByLabelText('probe')[0], { target: { value: 'health' } });
    fireEvent.click(screen.getAllByText('Remove').at(-1));
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    const saved = bodyOf(f, 'PUT /scenarios/my-scn');
    expect(saved).toEqual({
      name: 'my-scn',
      description: 'desc',
      baselineS: 1,
      recoveryS: 2,
      watch: ['/a', '/b'],
      steps: [
        { fault: 'latency', service: 'mysql', durationS: 10, params: { mode: 'a' } },
        { pause: 4 },
      ],
      expectations: [{ type: 'status_during', status: 503, probe: 'health' }],
    });
    fireEvent.click(screen.getByLabelText('Allow a remote host'));
    fireEvent.change(screen.getByLabelText('Type the host again'), { target: { value: 'h' } });
    fireEvent.change(screen.getByLabelText('Target'), { target: { value: 'prod' } });
    fireEvent.click(screen.getByText('Validate (plan)'));
    expect(await screen.findByText('Plan refused')).toBeInTheDocument();
    expect(screen.getByText('PARAM_INVALID: bad')).toBeInTheDocument();
    expect(screen.getByText('w1')).toBeInTheDocument();
    expect(bodyOf(f, 'POST /plan')).toMatchObject({
      target: 'prod',
      allowRemote: true,
      confirmHost: 'h',
    });
    fireEvent.click(screen.getByText('Run'));
    await waitFor(() => expect(onRun).toHaveBeenCalledWith('run-9'));
    fireEvent.click(screen.getAllByText('Remove')[0]);
    expect(screen.queryByLabelText('Service')).toBeNull();
  });

  it('loads saved scenarios and shows guard refusals from the server', async () => {
    setup({
      'POST /runs': () =>
        json(
          {
            error: {
              code: 'GUARD_REFUSED',
              message: 'production',
              details: { ok: false, estimatedDurationS: 1, errors: [], warnings: [], target: {} },
            },
          },
          403,
        ),
      'POST /plan': { ok: true, estimatedDurationS: 5, errors: [], warnings: [] },
    });
    fireEvent.click(await screen.findByText('db-outage'));
    expect(screen.getByLabelText('Name')).toHaveValue('db-outage');
    expect(screen.getByLabelText('Pause (s)')).toHaveValue(2);
    expect(screen.getByText('broken').closest('button')).toBeDisabled();
    fireEvent.click(screen.getByText('Run'));
    expect(await screen.findByRole('alert')).toHaveTextContent('GUARD_REFUSED: production');
    expect(screen.getByText('Plan refused')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Validate (plan)'));
    expect(await screen.findByText('Plan is valid')).toBeInTheDocument();
    fireEvent.click(screen.getByText('New scenario'));
    expect(screen.getByLabelText('Name')).toHaveValue('new-scenario');
  });

  it('starts from an initial draft and works without targets', () => {
    mockFetch({ 'GET /scenarios': [] });
    renderI18n(
      <ScenarioEditor
        catalog={CATALOG}
        targets={[]}
        types={TYPES}
        initial={{
          name: 'adhoc',
          baselineS: 1,
          recoveryS: 1,
          watch: [],
          steps: [{ fault: 'latency', service: '', durationS: 5 }],
          expectations: [],
        }}
      />,
      'en',
    );
    expect(screen.getByLabelText('Name')).toHaveValue('adhoc');
    fireEvent.click(screen.getByText('Save'));
  });
});

describe('RunView', () => {
  const EVENTS = [
    { type: 'status', ts: 1000, status: 'running' },
    { type: 'phase', ts: 1000, phase: 'baseline' },
    { type: 'samples', ts: 1100, samples: [{ ts: 1100, probe: 'health', status: 200 }] },
    { type: 'inject', ts: 2000, fault: 'latency', service: 'mysql' },
    { type: 'samples', ts: 2100, samples: [{ ts: 2100, probe: 'health', status: 503 }] },
  ];

  it('folds events into phase, active fault and windows', () => {
    const v = reduceEvents([
      ...EVENTS,
      { type: 'revert', ts: 3000, ok: false, error: 'x' },
      { type: 'finished', ts: 4000, status: 'failed' },
    ]);
    expect(v).toMatchObject({
      status: 'failed',
      phase: 'fault',
      active: undefined,
      windows: [{ start: 2000, end: 3000 }],
    });
    expect(reduceEvents([{ type: 'revert', ts: 1 }]).windows).toEqual([]);
  });

  it('streams a live run and aborts it', async () => {
    const f = mockFetch({
      'GET /runs/r1': () => ({ ok: true, status: 200, body: sseBody(EVENTS) }),
      'POST /runs/r1/abort': { id: 'r1', status: 'aborted' },
    });
    renderI18n(<RunView id="r1" onReport={() => {}} />, 'en');
    expect((await screen.findAllByText('latency → mysql')).length).toBeGreaterThan(0);
    expect(screen.getByRole('img', { name: 'probes' })).toBeInTheDocument();
    fireEvent.click(screen.getByText('Abort this scenario'));
    await waitFor(() => expect(f.mock.calls.some((c) => c[0] === '/runs/r1/abort')).toBe(true));
  });

  it('shows a failed revert with its error in the log', async () => {
    mockFetch({
      'GET /runs/r4': () => ({
        ok: true,
        status: 200,
        body: sseBody([
          ...EVENTS,
          { type: 'revert', ts: 3000, fault: 'latency', ok: false, error: 'toxiproxy exploded' },
          { type: 'revert', ts: 3100, fault: 'latency', ok: true },
        ]),
      }),
    });
    renderI18n(<RunView id="r4" onReport={() => {}} />, 'en');
    expect(await screen.findByText(/✗ toxiproxy exploded/)).toBeInTheDocument();
    expect(screen.getByText(/revert latency ✓|revert latency.*✓/)).toBeInTheDocument();
  });

  it('links to the report once finished and reports stream errors', async () => {
    const onReport = vi.fn();
    mockFetch({
      'GET /runs/r2': () => ({
        ok: true,
        status: 200,
        body: sseBody([
          ...EVENTS,
          { type: 'revert', ts: 3000, fault: 'latency', ok: true },
          { type: 'error', ts: 3001, message: 'oops' },
          { type: 'finished', ts: 4000, status: 'passed' },
        ]),
      }),
      'GET /runs/r3': () => json({ error: { code: 'RUN_UNKNOWN', message: 'gone' } }, 404),
    });
    const { unmount } = renderI18n(<RunView id="r2" onReport={onReport} />, 'en');
    fireEvent.click(await screen.findByText('Reports →'));
    expect(onReport).toHaveBeenCalledWith('r2');
    expect(screen.getByText(/oops/)).toBeInTheDocument();
    unmount();
    renderI18n(<RunView id="r3" onReport={onReport} />, 'en');
    expect(await screen.findByRole('alert')).toHaveTextContent('RUN_UNKNOWN: gone');
  });

  it('ignores the abort error when unmounting and surfaces abort failures', async () => {
    mockFetch({
      'GET /runs/r4': (o) =>
        new Promise((_ok, reject) =>
          o.signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          ),
        ),
    });
    const { unmount } = renderI18n(<RunView id="r4" onReport={() => {}} />, 'en');
    unmount();
    mockFetch({
      'GET /runs/r5': () => ({ ok: true, status: 200, body: sseBody(EVENTS) }),
      'POST /runs/r5/abort': () =>
        json({ error: { code: 'RUN_NOT_ACTIVE', message: 'done' } }, 409),
    });
    renderI18n(<RunView id="r5" onReport={() => {}} />, 'en');
    fireEvent.click(await screen.findByText('Abort this scenario'));
    expect(await screen.findByRole('alert')).toHaveTextContent('RUN_NOT_ACTIVE');
  });
});

describe('Reports', () => {
  it('lists runs and opens a report with evidence and exports', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const onOpen = vi.fn();
    const f = mockFetch({
      'GET /runs': {
        active: null,
        runs: [
          {
            id: 'r1',
            scenario: 'db-outage',
            target: 'demo',
            status: 'failed',
            score: null,
            actor: 'a',
            startedAt: 's',
          },
        ],
      },
      'GET /runs/r1': { id: 'r1', report: REPORT },
      'GET /runs/r1/report.html': () => json({}),
    });
    const { rerender } = renderI18n(<Reports openId={null} onOpen={onOpen} />, 'en');
    fireEvent.click(await screen.findByText('Open'));
    expect(onOpen).toHaveBeenCalledWith('r1');
    cleanup();
    renderI18n(<Reports openId="r1" onOpen={onOpen} />, 'en');
    expect(await screen.findByText('something broke')).toBeInTheDocument();
    expect(screen.getByText('Revert failed')).toBeInTheDocument();
    expect(screen.getByText('Evidence (1)')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Export JSON'));
    fireEvent.click(screen.getByText('Export HTML'));
    await waitFor(() =>
      expect(
        f.mock.calls.some((c) => String(c[0]).startsWith('/runs/r1/report.html?lang=en')),
      ).toBe(true),
    );
    fireEvent.click(screen.getByText('← Back'));
    expect(onOpen).toHaveBeenLastCalledWith(null);
    void rerender;
    click.mockRestore();
  });

  it('shows errors for unknown reports and failed exports', async () => {
    mockFetch({
      'GET /runs/nope': () => json({ error: { code: 'RUN_UNKNOWN', message: 'x' } }, 404),
    });
    renderI18n(<Reports openId="nope" onOpen={() => {}} />, 'en');
    expect(await screen.findByRole('alert')).toHaveTextContent('RUN_UNKNOWN');
    cleanup();
    mockFetch({
      'GET /runs/r1': { id: 'r1', report: { ...REPORT, score: null } },
      'GET /runs/r1/report.html': () => json({ error: { code: 'X', message: 'y' } }, 500),
    });
    renderI18n(<Reports openId="r1" onOpen={() => {}} />, 'en');
    fireEvent.click(await screen.findByText('Export HTML'));
    expect(await screen.findByRole('alert')).toHaveTextContent('X: y');
  });
});

describe('Journal', () => {
  it('shows who injected what and the revert outcome', async () => {
    mockFetch({
      'GET /journal': [
        {
          id: '1',
          startedAt: 't',
          actor: 'alice',
          fault: 'latency',
          target: 'demo',
          service: 'mysql',
          params: { a: 1 },
          revertOk: true,
        },
        {
          id: '2',
          startedAt: 't',
          actor: 'bob',
          fault: 'service_kill',
          target: 'demo',
          service: 'api',
          params: {},
          revertOk: false,
          error: 'boom',
          revertedBy: 'recovery',
        },
        {
          id: '3',
          startedAt: 't',
          actor: 'cli',
          fault: 'x',
          target: 'demo',
          service: 'api',
          params: {},
          revertOk: null,
        },
      ],
    });
    renderI18n(<Journal />, 'en');
    expect(await screen.findByText('alice')).toBeInTheDocument();
    expect(screen.getByText('Revert OK')).toBeInTheDocument();
    expect(screen.getByText('Revert failed')).toBeInTheDocument();
    expect(screen.getByText('recovery')).toBeInTheDocument();
    expect(screen.getByText('pending')).toBeInTheDocument();
  });
});

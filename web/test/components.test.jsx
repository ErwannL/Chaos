import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ParamField, { defaults } from '../src/components/ParamField.jsx';
import ProbeChart from '../src/components/ProbeChart.jsx';
import FaultStep from '../src/components/FaultStep.jsx';
import ExpectationStep from '../src/components/ExpectationStep.jsx';
import { Badge, Button, ErrorBox } from '../src/components/ui.jsx';
import { DICTS, useI18n } from '../src/i18n.jsx';
import { CATALOG, REPORT, TARGETS, TYPES, renderI18n } from './helpers.jsx';

afterEach(cleanup);

describe('ParamField (generated from typed specs)', () => {
  it('renders bounded numbers and converts values', () => {
    const onChange = vi.fn();
    render(
      <ParamField
        name="latencyMs"
        spec={CATALOG[0].params.latencyMs}
        value={5}
        onChange={onChange}
      />,
    );
    const input = screen.getByLabelText('latencyMs (ms) [0–30000]');
    expect(input).toHaveAttribute('max', '30000');
    fireEvent.change(input, { target: { value: '42' } });
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange.mock.calls).toEqual([[42], [undefined]]);
  });

  it('renders enums, strings and booleans', () => {
    const onChange = vi.fn();
    render(
      <>
        <ParamField name="mode" spec={{ type: 'enum', values: ['a', 'b'] }} onChange={onChange} />
        <ParamField name="route" spec={{ type: 'string' }} value="/x" onChange={onChange} />
        <ParamField name="bySelf" spec={{ type: 'boolean' }} onChange={onChange} />
      </>,
    );
    fireEvent.change(screen.getByLabelText('mode'), { target: { value: 'b' } });
    fireEvent.change(screen.getByLabelText('route'), { target: { value: '/y' } });
    fireEvent.click(screen.getByLabelText('bySelf'));
    expect(onChange.mock.calls).toEqual([['b'], ['/y'], [true]]);
  });

  it('computes defaults', () => {
    expect(defaults(CATALOG[0].params)).toEqual({ latencyMs: 1000, mode: 'a' });
    expect(defaults({})).toEqual({});
  });
});

describe('ProbeChart', () => {
  it('draws rows, samples and fault windows', () => {
    const { container } = render(
      <ProbeChart
        samples={REPORT.samples}
        windows={[...REPORT.windows, { fault: 'x', start: 3000, end: null }]}
        now={9000}
      />,
    );
    expect(container.querySelectorAll('text')).toHaveLength(4);
    expect(container.querySelectorAll('.fill-red-500')).toHaveLength(3);
    expect(container.querySelectorAll('.fill-amber-500\\/20')).toHaveLength(2);
  });
  it('renders nothing without samples', () => {
    const { container } = render(<ProbeChart samples={[]} windows={[]} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('FaultStep and ExpectationStep', () => {
  it('lists compatible services and regenerates params when the fault changes', () => {
    const onChange = vi.fn();
    renderI18n(
      <FaultStep
        step={{ fault: 'latency', service: '', durationS: 700, params: {} }}
        onChange={onChange}
        catalog={CATALOG}
        target={TARGETS[0]}
      />,
    );
    const service = screen.getByLabelText('Service');
    expect([...service.options].map((o) => o.value)).toEqual(['', 'mysql']);
    fireEvent.change(service, { target: { value: 'mysql' } });
    fireEvent.change(screen.getByLabelText('fault'), { target: { value: 'service_pause' } });
    fireEvent.change(screen.getByLabelText('Durée (s) [1–600]'), { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText('latencyMs (ms) [0–30000]'), { target: { value: '7' } });
    expect(onChange.mock.calls.map((c) => c[0])).toEqual([
      { fault: 'latency', service: 'mysql', durationS: 700, params: {} },
      { fault: 'service_pause', service: '', durationS: 300, params: {} },
      { fault: 'latency', service: '', durationS: 9, params: {} },
      { fault: 'latency', service: '', durationS: 700, params: { latencyMs: 7 } },
    ]);
  });

  it('works without a target', () => {
    renderI18n(
      <FaultStep
        step={{ fault: 'service_pause', service: '', durationS: 1 }}
        onChange={() => {}}
        catalog={CATALOG}
      />,
    );
    expect(screen.getByLabelText('Service').options).toHaveLength(1);
  });

  it('edits expectations from the served field specs', () => {
    const onChange = vi.fn();
    render(
      <ExpectationStep
        exp={{ type: 'status_during', status: 503 }}
        onChange={onChange}
        types={TYPES}
      />,
    );
    fireEvent.change(screen.getByLabelText('type'), { target: { value: 'service_restarts' } });
    fireEvent.change(screen.getByLabelText('status'), { target: { value: '200' } });
    expect(onChange.mock.calls).toEqual([
      [{ type: 'service_restarts', bySelf: false }],
      [{ type: 'status_during', status: 200 }],
    ]);
  });
});

describe('ui and i18n', () => {
  it('renders badges, buttons and errors', () => {
    render(
      <>
        <Badge>b</Badge>
        <Button kind="danger">d</Button>
        <ErrorBox error={{ code: 'X', message: 'm' }} />
        <ErrorBox error={{ message: 'plain' }} />
        <ErrorBox error={null} />
      </>,
    );
    expect(screen.getAllByRole('alert').map((a) => a.textContent)).toEqual(['X: m', 'plain']);
  });

  it('has the same keys in fr and en', () => {
    expect(Object.keys(DICTS.fr).sort()).toEqual(Object.keys(DICTS.en).sort());
  });

  function Probe() {
    const { t, tr, lang, setLang } = useI18n();
    return (
      <button type="button" onClick={() => setLang(lang === 'fr' ? 'en' : 'fr')}>
        {t('abortAll')}|{tr({ fr: 'bonjour', en: 'hello' })}|{tr({ fr: 'seul' })}|{tr('brut')}|
        {tr(null)}|{t('unknownKey')}
      </button>
    );
  }

  it('translates, falls back and persists the language', () => {
    renderI18n(<Probe />, 'fr');
    const b = screen.getByRole('button');
    expect(b.textContent).toBe('Tout annuler|bonjour|seul|brut||unknownKey');
    fireEvent.click(b);
    expect(b.textContent).toBe('Cancel everything|hello|seul|brut||unknownKey');
    expect(localStorage.getItem('chaos.lang')).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('defaults to the browser language', () => {
    localStorage.clear();
    const spy = vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
    const { unmount } = render(
      <DICTSProvider>
        <Probe />
      </DICTSProvider>,
    );
    expect(screen.getByRole('button').textContent).toMatch(/^Cancel everything/);
    unmount();
    spy.mockReturnValue(undefined);
    render(
      <DICTSProvider>
        <Probe />
      </DICTSProvider>,
    );
    expect(screen.getByRole('button').textContent).toMatch(/^Tout annuler/);
    spy.mockRestore();
  });
});

import { I18nProvider as DICTSProvider } from '../src/i18n.jsx';

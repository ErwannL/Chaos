import { join } from 'node:path';
import { createCatalog } from './catalog/index.js';
import { createJournal } from './journal.js';
import { createStore } from './store.js';
import { createRunner } from './runner.js';
import { createScenarioRepo } from './scenarios.js';
import { loadTargets } from './targets.js';
import { createDockerApi, ScopedDocker } from './drivers/docker.js';
import { createToxiproxy } from './drivers/toxiproxy.js';
import { createBrowserDriver } from './drivers/browser.js';
import { systemClock } from './clock.js';

/** Wires the real drivers. Shared by the HTTP server and the CLI. */
export function createContext({
  dataDir,
  targetsFile,
  scenariosDir,
  dockerSocket,
  clock = systemClock,
  fetchImpl = globalThis.fetch,
  log = console.log,
}) {
  const catalog = createCatalog();
  const journal = createJournal({ file: join(dataDir, 'journal.jsonl'), clock });
  const store = createStore({ dir: join(dataDir, 'runs') });
  const scenarios = createScenarioRepo({ dir: scenariosDir });
  const targets = () => loadTargets(targetsFile); // re-read so edits apply without restart
  const dockerApi = createDockerApi({ socketPath: dockerSocket });
  const browser = createBrowserDriver();
  const drivers = (target) => ({
    docker: new ScopedDocker(dockerApi, target.project),
    toxiproxy: target.toxiproxy ? createToxiproxy({ url: target.toxiproxy.url, fetchImpl }) : null,
    browser,
  });
  const runner = createRunner({
    catalog,
    targets,
    journal,
    store,
    drivers,
    clock,
    fetchImpl,
    lockFile: join(dataDir, 'run.lock'),
    log,
  });
  return { catalog, journal, store, scenarios, targets, drivers, runner, clock, fetchImpl, log };
}

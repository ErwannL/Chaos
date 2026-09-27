import { ScopedDocker } from '../../src/drivers/docker.js';
import {
  createFakeDockerApi,
  createFakeToxiproxy,
  createFakeBrowser,
  createFakeClock,
  projectContainer,
} from './fakes.js';
import { parseTargets } from '../../src/targets.js';
import { demoTargetDoc } from './fixtures.js';

export function makeWorld(opts = {}) {
  const target = parseTargets({ targets: [demoTargetDoc(opts.target)] }, {})[0];
  const dockerApi = createFakeDockerApi({
    containers: [
      projectContainer('c-mysql', 'chaos-demo', 'mysql', {
        networks: { 'chaos-demo_backend': { Aliases: ['mysql'] } },
      }),
      projectContainer('c-redis', 'chaos-demo', 'redis'),
      projectContainer('c-api', 'chaos-demo', 'api', {
        networks: {
          'chaos-demo_backend': { Aliases: ['api'] },
          'chaos-demo_egress': { Aliases: ['api', null] },
        },
      }),
      projectContainer('c-web', 'chaos-demo', 'web', {
        networks: { 'chaos-demo_egress': {} },
      }),
      projectContainer('c-foreign', 'someone-else', 'api'),
    ],
    networks: {
      'chaos-demo_backend': { Name: 'chaos-demo_backend', Internal: true, Labels: {} },
      'chaos-demo_egress': { Name: 'chaos-demo_egress', Internal: false, Labels: {} },
    },
  });
  const docker = new ScopedDocker(dockerApi, target.project);
  const toxiproxy = createFakeToxiproxy();
  const browser = createFakeBrowser(opts.snapshot);
  const clock = createFakeClock();
  return { target, dockerApi, docker, toxiproxy, browser, clock };
}

export function faultCtx(world, serviceName) {
  const service = world.target.services.find((s) => s.name === serviceName);
  const ctx = {
    target: world.target,
    service,
    docker: world.docker,
    toxiproxy: world.toxiproxy,
    browser: world.browser,
    clock: world.clock,
    checkpoints: [],
    session: null,
    checkpoint: async (s) => {
      ctx.checkpoints.push(structuredClone(s));
    },
    attach: (s) => {
      ctx.session = s;
    },
    detach: async () => {
      await ctx.session?.close();
      ctx.session = null;
    },
  };
  return ctx;
}

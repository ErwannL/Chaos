import http from 'node:http';
import { ChaosError, GuardError } from '../errors.js';

export const PROJECT_LABEL = 'com.docker.compose.project';
export const SERVICE_LABEL = 'com.docker.compose.service';

const DEFAULT_SOCKET = '/var/run/docker.sock';

/**
 * Where the Docker Engine API is: `DOCKER_SOCKET` (a unix socket path or a
 * `tcp://host:port`), else `DOCKER_HOST` (`unix://…` or `tcp://…`), else the
 * default socket. Any other `DOCKER_HOST` scheme is refused, not guessed.
 */
export function dockerEndpoint(env = process.env) {
  if (env.DOCKER_SOCKET) return env.DOCKER_SOCKET;
  const host = env.DOCKER_HOST;
  if (!host) return DEFAULT_SOCKET;
  if (host.startsWith('unix://')) return host.slice('unix://'.length);
  if (host.startsWith('tcp://')) return host;
  throw new ChaosError('DOCKER_HOST', `Unsupported DOCKER_HOST scheme: ${host.split(':')[0]}`, 500);
}

/** `http.request` connection options for a socket path or a `tcp://host:port`. */
function connectionOptions(endpoint) {
  if (!endpoint.startsWith('tcp://')) return { socketPath: endpoint };
  const url = new URL(endpoint);
  return { host: url.hostname, port: Number(url.port || 2375) };
}

/** Minimal Docker Engine API client over a unix socket or plain TCP. */
export function createDockerApi({ socketPath = DEFAULT_SOCKET, timeoutMs = 30_000 } = {}) {
  return {
    request(method, path, body) {
      return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const req = http.request(
          {
            ...connectionOptions(socketPath),
            method,
            path: `/v1.43${path}`,
            timeout: timeoutMs,
            headers: payload
              ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
              : {},
          },
          (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8');
              let json;
              try {
                json = text ? JSON.parse(text) : undefined;
              } catch {
                json = undefined;
              }
              resolve({ status: res.statusCode, body: json, text });
            });
          },
        );
        req.on('timeout', () => req.destroy(new Error('docker request timed out')));
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
      });
    },
  };
}

function check(res, what, okStatuses = [200, 201, 204, 304]) {
  if (!okStatuses.includes(res.status)) {
    const msg = res.body?.message ?? res.text;
    throw new ChaosError('DOCKER_ERROR', `${what} failed (${res.status}): ${msg}`, 502);
  }
  return res.body;
}

/**
 * Docker access restricted to one compose project. Every mutating call
 * re-inspects the container and refuses it unless its project label matches.
 */
export class ScopedDocker {
  constructor(api, project) {
    if (!project) throw new GuardError('PROJECT_MISSING', 'A compose project is required');
    this.api = api;
    this.project = project;
  }

  async containersFor(service) {
    const filters = JSON.stringify({
      label: [`${PROJECT_LABEL}=${this.project}`, `${SERVICE_LABEL}=${service}`],
    });
    const list = check(
      await this.api.request(
        'GET',
        `/containers/json?all=1&filters=${encodeURIComponent(filters)}`,
      ),
      'list containers',
    );
    // Defense in depth: never trust the daemon-side filter alone.
    return list.filter(
      (c) => c.Labels?.[PROJECT_LABEL] === this.project && c.Labels?.[SERVICE_LABEL] === service,
    );
  }

  async containerFor(service) {
    const [c] = await this.containersFor(service);
    if (!c) {
      throw new ChaosError(
        'CONTAINER_NOT_FOUND',
        `No container for service ${service} in project ${this.project}`,
        404,
      );
    }
    return c.Id;
  }

  async inspect(id) {
    const info = check(
      await this.api.request('GET', `/containers/${encodeURIComponent(id)}/json`),
      'inspect',
    );
    if (info.Config?.Labels?.[PROJECT_LABEL] !== this.project) {
      throw new GuardError(
        'PROJECT_MISMATCH',
        `Container ${id} does not belong to project ${this.project}`,
      );
    }
    return info;
  }

  async #post(id, action, what, body, ok) {
    await this.inspect(id);
    return check(
      await this.api.request('POST', `/containers/${encodeURIComponent(id)}/${action}`, body),
      what,
      ok,
    );
  }

  pause(id) {
    return this.#post(id, 'pause', 'pause');
  }

  unpause(id) {
    return this.#post(id, 'unpause', 'unpause');
  }

  kill(id, signal = 'SIGKILL') {
    return this.#post(id, `kill?signal=${encodeURIComponent(signal)}`, 'kill');
  }

  start(id) {
    return this.#post(id, 'start', 'start');
  }

  async state(id) {
    const info = await this.inspect(id);
    return {
      running: !!info.State?.Running,
      paused: !!info.State?.Paused,
      restartCount: info.RestartCount ?? 0,
      startedAt: info.State?.StartedAt,
      health: info.State?.Health?.Status,
    };
  }

  async exec(id, cmd) {
    const created = await this.#post(id, 'exec', 'exec create', {
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    });
    const started = await this.api.request('POST', `/exec/${created.Id}/start`, {
      Detach: false,
      Tty: true,
    });
    check(started, 'exec start');
    const info = check(await this.api.request('GET', `/exec/${created.Id}/json`), 'exec inspect');
    return { exitCode: info.ExitCode, output: started.text };
  }

  async networks(id) {
    const info = await this.inspect(id);
    return info.NetworkSettings?.Networks ?? {};
  }

  async networkInfo(name) {
    return check(await this.api.request('GET', `/networks/${encodeURIComponent(name)}`), 'network');
  }

  async connect(network, id, aliases = []) {
    await this.inspect(id);
    const res = await this.api.request('POST', `/networks/${encodeURIComponent(network)}/connect`, {
      Container: id,
      EndpointConfig: { Aliases: aliases },
    });
    check(res, 'network connect');
  }

  async disconnect(network, id) {
    await this.inspect(id);
    const res = await this.api.request(
      'POST',
      `/networks/${encodeURIComponent(network)}/disconnect`,
      { Container: id, Force: true },
    );
    check(res, 'network disconnect');
  }

  /** Creates (or reuses) an internal network owned by the project. */
  async ensureInternalNetwork(name) {
    const existing = await this.api.request('GET', `/networks/${encodeURIComponent(name)}`);
    if (existing.status === 200) {
      if (existing.body.Labels?.[PROJECT_LABEL] !== this.project || !existing.body.Internal) {
        throw new GuardError('PROJECT_MISMATCH', `Network ${name} is not ours`);
      }
      return;
    }
    check(
      await this.api.request('POST', '/networks/create', {
        Name: name,
        Internal: true,
        Labels: { [PROJECT_LABEL]: this.project, 'chaos.managed': 'true' },
      }),
      'network create',
    );
  }

  async removeNetwork(name) {
    const existing = await this.api.request('GET', `/networks/${encodeURIComponent(name)}`);
    if (existing.status === 404) return;
    if (existing.body.Labels?.['chaos.managed'] !== 'true') {
      throw new GuardError('PROJECT_MISMATCH', `Network ${name} is not managed by Chaos`);
    }
    check(
      await this.api.request('DELETE', `/networks/${encodeURIComponent(name)}`),
      'network remove',
    );
  }
}

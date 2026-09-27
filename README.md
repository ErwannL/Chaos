# Chaos

Outil autonome d’ingénierie du chaos pour une application web conteneurisée
(pile `docker compose`). Chaos injecte des pannes dans la **cible**, observe son
comportement pendant et après la panne, puis produit un rapport avec des
verdicts vérifiables et un score de résilience.

Chaos ne connaît la cible **que** par `chaos.targets.yaml` : aucun nom de
service n’est codé en dur, ni dans l’exécuteur, ni dans l’interface.

```
┌────────────── hôte (127.0.0.1) ────────────────────────────────────────────┐
│  Chaos (Node 22 + Express, UI React)   :8090                               │
│   ├─ API HTTP / SSE / CLI ──── exécuteur ── catalogue (1 fichier / panne)   │
│   ├─ sondes HTTP  ─────────────────────────────► cible :8080 (nginx → api)  │
│   ├─ Toxiproxy API ────────────────────────────► :8474 (dans la cible)      │
│   ├─ Docker Engine API (socket) ─► conteneurs du SEUL projet déclaré        │
│   └─ Playwright/Chromium ──────────────────────► frontend de la cible      │
└────────────────────────────────────────────────────────────────────────────┘
```

## Sommaire

- [Installation](#installation)
- [Configuration](#configuration)
- [Catalogue des pannes](#catalogue-des-pannes)
- [Scénarios et attentes](#scénarios-et-attentes)
- [Garde-fous](#garde-fous)
- [API HTTP](#api-http)
- [CLI et CI](#cli-et-ci)
- [Contrat SSO](#contrat-sso)
- [Application cible de démonstration](#application-cible-de-démonstration)
- [Qualité et tests](#qualité-et-tests)
- [Limites connues](#limites-connues)

## Installation

Prérequis : Docker (avec Compose v2) et, pour développer, Node.js ≥ 20.

```bash
cp .env.example .env            # choisir au moins CHAOS_LOCAL_PASSWORD (≥ 12 caractères)

# 1. la cible de démonstration (MySQL, Redis, Toxiproxy, API, frontend)
docker compose -f demo-target/docker-compose.yml up -d --build --wait

# 2. Chaos
docker compose up -d --build
# → http://127.0.0.1:8090  (compte défini dans .env)
```

Le conteneur Chaos utilise `network_mode: host`. Il joint donc les cibles sur
`127.0.0.1`, ce qui donne tout son sens au garde-fou « loopback », et
n’écoute que sur `127.0.0.1:8090`. Tous les ports de la démo sont publiés sur
`127.0.0.1` uniquement. Sous Docker Desktop (macOS/Windows), activez
_host networking_ dans les réglages, ou lancez Chaos hors conteneur :

```bash
npm ci && npm run build -w web
CHAOS_WEB_DIR=web/dist node --env-file=.env server/src/index.js
```

Développement de l’UI : `npm run dev -w web` (Vite relaie l’API vers `:8090`).

## Configuration

### Variables d’environnement (`.env`)

| Variable                                                      | Rôle                                                                                                                                                                  |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHAOS_LOCAL_USER`, `CHAOS_LOCAL_PASSWORD`                    | Compte local unique, utilisé quand le SSO n’est pas configuré.                                                                                                        |
| `CHAOS_SSO_SECRET`                                            | Secret HS256 partagé avec la console d’administration (≥ 32 caractères). Active le SSO et désactive le compte local.                                                  |
| `CHAOS_SSO_ISSUERS`                                           | Valeurs `iss` acceptées, séparées par des virgules (obligatoire avec le SSO).                                                                                         |
| `CHAOS_SESSION_SECRET`                                        | Signe les sessions Chaos. Doit **différer** de `CHAOS_SSO_SECRET` (≥ 32 caractères). Obligatoire avec le SSO ; sinon un secret aléatoire est tiré à chaque démarrage. |
| `CHAOS_SESSION_TTL_S`                                         | Durée de session (8 h par défaut).                                                                                                                                    |
| `CHAOS_FRAME_ANCESTORS`                                       | Origines autorisées à intégrer Chaos en iframe (CSP `frame-ancestors`).                                                                                               |
| `CHAOS_HOST` / `CHAOS_PORT`                                   | Adresse d’écoute : loopback **obligatoire**, `127.0.0.1:8090` par défaut.                                                                                             |
| `CHAOS_TARGETS_FILE`, `CHAOS_SCENARIOS_DIR`, `CHAOS_DATA_DIR` | Emplacement de la config des cibles, des scénarios, du journal et des rapports.                                                                                       |
| `DOCKER_SOCKET`                                               | Socket Docker (`/var/run/docker.sock` par défaut).                                                                                                                    |

Le serveur refuse de démarrer si ces règles ne sont pas respectées (secret
trop court, secrets identiques, hôte non loopback…).

### Cible : `chaos.targets.yaml`

```yaml
targets:
  - name: demo
    project: chaos-demo # label com.docker.compose.project : Chaos ne touche que lui
    environment: local # local | recette  (production/prod : toujours refusé)
    baseUrl: http://127.0.0.1:8080 # base des routes surveillées (watch, no_5xx)
    toxiproxy: { url: http://127.0.0.1:8474 }
    services:
      - { name: mysql, role: db, port: 3306, proxy: mysql } # proxy = nom du proxy Toxiproxy
      - { name: redis, role: cache, port: 6379, proxy: redis }
      - { name: api, role: api, port: 3000, diskPath: /tmp/chaos } # volume pour disk_pressure
      - { name: web, role: frontend, port: 80 }
    probes:
      health: http://127.0.0.1:8080/health # doit passer à 503 sans base
      liveness: http://127.0.0.1:8080/livez # doit rester à 200
      status: { url: http://127.0.0.1:8080/api/status, componentsPath: components }
      metrics: { url: http://127.0.0.1:8080/metrics, tokenEnv: DEMO_METRICS_TOKEN }
      logs: { url: http://127.0.0.1:3100, selector: '{app="api"}' } # Loki, optionnel
      intervalMs: 1000
      timeoutMs: 1500
    frontendUrl: http://127.0.0.1:8080 # scénarios navigateur
```

- **Rôles** : `db`, `cache`, `api`, `frontend`, `worker`. Chaque panne déclare
  les rôles compatibles.
- **`status`** : JSON dont `componentsPath` pointe vers une table
  (`{db: "up"}` ou `{db: {status: "down"}}`) ou une liste (`[{name, status}]`).
- **`metrics`** : le jeton est lu dans la variable nommée par `tokenEnv`. Il
  n’est jamais renvoyé par l’API (`hasToken: true`).
- **`logs`** : requête Loki `sum(count_over_time(<selector> |~ "(?i)error" [Ns]))`,
  que l’on peut changer avec `errorFilter`.
- Le fichier est relu à chaque requête : une modification ne demande pas de
  redémarrage.

## Catalogue des pannes

Chaque panne est **un fichier** de `server/src/catalog/faults/` et **une ligne**
de `server/src/catalog/index.js`. Une panne est un objet `{ key, title, description,
params, roles, requires, maxDurationS, inject(ctx, params), revert(ctx, state) }`.
L’exécuteur ne connaît aucune panne par son nom : il ne passe que par le
catalogue. L’UI génère ses formulaires à partir de `GET /catalog`.

| key                     | titre                         | rôles          | requiert    | paramètres (bornes, défaut)                                                                                                    | durée max |
| ----------------------- | ----------------------------- | -------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------ | --------- |
| `latency`               | Latence réseau                | db, cache, api | proxy       | `latencyMs` 0–30000 ms (1000)<br>`jitterMs` 0–10000 ms (0)                                                                     | 600 s     |
| `connection_reset`      | Coupure des connexions TCP    | db, cache, api | proxy       | `mode` disable \| reset_peer (disable)                                                                                         | 300 s     |
| `bandwidth`             | Débit limité                  | db, cache, api | proxy       | `rateKBps` 1–1000000 KB/s (10)                                                                                                 | 600 s     |
| `service_pause`         | Pause du service              | tous           | —           | —                                                                                                                              | 300 s     |
| `service_kill`          | Arrêt brutal du service       | tous           | —           | `method` docker_kill \| process_crash (docker_kill)<br>`signal` SIGKILL \| SIGTERM (SIGKILL)<br>`restartTimeoutS` 5–300 s (60) | 300 s     |
| `egress_block`          | Blocage de la sortie internet | tous           | —           | —                                                                                                                              | 600 s     |
| `browser_offline`       | Navigateur hors ligne         | frontend       | frontendUrl | —                                                                                                                              | 300 s     |
| `browser_slow_api`      | API lente (navigateur)        | frontend       | frontendUrl | `delayMs` 100–60000 ms (5000)<br>`urlPattern` regex (`/api/`)                                                                  | 300 s     |
| `browser_missing_chunk` | Chunk JS absent               | frontend       | frontendUrl | `chunkPattern` regex (`/assets/(?!index-)[^/]+\.js$`)                                                                          | 300 s     |
| `disk_pressure`         | Saturation disque             | tous           | diskPath    | `targetPercent` 50–95 % (90)<br>`maxMb` 1–4096 MB (256)                                                                        | 300 s     |

Mécanique et réversibilité de chaque panne :

- **Toxiproxy** (`latency`, `bandwidth`, `connection_reset/reset_peer`) : un
  _toxic_ au nom fixe `chaos_<key>`, retiré au revert. `connection_reset/disable`
  désactive le proxy : les connexions ouvertes sont fermées et les nouvelles
  refusées. Le revert le réactive.
- **`service_pause`** : `docker pause`, puis `unpause` au revert.
- **`service_kill`** : avec `docker_kill`, Chaos tue le conteneur via l’API et
  le relance au revert, puis attend qu’il tourne (et soit _healthy_). Avec
  `process_crash`, il fait `kill -1` **dans** le conteneur : seule la politique
  de redémarrage du service peut le ramener (il faut un init comme tini).
  C’est ce que vérifie `service_restarts … bySelf: true`.
- **`egress_block`** : le service est détaché de ses réseaux avec passerelle et
  ne garde que ses réseaux `internal: true`. S’il n’en a aucun, Chaos lui crée
  un réseau interne étiqueté au nom du projet. Le plan est journalisé **avant**
  toute action. Au revert, les réseaux sont reconnectés avec leurs alias.
- **`disk_pressure`** : `df` puis `dd` dans le conteneur jusqu’à
  `min(targetPercent, maxMb)` sur le `diskPath` déclaré. Le revert supprime le
  fichier. Les commandes sont passées en argv, sans shell.
- **Navigateur** : une session Playwright ouvre `frontendUrl` avec la
  condition voulue (hors ligne, requêtes retardées ou chunk bloqué) et observe
  la page : écran blanc ? message d’erreur (`[role=alert]`,
  `[data-chaos-error]`) ? Le revert ferme le navigateur.

## Scénarios et attentes

Un scénario (YAML dans `scenarios/`, ou saisi dans l’éditeur) est une suite
d’étapes (panne + durée, ou pause) accompagnée d’**attentes**.

```yaml
name: db-outage
baselineS: 3 # observation avant la première panne
recoveryS: 15 # observation après la dernière
watch: [/api/items] # routes sondées en plus (relatives à baseUrl)
steps:
  - { fault: connection_reset, service: mysql, durationS: 12, params: { mode: disable } }
  - { pause: 5 }
expectations:
  - { type: status_during, probe: health, status: 503 }
  - { type: status_during, probe: liveness, status: 200 }
  - { type: status_component, component: db, state: down }
  - { type: recovers_within, probe: health, status: 200, seconds: 10 }
```

| type                   | vérifie                                                                                                                      | champs                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `status_during`        | la sonde renvoie ce code pendant la panne                                                                                    | `probe`, `status`                      |
| `recovers_within`      | la sonde revient au code attendu moins de N s après le dernier revert                                                        | `probe`, `status`, `seconds`           |
| `status_component`     | la page de statut signale le composant dans cet état                                                                         | `component`, `state` (chaîne ou liste) |
| `no_5xx`               | aucune réponse 5xx sur la route pendant la panne                                                                             | `route`                                |
| `frontend_error_shown` | la page affiche un message d’erreur et jamais un écran blanc                                                                 | —                                      |
| `frontend_not_blank`   | la page n’est jamais blanche                                                                                                 | —                                      |
| `service_restarts`     | le conteneur redémarre (nouveau `StartedAt` ou `RestartCount`) en moins de N s ; avec `bySelf`, **avant** le revert de Chaos | `service`, `seconds`, `bySelf`         |
| `log_errors_below`     | pas plus de N lignes d’erreur dans Loki                                                                                      | `max`                                  |

Les attentes « pendant » acceptent `step` (limite à une étape) et `settleS`
(délai de détection, 2 s par défaut). Chaque attente rend un verdict
**passé / échoué / non mesurable**, avec en preuve les échantillons horodatés
(30 au plus). Le **score de résilience** est la part des attentes mesurables
qui passent (`null` si aucune n’est mesurable).

Scénarios fournis : `db-outage`, `cache-outage`, `db-latency`, `api-crash`,
`api-pause`, `egress-and-disk`, `frontend-offline`, `frontend-missing-chunk`,
`frontend-slow-api`.

## Garde-fous

Aucun drapeau, aucune option ne contourne ces règles. Chaque refus a son test.

| Règle                                                                                                               | Mise en œuvre                                                                                                                                                  | Tests                                                                         |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 🔴 Refus de `production`/`prod` (casse et espaces ignorés, et tout `prod*`) ; seuls `local` et `recette` sont admis | `guards.js › assertEnvironmentAllowed`, appelé par `plan`, `start` (deux fois) et la CLI                                                                       | `guards.test.js`, `runner.test.js`, `app.test.js`, `cli.test.js`, intégration |
| 🔴 Hôte non loopback refusé sauf `allowRemote === true` **et** chaque hôte retapé dans `confirmHost`                | comparaison **côté serveur** (`assertHostsAllowed`) : l’UI et la CLI se contentent de transmettre                                                              | `guards.test.js`, `app.test.js`, `cli.test.js`                                |
| 🔴 Seuls les conteneurs dont le label `com.docker.compose.project` égale le projet déclaré                          | `ScopedDocker` filtre la liste **et** réinspecte le label avant chaque action (pause, kill, start, exec, réseau)                                               | `docker.test.js`, `catalog.test.js`                                           |
| 🔴 Tout est réversible, le revert tourne toujours                                                                   | `finally` par étape + filet final ; 3 tentatives ; SIGINT/SIGTERM → `abortAll()` ; journal fsyncé, relu au démarrage (`recoverPending`) et par `chaos recover` | `runner.test.js`, `persistence.test.js`, `server.test.js`, `cli.test.js`      |
| Un seul scénario à la fois (409)                                                                                    | verrou en mémoire + fichier `run.lock` partagé entre serveur et CLI (repris si son processus est mort)                                                         | `runner.test.js`, `persistence.test.js`, `app.test.js`                        |
| Durée bornée par panne                                                                                              | `maxDurationS` du catalogue, vérifié au plan                                                                                                                   | `guards.test.js`, `runner.test.js`                                            |
| Journal de chaque injection (qui, quoi, quand, revert OK ?)                                                         | `data/journal.jsonl`, `GET /journal`, page Journal                                                                                                             | `persistence.test.js`                                                         |
| Écoute sur loopback uniquement                                                                                      | `CHAOS_HOST` refusé s’il n’est pas loopback ; ports de la démo publiés sur `127.0.0.1`                                                                         | `auth.test.js`, `server.test.js`                                              |

Ces comportements ont aussi été vérifiés sur la vraie pile : `kill -9` de Chaos
en pleine injection puis `chaos recover` (proxy réactivé), Ctrl-C (revert puis
code 2), `docker compose stop` du conteneur Chaos pendant une panne (revert
avant l’arrêt).

## API HTTP

Toutes les routes, sauf `/auth/*`, exigent `Authorization: Bearer <session>`.

| Méthode     | Route                                                        | Rôle                                                                                                                                                        |
| ----------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`       | `/catalog`                                                   | Le catalogue des pannes (sans fonctions).                                                                                                                   |
| `GET`       | `/expectation-types`                                         | Champs de chaque type d’attente (pilote l’éditeur).                                                                                                         |
| `GET`       | `/targets`                                                   | Cibles (sans secrets) + verdict des garde-fous + sondes en direct (`?live=0` pour s’en passer).                                                             |
| `POST`      | `/plan`                                                      | Valide sans exécuter : `{scenario: nom\|objet, target, allowRemote?, confirmHost?}` → verdict de cible, erreurs par étape, avertissements, durée estimée.   |
| `POST`      | `/runs`                                                      | Lance (202 `{id}`). 403 si un garde-fou refuse, 400 si le plan est invalide, 409 si un scénario tourne déjà.                                                |
| `GET`       | `/runs`                                                      | Historique + run actif.                                                                                                                                     |
| `GET`       | `/runs/:id`                                                  | JSON (événements ou rapport), ou **SSE** avec `Accept: text/event-stream` (`status`, `phase`, `samples`, `inject`, `revert`, `error`, `abort`, `finished`). |
| `POST`      | `/runs/:id/abort`                                            | Annule ce run (revert puis rapport `aborted`).                                                                                                              |
| `POST`      | `/abort-all`                                                 | « Tout annuler ».                                                                                                                                           |
| `GET`       | `/runs/:id/report.html`                                      | Rapport HTML autonome (`?lang=fr\|en`).                                                                                                                     |
| `GET`/`PUT` | `/scenarios`, `/scenarios/:name`                             | Liste et enregistrement des scénarios.                                                                                                                      |
| `GET`       | `/journal`                                                   | Journal des injections.                                                                                                                                     |
| `GET`       | `/auth/mode`, `/auth/me` · `POST` `/auth/login`, `/auth/sso` | Authentification.                                                                                                                                           |

## CLI et CI

```bash
npx chaos run db-outage --target demo            # nom de scénario ou chemin vers un .yaml
npx chaos run cache-outage --target demo --json  # rapport JSON sur stdout
npx chaos plan db-outage --target demo           # valide sans exécuter
npx chaos run x --target recette --allow-remote --confirm-host=recette.example.com
npx chaos catalog
npx chaos recover                                # annule les injections restées en suspens
# dans le conteneur :  docker compose exec chaos chaos run db-outage --target demo
```

| Code | Signification                                                                           |
| ---- | --------------------------------------------------------------------------------------- |
| 0    | toutes les attentes mesurables sont passées                                             |
| 1    | au moins une attente a échoué (avec `--strict`, une attente non mesurable compte aussi) |
| 2    | refus d’un garde-fou, erreur d’injection ou de revert, ou run annulé                    |
| 64   | usage incorrect                                                                         |

La CLI exécute le même moteur en local : mêmes garde-fous, même journal, même
verrou que le serveur (409 si un scénario tourne déjà ailleurs). Ctrl-C
annule proprement.

## Contrat SSO

Chaos sera ouvert dans une iframe par la console d’administration.

1. La console signe un **JWT HS256** avec `CHAOS_SSO_SECRET` et une durée de
   vie de **60 s au plus** :

   ```json
   {
     "iss": "admin-console",
     "aud": "chaos",
     "sub": "user-42",
     "name": "Ada Lovelace",
     "iat": 1790000000,
     "exp": 1790000060
   }
   ```

2. Elle ouvre `https://chaos.example/#sso=<jwt>`. Le jeton est dans le
   **fragment**, donc jamais envoyé au serveur dans l’URL, ni dans les logs, ni
   dans le `Referer`.
3. L’UI lit le fragment, l’efface aussitôt de l’historique (`replaceState`) et
   envoie `POST /auth/sso {"token": "<jwt>"}`.
4. Le serveur vérifie :
   - l’algorithme (exactement `HS256`, `none` refusé) et la signature (comparaison à temps constant) ;
   - `iss` ∈ `CHAOS_SSO_ISSUERS`, `aud` contient `chaos` ;
   - `sub` et `name` non vides, `iat` et `exp` entiers ;
   - `exp − iat ≤ 60`, `iat` pas dans le futur (tolérance 5 s), `exp` pas dépassé ;
   - aucun rejeu : un jeton ne sert qu’une fois.
5. Il répond `{ token, user, expiresAt }` : une **session Chaos** signée avec
   un **autre** secret (`CHAOS_SESSION_SECRET`, `aud: chaos-session`). Un
   jeton SSO n’est donc jamais accepté comme session, ni l’inverse.
   L’utilisateur apparaît comme `iss:sub` dans le journal.

La session voyage dans l’en-tête `Authorization`, pas dans un cookie. Il n’y a
donc ni CSRF ni souci de cookies tiers dans l’iframe. `CHAOS_FRAME_ANCESTORS`
fixe qui peut intégrer Chaos. Sans `CHAOS_SSO_SECRET`, `/auth/sso` renvoie 404
et seul le compte local de `.env` fonctionne.

Exemple côté console (Node) :

```js
import { createHmac } from 'node:crypto';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: 'admin-console', aud: 'chaos', sub: user.id, name: user.name, iat: now, exp: now + 60 })}`;
const jwt = `${body}.${createHmac('sha256', process.env.CHAOS_SSO_SECRET).update(body).digest('base64url')}`;
iframe.src = `http://127.0.0.1:8090/#sso=${jwt}`;
```

## Application cible de démonstration

`demo-target/` (projet compose `chaos-demo`) contient :

- **api** (Express) : `/livez` (toujours 200), `/health` (503 sans MySQL),
  `/api/status` (composants `db`/`cache`), `/api/items` (cache Redis de 5 s qui
  retombe sur MySQL), `/metrics` (Prometheus, jeton `DEMO_METRICS_TOKEN`).
  MySQL et Redis sont joints **à travers Toxiproxy**. Le service tourne sous
  `init` avec `restart: unless-stopped`, et dispose d’un `tmpfs` `/tmp/chaos`
  pour `disk_pressure`.
- **web** (React + nginx) : liste des items, panneau de statut chargé en
  **chunk paresseux**, _error boundary_, messages « hors ligne » et « lent ».
  Nginx relaie `/api`, `/health`, `/livez` et `/metrics` par le réseau interne.
- **mysql**, **redis** sur le réseau `backend` (`internal: true`, sans passerelle),
  et **toxiproxy** (`ghcr.io/shopify/toxiproxy`, proxies dans `toxiproxy.json`).

**Bugs volontaires**, pour prouver qu’un scénario échoue quand il le doit :

```bash
DEMO_BUG=1 docker compose -f demo-target/docker-compose.yml up -d api   # le cache ne retombe plus sur la base
npx chaos run cache-outage --target demo   # → FAILED no_5xx … exit 1
```

Ajoutez aussi `?bug=noboundary` à `frontendUrl` : sans _error boundary_,
`frontend-missing-chunk` voit un écran blanc et échoue.

## Qualité et tests

```bash
npm run lint              # ESLint + Prettier
npm run check:size        # aucun fichier > 1000 lignes
npm run coverage          # tests unitaires, ≥ 95 % PAR FICHIER (lignes, branches, fonctions, instructions), 4 workspaces
npm run test:mutation     # casse chaque garde-fou exprès et vérifie que les tests échouent
npm run test:integration  # vrais scénarios sur la vraie pile démo (Docker requis)
```

- **Unitaires** (`server/test`) : catalogue (chaque panne injectée puis
  annulée), garde-fous (un test par refus), exécuteur de bout en bout avec un
  **faux Docker Engine** (au niveau HTTP), un faux Toxiproxy, un faux
  navigateur et une horloge simulée, reprise après crash, API HTTP et SSE,
  SSO, CLI. `web/test` et `demo-target/*/test` couvrent l’UI et la démo.
- **Intégration** (`server/test/integration`) : `docker compose up` de la démo,
  puis `db-outage`, `cache-outage` (qui doit **réussir** sans bug puis
  **échouer, code 1** avec `DEMO_BUG=1`), `api-crash`,
  `frontend-missing-chunk`, refus d’une cible de production, et journal vide
  à la fin.
- `scripts/mutation-check.mjs` : garde-fou production, `confirm-host`, label de
  projet, revert oublié, détection des 5xx, durée de vie SSO, interrupteur du bug.
  La CI (`.github/workflows/ci.yml`) enchaîne tout cela et construit l’image.
- Seuls les points d’entrée de 3 lignes (`src/index.js`, `bin/chaos.js`,
  `main.jsx`) sont exclus de la couverture. Leur logique vit dans des modules
  testés (`server.js`, `cli.js`, `main.js`).

## Limites connues

- **`docker kill` ne déclenche pas la politique de redémarrage** : Docker le
  traite comme un arrêt manuel. Pour tester un redémarrage autonome, utilisez
  `service_kill` avec `method: process_crash` et un init dans le conteneur.
- **`egress_block` détache aussi les ports publiés** du service, puisqu’ils
  passent par le réseau à passerelle. Sondez donc le service à travers un
  autre (dans la démo, nginx sur le réseau interne). Un blocage purement
  sortant demanderait `NET_ADMIN` et iptables dans le conteneur ciblé.
- **Toxiproxy fait partie de la cible** : la cible doit router ses dépendances
  à travers ses proxies (`proxy:` dans la config). Chaos n’en crée pas.
- `recette` sur un hôte distant : les sondes et Toxiproxy passent par le
  réseau, mais l’API Docker reste celle du socket local. Pour agir sur des
  conteneurs distants, lancez Chaos sur l’hôte de recette.

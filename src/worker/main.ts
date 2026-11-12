import express from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerJournal } from './journal.js';
import { WorkerAgent, ManagerClient } from './agent.js';
import { ChatGptDriver, type BrowserDriver } from './browser.js';
import { ChromeBrowserSession } from './chrome.js';
import { loadWorkerConfig, type WorkerConfig } from './config.js';
export async function startWorker(
  config: WorkerConfig,
  options: { driver?: BrowserDriver; tickMs?: number } = {},
) {
  const journal = new WorkerJournal(join(config.dataDir, 'worker.sqlite'));
  const local = journal.setting<Partial<WorkerConfig>>('localConfig') ?? {};
  config = { ...config, ...local };
  const scope = `${config.managerUrl}|${config.workerId}`;
  const credentialScope = journal.setting<string>('credentialScope');
  const credential =
    !credentialScope || credentialScope === scope
      ? journal.setting<string>('credential')
      : undefined;
  const pending = journal.setting<{ generation: string; token: string; scope: string }>(
    'pendingPair',
  );
  const generation = !credential && pending?.scope === scope ? pending.generation : randomUUID();
  const client = new ManagerClient(config.managerUrl, credential);
  const driver = options.driver ?? new ChatGptDriver(new ChromeBrowserSession(config));
  const agent = new WorkerAgent({ workerId: config.workerId, generation, journal, client, driver });
  let closed = false,
    registered = false,
    browserReady = false,
    lastError: string | undefined,
    connecting = false,
    claiming = false,
    ticking = false,
    lastHeartbeat = 0;
  let pairingToken = config.pairingToken ?? (pending?.scope === scope ? pending.token : undefined);
  let retryAt = 0;
  const persistConnection = () =>
    journal.setSetting('connection', {
      version: client.settingsVersion,
      connection: client.connection,
    });
  const register = async () => {
    if (registered || connecting || Date.now() < retryAt || closed) return;
    connecting = true;
    const registrationToken = pairingToken;
    try {
      if (!client.credential && registrationToken)
        journal.setSetting('pendingPair', { scope, generation, token: registrationToken });
      const ack = await client.request('/api/v1/workers/register', {
        workerId: config.workerId,
        name: config.name,
        roles: config.roles,
        generation,
        ...(!client.credential && registrationToken ? { pairingToken: registrationToken } : {}),
      });
      if (ack.credential) {
        client.credential = ack.credential;
        journal.setSetting('credential', ack.credential);
        journal.setSetting('credentialScope', scope);
        journal.setSetting('pendingPair', null);
      }
      if (!client.credential)
        throw Error('Pairing required: supply AF_PAIRING_TOKEN or use local configuration');
      registered = true;
      lastError = undefined;
      pairingToken = undefined;
      persistConnection();
    } catch (error) {
      lastError = String(error);
      retryAt =
        pairingToken !== registrationToken
          ? 0
          : Date.now() + Math.max(options.tickMs ?? 1000, 3000);
    } finally {
      connecting = false;
    }
  };
  const claim = async () => {
    if (claiming || !registered || journal.active() || closed) return;
    claiming = true;
    try {
      browserReady = driver.ready ? await driver.ready() : true;
      if (!browserReady) {
        lastError = 'Human login required in the isolated Chrome window';
        return;
      }
      const ack = await client.request(
        `/api/v1/workers/${encodeURIComponent(config.workerId)}/claim`,
        { generation, waitSeconds: client.connection.longPollWaitSec },
        client.connection.longPollHttpTimeoutSec,
      );
      persistConnection();
      if (ack.attempt) journal.accept(ack.attempt);
    } catch (error) {
      lastError = String(error);
      registered = false;
      retryAt = Date.now() + 3000;
    } finally {
      claiming = false;
    }
  };
  const tick = async () => {
    if (ticking || closed) return;
    ticking = true;
    try {
      await register();
      if (registered) {
        if (journal.active()) await agent.tick();
        else await claim();
      }
    } catch (error) {
      lastError = String(error);
      registered = false;
      retryAt = Date.now() + 3000;
    } finally {
      ticking = false;
    }
  };
  const heartbeat = async () => {
    if (
      !registered ||
      closed ||
      Date.now() - lastHeartbeat < client.connection.heartbeatIntervalSec * 1000
    )
      return;
    lastHeartbeat = Date.now();
    const active = journal.active();
    try {
      await client.request(`/api/v1/workers/${encodeURIComponent(config.workerId)}/heartbeat`, {
        generation,
        settingsVersion: client.settingsVersion,
        attemptId: active?.id,
        progressAt: active?.progressAt,
      });
      persistConnection();
    } catch (error) {
      lastError = String(error);
      registered = false;
      retryAt = Date.now() + 3000;
    }
  };
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (req.method !== 'GET' && origin && origin !== `http://${req.get('host')}`) {
      res.status(403).json({ error: 'Local origin required' });
      return;
    }
    next();
  });
  app.get('/api/local/status', (_req, res) => {
    const active = journal.active();
    res.json({
      workerId: config.workerId,
      name: config.name,
      roles: config.roles,
      generation,
      registered,
      browserReady,
      settingsVersion: client.settingsVersion,
      connection: client.connection,
      lastError,
      active: active
        ? {
            id: active.id,
            state: active.state,
            progressAt: active.progressAt,
            error: active.error,
            receipt: active.receipt,
          }
        : null,
      attempts: journal
        .recent()
        .map((a) => ({ id: a.id, state: a.state, progressAt: a.progressAt, error: a.error })),
      config: {
        managerUrl: config.managerUrl,
        name: config.name,
        roles: config.roles,
        headless: config.headless,
        cdpPort: config.cdpPort,
      },
    });
  });
  app.post('/api/local/start', (_req, res) => {
    res.status(202).json({ accepted: true, status: '/api/local/status' });
    void tick();
  });
  app.post('/api/local/pair', (req, res) => {
    if (typeof req.body.pairingToken !== 'string' || !req.body.pairingToken) {
      res.status(400).json({ error: 'pairingToken is required' });
      return;
    }
    pairingToken = req.body.pairingToken;
    journal.setSetting('pendingPair', { scope, generation, token: pairingToken });
    registered = false;
    retryAt = 0;
    res.status(202).json({ accepted: true });
    void tick();
  });
  app.post('/api/local/config', (req, res) => {
    const { managerUrl, name, roles } = req.body;
    if (
      typeof managerUrl !== 'string' ||
      !/^https?:$/.test(new URL(managerUrl).protocol) ||
      typeof name !== 'string' ||
      !Array.isArray(roles) ||
      !roles.length ||
      roles.some((r: any) => typeof r !== 'string' || !r)
    ) {
      res.status(400).json({ error: 'Provide managerUrl (http/https), name and nonempty roles[]' });
      return;
    }
    journal.setSetting('localConfig', { managerUrl, name, roles });
    res.json({ saved: true, restartRequired: true });
  });
  app.get('/api/local/attempts/:id', (req, res) => {
    const row = journal.get(req.params.id);
    if (!row) {
      res.sendStatus(404);
      return;
    }
    res.json(row);
  });
  app.get('/api/local/attempts/:id/result', (req, res) => {
    const row = journal.get(req.params.id);
    if (row?.result?.text === undefined) {
      res.status(202).json({ state: row?.state ?? 'unknown' });
      return;
    }
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(row.result.text);
  });
  app.use(express.static(resolve(dirname(fileURLToPath(import.meta.url)), 'public')));
  app.use(
    (error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(400).json({ error: String(error.message ?? error) });
    },
  );
  const server = createServer(app);
  await new Promise<void>((r, reject) => {
    server.once('error', reject);
    server.listen(config.uiPort, '127.0.0.1', r);
  });
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const pollTimer = setInterval(() => {
    void tick();
  }, options.tickMs ?? 1000);
  const heartTimer = setInterval(
    () => {
      void heartbeat();
    },
    Math.min(options.tickMs ?? 1000, 1000),
  );
  void tick();
  return {
    url,
    journal,
    agent,
    client,
    async close() {
      closed = true;
      clearInterval(pollTimer);
      clearInterval(heartTimer);
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      /* Waiting requests observe closed before touching durable storage. */ while (
        ticking ||
        connecting ||
        claiming
      )
        await new Promise((r) => setTimeout(r, 25));
      await driver.close();
      journal.close();
    },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startWorker(loadWorkerConfig())
    .then((runtime) => {
      console.log(`Agent Flow Worker status: ${runtime.url}`);
      let stopping = false;
      for (const signal of ['SIGINT', 'SIGTERM'] as const)
        process.on(signal, () => {
          if (stopping) return;
          stopping = true;
          void runtime.close().then(() => process.exit(0));
        });
    })
    .catch((error) => {
      console.error(String(error));
      process.exitCode = 1;
    });
}

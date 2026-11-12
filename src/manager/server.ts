import express, { type RequestHandler } from 'express';
import { createServer } from 'node:http';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { rename, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Engine, hash } from '../core/engine.js';
import { AppError } from '../core/settings.js';
import { mountEditor } from '../editor/index.js';

export interface ManagerOptions {
  dataDir: string;
  adminToken: string;
  pairingToken: string;
  editor?: boolean;
  engine?: Engine;
  tickMs?: number;
}
export async function createManager(options: ManagerOptions) {
  if (!options.adminToken || !options.pairingToken)
    throw new Error('Manager admin and pairing tokens required');
  const engine = options.engine ?? new Engine(options);
  const app = express();
  const server = createServer(app);
  server.requestTimeout = 0;
  app.disable('x-powered-by');
  const secureEqual = (a: string, b: string) => {
    const x = Buffer.from(hash(a)),
      y = Buffer.from(hash(b));
    return timingSafeEqual(x, y);
  };
  const bearer = (req: express.Request) =>
    req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
  const isAdmin = (req: express.Request) => {
    const token = bearer(req),
      cookie =
        req.headers.cookie
          ?.split(';')
          .map((x) => x.trim())
          .find((x) => x.startsWith('af_admin='))
          ?.slice(9) || '';
    return (
      (!!token && secureEqual(token, options.adminToken)) ||
      (!!cookie && secureEqual(cookie, options.adminToken))
    );
  };
  const authorize: RequestHandler = (req, res, next) => {
    if (!isAdmin(req)) {
      res.status(401).json({ error: 'Admin authentication required' });
      return;
    }
    next();
  };
  const workerAuth: RequestHandler = (req, res, next) => {
    const worker = engine.authenticateWorker(bearer(req));
    if (!worker) {
      res.status(401).json({ error: 'Worker authentication required' });
      return;
    }
    res.locals.worker = worker;
    next();
  };
  const owner: RequestHandler = (req, res, next) => {
    try {
      const a = engine.getAttempt(req.params.id);
      if (a.workerId !== res.locals.worker.id)
        throw new AppError('Attempt belongs to another worker', 403);
      res.locals.attempt = a;
      next();
    } catch (e) {
      next(e);
    }
  };
  const sameWorker: RequestHandler = (req, res, next) => {
    if (req.params.id !== res.locals.worker.id) {
      res.status(403).json({ error: 'Worker identity mismatch' });
      return;
    }
    next();
  };
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
      try {
        if (new URL(origin).host !== req.headers.host) {
          res.status(403).json({ error: 'Cross-origin mutation rejected' });
          return;
        }
      } catch {
        res.status(403).json({ error: 'Invalid origin' });
        return;
      }
    }
    next();
  });
  // Authenticate streamed uploads before allocating files; never JSON-buffer the Markdown output.
  app.put('/api/v1/attempts/:id/result', workerAuth, owner, async (req, res, next) => {
    let temp = '';
    let timer: NodeJS.Timeout | undefined;
    try {
      const digest = String(req.get('x-content-sha256') ?? '');
      if (!/^[a-f0-9]{64}$/.test(digest)) throw new AppError('Valid X-Content-SHA256 required');
      const status = req.query.status ?? 'complete';
      if (status !== 'complete' && status !== 'partial')
        throw new AppError('Invalid result status');
      const root = engine.artifactsDir;
      mkdirSync(root, { recursive: true });
      temp = join(root, `${randomUUID()}.upload`);
      const checksum = createHash('sha256');
      let bytes = 0;
      const deadline = engine.getSettings().connection.artifactTransferIdleSec * 1000;
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          checksum.update(chunk);
          bytes += chunk.length;
          clearTimeout(timer);
          timer = setTimeout(
            () => meter.destroy(new AppError('Artifact transfer idle timeout', 408)),
            deadline,
          );
          callback(null, chunk);
        },
      });
      timer = setTimeout(
        () => meter.destroy(new AppError('Artifact transfer idle timeout', 408)),
        deadline,
      );
      await pipeline(req, meter, createWriteStream(temp, { flags: 'wx', flush: true }));
      clearTimeout(timer);
      if (checksum.digest('hex') !== digest) throw new AppError('Artifact checksum mismatch');
      const path = join(root, `${digest}.md`);
      if (existsSync(path)) {
        if ((await stat(path)).size !== bytes)
          throw new AppError('Stored artifact integrity conflict', 409);
        await unlink(temp);
      } else await rename(temp, path);
      temp = '';
      let metadata = {};
      if (req.get('x-result-metadata')) {
        const encoded = req.get('x-result-metadata')!;
        if (encoded.length > 10000) throw new AppError('Use metadata endpoint for large metadata');
        metadata = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      }
      res.json(
        engine.completeArtifact(
          req.params.id,
          { id: digest, path, sha256: digest, byteLength: bytes },
          status,
          metadata,
        ),
      );
    } catch (error) {
      if (temp) await unlink(temp).catch(() => {});
      next(error);
    } finally {
      clearTimeout(timer);
    }
  });
  app.use('/api', express.json({ limit: '32mb' }));
  app.get('/health', (_req, res) => res.json({ status: 'ready', service: 'agent-flow-manager' }));
  app.post('/api/v1/login', (req, res) => {
    if (typeof req.body.token !== 'string' || !secureEqual(req.body.token, options.adminToken)) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }
    res.cookie('af_admin', options.adminToken, {
      httpOnly: true,
      sameSite: 'strict',
      secure: req.secure,
      path: '/',
      maxAge: 8 * 3600000,
    });
    res.json({ ok: true });
  });
  app.post('/api/v1/logout', (_req, res) => {
    res.clearCookie('af_admin');
    res.json({ ok: true });
  });
  app.get('/api/v1/settings', authorize, (_req, res) => res.json(engine.getSettings()));
  app.put('/api/v1/settings', authorize, (req, res, next) => {
    try {
      res.json(engine.updateSettings(req.body));
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/v1/snapshot', authorize, (_req, res) => res.json(engine.snapshot()));
  app.get('/api/v1/workflows', authorize, (_req, res) => res.json(engine.listWorkflows()));
  app.post('/api/v1/workflows', authorize, (req, res, next) => {
    try {
      res.json(engine.publish(req.body.definition ?? req.body));
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/v1/workflows/:id/runs', authorize, (req, res, next) => {
    try {
      res
        .status(202)
        .json(
          engine.startRun(req.params.id, req.body.input ?? '', {
            eventId: req.body.eventId,
            triggerId: req.body.triggerId,
          }),
        );
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/v1/runs', authorize, (_req, res) => res.json(engine.listRuns()));
  app.get('/api/v1/runs/:id', authorize, (req, res, next) => {
    try {
      res.json(engine.getRun(req.params.id));
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/v1/runs/:id/control', authorize, (req, res, next) => {
    try {
      res.json(engine.controlRun(req.params.id, req.body.action));
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/v1/attempts/:id/resolve', authorize, (req, res, next) => {
    try {
      res.json(engine.resolveAttempt(req.params.id, req.body.action, req.body.note));
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/v1/workers', authorize, (_req, res) => res.json(engine.listWorkers()));
  app.post('/api/v1/events', authorize, (req, res, next) => {
    try {
      res.status(202).json(engine.emitEvent(req.body));
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/v1/artifacts/:id', authorize, (req, res, next) => {
    try {
      const a = engine.store.get('artifact', req.params.id);
      if (!a) throw new AppError('Artifact not found', 404);
      const format = req.query.format ?? 'md';
      if (!['md', 'txt', 'json'].includes(String(format)))
        throw new AppError('Unknown output format');
      res.set('Content-Disposition', `attachment; filename="${a.id}.${format}"`);
      if (format === 'json') {
        const artifact = engine.getArtifact(a.id);
        res.json({
          artifactId: a.id,
          sha256: a.sha256,
          byteLength: a.byteLength,
          response: artifact.text,
        });
        return;
      }
      res.set(
        'Content-Type',
        format === 'txt' ? 'text/plain; charset=utf-8' : 'text/markdown; charset=utf-8',
      );
      res.set('ETag', `"${a.sha256}"`);
      res.sendFile(a.path);
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/v1/workers/register', (req, res, next) => {
    try {
      res.json(
        engine.registerWorker({ ...req.body, credential: req.body.credential || bearer(req) }),
      );
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/v1/workers/:id/heartbeat', workerAuth, sameWorker, (req, res, next) => {
    try {
      res.json(engine.heartbeat(req.params.id, req.body));
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/v1/workers/:id/claim', workerAuth, sameWorker, async (req, res, next) => {
    let closed = false;
    res.once('close', () => {
      closed = true;
    });
    try {
      const id = req.params.id,
        c = engine.getSettings(),
        wait = Math.max(
          0,
          Math.min(
            Number(req.body.waitSeconds ?? c.connection.longPollWaitSec),
            c.connection.longPollWaitSec,
          ),
        );
      if (!Number.isFinite(wait)) throw new AppError('Invalid waitSeconds');
      const until = Date.now() + wait * 1000;
      do {
        const attempt = engine.claim(id, req.body.generation);
        if (attempt || Date.now() >= until) {
          res.json({
            attempt,
            settingsVersion: c.version,
            connection: { ...c.connection, ...c.workerOverrides[id] },
          });
          return;
        }
        await new Promise((r) => setTimeout(r, Math.min(250, Math.max(1, until - Date.now()))));
      } while (!closed);
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/v1/attempts/:id/send-intent', workerAuth, owner, (req, res, next) => {
    try {
      res.json(engine.sendIntent(req.params.id, req.body));
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/v1/attempts/:id/events', workerAuth, owner, (req, res, next) => {
    try {
      res.json(engine.event(req.params.id, req.body));
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/v1/attempts/:id/metadata', workerAuth, owner, (req, res, next) => {
    try {
      engine.setAttemptMetadata(req.params.id, req.body.metadata ?? req.body);
      res.json({ accepted: true });
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/v1/attempts/:id', (req, res, next) => {
    try {
      const a = engine.getAttempt(req.params.id);
      if (!isAdmin(req)) {
        const w = engine.authenticateWorker(bearer(req));
        if (!w || a.workerId !== w.id) throw new AppError('Attempt access denied', 403);
      }
      const { prompt, ...safe } = a;
      res.json(safe);
    } catch (e) {
      next(e);
    }
  });
  const editor =
    options.editor === false
      ? undefined
      : await mountEditor({
          app,
          server,
          dataDir: options.dataDir,
          adminToken: options.adminToken,
          authorize,
          engine,
        });
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (!res.headersSent && !res.destroyed)
      res.status(err.status ?? 400).json({ error: err.message ?? 'Request failed' });
  });
  const ticker = setInterval(() => {
    try {
      engine.tick();
    } catch (e) {
      console.error('Scheduler error:', (e as Error).message);
    }
  }, options.tickMs ?? 250);
  ticker.unref();
  return {
    app,
    server,
    engine,
    start: (port = 6060, host = '0.0.0.0') =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          resolve();
        });
      }),
    close: async () => {
      clearInterval(ticker);
      await editor?.close();
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((r) => server.close(() => r()));
      engine.close();
    },
  };
}

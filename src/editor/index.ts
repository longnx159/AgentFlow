import express from 'express';
import type { Express, RequestHandler } from 'express';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { assertAllowedDraft, compileFlow } from './compiler.js';
import { draftGuard } from './guard.js';
const require = createRequire(import.meta.url);
export interface EditorOptions {
  app: Express;
  server: Server;
  dataDir: string;
  adminToken: string;
  authorize: RequestHandler;
  engine: { publish: (definition: any) => any };
}
export async function mountEditor({
  app,
  server,
  dataDir,
  adminToken,
  authorize,
  engine,
}: EditorOptions): Promise<{ close(): Promise<void> }> {
  const RED = require('node-red');
  const bcrypt = require('bcryptjs');
  const userDir = path.resolve(dataDir, 'editor');
  const nodesDir = path.join(userDir, 'passive-nodes');
  await mkdir(nodesDir, { recursive: true });
  await mkdir(path.join(userDir, 'empty-core', 'examples'), { recursive: true });
  // Bundled assets also resolve when TypeScript is compiled into dist/.
  const sourceRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const root = sourceRoot;
  for (const name of ['agent-flow.cjs', 'agent-flow.html'])
    await copyFile(path.join(root, 'src', 'editor', 'nodes', name), path.join(nodesDir, name));
  const storage = require('@node-red/runtime/lib/storage/localfilesystem');
  const guardedStorage = {
    ...storage,
    getFlows: async () => {
      const flows = await storage.getFlows();
      assertAllowedDraft(flows);
      return flows;
    },
    saveFlows: async (flows: any, user: any) => {
      assertAllowedDraft(flows);
      return storage.saveFlows(flows, user);
    },
  };
  // Fail closed before Node-RED can initialize any persisted graph.
  try {
    assertAllowedDraft(JSON.parse(await readFile(path.join(userDir, 'flows.json'), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  RED.init(server, {
    userDir,
    flowFile: 'flows.json',
    httpAdminRoot: '/flows',
    httpNodeRoot: false,
    coreNodesDir: path.join(userDir, 'empty-core'),
    nodesDir,
    nodesIncludes: ['agent-flow.cjs'],
    storageModule: guardedStorage,
    credentialSecret: false,
    disableEditor: false,
    adminAuth: {
      type: 'credentials',
      users: [{ username: 'admin', password: await bcrypt.hash(adminToken, 10), permissions: '*' }],
    },
    externalModules: {
      autoInstall: false,
      palette: { allowInstall: false, allowUpload: false, allowList: [], denyList: ['*'] },
      modules: { allowInstall: false },
    },
    editorTheme: {
      page: { title: 'Agent Flow · Bản nháp' },
      header: { title: 'Agent Flow · Bản nháp' },
      projects: { enabled: false },
      tours: false,
    },
    functionExternalModules: false,
    logging: { console: { level: 'warn', metrics: false, audit: false } },
  });
  const parser = express.json({ limit: '8mb' });
  app.use('/flows', authorize, parser, draftGuard, RED.httpAdmin);
  app.get('/api/v1/editor/drafts', authorize, async (_req, res) => {
    try {
      res.json(await RED.runtime.flows.getFlows({}));
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });
  app.post('/api/v1/editor/drafts', authorize, parser, async (req, res) => {
    try {
      assertAllowedDraft(req.body?.flows);
      const result = await RED.runtime.flows.setFlows({ flows: req.body, deploymentType: 'full' });
      res.json(result);
    } catch (error) {
      res
        .status((error as any).code === 'version_mismatch' ? 409 : 400)
        .json({ error: (error as Error).message });
    }
  });
  app.post('/api/v1/editor/publish', authorize, parser, async (req, res) => {
    try {
      if (typeof req.body?.tabId !== 'string') throw new Error('tabId is required');
      const snapshot = await RED.runtime.flows.getFlows({});
      if (req.body.revision !== undefined && req.body.revision !== snapshot.rev) {
        res.status(409).json({ error: 'Draft revision changed; refresh before publishing' });
        return;
      }
      const definition = compileFlow(snapshot.flows, req.body.tabId);
      res.json(await engine.publish(definition));
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });
  app.use(express.static(path.join(root, 'public'), { index: 'index.html' }));
  try {
    await RED.start();
  } catch (error) {
    await RED.stop().catch(() => {});
    throw error;
  }
  return {
    close: async () => {
      await RED.stop();
    },
  };
}

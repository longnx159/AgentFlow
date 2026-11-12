import type { RequestHandler } from 'express';
import { assertAllowedDraft } from './compiler.js';
export const draftGuard: RequestHandler = (req, res, next) => {
  try {
    const path = req.path.replace(/\/$/, '');
    if (req.method === 'POST' && path === '/flows') {
      if (req.get('Node-RED-Deployment-Type') === 'reload')
        throw new Error('Reload is disabled; deploy a validated draft');
      assertAllowedDraft(Array.isArray(req.body) ? req.body : req.body?.flows);
    }
    if (
      (req.method === 'POST' && path === '/flow') ||
      (req.method === 'PUT' && path.startsWith('/flow/'))
    ) {
      if (!req.body || !Array.isArray(req.body.nodes))
        throw new Error('Single flow requires a nodes array');
      assertAllowedDraft([...req.body.nodes, ...(req.body.configs ?? [])]);
      if (req.body.subflows?.length) throw new Error('Subflows are not allowed');
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && /^\/(nodes|plugins)(\/|$)/.test(path))
      throw new Error('Palette modification is disabled');
    next();
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
};

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createManager } from './server.js';
const dataDir = resolve(process.env.AF_MANAGER_DATA_DIR ?? 'data/manager');
mkdirSync(dataDir, { recursive: true });
const secretFile = join(dataDir, 'secrets.json');
const secrets = existsSync(secretFile)
  ? JSON.parse(readFileSync(secretFile, 'utf8'))
  : { adminToken: randomBytes(24).toString('hex'), pairingToken: randomBytes(24).toString('hex') };
if (process.env.AF_ADMIN_TOKEN) secrets.adminToken = process.env.AF_ADMIN_TOKEN;
if (process.env.AF_PAIRING_TOKEN) secrets.pairingToken = process.env.AF_PAIRING_TOKEN;
writeFileSync(secretFile, JSON.stringify(secrets, null, 2), { mode: 0o600, flush: true });
const manager = await createManager({
  dataDir,
  ...secrets,
  editor: process.env.AF_DISABLE_EDITOR !== '1',
});
const port = Number(process.env.PORT ?? 6060),
  host = process.env.AF_BIND_HOST ?? '0.0.0.0';
await manager.start(port, host);
console.log(
  `Agent Flow Manager: http://localhost:${port}\nNode-RED editor: http://localhost:${port}/flows\nAdmin username: admin\nAdmin token/password: ${secrets.adminToken}\nWorker pairing token: ${secrets.pairingToken}\nData: ${dataDir}`,
);
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await manager.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

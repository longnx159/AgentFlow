import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hostname } from 'node:os';
export interface WorkerConfig {
  managerUrl: string;
  workerId: string;
  name: string;
  roles: string[];
  pairingToken?: string;
  dataDir: string;
  profileDir?: string;
  headless: boolean;
  offscreen: boolean;
  chromePath?: string;
  cdpPort: number;
  uiPort: number;
}
export function loadWorkerConfig(
  env: Record<string, string | undefined> = process.env,
): WorkerConfig {
  const file = env.AF_WORKER_CONFIG
    ? JSON.parse(readFileSync(resolve(env.AF_WORKER_CONFIG), 'utf8'))
    : {};
  const value = (key: string, field: string, fallback: any) => env[key] ?? file[field] ?? fallback;
  const port = (key: string, field: string, fallback: number) => {
    const n = Number(value(key, field, fallback));
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw Error(`${key} must be a port number`);
    return n;
  };
  const bool = (key: string, field: string, fallback = false) =>
    ['true', '1', 'yes'].includes(String(value(key, field, fallback)).toLowerCase());
  const managerUrl = value('AF_MANAGER_URL', 'managerUrl', 'http://PCA:6060');
  if (!/^https?:$/.test(new URL(managerUrl).protocol))
    throw Error('AF_MANAGER_URL must use http or https');
  const rawRoles = value('AF_WORKER_ROLES', 'roles', ['default']);
  const roles = (Array.isArray(rawRoles) ? rawRoles : String(rawRoles).split(','))
    .map((r: string) => r.trim())
    .filter(Boolean);
  if (!roles.length) throw Error('AF_WORKER_ROLES must contain at least one role');
  return {
    managerUrl,
    workerId: value('AF_WORKER_ID', 'workerId', hostname()),
    name: value('AF_WORKER_NAME', 'name', hostname()),
    roles,
    pairingToken: value('AF_PAIRING_TOKEN', 'pairingToken', undefined),
    dataDir: resolve(value('AF_WORKER_DATA_DIR', 'dataDir', './data/worker')),
    profileDir: value('CHROME_USER_DATA_DIR', 'profileDir', undefined),
    headless: bool('HEADLESS', 'headless'),
    offscreen:
      bool('AF_CHROME_OFFSCREEN', 'offscreen') ||
      String(value('HEADLESS', 'headless', false)).toLowerCase() === 'offscreen',
    chromePath: value('CHROME_PATH', 'chromePath', undefined),
    cdpPort: port('CDP_PORT', 'cdpPort', 9223),
    uiPort: port('AF_WORKER_UI_PORT', 'uiPort', 6061),
  };
}

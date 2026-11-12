import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { randomUUID } from 'node:crypto';
const [workflowId, file] = process.argv.slice(2);
if (!workflowId || !file)
  throw new Error('Usage: npx tsx scripts/submit.ts WORKFLOW_ID input.txt|input.json');
const text = readFileSync(file, 'utf8');
const input = extname(file).toLowerCase() === '.json' ? JSON.parse(text) : text;
const base = process.env.AF_MANAGER_URL ?? 'http://localhost:6060',
  token = process.env.AF_ADMIN_TOKEN;
if (!token) throw new Error('Set AF_ADMIN_TOKEN to the Manager admin token');
const response = await fetch(
  new URL(`/api/v1/workflows/${encodeURIComponent(workflowId)}/runs`, base),
  {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ input, eventId: randomUUID() }),
  },
);
if (!response.ok) throw new Error(await response.text());
console.log(JSON.stringify(await response.json(), null, 2));

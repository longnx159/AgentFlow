import { cpSync, mkdirSync } from 'node:fs';
for (const source of ['public', 'examples', 'src/editor/nodes', 'src/worker/public']) {
  const destination = `dist/${source}`;
  mkdirSync(destination, { recursive: true });
  cpSync(source, destination, { recursive: true });
}

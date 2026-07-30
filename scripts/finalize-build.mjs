import { copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

copyFileSync(
  resolve(projectDirectory, 'src/index.esm.js'),
  resolve(projectDirectory, 'dist/index.mjs')
);

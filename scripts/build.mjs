import { build } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {typographyPlugin} from './typography-plugin.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Preserve earlier build files; no recursive emptying or cleaning.
await build({ root, configFile: false, plugins:[typographyPlugin(root)], build: { emptyOutDir: false, chunkSizeWarningLimit: 5000 },
  define: { 'process.env.IS_PREACT': 'false' } });

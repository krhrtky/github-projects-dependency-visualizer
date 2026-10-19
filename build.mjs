import { build } from 'vite';
import { mkdir, copyFile, rm } from 'node:fs/promises';
const watch = process.argv.includes('--watch');
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await copyFile('src/manifest.json', 'dist/manifest.json');
const base = { configFile: false, build: { outDir: 'dist', emptyOutDir: false, sourcemap: false, watch: watch ? {} : null } };
await build({ ...base, base: './', build: { ...base.build, rollupOptions: { input: 'src/popup/index.html' } } });
for (const name of ['background', 'content']) {
  await build({ ...base, build: { ...base.build, lib: { entry: `src/${name}/index.ts`, name: `Dependency${name}`, formats: ['iife'], fileName: () => `${name}.js` }, rollupOptions: { output: { inlineDynamicImports: true } } } });
}

import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8'));
const version = packageJson.version;

if (!/^\d+\.\d+\.\d+$/.test(version) || manifest.version !== version || manifest.manifest_version !== 3) {
  throw new Error('package.json and the built MV3 manifest must have the same numeric version.');
}
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${version}`) {
  throw new Error('The release tag must equal v followed by the extension version.');
}
if (!(await lstat(dist)).isDirectory()) throw new Error('dist must be a regular directory.');

async function filesIn(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async entry => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return filesIn(join(directory, entry.name), relative);
    if (!entry.isFile()) throw new Error(`Only regular files can be packaged: ${relative}`);
    return [relative];
  }))).flat();
}

const files = (await filesIn(dist)).sort();
const allowed = /^(?:manifest\.json|background\.js|content\.js|src\/popup\/index\.html|assets\/[A-Za-z0-9_-]+\.(?:js|css))$/;
const credential = /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/;
for (const file of files) {
  if (!allowed.test(file)) throw new Error(`Unexpected extension file: ${file}`);
  if (credential.test(await readFile(join(dist, file), 'utf8'))) {
    throw new Error(`A possible GitHub credential was found in: ${file}`);
  }
}
const required = [
  'manifest.json',
  'background.js',
  'content.js',
  'src/popup/index.html',
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...(manifest.content_scripts ?? []).flatMap(script => [...(script.js ?? []), ...(script.css ?? [])]),
];
for (const file of required) {
  if (typeof file !== 'string' || !files.includes(file)) throw new Error(`Missing extension file: ${file}`);
}

const outputDirectory = join(root, 'release');
const name = `github-projects-dependency-visualizer-${version}-chrome.zip`;
const archive = join(outputDirectory, name);
await mkdir(outputDirectory, { recursive: true });
await rm(archive, { force: true });
const zipped = spawnSync('zip', ['-X', '-q', archive, '-@'], { cwd: dist, input: `${files.join('\n')}\n`, encoding: 'utf8' });
if (zipped.error) throw new Error('The zip command is required (available on macOS and Ubuntu).', { cause: zipped.error });
if (zipped.status !== 0) throw new Error(`zip failed: ${zipped.stderr}`);
const checksum = createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(`${archive}.sha256`, `${checksum}  ${name}\n`);
console.log(`Packaged ${files.length} extension files: release/${name}`);

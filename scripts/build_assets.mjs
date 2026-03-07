import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const targets = [
  { entry: 'static/js/index-app.js', out: 'static/js/index-app.min.js' },
  { entry: 'static/js/study.js', out: 'static/js/study.min.js' },
  { entry: 'static/js/admin.js', out: 'static/js/admin.min.js' },
];

const checkMode = process.argv.includes('--check');

async function buildTarget(target, writeOutput) {
  return build({
    entryPoints: [path.join(projectRoot, target.entry)],
    outfile: path.join(projectRoot, target.out),
    bundle: false,
    minify: true,
    legalComments: 'none',
    sourcemap: false,
    target: ['es2018'],
    write: writeOutput,
  });
}

async function isTargetCurrent(target) {
  const result = await buildTarget(target, false);
  const generated = result.outputFiles && result.outputFiles[0] ? Buffer.from(result.outputFiles[0].contents) : Buffer.alloc(0);
  try {
    const existing = await readFile(path.join(projectRoot, target.out));
    return Buffer.compare(existing, generated) === 0;
  } catch (_error) {
    return false;
  }
}

if (checkMode) {
  const staleTargets = [];
  for (const target of targets) {
    const current = await isTargetCurrent(target);
    if (!current) {
      staleTargets.push(target.out);
    }
  }
  if (staleTargets.length) {
    console.error('Generated assets are stale:', staleTargets.join(', '));
    process.exit(1);
  }
  console.log('Generated assets are up to date:', targets.map((target) => target.out).join(', '));
  process.exit(0);
}

for (const target of targets) {
  await buildTarget(target, true);
}

console.log('Minified assets generated:', targets.map((t) => t.out).join(', '));

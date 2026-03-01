import { build } from 'esbuild';
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

for (const target of targets) {
  await build({
    entryPoints: [path.join(projectRoot, target.entry)],
    outfile: path.join(projectRoot, target.out),
    bundle: false,
    minify: true,
    legalComments: 'none',
    sourcemap: false,
    target: ['es2018'],
  });
}

console.log('Minified assets generated:', targets.map((t) => t.out).join(', '));

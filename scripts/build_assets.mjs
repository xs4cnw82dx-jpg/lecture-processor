import { build } from 'esbuild';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const targets = [
  { entry: 'static/js/dashboard.js', out: 'static/js/dashboard.min.js' },
  { entry: 'static/js/batch-dashboard.js', out: 'static/js/batch-dashboard.min.js' },
  { entry: 'static/js/batch-mode.js', out: 'static/js/batch-mode.min.js' },
  { entry: 'static/js/buy-credits.js', out: 'static/js/buy-credits.min.js' },
  { entry: 'static/js/index-app.js', out: 'static/js/index-app.min.js' },
  { entry: 'static/js/index-results-utils.js', out: 'static/js/index-results-utils.min.js' },
  { entry: 'static/js/admin.js', out: 'static/js/admin.min.js' },
  { entry: 'static/js/physio.js', out: 'static/js/physio.min.js' },
  { entry: 'static/js/reader.js', out: 'static/js/reader.min.js' },
  { entry: 'static/js/shared-study.js', out: 'static/js/shared-study.min.js' },
  { entry: 'static/js/study-api-utils.js', out: 'static/js/study-api-utils.min.js' },
  { entry: 'static/js/study.js', out: 'static/js/study.min.js' },
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

async function listTemplateFiles() {
  const templatesDir = path.join(projectRoot, 'templates');
  const entries = await readdir(templatesDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => path.join(templatesDir, entry.name));
}

async function getExternalScriptsMissingIntegrity() {
  const templateFiles = await listTemplateFiles();
  const missing = [];
  const scriptPattern = /<script\b[^>]*\bsrc="https?:\/\/[^"]+"[^>]*>/gi;
  for (const filePath of templateFiles) {
    const content = await readFile(filePath, 'utf8');
    const matches = content.match(scriptPattern) || [];
    for (const tag of matches) {
      if (!/\bintegrity="/i.test(tag)) {
        missing.push(path.relative(projectRoot, filePath));
        break;
      }
    }
  }
  return missing;
}

async function verifyTemplateScriptIntegrity() {
  const missing = await getExternalScriptsMissingIntegrity();
  if (!missing.length) return;
  console.error('External script tags missing integrity:', missing.join(', '));
  process.exit(1);
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
  await verifyTemplateScriptIntegrity();
  console.log('Generated assets are up to date:', targets.map((target) => target.out).join(', '));
  process.exit(0);
}

for (const target of targets) {
  await buildTarget(target, true);
}

await verifyTemplateScriptIntegrity();
console.log('Minified assets generated:', targets.map((t) => t.out).join(', '));

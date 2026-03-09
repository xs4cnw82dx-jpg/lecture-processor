import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const sourcePath = path.join(projectRoot, 'config', 'allowed_email_domains.json');
const targetPath = path.join(projectRoot, 'functions', 'allowed_email_domains.json');

function normalizeAllowlist(raw) {
  const parsed = JSON.parse(String(raw || '{}'));
  return JSON.stringify(parsed, null, 2) + '\n';
}

const canonicalRaw = await readFile(sourcePath, 'utf8');
const normalized = normalizeAllowlist(canonicalRaw);

await mkdir(path.dirname(targetPath), { recursive: true });

let current = '';
try {
  current = await readFile(targetPath, 'utf8');
} catch (_) { }

if (current !== normalized) {
  await writeFile(targetPath, normalized, 'utf8');
  console.log('Synced functions allowlist config from config/allowed_email_domains.json');
} else {
  console.log('Functions allowlist config is already in sync');
}

import { readFile, access, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const versions = JSON.parse(await readFile(path.join(root, 'versions.json'), 'utf8'));
const failures = [];
const requireTrue = (condition, message) => { if (!condition) failures.push(message); };

requireTrue(/^[a-z0-9-]+$/.test(manifest.id), 'manifest id must be lowercase alphanumeric/dashes');
requireTrue(!manifest.id.includes('obsidian') && !manifest.id.endsWith('-plugin'), 'manifest id contains a forbidden term');
requireTrue(!/obsidian/i.test(manifest.name), 'manifest name must not contain Obsidian');
requireTrue(!/obsidian/i.test(manifest.description), 'manifest description must not contain Obsidian');
requireTrue(/[.!?)]$/.test(manifest.description), 'manifest description must end with punctuation');
requireTrue(manifest.isDesktopOnly === false, 'plugin must support mobile');
requireTrue(/^\d+\.\d+\.\d+$/.test(manifest.version), 'manifest version must be exact semver');
requireTrue(pkg.version === manifest.version, 'package and manifest versions differ');
requireTrue(versions[manifest.version] === manifest.minAppVersion, 'versions.json does not match manifest');
for (const file of ['README.md', 'LICENSE', 'SECURITY.md', 'main.js', 'styles.css']) {
  try { await access(path.join(root, file)); } catch { failures.push(`${file} is missing`); }
}
const readme = await readFile(path.join(root, 'README.md'), 'utf8').catch(() => '');
if (manifest.version.startsWith('0.')) {
  requireTrue(readme.includes(`**Community review release:** \`${manifest.version}\``), 'README review-release version does not match manifest');
}
const sourceFiles = (await walk(root)).filter((file) => file !== import.meta.filename && !file.includes(`${path.sep}node_modules${path.sep}`) && !file.includes(`${path.sep}.git${path.sep}`));
for (const file of sourceFiles) {
  if (/\.(?:ts|js|mjs|json|md|yml|yaml)$/.test(file)) {
    const text = await readFile(file, 'utf8');
    requireTrue(!/\b(?:TODO|FIXME|HACK)\b/.test(text), `${path.relative(root, file)} contains an unfinished marker`);
    requireTrue(!/(?:Bearer\s+[A-Za-z0-9._~+/-]{24,}|gh[opurs]_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,})/.test(text), `${path.relative(root, file)} may contain a secret`);
  }
}
const bundle = await readFile(path.join(root, 'main.js'), 'utf8').catch(() => '');
const styles = await readFile(path.join(root, 'styles.css'), 'utf8').catch(() => '');
requireTrue(bundle.includes(`central-vault-sync release: ${manifest.version}`), 'bundle release marker does not match manifest');
requireTrue(styles.startsWith(`/* central-vault-sync release: ${manifest.version} */\n`), 'stylesheet release marker does not match manifest');
requireTrue(!/(?:node:|child_process|electron|require\(["'](?:fs|path|os))/.test(bundle), 'bundle contains a desktop/Node-only API');
requireTrue(!/\beval\s*\(/.test(bundle), 'bundle contains eval');
requireTrue(Buffer.byteLength(bundle) < 2 * 1024 * 1024, 'bundle exceeds 2 MiB');
if (!manifest.version.startsWith('0.')) {
  requireTrue(pkg.dependencies['@picassio/sync-core'] === manifest.version, 'stable plugin must use the matching public sync-core package');
}
if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'));
  process.exitCode = 1;
} else console.log(`Plugin policy checks passed (${sourceFiles.length} files scanned)`);

async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(file));
    else result.push(file);
  }
  return result;
}

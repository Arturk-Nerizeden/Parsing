import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { zipSync } from 'fflate';
const root = 'dist';
const files = {};
function walk(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, item.name);
    if (item.isDirectory()) walk(full);
    else files[relative(root, full).replaceAll('\\', '/')] = new Uint8Array(readFileSync(full));
  }
}
walk(root);
mkdirSync('release', { recursive: true });
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const target = `release/web3-audience-explorer-v${version}.zip`;
writeFileSync(target, zipSync(files, { level: 6 }));
console.log(target);

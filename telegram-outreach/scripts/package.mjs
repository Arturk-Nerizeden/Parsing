import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { zipSync } from 'fflate';
const files = {};
function collect(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) collect(path);
    else files[relative('dist', path).replaceAll('\\', '/')] = new Uint8Array(readFileSync(path));
  }
}
collect('dist');
mkdirSync('release', { recursive: true });
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const path = `release/telegram-outreach-v${version}.zip`;
writeFileSync(path, zipSync(files, { level: 6 }));
console.log(path);

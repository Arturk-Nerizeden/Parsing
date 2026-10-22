import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const root = 'dist';
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) throw new Error('Manifest V3 required');
if (manifest.host_permissions?.join(',') !== 'https://api.sorsa.io/*') throw new Error('API host permission must stay scoped');
if (manifest.permissions?.join(',') !== 'storage,webRequest') throw new Error('Unexpected extension permission');
if (!existsSync(join(root, manifest.background.service_worker))) throw new Error('Missing background script');
if (!existsSync(join(root, 'dashboard.html'))) throw new Error('Missing dashboard');
const html = readFileSync(join(root, 'dashboard.html'), 'utf8');
for (const [, asset] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  if (/^(https?:|data:)/.test(asset)) throw new Error('Remote assets are not permitted');
  if (!existsSync(join(root, asset.replace(/^\.\//, '')))) throw new Error(`Missing bundled asset: ${asset}`);
}
if (/api.?key|apikey/i.test(readFileSync(join(root, 'background.js'), 'utf8'))) {
  throw new Error('Background worker unexpectedly references API keys');
}
console.log('Manifest V3, scoped permissions and bundled files verified.');

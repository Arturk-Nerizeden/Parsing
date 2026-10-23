import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'acorn';

const dist = 'dist';
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3 || manifest.version !== '1.0.0') throw new Error('Invalid MV3 manifest/version.');
if (manifest.permissions?.join(',') !== 'storage') throw new Error('Unexpected browser permissions.');
if (manifest.host_permissions?.join(',') !== 'https://*.web.telegram.org/*') throw new Error('Telegram host permission changed.');
if (!manifest.content_security_policy?.extension_pages?.includes("'wasm-unsafe-eval'")) throw new Error('Bundled Telegram WASM cannot start under CSP.');
if (!existsSync(join(dist, 'dashboard.html')) || !existsSync(join(dist, manifest.background.service_worker))) throw new Error('Missing extension entry point.');
const html = readFileSync(join(dist, 'dashboard.html'), 'utf8');
for (const [, asset] of html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/g)) {
  if (/^(https?:|data:)/i.test(asset)) throw new Error('Remote executable/asset in dashboard.');
  if (!existsSync(join(dist, asset.replace(/^\.?\//, '')))) throw new Error(`Missing bundled asset: ${asset}`);
}
const assets = readdirSync(join(dist, 'assets'));
if (!assets.some(name => name.endsWith('.wasm'))) throw new Error('Telegram cryptography WASM was not bundled.');
let checked = 0;
for (const filename of ['dashboard.js', 'background.js', ...assets.filter(name => name.endsWith('.js')).map(name => `assets/${name}`)]) {
  const source = readFileSync(join(dist, filename), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const stack = [ast];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    if ((current.type === 'CallExpression' && current.callee?.type === 'Identifier' && current.callee.name === 'eval') ||
      (current.type === 'NewExpression' && current.callee?.type === 'Identifier' && current.callee.name === 'Function')) {
      throw new Error(`Extension CSP forbids dynamic JavaScript in ${filename}.`);
    }
    for (const value of Object.values(current)) {
      if (Array.isArray(value)) stack.push(...value);
      else if (value && typeof value === 'object') stack.push(value);
    }
  }
  checked += 1;
}
console.log(`Manifest V3, local WASM/assets and ${checked} JavaScript bundles verified.`);

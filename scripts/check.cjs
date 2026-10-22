const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../extension');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.permissions, ['activeTab', 'storage', 'clipboardWrite']);
for (const script of manifest.content_scripts) {
  assert.deepEqual(script.matches, ['https://web.telegram.org/*']);
  for (const file of script.js) assert.ok(fs.existsSync(path.join(root, file)), file);
}
for (const file of fs.readdirSync(root).filter(f => f.endsWith('.js'))) {
  new vm.Script(fs.readFileSync(path.join(root, file), 'utf8'), { filename: file });
}
assert.ok(fs.existsSync(path.join(root, manifest.action.default_popup)));
console.log('Manifest, script syntax, file references and scoped permissions OK.');

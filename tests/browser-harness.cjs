// Browser integration harness for environments where administrator policy blocks
// installing extensions. It runs the real content files in a CDP isolated world,
// the real bridge in the page world, and the real worker in a VM with Chrome API doubles.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../extension');
const source = name => fs.readFileSync(path.join(root, name), 'utf8');
function background() {
  const storage = {};
  let listener;
  const api = {
    async get(keys) {
      if (keys === null) return structuredClone(storage);
      return structuredClone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in storage).map(k => [k, storage[k]])));
    },
    async set(items) { Object.assign(storage, structuredClone(items)); },
    async remove(keys) { for (const key of keys) delete storage[key]; }
  };
  vm.runInNewContext(source('background.js'), {
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } }, storage: { local: api } },
    console, Promise, Date
  });
  return { storage: api, dispatch(message, id) {
    return new Promise(resolve => listener(structuredClone(message), { tab: { id }, url: 'https://web.telegram.org/k/' }, answer => resolve(structuredClone(answer))));
  } };
}
async function attach(page, id, bg) {
  const cdp = await page.context().newCDPSession(page);
  const frame = (await cdp.send('Page.getFrameTree')).frameTree.frame.id;
  const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: frame, worldName: 'collector-test-isolated' });
  const evaluate = async expression => {
    const result = await cdp.send('Runtime.evaluate', { expression, contextId: executionContextId, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  await cdp.send('Runtime.addBinding', { name: '__sendToBackground', executionContextId });
  cdp.on('Runtime.bindingCalled', async event => {
    if (event.name !== '__sendToBackground' || event.executionContextId !== executionContextId) return;
    const { requestId, message } = JSON.parse(event.payload);
    const response = await bg.dispatch(message, id);
    try { await evaluate(`__deliver(${JSON.stringify(requestId)}, ${JSON.stringify(response)})`); } catch { /* Navigated. */ }
  });
  await evaluate(`
    globalThis.__pending = new Map();
    globalThis.__deliver = (id, result) => { __pending.get(id)?.(result); __pending.delete(id); };
    globalThis.chrome = {runtime: {id: 'collector-test',
      sendMessage(message) { return new Promise(resolve => { const requestId = crypto.randomUUID(); __pending.set(requestId, resolve); __sendToBackground(JSON.stringify({requestId,message})); }); },
      onMessage: {addListener(fn) { globalThis.__runtimeListener = fn; }}
    }};
  `);
  await page.addScriptTag({ content: source('bridge.js') });
  for (const file of ['core.js', 'adapters.js', 'content.js']) await evaluate(source(file));
  return { evaluate, send(action, options) {
    return evaluate(`new Promise(resolve => __runtimeListener(${JSON.stringify({ type: `collector:${action}`, options })}, {id: 'collector-test'}, resolve))`);
  } };
}
module.exports = { background, attach, source };

// 仅用于明确启用 fixture CDP 的调试版客户端；不启动另一台游戏服务器。
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at < 0 ? fallback : args[at + 1];
};
const port = Number(arg('port', '19389'));
const mode = arg('mode', 'inspect');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CDP端口无效');
let page;
for (let i = 0; i < 60; i++) {
  try {
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    page = pages.find(p => p.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(p.url) && !p.url.includes('/__bootstrap/'));
    if (page) break;
  } catch (_) { /* WebView未就绪；等待具体页面出现 */ }
  await new Promise(resolve => setTimeout(resolve, 250));
}
if (!page) throw new Error('实际客户端WebView未在15秒内出现');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let nextId = 0;
const pending = new Map();
const events = [];
socket.onmessage = event => {
  const data = JSON.parse(event.data);
  if (data.id && pending.has(data.id)) {
    const { resolve, reject, timer } = pending.get(data.id);
    pending.delete(data.id); clearTimeout(timer);
    if (data.error) reject(new Error(JSON.stringify(data.error))); else resolve(data.result);
  } else if (['Runtime.exceptionThrown', 'Log.entryAdded', 'Network.loadingFailed'].includes(data.method)) {
    events.push(data);
  }
};
function send(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP超时: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}
try {
  await send('Runtime.enable'); await send('Log.enable'); await send('Network.enable');
  let value;
  if (mode === 'save') {
    value = await evaluate(`(async () => {
      document.querySelector('#save').click();
      await window.__ASHFALL_BRIDGE__.flush();
      return { revision: window.__ASHFALL_BRIDGE__.getRevision(), dirty: window.__ASHFALL_BRIDGE__.isDirty(), stored: localStorage.getItem('ashfall-probe'), text: document.querySelector('#result').textContent };
    })()`);
  } else if (mode === 'storage') {
    value = await evaluate(`(async () => {
      const bridge = window.__ASHFALL_BRIDGE__;
      await bridge.flush();
      const before = bridge.getRevision();
      sessionStorage.setItem('session-only-probe', 'not persisted');
      const sessionUnchanged = bridge.isDirty() === false;
      localStorage.setItem('probe-dynamic-uuid-123', '胶囊');
      localStorage.setItem('probe-pointer', 'probe-dynamic-uuid-123');
      localStorage.setItem('__proto__', '原型键');
      await bridge.flush();
      localStorage.removeItem('probe-pointer');
      await bridge.flush();
      return { before, after: bridge.getRevision(), sessionUnchanged, symbolKeys: Object.getOwnPropertySymbols(localStorage).length, protoValue: localStorage.getItem('__proto__'), dirty: bridge.isDirty() };
    })()`);
  } else if (mode === 'eval') {
    value = await evaluate(arg('expression', 'document.title'));
  } else if (mode === 'inspect') {
    value = await evaluate(`({ title: document.title, origin: location.origin, ready: document.readyState, hasBridge: !!window.__ASHFALL_BRIDGE__, revision: window.__ASHFALL_BRIDGE__?.getRevision(), savedProbe: localStorage.getItem('ashfall-probe'), body: document.body.innerText })`);
  } else if (mode === 'screenshot') {
    const path = resolve(arg('out', 'target/validation/fixture.png'));
    await mkdir(dirname(path), { recursive: true });
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path, Buffer.from(screenshot.data, 'base64'));
    value = { screenshot: path };
  } else {
    throw new Error(`未知模式 ${mode}`);
  }
  const result = JSON.stringify({ mode, value, events }, null, 2).replace(/\/__bootstrap\/[0-9a-f]+/g, '/__bootstrap/[REDACTED]');
  console.log(result);
  const out = arg('report', null);
  if (out) { const path = resolve(out); await mkdir(dirname(path), { recursive: true }); await writeFile(path, result); }
} finally {
  for (const { timer } of pending.values()) clearTimeout(timer);
  socket.close();
}

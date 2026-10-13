import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function install() {
  const fetchCalls = [], beaconCalls = [], openCalls = [], events = new Map(), styles = [];
  class Element { closest() { return this.anchor; } }
  const window = {
    fetch: async (...args) => { fetchCalls.push(args); return { ok: true }; },
    open: (...args) => { openCalls.push(args); return 'native-window'; },
  };
  const navigator = { sendBeacon: (...args) => { beaconCalls.push(args); return true; } };
  const context = vm.createContext({ window, navigator, Element, URL,
    location: { href: 'http://127.0.0.1:1234/index.html', origin: 'http://127.0.0.1:1234' },
    document: { addEventListener: (type, fn) => events.set(type, fn), createElement: tag => ({ tagName: tag }), head: { appendChild: el => styles.push(el) } },
  });
  vm.runInContext(fs.readFileSync(new URL('./offline-gate.js', import.meta.url), 'utf8'), context);
  return { window, navigator, fetchCalls, beaconCalls, openCalls, events, Element, styles };
}

test('只关闭已确认localhost开发预设和开发工具栏入口', () => {
  const s = install();
  assert.equal(s.styles.length, 1);
  assert.equal(s.styles[0].tagName, 'style');
  assert.equal(s.styles[0].textContent, '.dev-presets,.dev-strip{display:none!important;pointer-events:none!important}');
});

test('本地资源fetch保留原调用；在线服务拒绝且不伪造成功', async () => {
  const s = install();
  const options = { headers: { Range: 'bytes=0-99' } };
  assert.equal((await s.window.fetch('/assets/music.ogg', options)).ok, true);
  assert.equal(s.fetchCalls[0][1], options);
  await assert.rejects(s.window.fetch('/api/feedback'), /本地版/);
  await assert.rejects(s.window.fetch('https://example.org/tracker'), /本地版/);
  await assert.rejects(s.window.fetch('http://127.0.0.1:1235/other'), /本地版/);
  assert.equal(s.fetchCalls.length, 1);
  assert.equal(s.window.__ASHFALL_OFFLINE__, true);
});

test('Request形态与URL实例可加载本地资源；beacon不可报告在线成功', async () => {
  const s = install();
  await s.window.fetch({ url: 'http://127.0.0.1:1234/assets/model.glb' });
  await s.window.fetch(new URL('http://127.0.0.1:1234/assets/model.glb'));
  assert.equal(s.fetchCalls.length, 2);
  assert.equal(s.navigator.sendBeacon('/api/events', 'metrics'), false);
  assert.equal(s.navigator.sendBeacon('https://example.org/events', 'metrics'), false);
  assert.equal(s.beaconCalls.length, 0);
});

test('外部弹出窗口和外部链接阻断；本地锚点保持默认行为', () => {
  const s = install();
  assert.equal(s.window.open('https://example.org/'), null);
  assert.equal(s.openCalls.length, 0);
  const element = new s.Element();
  element.anchor = { href: 'https://example.org/' };
  let prevented = false;
  s.events.get('click')({ target: element, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(element.anchor.title, '本地版不打开外部链接');
  element.anchor.href = 'http://127.0.0.1:1234/index.html#credits';
  prevented = false;
  s.events.get('click')({ target: element, preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
});

import test, { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { discoverRefs, checkedUrl, snapshot, parseAssetMap } from './snapshot.mjs';

function createGlbFixture(jsonChunkObj) {
  const jsonStr = JSON.stringify(jsonChunkObj);
  const jsonBuf = Buffer.from(jsonStr, 'utf-8');
  // GLB chunk must be 4-byte aligned, pad with spaces (0x20)
  const paddingLen = (4 - (jsonBuf.length % 4)) % 4;
  const paddedJsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(paddingLen, 0x20)]);

  const header = Buffer.alloc(12);
  header.write('glTF', 0, 4, 'ascii'); // magic
  header.writeUInt32LE(2, 4); // version = 2
  const totalLength = 12 + 8 + paddedJsonBuf.length;
  header.writeUInt32LE(totalLength, 8); // total length

  const chunkHeader = Buffer.alloc(8);
  chunkHeader.writeUInt32LE(paddedJsonBuf.length, 0); // chunk length
  chunkHeader.write('JSON', 4, 4, 'ascii'); // chunk type (0x4E4F534A)

  return Buffer.concat([header, chunkHeader, paddedJsonBuf]);
}

describe('discoverRefs 引用发现', () => {
  it('收集 JS 中的静态/动态模块、Worker、资源映射和引号资产', () => {
    const code = `
      import "./static.js";
      import { foo } from "./named.js";
      export * from "./exported.js";
      const lazy = import("./lazy.js");
      const worker = new Worker(new URL("./worker.js", import.meta.url));
      const assetMap = {
        model: "/assets/models/battlecruiser.glb",
        sound: "assets/audio/laser.ogg",
        texture: "./textures/metal.png"
      };
    `;
    const refs = discoverRefs(code, 'js');
    assert.ok(refs.includes('./static.js'));
    assert.ok(refs.includes('./named.js'));
    assert.ok(refs.includes('./exported.js'));
    assert.ok(refs.includes('./lazy.js'));
    assert.ok(refs.includes('./worker.js'));
    assert.ok(refs.includes('/assets/models/battlecruiser.glb'));
    assert.ok(refs.includes('assets/audio/laser.ogg'));
    assert.ok(refs.includes('./textures/metal.png'));
  });

  it('真实Vite静态反引号new URL媒体可发现，动态插值模板不猜路径', () => {
    const code = 'const p=new URL(`/assets/terran-emblem-DcrhIktm.png`,``+import.meta.url).href; const dynamic=`/assets/${key}.png`; e.icon.replace(`/junker.webp`,`/`+hull+`.webp`);';
    const refs = discoverRefs(code, 'js', { hasAssetMap: true });
    assert.ok(refs.includes('/assets/terran-emblem-DcrhIktm.png'));
    assert.ok(!refs.includes('/junker.webp'));
    assert.ok(!refs.some(ref => ref.includes('${')));
  });

  it('排除 UI accept 模式（如 image/*,.png）与含逗号/通配符的伪引用', () => {
    const code = `
      const input = document.createElement('input');
      input.accept = 'image/*,.png';
      const pattern = '*.glb,*.png';
      const file = '/valid/sprite.png';
    `;
    const refs = discoverRefs(code, 'js');
    assert.ok(refs.includes('/valid/sprite.png'));
    assert.ok(!refs.includes('image/*,.png'));
    assert.ok(!refs.includes('*.glb,*.png'));
    assert.ok(!refs.some(r => r.includes('*') || r.includes(',')));
  });

  it('收集 HTML 中的 src、href 及内联样式/脚本引用', () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <link rel="stylesheet" href="/style.css">
          <link rel="icon" href="/favicon.ico">
          <style>
            .bg { background: url("./bg.png"); }
          </style>
        </head>
        <body>
          <script type="module" src="/main.js"></script>
          <img src="./hero.webp" />
          <script>
            import("./inline-lazy.js");
          </script>
        </body>
      </html>
    `;
    const refs = discoverRefs(html, 'html');
    assert.ok(refs.includes('/style.css'));
    assert.ok(refs.includes('/favicon.ico'));
    assert.ok(refs.includes('./bg.png'));
    assert.ok(refs.includes('/main.js'));
    assert.ok(refs.includes('./hero.webp'));
    assert.ok(refs.includes('./inline-lazy.js'));
  });

  it('收集 CSS 中的 url() 与 @import', () => {
    const css = `
      @import url("fonts.css");
      @import 'theme.css';
      body {
        background-image: url('images/stars.png');
        cursor: url(cursors/pointer.png), auto;
      }
    `;
    const refs = discoverRefs(css, 'css');
    assert.ok(refs.includes('fonts.css'));
    assert.ok(refs.includes('theme.css'));
    assert.ok(refs.includes('images/stars.png'));
    assert.ok(refs.includes('cursors/pointer.png'));
  });

  it('收集 JSON 映射中的资源路径字符串', () => {
    const jsonStr = JSON.stringify({
      version: 1,
      items: [
        { id: 1, uri: "/assets/ship.glb" },
        { id: 2, file: "./sounds/explode.ogg" }
      ],
      meta: {
        banner: "textures/banner.webp",
        unrelated: "just-a-plain-string"
      }
    });
    const refs = discoverRefs(jsonStr, 'json');
    assert.ok(refs.includes('/assets/ship.glb'));
    assert.ok(refs.includes('./sounds/explode.ogg'));
    assert.ok(refs.includes('textures/banner.webp'));
    assert.ok(!refs.includes('just-a-plain-string'));
  });

  it('收集 GLB 中的外部 buffers 和 images uri', () => {
    const glbBuffer = createGlbFixture({
      asset: { version: '2.0' },
      buffers: [
        { uri: 'marine_mesh.bin', byteLength: 1024 },
        { uri: 'data:application/octet-stream;base64,AAAA', byteLength: 4 }
      ],
      images: [
        { uri: 'marine_diffuse.png' }
      ]
    });
    const refs = discoverRefs(glbBuffer, 'glb');
    assert.ok(refs.includes('marine_mesh.bin'));
    assert.ok(refs.includes('marine_diffuse.png'));
    assert.ok(!refs.includes('data:application/octet-stream;base64,AAAA'));
  });
});

describe('checkedUrl 安全与同源校验', () => {
  const base = 'https://starcraft-shooter-2026.pages.dev/app/index.html';

  it('解析相对与绝对同源 URL', () => {
    const url1 = checkedUrl('./game.js', base);
    assert.equal(url1.href, 'https://starcraft-shooter-2026.pages.dev/app/game.js');

    const url2 = checkedUrl('/assets/style.css', base);
    assert.equal(url2.href, 'https://starcraft-shooter-2026.pages.dev/assets/style.css');
  });

  it('拒绝跨源 URL（不同 host、不同 scheme、不同 port）', () => {
    assert.throws(() => checkedUrl('https://example.org/x', base), /cross-origin/i);
    assert.throws(() => checkedUrl('http://starcraft-shooter-2026.pages.dev/x', base), /cross-origin|scheme/i);
    assert.throws(() => checkedUrl('https://starcraft-shooter-2026.pages.dev:8080/x', base), /cross-origin|port/i);
  });

  it('拒绝 userinfo', () => {
    assert.throws(() => checkedUrl('https://admin:pass@starcraft-shooter-2026.pages.dev/x', base), /userinfo/i);
  });

  it('拒绝路径穿越 ..、反斜杠 \\、冒号 :、NUL 与 double-percent', () => {
    assert.throws(() => checkedUrl('/../evil.js', base), /traversal|\.\./i);
    assert.throws(() => checkedUrl('/sub/..%2f..%2fevil.js', base), /traversal|\.\.|percent/i);
    assert.throws(() => checkedUrl('/assets\\evil.js', base), /backslash|invalid path/i);
    assert.throws(() => checkedUrl('/file:stream', base), /colon|invalid path|ads/i);
    assert.throws(() => checkedUrl('/file%00.js', base), /null|nul|invalid path/i);
    assert.throws(() => checkedUrl('/file%252e.js', base), /double percent|percent/i);
  });

  it('拒绝 Windows DOS 设备名', () => {
    assert.throws(() => checkedUrl('/con.png', base), /reserved|device|windows/i);
    assert.throws(() => checkedUrl('/assets/aux/test.js', base), /reserved|device|windows/i);
    assert.throws(() => checkedUrl('/prn.txt', base), /reserved|device|windows/i);
    assert.throws(() => checkedUrl('/com1.js', base), /reserved|device|windows/i);
    assert.throws(() => checkedUrl('/COM9.png', base), /reserved|device|windows/i);
    assert.throws(() => checkedUrl('/LPT3.svg', base), /reserved|device|windows/i);
    assert.throws(() => checkedUrl('/nul', base), /reserved|device|windows/i);
  });

  it('拒绝 Windows 非法字符 < > " | ? * 与 ASCII 控制字符', () => {
    assert.throws(() => checkedUrl('/assets/image/*,.png', base), /invalid path|illegal character|wildcard/i);
    assert.throws(() => checkedUrl('/assets/file?.js', base), /invalid path|illegal character/i);
    assert.throws(() => checkedUrl('/assets/<script>.js', base), /invalid path|illegal character/i);
    assert.throws(() => checkedUrl('/assets/foo|bar.png', base), /invalid path|illegal character/i);
    assert.throws(() => checkedUrl('/assets/test\x1f.js', base), /invalid path|control character/i);
  });
});

describe('snapshot 集成与 Mock HTTP 行为', () => {
  let server;
  let baseUrl;
  let tmpDir;

  afterEach(async () => {
    if (server) {
      await new Promise(r => server.close(r));
      server = null;
    }
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      tmpDir = null;
    }
  });

  it('自建 Mock 站点完成全量快照，生成 assets.json 和 snapshot-report.json', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashfall-snap-test-'));

    const glbData = createGlbFixture({
      asset: { version: '2.0' },
      buffers: [{ uri: 'model.bin', byteLength: 16 }]
    });

    const routes = {
      '/': {
        type: 'text/html; charset=utf-8',
        body: `<!DOCTYPE html><html><head><link rel="stylesheet" href="/style.css"></head><body><script type="module" src="/entry.js"></script></body></html>`
      },
      '/style.css': {
        type: 'text/css',
        body: `body { background: url('/bg.png'); }`
      },
      '/bg.png': {
        type: 'image/png',
        body: Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0])
      },
      '/entry.js': {
        type: 'application/javascript',
        body: `import('./lazy.js'); new Worker(new URL('./worker.js', import.meta.url)); const m = '/model.glb';`
      },
      '/lazy.js': {
        type: 'application/javascript',
        body: `console.log('lazy module');`
      },
      '/worker.js': {
        type: 'application/javascript',
        body: `console.log('worker script');`
      },
      '/model.glb': {
        type: 'model/gltf-binary',
        body: glbData
      },
      '/model.bin': {
        type: 'application/octet-stream',
        body: Buffer.alloc(16, 0x42)
      }
    };

    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const route = routes[url.pathname];
      if (route) {
        res.writeHead(200, { 'Content-Type': route.type });
        res.end(route.body);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
    });

    await new Promise(r => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}/`;

    const result = await snapshot({
      base: baseUrl,
      out: tmpDir,
      concurrency: 4,
      timeoutMs: 5000,
      backoffDelays: [20, 40]
    });

    assert.equal(result.success, true);
    assert.equal(result.report.failures.length, 0);
    assert.equal(result.report.consistency, 'consistent');
    assert.ok(result.report.closure.includes('pending_verification'));

    // 检查 assets.json
    const assetsJsonRaw = await fs.readFile(path.join(tmpDir, 'assets.json'), 'utf-8');
    const assets = JSON.parse(assetsJsonRaw);
    assert.ok(Array.isArray(assets));
    // 不能把 assets.json 和 snapshot-report.json 误抓
    assert.ok(!assets.some(a => a.path.includes('assets.json')));
    assert.ok(!assets.some(a => a.path.includes('snapshot-report.json')));

    // 检查下载到的文件
    const indexContent = await fs.readFile(path.join(tmpDir, 'index.html'), 'utf-8');
    assert.ok(indexContent.includes('style.css'));
    const entryContent = await fs.readFile(path.join(tmpDir, 'entry.js'), 'utf-8');
    assert.ok(entryContent.includes('lazy.js'));
    const binContent = await fs.readFile(path.join(tmpDir, 'model.bin'));
    assert.equal(binContent.length, 16);
  });

  it('拒绝跨源重定向并判定为失败', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashfall-snap-test-'));

    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<script src="/redirect.js"></script>`);
      } else if (url.pathname === '/redirect.js') {
        res.writeHead(302, { 'Location': 'https://evil.external.example.com/malicious.js' });
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise(r => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}/`;

    const result = await snapshot({
      base: baseUrl,
      out: tmpDir,
      concurrency: 2,
      timeoutMs: 2000,
      backoffDelays: [10, 20]
    });

    assert.equal(result.success, false);
    assert.ok(result.report.failures.length > 0);
    assert.ok(result.report.failures.some(f => f.reason.match(/cross-origin|redirect/i)));
    // 确保没有写出 redirect.js
    const exists = await fs.access(path.join(tmpDir, 'redirect.js')).then(() => true).catch(() => false);
    assert.equal(exists, false);
  });

  it('拒绝 HTML 冒充的 JS（如 SPA 404 返回 HTML）', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashfall-snap-test-'));

    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<script src="/app.js"></script>`);
      } else if (url.pathname === '/app.js') {
        // 返回 200 但是实际上是 HTML 页面
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><body>404 Not Found</body></html>`);
      }
    });

    await new Promise(r => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}/`;

    const result = await snapshot({
      base: baseUrl,
      out: tmpDir,
      concurrency: 2,
      timeoutMs: 2000,
      backoffDelays: [10, 20]
    });

    assert.equal(result.success, false);
    assert.ok(result.report.failures.some(f => f.reason.match(/html/i)));
    const exists = await fs.access(path.join(tmpDir, 'app.js')).then(() => true).catch(() => false);
    assert.equal(exists, false);
  });

  it('支持 429/500 重试与退避成功', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashfall-snap-test-'));

    let retryCount = 0;
    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<script src="/retry-me.js"></script>`);
      } else if (url.pathname === '/retry-me.js') {
        retryCount++;
        if (retryCount === 1) {
          res.writeHead(429, { 'Content-Type': 'text/plain' });
          res.end('Too Many Requests');
        } else if (retryCount === 2) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        } else {
          res.writeHead(200, { 'Content-Type': 'application/javascript' });
          res.end('console.log("finally success");');
        }
      }
    });

    await new Promise(r => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}/`;

    const result = await snapshot({
      base: baseUrl,
      out: tmpDir,
      concurrency: 2,
      maxAttempts: 3,
      timeoutMs: 2000,
      backoffDelays: [20, 40]
    });

    assert.equal(result.success, true);
    assert.ok(retryCount >= 3, `经历了至少 3 次尝试（含重试与锚点二次验证），实际为 ${retryCount}`);
    const content = await fs.readFile(path.join(tmpDir, 'retry-me.js'), 'utf-8');
    assert.ok(content.includes('finally success'));
  });

  it('超时处理正确并产生失败报告', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashfall-snap-test-'));

    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<script src="/hang.js"></script>`);
      } else if (url.pathname === '/hang.js') {
        // 挂起不响应
      }
    });

    await new Promise(r => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}/`;

    const result = await snapshot({
      base: baseUrl,
      out: tmpDir,
      concurrency: 1,
      maxAttempts: 1,
      timeoutMs: 80,
      backoffDelays: [10]
    });

    assert.equal(result.success, false);
    assert.ok(result.report.failures.some(f => f.reason.match(/timeout|abort/i)));
  });

  it('已下载文件校验 SHA 复用，减少重复传输', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashfall-snap-test-'));

    let audioRequests = 0;
    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<audio src="/sound.ogg"></audio>`);
      } else if (url.pathname === '/sound.ogg') {
        audioRequests++;
        res.writeHead(200, { 'Content-Type': 'audio/ogg' });
        // OggS magic
        res.end(Buffer.concat([Buffer.from('OggS', 'ascii'), Buffer.alloc(12, 0)]));
      }
    });

    await new Promise(r => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}/`;

    // 第一次运行
    const res1 = await snapshot({
      base: baseUrl,
      out: tmpDir,
      concurrency: 2,
      timeoutMs: 2000,
      backoffDelays: [10]
    });
    assert.equal(res1.success, true);
    assert.equal(audioRequests, 1);

    // 第二次运行（已有文件 SHA 匹配，直接复用无需再次网络请求已存在的二进制文件）
    const res2 = await snapshot({
      base: baseUrl,
      out: tmpDir,
      concurrency: 2,
      timeoutMs: 2000,
      backoffDelays: [10]
    });
    assert.equal(res2.success, true);
    assert.equal(audioRequests, 1, '已存在的未变动文件应当被复用，不应再次发起下载请求');
  });

  it('入口在下载前后 digest 发生变化时 fail closed', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashfall-snap-test-'));

    let entryFetches = 0;
    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/') {
        entryFetches++;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        // 第一次和后续返回不同内容
        res.end(`<!DOCTYPE html><html><body>Version ${entryFetches}</body></html>`);
      }
    });

    await new Promise(r => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}/`;

    const result = await snapshot({
      base: baseUrl,
      out: tmpDir,
      concurrency: 1,
      timeoutMs: 2000,
      backoffDelays: [10]
    });

    assert.equal(result.success, false);
    assert.ok(result.report.consistency.match(/changed|inconsistent/i));
  });

  it('并发数控制不超过 4', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashfall-snap-test-'));

    let currentConcurrent = 0;
    let maxSeenConcurrent = 0;

    const items = Array.from({ length: 12 }, (_, i) => `/item-${i}.js`);
    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        const scriptTags = items.map(p => `<script src="${p}"></script>`).join('\n');
        res.end(`<!DOCTYPE html><html><head>${scriptTags}</head></html>`);
      } else if (url.pathname.startsWith('/item-')) {
        currentConcurrent++;
        if (currentConcurrent > maxSeenConcurrent) {
          maxSeenConcurrent = currentConcurrent;
        }
        setTimeout(() => {
          currentConcurrent--;
          res.writeHead(200, { 'Content-Type': 'application/javascript' });
          res.end('// ok');
        }, 30);
      }
    });

    await new Promise(r => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}/`;

    const result = await snapshot({
      base: baseUrl,
      out: tmpDir,
      concurrency: 4,
      timeoutMs: 5000,
      backoffDelays: [10]
    });

    assert.equal(result.success, true);
    assert.ok(maxSeenConcurrent <= 4, `实际最大并发为 ${maxSeenConcurrent}，不应超过 4`);
  });

  it('同物理路径不同 URL 查询参数产生冲突并报错记录', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashfall-snap-test-'));

    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<script src="/dup.js?v=1"></script><script src="/dup.js?v=2"></script>`);
      } else if (url.pathname === '/dup.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end('// dup');
      }
    });

    await new Promise(r => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}/`;

    const result = await snapshot({
      base: baseUrl,
      out: tmpDir,
      concurrency: 2,
      timeoutMs: 2000,
      backoffDelays: [10]
    });

    assert.equal(result.success, false);
    assert.ok(result.report.failures.some(f => f.reason.match(/conflict|multiple urls map to the same physical path/i)));
  });

  it('发现跨源外链统计和反馈，不予下载并记录到 externalRefs', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashfall-snap-test-'));

    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head>
              <script src="https://static.cloudflareinsights.com/beacon.min.js"></script>
              <link rel="stylesheet" href="/style.css">
            </head>
            <body>
              <a href="https://starcraft.fandom.com/wiki">StarCraft Wiki</a>
            </body>
          </html>
        `);
      } else if (url.pathname === '/style.css') {
        res.writeHead(200, { 'Content-Type': 'text/css' });
        res.end('body { color: white; }');
      }
    });

    await new Promise(r => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}/`;

    const result = await snapshot({
      base: baseUrl,
      out: tmpDir,
      concurrency: 2,
      timeoutMs: 2000,
      backoffDelays: [10]
    });

    assert.equal(result.success, true);
    assert.equal(result.report.failures.length, 0);
    assert.ok(result.report.externalRefs.includes('https://static.cloudflareinsights.com/beacon.min.js'));
    assert.ok(result.report.externalRefs.includes('https://starcraft.fandom.com/wiki'));

    // 确保没有下载到本地
    const files = await fs.readdir(tmpDir);
    assert.ok(!files.includes('beacon.min.js'));
  });

  it('入口不变但发现的 asset-url.js 脚本锚点在下载中途变化时 fail closed', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashfall-snap-test-'));

    let assetUrlFetches = 0;
    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/') {
        // 入口 index.html 始终不变
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><script src="/assets/asset-url.js"></script></html>`);
      } else if (url.pathname === '/assets/asset-url.js') {
        assetUrlFetches++;
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        // 第一次和后续返回不同的 mapping 内容
        res.end(`export const assetMap = { version: ${assetUrlFetches} };`);
      }
    });

    await new Promise(r => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}/`;

    const result = await snapshot({
      base: baseUrl,
      out: tmpDir,
      concurrency: 2,
      timeoutMs: 2000,
      backoffDelays: [10]
    });

    assert.equal(result.success, false);
    assert.equal(result.report.consistency, 'inconsistent_anchor_changed');
    assert.ok(result.report.failures.some(f => f.url.includes('/assets/asset-url.js')));
  });

  it('已有文件复用时仍对 mapping.json 锚点进行在线核验，发生变动拒绝复用并报错', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashfall-snap-test-'));

    let configVersion = 1;
    let audioFetches = 0;

    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><script src="/config.json"></script><audio src="/sound.ogg"></audio></html>`);
      } else if (url.pathname === '/config.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ v: configVersion }));
      } else if (url.pathname === '/sound.ogg') {
        audioFetches++;
        res.writeHead(200, { 'Content-Type': 'audio/ogg' });
        res.end(Buffer.concat([Buffer.from('OggS', 'ascii'), Buffer.alloc(12, 0)]));
      }
    });

    await new Promise(r => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}/`;

    // 第一次运行：成功拉取版本 1
    const res1 = await snapshot({
      base: baseUrl,
      out: tmpDir,
      concurrency: 2,
      timeoutMs: 2000,
      backoffDelays: [10]
    });
    assert.equal(res1.success, true);
    assert.equal(audioFetches, 1);

    // 模拟服务端 mapping.json 更新为版本 2
    configVersion = 2;

    // 第二次运行：config.json 的版本变化，拒绝伪当一致并报错；audio 仍然复用不二次全传
    const res2 = await snapshot({
      base: baseUrl,
      out: tmpDir,
      concurrency: 2,
      timeoutMs: 2000,
      backoffDelays: [10]
    });

    assert.equal(res2.success, false);
    assert.equal(res2.report.consistency, 'inconsistent_anchor_changed');
    assert.equal(audioFetches, 1, '大媒体文件没有产生二次传输');
  });

  it('JS 中存在 image/*,.png 等伪引用时快照不崩溃且正常获取合法资源', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashfall-snap-test-'));

    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><script src="/main.js"></script></html>`);
      } else if (url.pathname === '/main.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        // 包含 UI accept 字符串字面量
        res.end(`
          const accept = "image/*,.png";
          const normal = "/valid-asset.png";
        `);
      } else if (url.pathname === '/valid-asset.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
      }
    });

    await new Promise(r => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}/`;

    const result = await snapshot({
      base: baseUrl,
      out: tmpDir,
      concurrency: 2,
      timeoutMs: 2000,
      backoffDelays: [10]
    });

    assert.equal(result.success, true);
    assert.ok(result.assets.some(a => a.path.includes('valid-asset.png')));
    // 确保没有为伪引用生成带有 * 或 , 的异常文件
    const files = await fs.readdir(tmpDir);
    assert.ok(!files.some(f => f.includes('*') || f.includes(',')));
  });

  it('流多次经历背压时不触发 MaxListenersExceededWarning', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashfall-snap-test-'));

    const warnings = [];
    const warningListener = (warning) => {
      warnings.push(warning);
    };
    process.on('warning', warningListener);

    try {
      server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        if (url.pathname === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<!DOCTYPE html><html><script src="/stream-test.js"></script></html>`);
        } else if (url.pathname === '/stream-test.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript' });
          // 发送 30 个分块，总大小 300KB
          let chunkIndex = 0;
          const interval = setInterval(() => {
            if (chunkIndex >= 30) {
              clearInterval(interval);
              res.end('// done\n');
            } else {
              res.write(`// chunk ${chunkIndex}\n` + '0'.repeat(16384) + '\n');
              chunkIndex++;
            }
          }, 5);
        }
      });

      await new Promise(r => server.listen(0, '127.0.0.1', r));
      baseUrl = `http://127.0.0.1:${server.address().port}/`;

      const result = await snapshot({
        base: baseUrl,
        out: tmpDir,
        concurrency: 1,
        timeoutMs: 5000,
        backoffDelays: [10]
      });

      assert.equal(result.success, true);
      const maxListenerWarnings = warnings.filter(w => w.name === 'MaxListenersExceededWarning');
      assert.equal(maxListenerWarnings.length, 0, `产生了 MaxListenersExceededWarning: ${maxListenerWarnings.map(w => w.message).join('; ')}`);
    } finally {
      process.removeListener('warning', warningListener);
    }
  });

  it('超大 GLB（>32MiB）仅解析前部 JSON Chunk，不全量内存缓冲且顺利流式落盘', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashfall-snap-test-'));

    // 构造一个 35MiB 的大 GLB
    const jsonStr = JSON.stringify({
      asset: { version: '2.0' },
      buffers: [{ uri: 'huge-sub.bin', byteLength: 1024 }]
    });
    const jsonBuf = Buffer.from(jsonStr, 'utf-8');
    const paddingLen = (4 - (jsonBuf.length % 4)) % 4;
    const paddedJson = Buffer.concat([jsonBuf, Buffer.alloc(paddingLen, 0x20)]);

    const binChunkLen = 35 * 1024 * 1024; // 35MiB
    const totalLen = 12 + 8 + paddedJson.length + 8 + binChunkLen;

    const header = Buffer.alloc(12);
    header.write('glTF', 0, 4, 'ascii');
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(totalLen, 8);

    const chunk0Header = Buffer.alloc(8);
    chunk0Header.writeUInt32LE(paddedJson.length, 0);
    chunk0Header.write('JSON', 4, 4, 'ascii');

    const chunk1Header = Buffer.alloc(8);
    chunk1Header.writeUInt32LE(binChunkLen, 0);
    chunk1Header.write('BIN\0', 4, 4, 'ascii');

    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><script src="/entry.js"></script></html>`);
      } else if (url.pathname === '/entry.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(`const m = '/huge-model.glb';`);
      } else if (url.pathname === '/huge-model.glb') {
        res.writeHead(200, { 'Content-Type': 'model/gltf-binary' });
        res.write(header);
        res.write(chunk0Header);
        res.write(paddedJson);
        res.write(chunk1Header);
        // 分块写入 35MiB
        const chunkSize = 1024 * 1024; // 1MiB
        const zeroChunk = Buffer.alloc(chunkSize, 0x55);
        for (let i = 0; i < 35; i++) {
          res.write(zeroChunk);
        }
        res.end();
      } else if (url.pathname === '/huge-sub.bin') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(Buffer.alloc(1024, 0xaa));
      }
    });

    await new Promise(r => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}/`;

    const result = await snapshot({
      base: baseUrl,
      out: tmpDir,
      concurrency: 1,
      timeoutMs: 10000,
      backoffDelays: [10],
      maxParseBytes: 32 * 1024 * 1024
    });

    assert.equal(result.success, true);
    // 验证 external uri 被成功发现并下载
    const subExists = await fs.access(path.join(tmpDir, 'huge-sub.bin')).then(() => true).catch(() => false);
    assert.ok(subExists, '大 GLB 中的外部引用 huge-sub.bin 应当被成功解析并下载');

    // 验证大模型文件本身被完整保存
    const stat = await fs.stat(path.join(tmpDir, 'huge-model.glb'));
    assert.equal(stat.size, totalLen);
  });

  it('文本资源超过 maxParseBytes 显式抛出 parse_limit_exceeded 绝不静默截断伪当成功', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashfall-snap-test-'));

    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><script src="/oversized.js"></script></html>`);
      } else if (url.pathname === '/oversized.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        // 发送 2048 字节内容，超过测试中设定的 1024 限制
        res.end('// large text\n' + 'var a = 1;\n'.repeat(150));
      }
    });

    await new Promise(r => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}/`;

    const result = await snapshot({
      base: baseUrl,
      out: tmpDir,
      concurrency: 1,
      timeoutMs: 2000,
      backoffDelays: [10],
      maxParseBytes: 1024 // 限制为 1KB
    });

    assert.equal(result.success, false, '文本超过 parse 限制必须 fail closed');
    assert.ok(result.report.failures.some(f => f.reason && f.reason.includes('parse_limit_exceeded')),
      `应报告 parse_limit_exceeded，实际 failures: ${JSON.stringify(result.report.failures)}`);
  });

  it('GLB 内部 JSON Chunk 超过 16MiB 显式抛出 parse_limit_exceeded 绝不截断伪当成功', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashfall-snap-test-'));

    // 伪造一个 Header 声明 Chunk 0 长度为 20MiB 的 GLB
    const fakeChunk0Len = 20 * 1024 * 1024; // 20MiB > 16MiB
    const header = Buffer.alloc(12);
    header.write('glTF', 0, 4, 'ascii');
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + fakeChunk0Len, 8);

    const chunk0Header = Buffer.alloc(8);
    chunk0Header.writeUInt32LE(fakeChunk0Len, 0);
    chunk0Header.write('JSON', 4, 4, 'ascii');

    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><script src="/entry.js"></script></html>`);
      } else if (url.pathname === '/entry.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(`const m = '/huge-json.glb';`);
      } else if (url.pathname === '/huge-json.glb') {
        res.writeHead(200, { 'Content-Type': 'model/gltf-binary' });
        res.write(header);
        res.write(chunk0Header);
        // 发送少量数据
        res.end(Buffer.alloc(1024, 0x20));
      }
    });

    await new Promise(r => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}/`;

    const result = await snapshot({
      base: baseUrl,
      out: tmpDir,
      concurrency: 1,
      timeoutMs: 2000,
      backoffDelays: [10]
    });

    assert.equal(result.success, false, 'GLB JSON Chunk 超限必须 fail closed');
    assert.ok(result.report.failures.some(f => f.reason && f.reason.includes('parse_limit_exceeded')),
      `应报告 parse_limit_exceeded，实际 failures: ${JSON.stringify(result.report.failures)}`);
  });

  describe('Discovery Spec 与权威 Asset Map 模式', () => {
    it('parseAssetMap 安全非 eval 提取 var t = { ... } 映射', () => {
      const code = `
        import { foo } from "./mod.js";
        var t={"/assets/art/deck.webp":\`5b495f8364\`,"/assets/models/unit.glb":'1234567890'};
        export default t;
      `;
      const map = parseAssetMap(code);
      assert.equal(map.get('/assets/art/deck.webp'), '/assets/art/deck.webp?v=5b495f8364');
      assert.equal(map.get('/assets/models/unit.glb'), '/assets/models/unit.glb?v=1234567890');
    });

    it('配置错误的 expectedSha256 拒绝执行', async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashfall-snap-test-'));
      const mapFile = path.join(tmpDir, 'asset-url.js');
      await fs.writeFile(mapFile, 'var t={"/assets/a.png":`1122334455`};');

      await assert.rejects(async () => {
        await snapshot({
          base: 'http://127.0.0.1:9999/',
          out: tmpDir,
          spec: {
            assetMap: {
              file: mapFile,
              url: '/assets/asset-url.js',
              expectedSha256: 'deadbeef00000000000000000000000000000000000000000000000000000000'
            }
          }
        });
      }, /Asset map SHA mismatch/i);
    });

    it('Spec 校验必填项：缺少 file/url/expectedSha256、非法 SHA、跨源 URL 或 malformed exclusions 严格拒绝', async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashfall-snap-test-'));
      const mapFile = path.join(tmpDir, 'asset-url.js');
      await fs.writeFile(mapFile, 'var t={"/assets/a.png":`1122334455`};');
      const validSha = crypto.createHash('sha256').update(await fs.readFile(mapFile)).digest('hex');

      // 1. 空 spec = {}
      await assert.rejects(async () => {
        await snapshot({ base: 'http://127.0.0.1:9999/', out: tmpDir, spec: {} });
      }, /Spec requires assetMap/i);

      // 2. 缺少 file
      await assert.rejects(async () => {
        await snapshot({
          base: 'http://127.0.0.1:9999/',
          out: tmpDir,
          spec: { assetMap: { url: '/assets/asset-url.js', expectedSha256: validSha } }
        });
      }, /Spec requires assetMap\.file/i);

      // 3. 缺少 url
      await assert.rejects(async () => {
        await snapshot({
          base: 'http://127.0.0.1:9999/',
          out: tmpDir,
          spec: { assetMap: { file: mapFile, expectedSha256: validSha } }
        });
      }, /Spec requires assetMap\.url/i);

      // 4. 跨源 url
      await assert.rejects(async () => {
        await snapshot({
          base: 'http://127.0.0.1:9999/',
          out: tmpDir,
          spec: { assetMap: { file: mapFile, url: 'https://evil.com/asset-url.js', expectedSha256: validSha } }
        });
      }, /cross-origin/i);

      // 5. 缺少或非法 64 位 expectedSha256
      await assert.rejects(async () => {
        await snapshot({
          base: 'http://127.0.0.1:9999/',
          out: tmpDir,
          spec: { assetMap: { file: mapFile, url: '/assets/asset-url.js', expectedSha256: 'short-sha' } }
        });
      }, /expectedSha256 must be a 64-character hex string/i);

      // 6. malformed exclusions（缺少 reason 或 path）
      await assert.rejects(async () => {
        await snapshot({
          base: 'http://127.0.0.1:9999/',
          out: tmpDir,
          spec: {
            assetMap: { file: mapFile, url: '/assets/asset-url.js', expectedSha256: validSha },
            exclusions: [{ path: '/assets/a.png' }] // 缺少 reason
          }
        });
      }, /Malformed exclusion entry/i);
    });

    it('配置不在 mapKeys 范围内的 exclusion 拒绝执行', async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashfall-snap-test-'));
      const mapFile = path.join(tmpDir, 'asset-url.js');
      await fs.writeFile(mapFile, 'var t={"/assets/a.png":`1122334455`};');
      const validSha = crypto.createHash('sha256').update(await fs.readFile(mapFile)).digest('hex');

      await assert.rejects(async () => {
        await snapshot({
          base: 'http://127.0.0.1:9999/',
          out: tmpDir,
          spec: {
            assetMap: { file: mapFile, url: '/assets/asset-url.js', expectedSha256: validSha },
            exclusions: [{ path: '/assets/unknown.png', reason: '测试' }]
          }
        });
      }, /Invalid exclusion.*not in asset map keys/i);
    });

    it('未配置 exclusion 时缺失资源仍然判为失败；配置合法 exclusion 则排除并记入报告', async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashfall-snap-test-'));
      const mapContent = 'var t={"/assets/real.png":`aaaaaaaaaa`,"/assets/swann.glb":`bbbbbbbbbb`};';
      const mapFile = path.join(tmpDir, 'asset-url.js');
      await fs.writeFile(mapFile, mapContent);
      const validSha = crypto.createHash('sha256').update(mapContent).digest('hex');

      server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        if (url.pathname === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<!DOCTYPE html><html><script src="/entry.js"></script></html>`);
        } else if (url.pathname === '/entry.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript' });
          res.end(`console.log("ok");`);
        } else if (url.pathname === '/assets/asset-url.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript' });
          res.end(mapContent);
        } else if (url.pathname === '/assets/real.png') {
          res.writeHead(200, { 'Content-Type': 'image/png' });
          res.end(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
        } else {
          // swann.glb 不存在，远端返回 404
          res.writeHead(404, { 'Content-Type': 'text/html' });
          res.end('<html>404 Not Found</html>');
        }
      });

      await new Promise(r => server.listen(0, '127.0.0.1', r));
      baseUrl = `http://127.0.0.1:${server.address().port}/`;

      // 1. 未配置 exclusion：swann.glb 缺失，必须判定失败
      const resWithoutExclusion = await snapshot({
        base: baseUrl,
        out: tmpDir,
        concurrency: 1,
        timeoutMs: 2000,
        backoffDelays: [10],
        spec: {
          assetMap: { file: mapFile, url: '/assets/asset-url.js', expectedSha256: validSha }
        }
      });
      assert.equal(resWithoutExclusion.success, false);

      // 2. 显式精确配置 exclusion：排除 swann.glb 并记录原因，全流程成功
      const subOut = path.join(tmpDir, 'sub-out');
      const resWithExclusion = await snapshot({
        base: baseUrl,
        out: subOut,
        concurrency: 1,
        timeoutMs: 2000,
        backoffDelays: [10],
        spec: {
          assetMap: { file: mapFile, url: '/assets/asset-url.js', expectedSha256: validSha },
          exclusions: [{ path: '/assets/swann.glb', reason: '原站未发布futurebranch' }]
        }
      });

      assert.equal(resWithExclusion.success, true);
      assert.ok(resWithExclusion.report.exclusions.some(e => e.path === '/assets/swann.glb'));
      assert.ok(resWithExclusion.report.notCompleteReason);
      assert.equal(resWithExclusion.report.closure, 'pending_runtime_verification');
    });

    it('bare 路径自动 canonical 到 approved ?v=hash，不同 query 依然判定冲突', async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashfall-snap-test-'));
      const mapContent = 'var t={"/assets/art/deck.webp":`5b495f8364`};';
      const mapFile = path.join(tmpDir, 'asset-url.js');
      await fs.writeFile(mapFile, mapContent);
      const validSha = crypto.createHash('sha256').update(mapContent).digest('hex');

      server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        if (url.pathname === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          // entry 引用 bare 路径，同时又引用带 ?v=5b495f8364 路径
          res.end(`<!DOCTYPE html><html><img src="/assets/art/deck.webp"><img src="/assets/art/deck.webp?v=5b495f8364"></html>`);
        } else if (url.pathname === '/assets/asset-url.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript' });
          res.end(mapContent);
        } else if (url.pathname === '/assets/art/deck.webp') {
          res.writeHead(200, { 'Content-Type': 'image/webp' });
          res.end(Buffer.concat([Buffer.from('RIFF....WEBP', 'ascii'), Buffer.alloc(10, 0)]));
        }
      });

      await new Promise(r => server.listen(0, '127.0.0.1', r));
      baseUrl = `http://127.0.0.1:${server.address().port}/`;

      const resCanonical = await snapshot({
        base: baseUrl,
        out: tmpDir,
        concurrency: 1,
        timeoutMs: 2000,
        backoffDelays: [10],
        spec: {
          assetMap: { file: mapFile, url: '/assets/asset-url.js', expectedSha256: validSha }
        }
      });
      assert.equal(resCanonical.success, true, '通过 map canonical 消除 bare 与权威 query 的冲突');

      // 验证：如果是未经批准的不同 query（例如 ?v=wronghash），依然报错冲突
      const badServer = http.createServer((req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        if (url.pathname === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<!DOCTYPE html><html><img src="/assets/art/deck.webp?v=wrong"><img src="/assets/art/deck.webp?v=5b495f8364"></html>`);
        } else if (url.pathname === '/assets/asset-url.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript' });
          res.end(mapContent);
        } else if (url.pathname === '/assets/art/deck.webp') {
          res.writeHead(200, { 'Content-Type': 'image/webp' });
          res.end(Buffer.concat([Buffer.from('RIFF....WEBP', 'ascii'), Buffer.alloc(10, 0)]));
        }
      });
      await new Promise(r => badServer.listen(0, '127.0.0.1', r));
      const badBaseUrl = `http://127.0.0.1:${badServer.address().port}/`;

      const subOut = path.join(tmpDir, 'sub-bad');
      const resBad = await snapshot({
        base: badBaseUrl,
        out: subOut,
        concurrency: 1,
        timeoutMs: 2000,
        backoffDelays: [10],
        spec: {
          assetMap: { file: mapFile, url: '/assets/asset-url.js', expectedSha256: validSha }
        }
      });
      assert.equal(resBad.success, false, '未核准 query 必须保持冲突失败');
      assert.ok(resBad.report.failures.some(f => f.reason && f.reason.includes('Conflict')));
      await new Promise(r => badServer.close(r));
    });

    it('JS 中的 assets/chunk.js 相对文档根目录解析，且 JSON 排除 build source 字段', async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashfall-snap-test-'));
      const mapContent = 'var t={"/assets/real-item.png":`1111111111`};';
      const mapFile = path.join(tmpDir, 'asset-url.js');
      await fs.writeFile(mapFile, mapContent);
      const validSha = crypto.createHash('sha256').update(mapContent).digest('hex');

      server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        if (url.pathname === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<!DOCTYPE html><html><script src="/assets/entry.js"></script><script src="/assets/data.json"></script></html>`);
        } else if (url.pathname === '/assets/asset-url.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript' });
          res.end(mapContent);
        } else if (url.pathname === '/assets/entry.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript' });
          // 在 /assets/entry.js 中引用 "assets/chunk.js"，不应解析为 /assets/assets/chunk.js
          res.end(`import "assets/chunk.js";`);
        } else if (url.pathname === '/assets/chunk.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript' });
          res.end(`console.log("chunk loaded");`);
        } else if (url.pathname === '/assets/data.json') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          // 包含 build / source 路径字段与真实 web 路径
          res.end(JSON.stringify({
            source: 'rawgithub/source.wav',
            sources: ['mods/fire.dds'],
            sourcePath: 'public/build/napalm.png',
            file: '/assets/real-item.png'
          }));
        } else if (url.pathname === '/assets/real-item.png') {
          res.writeHead(200, { 'Content-Type': 'image/png' });
          res.end(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
        }
      });

      await new Promise(r => server.listen(0, '127.0.0.1', r));
      baseUrl = `http://127.0.0.1:${server.address().port}/`;

      const result = await snapshot({
        base: baseUrl,
        out: tmpDir,
        concurrency: 1,
        timeoutMs: 2000,
        backoffDelays: [10],
        spec: {
          assetMap: { file: mapFile, url: '/assets/asset-url.js', expectedSha256: validSha }
        }
      });

      assert.equal(result.success, true);
      assert.ok(result.assets.some(a => a.path === 'assets/chunk.js'), 'assets/chunk.js 应被解析为根路径下的 assets/chunk.js');
      assert.ok(!result.assets.some(a => a.path.includes('assets/assets')), '绝不应产生 /assets/assets/ 重叠路径');
      assert.ok(result.assets.some(a => a.path === 'assets/real-item.png'), '真实 web 路径正常下载');
      assert.ok(!result.assets.some(a => a.path.includes('source.wav') || a.path.includes('fire.dds')), 'JSON provenance 路径被正确排除');
    });

    it('远端稳态与本地/预期 Map SHA 不一致时，快照必须 fail closed 并记录 map_source_changed', async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashfall-snap-test-'));
      // 本地是旧版本
      const localMapContent = 'var t={"/assets/a.png":`1111111111`};';
      const mapFile = path.join(tmpDir, 'asset-url.js');
      await fs.writeFile(mapFile, localMapContent);
      const localSha = crypto.createHash('sha256').update(localMapContent).digest('hex');

      // 远端已经是新版本（稳态不同）
      const remoteMapContent = 'var t={"/assets/a.png":`2222222222`};';

      server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        if (url.pathname === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<!DOCTYPE html><html><script src="/assets/asset-url.js"></script></html>`);
        } else if (url.pathname === '/assets/asset-url.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript' });
          res.end(remoteMapContent);
        }
      });

      await new Promise(r => server.listen(0, '127.0.0.1', r));
      baseUrl = `http://127.0.0.1:${server.address().port}/`;

      const result = await snapshot({
        base: baseUrl,
        out: tmpDir,
        concurrency: 1,
        timeoutMs: 2000,
        backoffDelays: [10],
        spec: {
          assetMap: { file: mapFile, url: '/assets/asset-url.js', expectedSha256: localSha }
        }
      });

      assert.equal(result.success, false, '远端与本地 Map SHA 不一致必须判定失败');
      assert.ok(result.report.failures.some(f => f.reason && f.reason.includes('map_source_changed')),
        `应记录 map_source_changed 失败，实际 failures: ${JSON.stringify(result.report.failures)}`);
    });

    it('fetchResourceDigest 遇到跨源重定向时被拦截报错，不静默跟随', async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashfall-snap-test-'));
      const mapContent = 'var t={"/assets/a.png":`1111111111`};';
      const mapFile = path.join(tmpDir, 'asset-url.js');
      await fs.writeFile(mapFile, mapContent);
      const validSha = crypto.createHash('sha256').update(mapContent).digest('hex');

      server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        if (url.pathname === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<!DOCTYPE html><html><script src="/assets/asset-url.js"></script></html>`);
        } else if (url.pathname === '/assets/asset-url.js') {
          // 恶意重定向到跨源地址
          res.writeHead(302, { 'Location': 'http://evil.cross-origin.com/fake.js' });
          res.end();
        }
      });

      await new Promise(r => server.listen(0, '127.0.0.1', r));
      baseUrl = `http://127.0.0.1:${server.address().port}/`;

      const result = await snapshot({
        base: baseUrl,
        out: tmpDir,
        concurrency: 1,
        timeoutMs: 2000,
        backoffDelays: [10],
        spec: {
          assetMap: { file: mapFile, url: '/assets/asset-url.js', expectedSha256: validSha }
        }
      });

      assert.equal(result.success, false, '跨源重定向必须拦截失败');
      assert.ok(result.report.failures.some(f => f.reason && /cross-origin/i.test(f.reason)),
        `应记录 cross-origin 错误，实际 failures: ${JSON.stringify(result.report.failures)}`);
    });

    it('Vite 动态 mapDeps 包含未在 assetMap 中的新 .js 和 .css 时仍完整入队递归且不发生 /assets/assets/ 路径叠加', async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashfall-snap-test-'));
      // map 中只有常规资源，没有 dynamic UI chunk
      const mapContent = 'var t={"/assets/base.png":`1111111111`};';
      const mapFile = path.join(tmpDir, 'asset-url.js');
      await fs.writeFile(mapFile, mapContent);
      const validSha = crypto.createHash('sha256').update(mapContent).digest('hex');

      server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        if (url.pathname === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<!DOCTYPE html><html><script src="/assets/main-entry.js"></script></html>`);
        } else if (url.pathname === '/assets/asset-url.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript' });
          res.end(mapContent);
        } else if (url.pathname === '/assets/base.png') {
          res.writeHead(200, { 'Content-Type': 'image/png' });
          res.end(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
        } else if (url.pathname === '/assets/main-entry.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript' });
          // 模拟真实产物中的 Vite mapDeps 结构：动态引入包含 assets/possibility-ui-BiJyBvDd.js 与 CSS
          res.end(`
            const __vite__mapDeps = (i) => [[0, "assets/possibility-ui-BiJyBvDd.js", "assets/possibility-ui-Csy0ggi0.css"]][i];
            const emblem=new URL(\`/assets/terran-emblem-DcrhIktm.png\`,\`\`+import.meta.url);
            console.log("main entry ready");
          `);
        } else if (url.pathname === '/assets/possibility-ui-BiJyBvDd.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript' });
          res.end(`console.log("possibility ui js loaded");`);
        } else if (url.pathname === '/assets/terran-emblem-DcrhIktm.png') {
          res.writeHead(200, { 'Content-Type': 'image/png' });
          res.end(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
        } else if (url.pathname === '/assets/possibility-ui-Csy0ggi0.css') {
          res.writeHead(200, { 'Content-Type': 'text/css' });
          res.end(`.possibility { display: flex; }`);
        } else {
          res.writeHead(404, { 'Content-Type': 'text/html' });
          res.end('404');
        }
      });

      await new Promise(r => server.listen(0, '127.0.0.1', r));
      baseUrl = `http://127.0.0.1:${server.address().port}/`;

      const result = await snapshot({
        base: baseUrl,
        out: tmpDir,
        concurrency: 1,
        timeoutMs: 2000,
        backoffDelays: [10],
        spec: {
          assetMap: { file: mapFile, url: '/assets/asset-url.js', expectedSha256: validSha }
        }
      });

      assert.equal(result.success, true, '快照整体必须成功');
      assert.ok(result.assets.some(a => a.path === 'assets/possibility-ui-BiJyBvDd.js'), 'Vite 动态 JS 必须入队下载');
      assert.ok(result.assets.some(a => a.path === 'assets/terran-emblem-DcrhIktm.png'), '未在public map内的实际Vite打包媒体必须下载');
      assert.ok(result.assets.some(a => a.path === 'assets/possibility-ui-Csy0ggi0.css'), 'Vite 动态 CSS 必须入队下载');
      assert.ok(!result.assets.some(a => a.path.includes('assets/assets')), '绝不应产生 /assets/assets/ 重叠路径');
    });

    it('JSON 中的 public/assets 路径在 file 字段中被自动归一化为 /assets 并正常下载，而 source/audition 被记录到 metadataRefs', async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashfall-snap-test-'));
      const mapContent = 'var t={"/assets/base.png":`1111111111`};';
      const mapFile = path.join(tmpDir, 'asset-url.js');
      await fs.writeFile(mapFile, mapContent);
      const validSha = crypto.createHash('sha256').update(mapContent).digest('hex');

      server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        if (url.pathname === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<!DOCTYPE html><html><script src="/assets/data-loader.js"></script></html>`);
        } else if (url.pathname === '/assets/asset-url.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript' });
          res.end(mapContent);
        } else if (url.pathname === '/assets/base.png') {
          res.writeHead(200, { 'Content-Type': 'image/png' });
          res.end(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
        } else if (url.pathname === '/assets/data-loader.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript' });
          res.end(`const data = fetch("/assets/weapons.json");`);
        } else if (url.pathname === '/assets/weapons.json') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            weaponId: 'napalm',
            file: 'public/assets/fx/napalm-fire.png',
            source: 'mods/sc2/napalm.dds',
            audition: 'mods/sc2/audition.ogg'
          }));
        } else if (url.pathname === '/assets/fx/napalm-fire.png') {
          res.writeHead(200, { 'Content-Type': 'image/png' });
          res.end(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
        } else {
          res.writeHead(404, { 'Content-Type': 'text/html' });
          res.end('404');
        }
      });

      await new Promise(r => server.listen(0, '127.0.0.1', r));
      baseUrl = `http://127.0.0.1:${server.address().port}/`;

      const result = await snapshot({
        base: baseUrl,
        out: tmpDir,
        concurrency: 1,
        timeoutMs: 2000,
        backoffDelays: [10],
        spec: {
          assetMap: { file: mapFile, url: '/assets/asset-url.js', expectedSha256: validSha }
        }
      });

      assert.equal(result.success, true);
      assert.ok(result.assets.some(a => a.path === 'assets/fx/napalm-fire.png'), 'public/assets 应被归一化为 /assets 并成功下载');
      assert.ok(result.report.metadataRefs.includes('mods/sc2/napalm.dds'), 'source 路径记录在 metadataRefs');
      assert.ok(result.report.metadataRefs.includes('mods/sc2/audition.ogg'), 'audition 路径记录在 metadataRefs');
      assert.ok(!result.assets.some(a => a.path.includes('napalm.dds')), 'provenance 路径不作为有效资产下载');
    });

    it('entry 实际 import map.js 且代码中包含 excluded asset 时集中拦截，绝不发起请求', async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashfall-snap-test-'));
      const mapContent = 'var t={"/assets/real.png":`1111111111`,"/assets/excluded-audio.ogg":`2222222222`};';
      const mapFile = path.join(tmpDir, 'asset-url.js');
      await fs.writeFile(mapFile, mapContent);
      const validSha = crypto.createHash('sha256').update(mapContent).digest('hex');

      const requests = [];

      server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        requests.push(url.pathname);
        if (url.pathname === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<!DOCTYPE html><html><script src="/entry.js"></script></html>`);
        } else if (url.pathname === '/entry.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript' });
          // entry 实际 import asset-url.js
          res.end(`import "/assets/asset-url.js";`);
        } else if (url.pathname === '/assets/asset-url.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript' });
          res.end(mapContent);
        } else if (url.pathname === '/assets/real.png') {
          res.writeHead(200, { 'Content-Type': 'image/png' });
          res.end(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
        } else if (url.pathname === '/assets/excluded-audio.ogg') {
          // 如果向被排除的资源发起了请求，立即返回 404
          res.writeHead(404, { 'Content-Type': 'text/html' });
          res.end('404');
        } else {
          res.writeHead(404, { 'Content-Type': 'text/html' });
          res.end('404');
        }
      });

      await new Promise(r => server.listen(0, '127.0.0.1', r));
      baseUrl = `http://127.0.0.1:${server.address().port}/`;

      const result = await snapshot({
        base: baseUrl,
        out: tmpDir,
        concurrency: 1,
        timeoutMs: 2000,
        backoffDelays: [10],
        spec: {
          assetMap: { file: mapFile, url: '/assets/asset-url.js', expectedSha256: validSha },
          exclusions: [{ path: '/assets/excluded-audio.ogg', reason: '未发布素材' }]
        }
      });

      assert.equal(result.success, true, '快照整体必须成功');
      assert.ok(!requests.includes('/assets/excluded-audio.ogg'), '集中拦截确保绝不向被排除资源发起 HTTP 请求');
      assert.ok(result.report.exclusions.some(e => e.path === '/assets/excluded-audio.ogg'), '报告中包含排除项');
      assert.ok(result.assets.some(a => a.path === 'assets/real.png'), '真实资源正常下载');
    });

    it('HTML 中的 <link rel="canonical"> 跳过不作为静态资源下载，保留 stylesheet/preload', async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashfall-snap-test-'));
      const mapContent = 'var t={"/assets/real.png":`1111111111`};';
      const mapFile = path.join(tmpDir, 'asset-url.js');
      await fs.writeFile(mapFile, mapContent);
      const validSha = crypto.createHash('sha256').update(mapContent).digest('hex');

      server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        if (url.pathname === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          // HTML 包含 canonical 指向 /assets（目录），以及合法的 stylesheet
          res.end(`<!DOCTYPE html><html>
            <head>
              <link rel="canonical" href="http://${req.headers.host}/assets">
              <link rel="stylesheet" href="/assets/style.css">
            </head>
            <body></body>
          </html>`);
        } else if (url.pathname === '/assets/asset-url.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript' });
          res.end(mapContent);
        } else if (url.pathname === '/assets/style.css') {
          res.writeHead(200, { 'Content-Type': 'text/css' });
          res.end(`body { margin: 0; }`);
        } else if (url.pathname === '/assets/real.png') {
          res.writeHead(200, { 'Content-Type': 'image/png' });
          res.end(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
        } else {
          res.writeHead(404, { 'Content-Type': 'text/html' });
          res.end('404');
        }
      });

      await new Promise(r => server.listen(0, '127.0.0.1', r));
      baseUrl = `http://127.0.0.1:${server.address().port}/`;

      const result = await snapshot({
        base: baseUrl,
        out: tmpDir,
        concurrency: 1,
        timeoutMs: 2000,
        backoffDelays: [10],
        spec: {
          assetMap: { file: mapFile, url: '/assets/asset-url.js', expectedSha256: validSha }
        }
      });

      assert.equal(result.success, true, '快照整体必须成功');
      assert.ok(result.assets.some(a => a.path === 'assets/style.css'), 'stylesheet 依赖正常下载');
      assert.ok(!result.assets.some(a => a.path === 'assets'), '绝不将 canonical 目录当成资源下载');
      assert.ok(!result.report.failures.some(f => f.url.endsWith('/assets')), '没有针对 /assets 的失败记录');
    });

    it('JSON 制作字段 preparation 包含冒号正文时不被当成 URL 报错且对应 file 正常下载，且 alternate stylesheet 正常放行', async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashfall-snap-test-'));
      const mapContent = 'var t={"/assets/audio/sc2/terran-theme.ogg":`1111111111`};';
      const mapFile = path.join(tmpDir, 'asset-url.js');
      await fs.writeFile(mapFile, mapContent);
      const validSha = crypto.createHash('sha256').update(mapContent).digest('hex');

      server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        if (url.pathname === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          // 包含 entry 脚本、alternate stylesheet（合法样式）以及纯 alternate（SEO，忽略）
          res.end(`<!DOCTYPE html><html>
            <head>
              <link rel="alternate stylesheet" href="/assets/theme-dark.css">
              <link rel="alternate" href="/feed.xml">
              <script src="/entry.js"></script>
            </head>
            <body></body>
          </html>`);
        } else if (url.pathname === '/entry.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript' });
          res.end(`fetch("/assets/audio/sc2/manifest.json");`);
        } else if (url.pathname === '/assets/asset-url.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript' });
          res.end(mapContent);
        } else if (url.pathname === '/assets/theme-dark.css') {
          res.writeHead(200, { 'Content-Type': 'text/css' });
          res.end(`body { background: #000; }`);
        } else if (url.pathname === '/assets/audio/sc2/manifest.json') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          // 模拟真实 manifest.json:215 中的 preparation 制作流水线说明字段（带冒号）
          res.end(JSON.stringify({
            trackId: 'terran_theme',
            preparation: 'ffmpeg -c:a libvorbis -b:a 128k preserved assets/audio/sc2/terran-theme.ogg',
            recipe: 'audio-pipeline:v2',
            description: 'Terran theme music: remastered',
            file: '/assets/audio/sc2/terran-theme.ogg'
          }));
        } else if (url.pathname === '/assets/audio/sc2/terran-theme.ogg') {
          res.writeHead(200, { 'Content-Type': 'audio/ogg' });
          res.end(Buffer.from('OggS....fake audio data'));
        } else {
          res.writeHead(404, { 'Content-Type': 'text/html' });
          res.end('404');
        }
      });

      await new Promise(r => server.listen(0, '127.0.0.1', r));
      baseUrl = `http://127.0.0.1:${server.address().port}/`;

      const result = await snapshot({
        base: baseUrl,
        out: tmpDir,
        concurrency: 1,
        timeoutMs: 2000,
        backoffDelays: [10],
        spec: {
          assetMap: { file: mapFile, url: '/assets/asset-url.js', expectedSha256: validSha }
        }
      });

      assert.equal(result.success, true, '快照整体必须成功');
      assert.equal(result.report.failures.length, 0, '绝无冒号或缺失导致的失败');
      assert.ok(result.assets.some(a => a.path === 'assets/audio/sc2/terran-theme.ogg'), '同条目的合法 file 正常下载');
      assert.ok(result.assets.some(a => a.path === 'assets/theme-dark.css'), 'alternate stylesheet 正常作为有效样式下载');
      assert.ok(!result.assets.some(a => a.path.includes('feed.xml')), '纯 alternate 被跳过不作为资产下载');
      assert.ok(result.report.metadataRefs.some(m => m.includes('ffmpeg -c:a')), 'preparation 制作说明被记录在 metadataRefs');
    });
    it('映射外未发布资源须绑定实际引用源码SHA，默认失败和远端漂移均不能掩盖', async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashfall-ref-exclusion-'));
      const mapContent = 'var t={"/assets/base.png":`1111111111`};';
      const code = 'const card=`/assets/ui/unpublished-card.webp`;';
      const mapFile = path.join(tmpDir, 'map-source.js');
      const sourceFile = path.join(tmpDir, 'code-source.js');
      await fs.writeFile(mapFile, mapContent);
      await fs.writeFile(sourceFile, code);
      const digest = text => crypto.createHash('sha256').update(text).digest('hex');
      let unavailableRequests = 0;
      let remoteCode = code;
      server = http.createServer((req, res) => {
        const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
        if (pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<script src="/assets/entry.js"></script>'); }
        else if (pathname === '/assets/map.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(mapContent); }
        else if (pathname === '/assets/entry.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(remoteCode); }
        else if (pathname === '/assets/base.png') { res.setHeader('Content-Type', 'image/png'); res.end(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])); }
        else { unavailableRequests++; res.setHeader('Content-Type', 'text/html'); res.end('<html>unpublished</html>'); }
      });
      await new Promise(r => server.listen(0, '127.0.0.1', r));
      baseUrl = `http://127.0.0.1:${server.address().port}/`;
      const options = { base: baseUrl, out: tmpDir, concurrency: 1, timeoutMs: 2000, backoffDelays: [1],
        spec: { assetMap: { file: mapFile, url: '/assets/map.js', expectedSha256: digest(mapContent) } } };
      assert.equal((await snapshot(options)).success, false);
      const exclusion = { path: '/assets/ui/unpublished-card.webp', reason: '已审请求返回HTML而非媒体，未承诺对应功能',
        reference: { file: sourceFile, url: '/assets/entry.js', expectedSha256: digest(code) } };
      options.spec.exclusions = [exclusion];
      unavailableRequests = 0;
      const result = await snapshot(options);
      assert.equal(result.success, true);
      assert.equal(unavailableRequests, 0);
      assert.equal(result.report.closure, 'pending_runtime_verification');
      assert.equal(result.report.exclusions[0].reference.expectedSha256, digest(code));
      options.spec.exclusions = [{ ...exclusion, path: '/assets/never-referenced.webp' }];
      await assert.rejects(snapshot(options), /not statically referenced/);
      options.spec.exclusions = [{ ...exclusion, reference: { ...exclusion.reference, expectedSha256: '0'.repeat(64) } }];
      await assert.rejects(snapshot(options), /reference SHA mismatch/);
      options.spec.exclusions = [exclusion];
      remoteCode = code + ' const drift=true;';
      const drift = await snapshot(options);
      assert.equal(drift.success, false);
      assert.ok(drift.report.failures.some(f => f.reason.includes('reference_source_changed')));
    });
  });
});

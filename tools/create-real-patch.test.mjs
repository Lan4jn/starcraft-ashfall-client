// tools/create-real-patch.test.mjs - 真实补丁策略生成器回归测试
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { generateRealPatchPolicy, writeRealPatchPolicy } from './create-real-patch.mjs';
import { validatePolicySchema, adaptAssets } from './adapt.mjs';

export const AUDITED_TELEMETRY_BODY = `
/* The game's module uses top-level await, a syntax error in Chrome 88, Safari 14 and the old X5 kernel of WeChat:
   there it never runs and the page stays on its loading bar, uncounted. A one-line module probes for it, and a page
   where it did not run is counted as old-browser (src/telemetry-rules.js). Nothing changes on screen. */
(function () {
  try {
    var probe = document.createElement('script'); probe.type = 'module'; probe.textContent = 'await 0; window.__tlaOk = true;';
    document.head.appendChild(probe);
    setTimeout(function () {
      if (window.__tlaOk || /^(localhost|127\\.0\\.0\\.1|\\[::1\\])$/.test(location.hostname)) return;
      var phone = window.matchMedia && matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820;
      var text = JSON.stringify({ event: 'old-browser', device: phone ? 'phone' : 'desktop' });
      if (navigator.sendBeacon) navigator.sendBeacon('/api/events', new Blob([text], { type: 'text/plain' }));
    }, 3000);
  } catch (error) { /* Counting must never stop the page. */ }
})();
`;

// 构造与实际 remote-entry.html 结构一致的测试 fixture
async function setupRemoteEntryFixture(tmpDir, overrides = {}) {
  const inDir = path.join(tmpDir, 'vendor-in');
  await fs.mkdir(inDir, { recursive: true });

  const htmlContent = overrides.html ?? [
    '<!doctype html><html><head>',
    '  <script type="module" crossorigin src="/assets/game-DqqbYs5s.js"></script>',
    '</head><body><main id="app">',
    '  <div class="console-cap"><span class="terminal-status"><i></i> ONLINE</span></div>',
    '  <footer class="deployment-footer"><a class="author-credit" href="https://ji-games.pages.dev/">Ji 制作</a><button class="author-link feedback-link" id="feedback-open" type="button" data-i18n="feedback.open">反馈</button><a class="lab-link" id="lab-link" href="/interface.html" data-i18n="welcome.lab" hidden>界面试装台</a></footer>',
    '  <section id="modal"><button id="feedback-debrief" class="text-button" data-i18n="feedback.debrief">给作者说两句</button></section>',
    '  <section id="feedback"><button id="feedback-send" class="sc2-button primary"><span data-i18n="feedback.send">发送</span></button></section>',
    '  <section id="error"><button onclick="location.reload()" data-i18n="error.reload">重新载入战场</button></section>',
    `</main><script>${AUDITED_TELEMETRY_BODY}</script><!-- Cloudflare Pages Analytics --><script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "b5e7501d5f3e4d76948d6dd138899b0d"}'></script><!-- Cloudflare Pages Analytics --></body></html>`
  ].join('\n');

  await fs.writeFile(path.join(inDir, 'index.html'), htmlContent, 'utf-8');

  const htmlHash = crypto.createHash('sha256').update(Buffer.from(htmlContent)).digest('hex');
  const assets = [
    { sourceUrl: 'https://example.com/index.html', path: 'index.html', size: Buffer.byteLength(htmlContent), sha256: htmlHash, contentType: 'text/html' }
  ];

  const manifestBytes = Buffer.from(JSON.stringify(assets, null, 2), 'utf-8');
  await fs.writeFile(path.join(inDir, 'assets.json'), manifestBytes);

  const report = overrides.report ?? { consistency: 'consistent', failures: [] };
  await fs.writeFile(path.join(inDir, 'snapshot-report.json'), JSON.stringify(report, null, 2), 'utf-8');

  const gateScriptPath = path.join(tmpDir, 'offline-gate.js');
  await fs.writeFile(gateScriptPath, 'window.__ASHFALL_OFFLINE__ = true;', 'utf-8');

  return { inDir, htmlHash, gateScriptPath, manifestBytes };
}

test('1. generateRealPatchPolicy: 生成符合紧凑 schemaVersion:1 的策略对象', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'patch-gen-test-'));
  try {
    const { inDir, htmlHash, gateScriptPath, manifestBytes } = await setupRemoteEntryFixture(tmpDir);

    const policy = await generateRealPatchPolicy({
      inDir,
      offlineGateScriptPath: gateScriptPath,
      policyId: 'starcraft-ashfall-offline-v1'
    });

    // 1.1 严格符合 schema
    validatePolicySchema(policy);

    // 1.2 校验哈希绑定
    const expectedManifestSha = crypto.createHash('sha256').update(manifestBytes).digest('hex');
    assert.equal(policy.sourceManifestSha256, expectedManifestSha);
    assert.equal(policy.files.length, 1);
    assert.equal(policy.files[0].path, 'index.html');
    assert.equal(policy.files[0].sourceSha256, htmlHash);

    // 1.3 校验全部预期字面量替换数量
    assert.equal(policy.files[0].replacements.length, 9);
    for (const r of policy.files[0].replacements) {
      assert.equal(r.expectedCount, 1);
    }

    // 1.4 附加文件包含 offline-gate.js
    assert.equal(policy.additionalFiles.length, 1);
    assert.equal(policy.additionalFiles[0].path, 'offline-gate.js');
    assert.equal(policy.additionalFiles[0].content, 'window.__ASHFALL_OFFLINE__ = true;');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('2. 端到端验证：生成的 policy 能够成功被 adaptAssets 消费并保障离线隔离', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'patch-e2e-test-'));
  try {
    const { inDir, gateScriptPath } = await setupRemoteEntryFixture(tmpDir);
    const outDir = path.join(tmpDir, 'game-out');

    const policy = await generateRealPatchPolicy({
      inDir,
      offlineGateScriptPath: gateScriptPath,
    });

    const result = await adaptAssets({ inDir, outDir, patchSpec: policy });
    assert.equal(result.success, true);
    assert.equal(result.report.policyVerification.hashVerified, true);
    assert.equal(result.report.policyVerification.countsMatched, true);

    const adaptedHtml = await fs.readFile(path.join(outDir, 'index.html'), 'utf-8');
    // 门禁脚本先于主模块加载
    assert.ok(adaptedHtml.indexOf('<script src="./offline-gate.js"></script>') < adaptedHtml.indexOf('<script type="module"'));
    // 遥测和 CF 移除
    assert.ok(!adaptedHtml.includes('cloudflareinsights.com'));
    assert.ok(!adaptedHtml.includes('window.__tlaOk'));
    // 按钮禁用且保留 ID
    assert.ok(adaptedHtml.includes('id="feedback-open"') && adaptedHtml.includes('id="feedback-send"') && adaptedHtml.includes('id="feedback-debrief"'));
    assert.ok(!adaptedHtml.includes('data-i18n="feedback.open"'));
    // 状态变更为 LOCAL
    assert.ok(adaptedHtml.includes('LOCAL'));
    assert.ok(!adaptedHtml.includes('ONLINE'));
    // onclick reload 禁用
    assert.ok(!adaptedHtml.includes('location.reload()'));
    assert.ok(adaptedHtml.includes('关闭后重新打开'));
    // lab-link 包含 display: none !important
    assert.ok(adaptedHtml.includes('style="display: none !important;"'));
    // 作者署名保留
    assert.ok(adaptedHtml.includes('Ji 制作'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('3. Fail-Closed: 报告不一致或存在失败时拒绝生成策略', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'patch-fail-report-'));
  try {
    const { inDir, gateScriptPath } = await setupRemoteEntryFixture(tmpDir, {
      report: { consistency: 'inconsistent', failures: [] }
    });

    await assert.rejects(
      async () => {
        await generateRealPatchPolicy({ inDir, offlineGateScriptPath: gateScriptPath });
      },
      /consistency/i
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('4. Fail-Closed: 未知 HTML 构建结构（缺少必要锚点）时拒绝生成策略', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'patch-unknown-html-'));
  try {
    // 缺少 feedback 按钮与 main module 的异常 HTML
    const strangeHtml = '<html><body><h1>Unknown Game Variant</h1></body></html>';
    const { inDir, gateScriptPath } = await setupRemoteEntryFixture(tmpDir, { html: strangeHtml });

    await assert.rejects(
      async () => {
        await generateRealPatchPolicy({ inDir, offlineGateScriptPath: gateScriptPath });
      },
      /anchor mismatch|cannot find/i
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('5. writeRealPatchPolicy: 默认拒绝覆写已存在文件，提供排他防覆盖（非整文件原子写）', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'patch-write-test-'));
  try {
    const outPath = path.join(tmpDir, 'source-patch.json');
    const dummyPolicy = {
      schemaVersion: 1,
      id: 'test-policy',
      sourceManifestSha256: '0'.repeat(64),
      files: [
        {
          path: 'index.html',
          sourceSha256: '1'.repeat(64),
          replacements: [{ search: 'a', replace: 'b', expectedCount: 1 }],
        }
      ],
    };

    await writeRealPatchPolicy(dummyPolicy, outPath);
    assert.equal(await fs.stat(outPath).then(() => true).catch(() => false), true);

    // 默认禁止覆盖
    await assert.rejects(
      async () => {
        await writeRealPatchPolicy(dummyPolicy, outPath);
      },
      /already exists|EEXIST/i
    );

    // 允许显式覆盖
    await writeRealPatchPolicy(dummyPolicy, outPath, { overwrite: true });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('6. Fail-Closed: 未知或混入关键游戏逻辑的旧浏览器遥测脚本拒绝（严格体哈希校验）', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'patch-mixed-telemetry-'));
  try {
    // 构造混入了游戏关键状态的遥测脚本
    const mixedTelemetryBody = `${AUDITED_TELEMETRY_BODY}\nwindow.CriticalGameState = 1;`;
    const mixedHtml = [
      '<!doctype html><html><head>',
      '  <script type="module" crossorigin src="/assets/game-DqqbYs5s.js"></script>',
      '</head><body><main id="app">',
      '  <div class="console-cap"><span class="terminal-status"><i></i> ONLINE</span></div>',
      '  <footer class="deployment-footer"><a class="author-credit" href="https://ji-games.pages.dev/">Ji 制作</a><button class="author-link feedback-link" id="feedback-open" type="button" data-i18n="feedback.open">反馈</button><a class="lab-link" id="lab-link" href="/interface.html" data-i18n="welcome.lab" hidden>界面试装台</a></footer>',
      '  <section id="modal"><button id="feedback-debrief" class="text-button" data-i18n="feedback.debrief">给作者说两句</button></section>',
      '  <section id="feedback"><button id="feedback-send" class="sc2-button primary"><span data-i18n="feedback.send">发送</span></button></section>',
      '  <section id="error"><button onclick="location.reload()" data-i18n="error.reload">重新载入战场</button></section>',
      `</main><script>${mixedTelemetryBody}</script><!-- Cloudflare Pages Analytics --><script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "b5e7501d5f3e4d76948d6dd138899b0d"}'></script><!-- Cloudflare Pages Analytics --></body></html>`
    ].join('\n');

    const { inDir, gateScriptPath } = await setupRemoteEntryFixture(tmpDir, { html: mixedHtml });

    await assert.rejects(
      async () => {
        await generateRealPatchPolicy({ inDir, offlineGateScriptPath: gateScriptPath });
      },
      /body hash mismatch or mixed code detected/i
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('7. Fail-Closed: 游戏内联脚本提及 CF 域名不得误判为 beacon，缺少真正 CF beacon 时拒绝', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'patch-cf-preserve-'));
  try {
    // 包含提及 CF 域名的游戏脚本，但缺少真正的 CF beacon
    const htmlWithGameCf = [
      '<!doctype html><html><head>',
      '  <script type="module" crossorigin src="/assets/game-DqqbYs5s.js"></script>',
      '  <script>const CF_MIRROR = "https://static.cloudflareinsights.com/fake.js";</script>',
      '</head><body><main id="app">',
      '  <div class="console-cap"><span class="terminal-status"><i></i> ONLINE</span></div>',
      '  <footer class="deployment-footer"><a class="author-credit" href="https://ji-games.pages.dev/">Ji 制作</a><button class="author-link feedback-link" id="feedback-open" type="button" data-i18n="feedback.open">反馈</button><a class="lab-link" id="lab-link" href="/interface.html" data-i18n="welcome.lab" hidden>界面试装台</a></footer>',
      '  <section id="modal"><button id="feedback-debrief" class="text-button" data-i18n="feedback.debrief">给作者说两句</button></section>',
      '  <section id="feedback"><button id="feedback-send" class="sc2-button primary"><span data-i18n="feedback.send">发送</span></button></section>',
      '  <section id="error"><button onclick="location.reload()" data-i18n="error.reload">重新载入战场</button></section>',
      `</main><script>${AUDITED_TELEMETRY_BODY}</script></body></html>`
    ].join('\n');

    const { inDir, gateScriptPath } = await setupRemoteEntryFixture(tmpDir, { html: htmlWithGameCf });

    await assert.rejects(
      async () => {
        await generateRealPatchPolicy({ inDir, offlineGateScriptPath: gateScriptPath });
      },
      /Cannot find Cloudflare beacon script anchor/i
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('8. Fail-Closed: assets.json 中 index.html 缺少或非法 64-hex sha256 时拒绝', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'patch-invalid-asset-sha-'));
  try {
    const { inDir, gateScriptPath } = await setupRemoteEntryFixture(tmpDir);

    // 修改 assets.json 使 index.html sha256 缺失
    const manifestBytes = await fs.readFile(path.join(inDir, 'assets.json'));
    const assets = JSON.parse(manifestBytes.toString('utf-8'));
    delete assets[0].sha256;
    await fs.writeFile(path.join(inDir, 'assets.json'), JSON.stringify(assets, null, 2), 'utf-8');

    await assert.rejects(
      async () => {
        await generateRealPatchPolicy({ inDir, offlineGateScriptPath: gateScriptPath });
      },
      /Missing or invalid sha256.*index\.html/i
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('9. Fail-Closed: 遥测脚本若携带 src 属性（如 src="/critical-game.js"）绝不可误删', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'patch-telemetry-foreign-src-'));
  try {
    // 构造带有外部关键脚本 src 的遥测标签
    const foreignSrcHtml = [
      '<!doctype html><html><head>',
      '  <script type="module" crossorigin src="/assets/game-DqqbYs5s.js"></script>',
      '</head><body><main id="app">',
      '  <div class="console-cap"><span class="terminal-status"><i></i> ONLINE</span></div>',
      '  <footer class="deployment-footer"><a class="author-credit" href="https://ji-games.pages.dev/">Ji 制作</a><button class="author-link feedback-link" id="feedback-open" type="button" data-i18n="feedback.open">反馈</button><a class="lab-link" id="lab-link" href="/interface.html" data-i18n="welcome.lab" hidden>界面试装台</a></footer>',
      '  <section id="modal"><button id="feedback-debrief" class="text-button" data-i18n="feedback.debrief">给作者说两句</button></section>',
      '  <section id="feedback"><button id="feedback-send" class="sc2-button primary"><span data-i18n="feedback.send">发送</span></button></section>',
      '  <section id="error"><button onclick="location.reload()" data-i18n="error.reload">重新载入战场</button></section>',
      `</main><script src="/critical-game.js">${AUDITED_TELEMETRY_BODY}</script><!-- Cloudflare Pages Analytics --><script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "b5e7501d5f3e4d76948d6dd138899b0d"}'></script><!-- Cloudflare Pages Analytics --></body></html>`
    ].join('\n');

    const { inDir, gateScriptPath } = await setupRemoteEntryFixture(tmpDir, { html: foreignSrcHtml });

    await assert.rejects(
      async () => {
        await generateRealPatchPolicy({ inDir, offlineGateScriptPath: gateScriptPath });
      },
      /foreign attributes\/src detected/i
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

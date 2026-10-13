// tools/adapt.test.mjs - 离线适配器紧凑策略与物理安全严格回归测试
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { adaptHtml, adaptJs, offlineCsp, adaptAssets, computeFileHash, validatePolicySchema } from './adapt.mjs';

// 辅助函数：构造测试用的完整一致构建与绑定策略
async function setupConsistentFixture(dir, options = {}) {
  const inDir = path.join(dir, 'vendor-in');
  const outDir = path.join(dir, 'game-out');
  await fs.mkdir(inDir, { recursive: true });

  const html = options.html ?? '<html><head><script src="https://static.cloudflareinsights.com/beacon.min.js"></script></head><body><button id="feedback-send" data-i18n="send">发送反馈</button></body></html>';
  const js = options.js ?? 'function run() { return "original"; }';

  await fs.writeFile(path.join(inDir, 'index.html'), html, 'utf-8');
  await fs.writeFile(path.join(inDir, 'main.js'), js, 'utf-8');

  const htmlHash = crypto.createHash('sha256').update(Buffer.from(html)).digest('hex');
  const jsHash = crypto.createHash('sha256').update(Buffer.from(js)).digest('hex');

  const assets = [
    { sourceUrl: 'https://fixture.test/index.html', path: 'index.html', contentType: 'text/html', size: Buffer.byteLength(html), sha256: htmlHash },
    { sourceUrl: 'https://fixture.test/main.js', path: 'main.js', contentType: 'application/javascript', size: Buffer.byteLength(js), sha256: jsHash },
  ];

  const manifestBytes = Buffer.from(JSON.stringify(assets, null, 2), 'utf-8');
  await fs.writeFile(path.join(inDir, 'assets.json'), manifestBytes);
  const manifestSha256 = crypto.createHash('sha256').update(manifestBytes).digest('hex');

  await fs.writeFile(
    path.join(inDir, 'snapshot-report.json'),
    JSON.stringify({ consistency: 'consistent', failures: [] }, null, 2),
    'utf-8'
  );

  const policy = {
    schemaVersion: 1,
    id: 'ashfall-test-policy-v1',
    sourceManifestSha256: manifestSha256,
    files: [
      {
        path: 'index.html',
        sourceSha256: htmlHash,
        replacements: [
          {
            search: '<script src="https://static.cloudflareinsights.com/beacon.min.js"></script>',
            replace: '',
            expectedCount: 1,
          },
          {
            search: '<button id="feedback-send" data-i18n="send">发送反馈</button>',
            replace: '<button id="feedback-send" disabled title="本地版不提供在线反馈">本地版不提供在线反馈</button>',
            expectedCount: 1,
          }
        ]
      }
    ],
    additionalFiles: [
      {
        path: 'offline-gate.js',
        content: 'window.__OFFLINE_GATE__ = true;',
        contentType: 'application/javascript',
      }
    ]
  };

  return { inDir, outDir, policy, manifestSha256, htmlHash, jsHash };
}

test('1. adaptHtml: 逐script提取、独立信标移除、混合游戏脚本拒绝、移除data-i18n防语言覆写', () => {
  const safeInput = [
    '<!DOCTYPE html><html><head>',
    '<script>const GAME_INITIALIZED = true;</script>',
    '<script src="https://static.cloudflareinsights.com/beacon.min.js"></script>',
    '<script>function runSimulation() { return 100; }</script>',
    '</head><body>',
    '<button id="feedback-send" data-i18n="feedback.send">发送反馈</button>',
    '<button id="feedback-open" data-i18n="feedback.open">打开反馈</button>',
    '</body></html>'
  ].join('\n');

  const output = adaptHtml(safeInput);
  assert.ok(output.includes('const GAME_INITIALIZED = true;'), '首个游戏script不得被连坐删除');
  assert.ok(output.includes('function runSimulation'), '后续游戏script不得被连坐删除');
  assert.ok(!output.includes('cloudflareinsights.com'), '独立beacon标签必须移除');
  assert.ok(output.includes('本地版不提供在线反馈'));
  assert.ok(output.includes('disabled'));
  assert.ok(!output.includes('data-i18n="feedback.send"'));
  assert.ok(!output.includes('data-i18n="feedback.open"'));
  assert.equal(adaptHtml(output), output, '幂等性保障');

  const mixedInput = [
    '<html><head>',
    '<script>',
    'const criticalGameState = { wave: 5 };',
    'navigator.serviceWorker.register("/sw.js");',
    '</script>',
    '</head></html>'
  ].join('\n');

  assert.throws(
    () => { adaptHtml(mixedInput); },
    /mixed|cannot safely remove|fail closed/i
  );
});

test('2. adaptJs: 默认拒绝篡改JS以保护仿真；支持确切字面量与正整数计数', () => {
  const code = 'function sendTelemetry() { fetch("/api/log"); } function sim() { return 1; }';

  assert.throws(
    () => { adaptJs(code); },
    /explicit patch spec required|reject js modification/i
  );

  const adapted = adaptJs(code, {
    patchSpec: {
      replacements: [
        {
          search: 'fetch("/api/log");',
          replace: '/* disabled */ void 0;',
          expectedCount: 1,
        }
      ]
    }
  });

  assert.ok(adapted.includes('/* disabled */ void 0;'));
  assert.ok(adapted.includes('function sim() { return 1; }'));

  assert.throws(
    () => {
      adaptJs(code, {
        patchSpec: {
          replacements: [
            {
              search: 'non_existent();',
              replace: '',
              expectedCount: 1,
            }
          ]
        }
      });
    },
    /expected 1 replacement/i
  );

  // 2.3 必须提供正安全整数 expectedCount，缺少或非正整数时抛错
  assert.throws(
    () => {
      adaptJs(code, {
        patchSpec: {
          replacements: [
            {
              search: 'fetch("/api/log");',
              replace: '',
              // 缺少 expectedCount
            }
          ]
        }
      });
    },
    /expectedCount must be a positive integer/i
  );

  assert.throws(
    () => {
      adaptJs(code, {
        patchSpec: {
          replacements: [
            {
              search: 'fetch("/api/log");',
              replace: '',
              expectedCount: 0,
            }
          ]
        }
      });
    },
    /expectedCount must be a positive integer/i
  );
});

test('3. offlineCsp: 包含精确 runtime IPC 与 worker-src，禁止公网与通配', () => {
  const csp = offlineCsp();
  assert.ok(csp.includes("worker-src 'self' blob:"));
  assert.ok(csp.includes("connect-src 'self' blob: ipc: http://ipc.localhost"));
  const scriptTokens = csp.split(';').find((d) => d.trim().startsWith('script-src ')).trim().split(/\s+/);
  assert.deepEqual(scriptTokens, ['script-src', "'self'", 'blob:', "'wasm-unsafe-eval'"]);
  assert.ok(!scriptTokens.includes("'unsafe-eval'"));
  assert.ok(!scriptTokens.includes("'unsafe-inline'"));
  assert.ok(!csp.includes('*'));
  assert.ok(!csp.includes('http://*'));
  assert.ok(!csp.includes('https://*'));
});

test('4. Policy Schema 严格校验：拒未知字段、schemaVersion===1、expectedCount为正整数', () => {
  // 4.1 schemaVersion 错误
  assert.throws(
    () => validatePolicySchema({ schemaVersion: 2, id: 'x', sourceManifestSha256: 'a'.repeat(64), files: [] }),
    /schemaVersion/i
  );

  // 4.2 未知顶层字段拒绝
  assert.throws(
    () => validatePolicySchema({
      schemaVersion: 1,
      id: 'x',
      sourceManifestSha256: 'a'.repeat(64),
      files: [],
      unknownField: true,
    }),
    /unknown field/i
  );

  // 4.3 expectedCount 必须为正整数
  assert.throws(
    () => validatePolicySchema({
      schemaVersion: 1,
      id: 'x',
      sourceManifestSha256: 'a'.repeat(64),
      files: [
        {
          path: 'index.html',
          sourceSha256: 'b'.repeat(64),
          replacements: [{ search: 'a', replace: 'b', expectedCount: 0 }]
        }
      ]
    }),
    /expectedCount/i
  );
});

test('5. sourceManifestSha256 原始字节绑定校验失败时 Fail-Closed', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adapt-manifest-sha-'));
  try {
    const { inDir, outDir, policy } = await setupConsistentFixture(tmpDir);
    // 篡改 policy 中的期望 manifest 哈希
    policy.sourceManifestSha256 = '0'.repeat(64);

    await assert.rejects(
      async () => {
        await adaptAssets({ inDir, outDir, patchSpec: policy });
      },
      /sourceManifestSha256 mismatch/i
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('6. physical realpath 包含性与路径穿越防御（包含绝对路径、相对逃逸与Junction链接逃逸）', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adapt-realpath-'));
  try {
    const { inDir, outDir, policy } = await setupConsistentFixture(tmpDir);

    // 6.1 相对路径逃逸
    const badManifest1 = Buffer.from(JSON.stringify([
      { path: '../outside.js', size: 10, sha256: 'a'.repeat(64) }
    ]));
    await fs.writeFile(path.join(inDir, 'assets.json'), badManifest1);
    policy.sourceManifestSha256 = crypto.createHash('sha256').update(badManifest1).digest('hex');

    await assert.rejects(
      async () => {
        await adaptAssets({ inDir, outDir, patchSpec: policy });
      },
      /containment|traversal|escapes/i
    );

    // 6.2 Junction/符号链接逃逸（物理 realpath 校验）
    const outsideTargetDir = path.join(tmpDir, 'outside-target');
    await fs.mkdir(outsideTargetDir, { recursive: true });
    await fs.writeFile(path.join(outsideTargetDir, 'secret.js'), 'secret_content');
    const secretHash = crypto.createHash('sha256').update(Buffer.from('secret_content')).digest('hex');

    // 在 inDir 内创建指向外部目录的 junction
    const junctionLink = path.join(inDir, 'linked-dir');
    try {
      await fs.symlink(outsideTargetDir, junctionLink, 'junction');
      const badManifest2 = Buffer.from(JSON.stringify([
        { path: 'linked-dir/secret.js', size: 14, sha256: secretHash }
      ]));
      await fs.writeFile(path.join(inDir, 'assets.json'), badManifest2);
      policy.sourceManifestSha256 = crypto.createHash('sha256').update(badManifest2).digest('hex');

      await assert.rejects(
        async () => {
          await adaptAssets({ inDir, outDir, patchSpec: policy });
        },
        /Physical path traversal escape|resolves outside/i
      );
    } catch (symlinkErr) {
      if (symlinkErr.code !== 'EPERM') {
        throw symlinkErr;
      }
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('7. files[].sourceSha256 前置校验不匹配时拒绝修改', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adapt-source-sha-'));
  try {
    const { inDir, outDir, policy } = await setupConsistentFixture(tmpDir);
    // 篡改 policy 中 index.html 的 sourceSha256
    policy.files[0].sourceSha256 = 'f'.repeat(64);

    await assert.rejects(
      async () => {
        await adaptAssets({ inDir, outDir, patchSpec: policy });
      },
      /sourceSha256 mismatch/i
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('8. additionalFiles 策略合法性与禁止覆盖原有资产校验', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adapt-additional-'));
  try {
    const { inDir, outDir, policy } = await setupConsistentFixture(tmpDir);

    // 8.1 试图覆盖原有清单中已存在的 index.html
    policy.additionalFiles = [
      { path: 'index.html', content: 'hacked', contentType: 'text/html' }
    ];

    await assert.rejects(
      async () => {
        await adaptAssets({ inDir, outDir, patchSpec: policy });
      },
      /overwrite existing asset|collision/i
    );

    // 8.2 试图通过大写 INDEX.HTML 绕过并触发 NTFS 大小写不区分物理覆盖
    policy.additionalFiles = [
      { path: 'INDEX.HTML', content: 'hacked', contentType: 'text/html' }
    ];

    await assert.rejects(
      async () => {
        await adaptAssets({ inDir, outDir, patchSpec: policy });
      },
      /ASCII case collision|cannot overwrite/i
    );

    // 8.3 试图覆盖 assets.json
    policy.additionalFiles = [
      { path: 'assets.json', content: '[]', contentType: 'application/json' }
    ];

    await assert.rejects(
      async () => {
        await adaptAssets({ inDir, outDir, patchSpec: policy });
      },
      /overwrite|reserved/i
    );

    // 8.4 试图通过大写 ASSETS.JSON 覆盖保留文件
    policy.additionalFiles = [
      { path: 'ASSETS.JSON', content: '[]', contentType: 'application/json' }
    ];

    await assert.rejects(
      async () => {
        await adaptAssets({ inDir, outDir, patchSpec: policy });
      },
      /ASCII case collision|reserved/i
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('9. 紧凑策略完整端到端适配、追加 offline-gate.js、policyVerification 生成', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adapt-e2e-'));
  try {
    const { inDir, outDir, policy, jsHash } = await setupConsistentFixture(tmpDir);

    const res = await adaptAssets({ inDir, outDir, patchSpec: policy });
    assert.equal(res.success, true);
    assert.equal(res.patchedFiles.length, 1);
    assert.equal(res.patchedFiles[0].path, 'index.html');

    // 验证 outDir 内内容
    const outHtml = await fs.readFile(path.join(outDir, 'index.html'), 'utf-8');
    assert.ok(!outHtml.includes('cloudflareinsights.com'));
    assert.ok(outHtml.includes('本地版不提供在线反馈'));

    // 未在 policy.files 中列出的 main.js 原封未动复制
    const outJs = await fs.readFile(path.join(outDir, 'main.js'), 'utf-8');
    assert.equal(crypto.createHash('sha256').update(outJs).digest('hex'), jsHash);

    // 追加的 offline-gate.js 存在且内容正确
    const gateJs = await fs.readFile(path.join(outDir, 'offline-gate.js'), 'utf-8');
    assert.equal(gateJs, 'window.__OFFLINE_GATE__ = true;');

    // 验证 assets.json 包含原有文件与追加文件，且已重算哈希，追加文件带有符合 Rust 反序列化要求的 sourceUrl
    const newAssets = JSON.parse(await fs.readFile(path.join(outDir, 'assets.json'), 'utf-8'));
    assert.equal(newAssets.length, 3);
    const gateAsset = newAssets.find(a => a.path === 'offline-gate.js');
    assert.ok(gateAsset);
    assert.equal(gateAsset.sourceUrl, `local://policy/${policy.id}/offline-gate.js`);
    assert.equal(gateAsset.contentType, 'application/javascript');

    // 验证 patch-report.json 包含 policyVerification 契约对象及清单字节哈希绑定
    const outAssetsBytes = await fs.readFile(path.join(outDir, 'assets.json'));
    const expectedOutManifestSha = crypto.createHash('sha256').update(outAssetsBytes).digest('hex');

    const patchReport = JSON.parse(await fs.readFile(path.join(outDir, 'patch-report.json'), 'utf-8'));
    assert.equal(patchReport.consistency, 'consistent_adapted');
    assert.equal(patchReport.sourceManifestSha256, policy.sourceManifestSha256);
    assert.equal(patchReport.adaptedManifestSha256, expectedOutManifestSha);
    assert.ok(patchReport.policyVerification);
    assert.equal(patchReport.policyVerification.id, policy.id);
    assert.equal(patchReport.policyVerification.hashVerified, true);
    assert.equal(patchReport.policyVerification.countsMatched, true);
    assert.ok(/^[0-9a-f]{64}$/.test(patchReport.policyVerification.policySha256));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('10. Fail-closed: report.failures 非空或 consistency 不一致时拒绝处理', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adapt-report-failures-'));
  try {
    const { inDir, outDir, policy } = await setupConsistentFixture(tmpDir);

    await fs.writeFile(
      path.join(inDir, 'snapshot-report.json'),
      JSON.stringify({ consistency: 'consistent', failures: [{ url: 'missing', reason: '404' }] }),
      'utf-8'
    );

    await assert.rejects(
      async () => {
        await adaptAssets({ inDir, outDir, patchSpec: policy });
      },
      /failures|inconsistent/i
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('11. 原子重命名发布与拒绝已存在的 outDir', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adapt-atomic-rename-'));
  try {
    const { inDir, outDir, policy } = await setupConsistentFixture(tmpDir);

    // 首次运行成功发布
    const res = await adaptAssets({ inDir, outDir, patchSpec: policy });
    assert.equal(res.success, true);

    // 再次向已存在的 outDir 发布时必须拒绝
    await assert.rejects(
      async () => {
        await adaptAssets({ inDir, outDir, patchSpec: policy });
      },
      /already exists/i
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('12. computeFileHash 流式计算验证', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hash-stream-verify-'));
  const filePath = path.join(tmpDir, 'data.bin');
  const buffer = Buffer.from('STREAM_CHUNK_TEST_XYZ_987');
  await fs.writeFile(filePath, buffer);

  try {
    const { sha256, size } = await computeFileHash(filePath);
    assert.equal(sha256, crypto.createHash('sha256').update(buffer).digest('hex'));
    assert.equal(size, buffer.length);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('13. 原始清单 ASCII 大小写重复（ASCII case-folding 冲突）时 Fail-Closed', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adapt-case-dup-'));
  try {
    const inDir = path.join(tmpDir, 'vendor-in');
    const outDir = path.join(tmpDir, 'game-out');
    await fs.mkdir(inDir, { recursive: true });

    await fs.writeFile(path.join(inDir, 'data.js'), 'const a = 1;');
    await fs.writeFile(path.join(inDir, 'DATA.JS'), 'const b = 2;');

    const hash1 = crypto.createHash('sha256').update('const a = 1;').digest('hex');
    const hash2 = crypto.createHash('sha256').update('const b = 2;').digest('hex');

    const duplicateAssets = [
      { path: 'data.js', size: 12, sha256: hash1 },
      { path: 'DATA.JS', size: 12, sha256: hash2 },
    ];

    const rawManifest = Buffer.from(JSON.stringify(duplicateAssets, null, 2), 'utf-8');
    await fs.writeFile(path.join(inDir, 'assets.json'), rawManifest);
    await fs.writeFile(
      path.join(inDir, 'snapshot-report.json'),
      JSON.stringify({ consistency: 'consistent', failures: [] }),
      'utf-8'
    );

    const policy = {
      schemaVersion: 1,
      id: 'test-case-dup-v1',
      sourceManifestSha256: crypto.createHash('sha256').update(rawManifest).digest('hex'),
      files: [],
    };

    await assert.rejects(
      async () => {
        await adaptAssets({ inDir, outDir, patchSpec: policy });
      },
      /Duplicate asset in manifest under ASCII case-folding/i
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('14. 适配报告保留原始限定范围、排除项与运行时未验证状态', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adapt-scope-'));
  try {
    const { inDir, outDir, policy } = await setupConsistentFixture(tmpDir);
    const sourceSnapshot = {
      scope: 'limited_by_asset_map',
      closure: 'pending_runtime_verification',
      exclusions: [{ path: '/assets/unavailable.ogg', reason: '远端返回HTML而非媒体' }],
      notCompleteReason: '候选排除项尚待实际调用验证',
    };
    await fs.writeFile(path.join(inDir, 'snapshot-report.json'), JSON.stringify({
      consistency: 'consistent', failures: [], ...sourceSnapshot,
    }));
    await adaptAssets({ inDir, outDir, patchSpec: policy });
    const report = JSON.parse(await fs.readFile(path.join(outDir, 'patch-report.json'), 'utf8'));
    assert.deepEqual(report.sourceSnapshot, sourceSnapshot);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

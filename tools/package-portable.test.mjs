import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  packagePortable,
  verifyPeHeader,
  computeFileHashAndSize,
  verifyGameDirectory,
  validateAssetPath,
} from './package-portable.mjs';

function computeSha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex').toLowerCase();
}

/**
 * 构造一个合法的最小 Windows x64 PE 二进制文件
 */
async function createValidPe64(filePath) {
  // 建立一个至少 0x80 字节的 buffer
  const buf = Buffer.alloc(0x100);
  // MZ 头
  buf[0] = 0x4d;
  buf[1] = 0x5a;
  // e_lfanew 偏移设为 0x40
  buf.writeUInt32LE(0x40, 0x3c);
  // PE 签名
  buf[0x40] = 0x50; // P
  buf[0x41] = 0x45; // E
  buf[0x42] = 0x00;
  buf[0x43] = 0x00;
  // Machine 字段在 PE + 4 (0x44)
  buf.writeUInt16LE(0x8664, 0x44); // IMAGE_FILE_MACHINE_AMD64

  await fsp.writeFile(filePath, buf);
}

/**
 * 构造包含有效资产与报告的游戏目录
 */
async function createValidGameDir(gameDir, options = {}) {
  await fsp.mkdir(gameDir, { recursive: true });

  const indexHtml = options.indexHtmlContent ?? '<!DOCTYPE html><html><body>Game Entry</body></html>';
  const indexBuf = Buffer.from(indexHtml, 'utf-8');
  await fsp.writeFile(path.join(gameDir, 'index.html'), indexBuf);

  const scriptData = options.scriptContent ?? 'console.log("local script loaded");';
  const scriptBuf = Buffer.from(scriptData, 'utf-8');
  await fsp.mkdir(path.join(gameDir, 'assets'), { recursive: true });
  await fsp.writeFile(path.join(gameDir, 'assets', 'app.js'), scriptBuf);

  const assets = [
    {
      sourceUrl: 'https://example.com/index.html',
      path: 'index.html',
      contentType: 'text/html',
      size: indexBuf.length,
      sha256: computeSha256(indexBuf),
    },
    {
      sourceUrl: 'https://example.com/assets/app.js',
      path: 'assets/app.js',
      contentType: 'application/javascript',
      size: scriptBuf.length,
      sha256: computeSha256(scriptBuf),
    },
  ];

  if (options.corruptSha) {
    assets[0].sha256 = '0'.repeat(64);
  }
  if (options.corruptSize) {
    assets[0].size = indexBuf.length + 99;
  }
  if (options.omitIndex) {
    assets.shift();
  }
  if (options.traversalPath) {
    assets.push({
      sourceUrl: 'https://example.com/bad',
      path: '../outside.js',
      contentType: 'application/javascript',
      size: 10,
      sha256: '0'.repeat(64),
    });
  }

  const manifestRaw = JSON.stringify(assets, null, 2);
  await fsp.writeFile(path.join(gameDir, 'assets.json'), manifestRaw, 'utf-8');

  const patchReport = {
    timestamp: new Date().toISOString(),
    totalPatched: 1,
    consistency: options.consistency ?? 'consistent_adapted',
    adaptedManifestSha256: options.corruptAdaptedManifestSha
      ? '0'.repeat(64)
      : computeSha256(Buffer.from(manifestRaw, 'utf-8')),
    policyVerification: options.policyVerification ?? {
      id: 'starcraft-ashfall-offline-v1',
      hashVerified: true,
      countsMatched: true,
      policySha256: 'a'.repeat(64),
    },
  };

  if (!options.omitPatchReport) {
    await fsp.writeFile(path.join(gameDir, 'patch-report.json'), JSON.stringify(patchReport, null, 2), 'utf-8');
  }

  // 额外放置一个不在清单内的冗余文件，用于验证打包是否严格只复制清单文件
  await fsp.writeFile(path.join(gameDir, 'redundant.tmp'), 'this should not be copied');
}

test('PE Header 校验：有效 Windows x64 PE 通过，损坏/非法架构拒绝', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pe-test-'));
  try {
    const validExe = path.join(tmpDir, 'valid.exe');
    await createValidPe64(validExe);
    assert.equal(await verifyPeHeader(validExe), true);

    // 1. 非 PE 文件（足够长但无 MZ 签名）
    const textFile = path.join(tmpDir, 'plain.txt');
    await fsp.writeFile(textFile, 'This is a long text file that exceeds sixty-four bytes but lacks the MZ signature header.');
    await assert.rejects(verifyPeHeader(textFile), /Invalid DOS signature/);

    // 2. 文件过小
    const smallFile = path.join(tmpDir, 'small.bin');
    await fsp.writeFile(smallFile, Buffer.alloc(10));
    await assert.rejects(verifyPeHeader(smallFile), /too small/);

    // 3. 非 x64 架构（例如 x86 0x014c）
    const x86Exe = path.join(tmpDir, 'x86.exe');
    const x86Buf = Buffer.alloc(0x100);
    x86Buf[0] = 0x4d;
    x86Buf[1] = 0x5a;
    x86Buf.writeUInt32LE(0x40, 0x3c);
    x86Buf[0x40] = 0x50;
    x86Buf[0x41] = 0x45;
    x86Buf.writeUInt16LE(0x014c, 0x44); // IMAGE_FILE_MACHINE_I386
    await fsp.writeFile(x86Exe, x86Buf);
    await assert.rejects(verifyPeHeader(x86Exe), /Invalid PE Machine architecture/);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

test('资源路径语法安全校验', () => {
  assert.doesNotThrow(() => validateAssetPath('index.html'));
  assert.doesNotThrow(() => validateAssetPath('assets/app.js'));
  assert.doesNotThrow(() => validateAssetPath('audio/bgm/track1.ogg'));

  assert.throws(() => validateAssetPath('/index.html'), /leading slash/);
  assert.throws(() => validateAssetPath('assets/'), /trailing slash/);
  assert.throws(() => validateAssetPath('assets/../secret.txt'), /relative traversal/);
  assert.throws(() => validateAssetPath('assets/./app.js'), /relative traversal/);
  assert.throws(() => validateAssetPath('assets//app.js'), /empty or relative/);
  assert.throws(() => validateAssetPath('assets\\app.js'), /forbidden characters/);
  assert.throws(() => validateAssetPath('assets:app.js'), /forbidden characters/);
  assert.throws(() => validateAssetPath('assets%20app.js'), /forbidden characters/);
  assert.throws(() => validateAssetPath('aux.js'), /Windows reserved/);
  assert.throws(() => validateAssetPath('com1.dat'), /Windows reserved/);
});

test('游戏目录校验：正常目录通过，缺失/损坏/篡改严格拒绝', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'game-test-'));
  try {
    const validGame = path.join(tmpDir, 'valid-game');
    await createValidGameDir(validGame);
    const verified = await verifyGameDirectory(validGame);
    assert.equal(verified.assets.length, 2);

    // 1. 资产哈希损坏
    const corruptShaGame = path.join(tmpDir, 'corrupt-sha-game');
    await createValidGameDir(corruptShaGame, { corruptSha: true });
    await assert.rejects(verifyGameDirectory(corruptShaGame), /SHA-256 mismatch/);

    // 2. 资产尺寸不匹配
    const corruptSizeGame = path.join(tmpDir, 'corrupt-size-game');
    await createValidGameDir(corruptSizeGame, { corruptSize: true });
    await assert.rejects(verifyGameDirectory(corruptSizeGame), /size mismatch/);

    // 3. 缺少 index.html
    const noIndexGame = path.join(tmpDir, 'no-index-game');
    await createValidGameDir(noIndexGame, { omitIndex: true });
    await assert.rejects(verifyGameDirectory(noIndexGame), /must contain an entry for 'index\.html'/);

    // 4. 路径遍历逃逸
    const traversalGame = path.join(tmpDir, 'traversal-game');
    await createValidGameDir(traversalGame, { traversalPath: true });
    await assert.rejects(verifyGameDirectory(traversalGame), /relative traversal/);

    // 5. patch-report.json 缺少或 consistency 不匹配
    const badReportGame = path.join(tmpDir, 'bad-report-game');
    await createValidGameDir(badReportGame, { consistency: 'unverified' });
    await assert.rejects(verifyGameDirectory(badReportGame), /patch-report consistency must be 'consistent_adapted'/);

    // 6. policyVerification 未通过 (hashVerified == false)
    const badPolicyGame = path.join(tmpDir, 'bad-policy-game');
    await createValidGameDir(badPolicyGame, {
      policyVerification: {
        id: 'test-policy',
        hashVerified: false,
        countsMatched: true,
        policySha256: 'a'.repeat(64),
      },
    });
    await assert.rejects(verifyGameDirectory(badPolicyGame), /hashVerified must be true/);

    // 7. adaptedManifestSha256 缺失、null 或格式非法坚决拒绝 (禁止绕过)
    const missingHashGame = path.join(tmpDir, 'missing-hash-game');
    await createValidGameDir(missingHashGame);
    const missingReportPath = path.join(missingHashGame, 'patch-report.json');
    const missingReport = JSON.parse(await fsp.readFile(missingReportPath, 'utf-8'));
    delete missingReport.adaptedManifestSha256;
    await fsp.writeFile(missingReportPath, JSON.stringify(missingReport, null, 2), 'utf-8');
    await assert.rejects(
      verifyGameDirectory(missingHashGame),
      /missing or invalid adaptedManifestSha256/
    );

    const nullHashGame = path.join(tmpDir, 'null-hash-game');
    await createValidGameDir(nullHashGame);
    const nullReportPath = path.join(nullHashGame, 'patch-report.json');
    const nullReport = JSON.parse(await fsp.readFile(nullReportPath, 'utf-8'));
    nullReport.adaptedManifestSha256 = null;
    await fsp.writeFile(nullReportPath, JSON.stringify(nullReport, null, 2), 'utf-8');
    await assert.rejects(
      verifyGameDirectory(nullHashGame),
      /missing or invalid adaptedManifestSha256/
    );

    const invalidHexGame = path.join(tmpDir, 'invalid-hex-game');
    await createValidGameDir(invalidHexGame);
    const invalidHexReportPath = path.join(invalidHexGame, 'patch-report.json');
    const invalidHexReport = JSON.parse(await fsp.readFile(invalidHexReportPath, 'utf-8'));
    invalidHexReport.adaptedManifestSha256 = 'not-a-valid-64-hex';
    await fsp.writeFile(invalidHexReportPath, JSON.stringify(invalidHexReport, null, 2), 'utf-8');
    await assert.rejects(
      verifyGameDirectory(invalidHexGame),
      /missing or invalid adaptedManifestSha256/
    );

    // 8. adaptedManifestSha256 漂移拒绝
    const driftGame = path.join(tmpDir, 'drift-game');
    await createValidGameDir(driftGame);
    const reportPath = path.join(driftGame, 'patch-report.json');
    const report = JSON.parse(await fsp.readFile(reportPath, 'utf-8'));
    report.adaptedManifestSha256 = 'f'.repeat(64); // 注入不匹配的 adapted manifest hash
    await fsp.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');
    await assert.rejects(verifyGameDirectory(driftGame), /Manifest hash drift detected/);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

test('目录联结物理逃逸 (Directory Junction Containment)：必须实际校验并拒绝', async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'junction-test-'));
  try {
    const gameDir = path.join(tmpDir, 'game');
    await createValidGameDir(gameDir);

    const outsideDir = path.join(tmpDir, 'outside');
    await fsp.mkdir(outsideDir, { recursive: true });
    const outsideFile = path.join(outsideDir, 'secret.js');
    await fsp.writeFile(outsideFile, 'secret outside content');

    const junctionTarget = path.join(gameDir, 'linked_dir');

    try {
      // Windows 下创建 junction 目录联结无需特权
      await fsp.symlink(outsideDir, junctionTarget, 'junction');
    } catch (err) {
      t.skip(`Directory junction creation skipped: ${err.message}`);
      return;
    }

    const assetsPath = path.join(gameDir, 'assets.json');
    const assetsList = JSON.parse(await fsp.readFile(assetsPath, 'utf-8'));
    assetsList.push({
      sourceUrl: 'https://example.com/linked_dir/secret.js',
      path: 'linked_dir/secret.js',
      contentType: 'application/javascript',
      size: 22,
      sha256: computeSha256(Buffer.from('secret outside content')),
    });
    const newManifestRaw = JSON.stringify(assetsList, null, 2);
    await fsp.writeFile(assetsPath, newManifestRaw, 'utf-8');

    // 同步更新 patch-report.json 中的 adaptedManifestSha256，使校验深入至目录物理逃逸检查
    const reportPath = path.join(gameDir, 'patch-report.json');
    const report = JSON.parse(await fsp.readFile(reportPath, 'utf-8'));
    report.adaptedManifestSha256 = computeSha256(Buffer.from(newManifestRaw, 'utf-8'));
    await fsp.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');

    // 必须实际执行校验并抛出 Physical path containment escape
    await assert.rejects(
      verifyGameDirectory(gameDir),
      /Physical path containment escape/
    );
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

test('CLI 参数与退出码验证 (spawnSync stdio ignore)', () => {
  const scriptPath = path.resolve('tools/package-portable.mjs');

  // 1. --help 应该返回退出码 0
  const helpRes = spawnSync(process.execPath, [scriptPath, '--help'], {
    stdio: 'ignore',
  });
  assert.equal(helpRes.status, 0);

  // 2. 缺少参数应该返回退出码 1
  const noArgsRes = spawnSync(process.execPath, [scriptPath], {
    stdio: 'ignore',
  });
  assert.equal(noArgsRes.status, 1);

  // 3. 部分参数缺少应该返回退出码 1
  const partialArgsRes = spawnSync(
    process.execPath,
    [scriptPath, '--exe', 'foo.exe'],
    { stdio: 'ignore' }
  );
  assert.equal(partialArgsRes.status, 1);
});

test('完整打包流程：成功发布便携目录、排他只复制清单资源、生成运行说明', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'package-full-test-'));
  try {
    const exePath = path.join(tmpDir, 'ashfall-built.exe');
    await createValidPe64(exePath);

    const gameDir = path.join(tmpDir, 'adapted-game');
    await createValidGameDir(gameDir);

    const outDir = path.join(tmpDir, 'dist', 'Ashfall-Portable');

    const result = await packagePortable({
      exe: exePath,
      game: gameDir,
      out: outDir,
    });

    assert.equal(result.success, true);
    assert.equal(result.outDir, outDir);
    assert.equal(result.totalAssets, 2);

    // 1. 验证输出目录存在且包含 ashfall-local.exe
    const targetExe = path.join(outDir, 'ashfall-local.exe');
    assert.equal((await fsp.stat(targetExe)).isFile(), true);

    // 2. 验证 game 目录下包含清单声明的文件
    assert.equal((await fsp.stat(path.join(outDir, 'game', 'index.html'))).isFile(), true);
    assert.equal((await fsp.stat(path.join(outDir, 'game', 'assets', 'app.js'))).isFile(), true);
    assert.equal((await fsp.stat(path.join(outDir, 'game', 'assets.json'))).isFile(), true);
    assert.equal((await fsp.stat(path.join(outDir, 'game', 'patch-report.json'))).isFile(), true);

    // 3. 验证排他性：源目录中的冗余文件 redundant.tmp 绝不被复制
    let redundantExists = false;
    try {
      await fsp.stat(path.join(outDir, 'game', 'redundant.tmp'));
      redundantExists = true;
    } catch {}
    assert.equal(redundantExists, false, 'Redundant file not in manifest must not be copied');

    // 4. 验证说明文档与元数据
    const readmeContent = await fsp.readFile(path.join(outDir, '使用说明.txt'), 'utf-8');
    assert.match(readmeContent, /WebView2/);
    assert.match(readmeContent, /LOCALAPPDATA/);
    assert.match(readmeContent, /F11/);

    const noticesContent = await fsp.readFile(path.join(outDir, '第三方说明.txt'), 'utf-8');
    assert.match(noticesContent, /暴雪娱乐/);
    assert.match(noticesContent, /原作者/);

    const infoContent = await fsp.readFile(path.join(outDir, 'package-info.json'), 'utf-8');
    assert.match(infoContent, /ashfall-local\.exe/);

    // 5. 验证拒绝覆盖已存在的 out 目录
    await assert.rejects(
      packagePortable({ exe: exePath, game: gameDir, out: outDir }),
      /Target output directory already exists.*Refusing to overwrite/
    );
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

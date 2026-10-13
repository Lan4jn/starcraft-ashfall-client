#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * 校验 Windows x64 PE 二进制文件 Header (MZ + PE signature + Machine == 0x8664)
 * @param {string} exePath
 */
export async function verifyPeHeader(exePath) {
  const stat = await fsp.stat(exePath).catch((err) => {
    throw new Error(`Executable not found or inaccessible: ${exePath} (${err.message})`);
  });

  if (!stat.isFile()) {
    throw new Error(`Executable is not a regular file: ${exePath}`);
  }

  if (stat.size < 0x40) {
    throw new Error(`Executable file is too small to be a valid PE (${stat.size} bytes)`);
  }

  const fd = await fsp.open(exePath, 'r');
  try {
    // 读取 DOS 头 (至少 0x40 字节以读取 e_lfanew)
    const dosHeader = Buffer.alloc(0x40);
    await fd.read(dosHeader, 0, 0x40, 0);

    // 检查 MZ 签名 (0x4D, 0x5A)
    if (dosHeader[0] !== 0x4d || dosHeader[1] !== 0x5a) {
      throw new Error(`Invalid DOS signature: expected 'MZ' (0x4D5A), got 0x${dosHeader[0].toString(16)}${dosHeader[1].toString(16)}`);
    }

    // 读取 PE 头偏移 (0x3C 处的 32-bit LE 整数)
    const peOffset = dosHeader.readUInt32LE(0x3c);
    if (peOffset < 0x40 || peOffset + 24 > stat.size) {
      throw new Error(`Invalid PE header offset: 0x${peOffset.toString(16)} (file size: ${stat.size})`);
    }

    // 读取 PE 签名与 COFF Header (24 字节)
    const peHeader = Buffer.alloc(24);
    await fd.read(peHeader, 0, 24, peOffset);

    // 检查 PE\0\0 签名 (0x50, 0x45, 0x00, 0x00)
    if (
      peHeader[0] !== 0x50 ||
      peHeader[1] !== 0x45 ||
      peHeader[2] !== 0x00 ||
      peHeader[3] !== 0x00
    ) {
      throw new Error('Invalid PE signature: expected PE\\0\\0');
    }

    // 检查 Machine 架构 (偏移 +4 处的 16-bit LE 整数)
    // 0x8664 = IMAGE_FILE_MACHINE_AMD64 (x86-64)
    const machine = peHeader.readUInt16LE(4);
    if (machine !== 0x8664) {
      throw new Error(`Invalid PE Machine architecture: expected 0x8664 (x86-64), got 0x${machine.toString(16)}`);
    }

    return true;
  } finally {
    await fd.close();
  }
}

/**
 * 流式计算文件的 SHA-256 与字节大小
 * @param {string} filePath
 * @returns {Promise<{ sha256: string, size: number }>}
 */
export async function computeFileHashAndSize(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let size = 0;
    const stream = fs.createReadStream(filePath);

    stream.on('data', (chunk) => {
      size += chunk.length;
      hash.update(chunk);
    });

    stream.on('end', () => {
      resolve({
        sha256: hash.digest('hex').toLowerCase(),
        size,
      });
    });

    stream.on('error', (err) => {
      reject(new Error(`Failed to stream and hash file ${filePath}: ${err.message}`));
    });
  });
}

const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * 校验资源相对路径语法安全性
 * @param {string} relPath
 */
export function validateAssetPath(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new Error('Asset path must be a non-empty string');
  }

  if (relPath.startsWith('/') || relPath.startsWith('\\')) {
    throw new Error(`Asset path must not start with a leading slash: ${relPath}`);
  }

  if (relPath.endsWith('/') || relPath.endsWith('\\')) {
    throw new Error(`Asset path must not end with a trailing slash: ${relPath}`);
  }

  if (/[\\:\0%?#]/.test(relPath)) {
    throw new Error(`Asset path contains forbidden characters (\\, :, NUL, %, ?, #): ${relPath}`);
  }

  const segments = relPath.split('/');
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') {
      throw new Error(`Asset path contains empty or relative traversal component: ${relPath}`);
    }

    const stem = seg.split('.')[0].toUpperCase();
    if (WINDOWS_RESERVED_NAMES.has(stem)) {
      throw new Error(`Asset path contains Windows reserved device name '${seg}': ${relPath}`);
    }
  }
}

/**
 * 校验 game 目录下的 assets.json 与 patch-report.json
 * @param {string} gameDir
 */
export async function verifyGameDirectory(gameDir) {
  const stat = await fsp.stat(gameDir).catch((err) => {
    throw new Error(`Game directory not found or inaccessible: ${gameDir} (${err.message})`);
  });

  if (!stat.isDirectory()) {
    throw new Error(`Game path is not a directory: ${gameDir}`);
  }

  // 1. 校验 patch-report.json
  const patchReportPath = path.join(gameDir, 'patch-report.json');
  const patchReportContent = await fsp.readFile(patchReportPath, 'utf-8').catch((err) => {
    throw new Error(`patch-report.json missing or unreadable in ${gameDir}: ${err.message}`);
  });

  let patchReport;
  try {
    patchReport = JSON.parse(patchReportContent);
  } catch (err) {
    throw new Error(`Invalid JSON in patch-report.json: ${err.message}`);
  }

  if (patchReport.consistency !== 'consistent_adapted') {
    throw new Error(
      `patch-report consistency must be 'consistent_adapted', got '${patchReport.consistency}'`
    );
  }

  const pv = patchReport.policyVerification;
  if (!pv || typeof pv !== 'object') {
    throw new Error('patch-report.json missing valid policyVerification object');
  }

  if (pv.hashVerified !== true) {
    throw new Error('policyVerification.hashVerified must be true');
  }

  if (pv.countsMatched !== true) {
    throw new Error('policyVerification.countsMatched must be true');
  }

  if (typeof pv.id !== 'string' || pv.id.trim().length === 0) {
    throw new Error('policyVerification.id must be a non-empty string');
  }

  if (typeof pv.policySha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(pv.policySha256)) {
    throw new Error('policyVerification.policySha256 must be a 64-character hex hash');
  }

  // 2. 校验 assets.json
  const assetsJsonPath = path.join(gameDir, 'assets.json');
  const rawManifestBytes = await fsp.readFile(assetsJsonPath).catch((err) => {
    throw new Error(`assets.json missing or unreadable in ${gameDir}: ${err.message}`);
  });

  const actualManifestSha256 = crypto
    .createHash('sha256')
    .update(rawManifestBytes)
    .digest('hex')
    .toLowerCase();

  // 绑定核对写出的 game/assets.json 原始字节与 patch-report.adaptedManifestSha256，防清单漂移
  // 必须为非空 64 位十六进制哈希，绝不允许缺失、undefined 或 null 绕过
  if (
    typeof patchReport.adaptedManifestSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(patchReport.adaptedManifestSha256)
  ) {
    throw new Error(
      `patch-report.json missing or invalid adaptedManifestSha256: must be a 64-character hex hash, got ${JSON.stringify(
        patchReport.adaptedManifestSha256
      )}`
    );
  }

  if (patchReport.adaptedManifestSha256.toLowerCase() !== actualManifestSha256) {
    throw new Error(
      `Manifest hash drift detected: patch-report adaptedManifestSha256 (${patchReport.adaptedManifestSha256}) does not match assets.json SHA-256 (${actualManifestSha256})`
    );
  }

  let assets;
  try {
    assets = JSON.parse(rawManifestBytes.toString('utf-8'));
  } catch (err) {
    throw new Error(`Invalid JSON in assets.json: ${err.message}`);
  }

  if (!Array.isArray(assets) || assets.length === 0) {
    throw new Error('assets.json must be a non-empty array of asset entries');
  }

  const hasIndex = assets.some((a) => a.path === 'index.html');
  if (!hasIndex) {
    throw new Error("assets.json must contain an entry for 'index.html'");
  }

  // 获取 gameDir 的物理规范路径，用于防符号链接逃逸 (canonical containment)
  // realpath 失败绝不使用 path.resolve 回退，必须 fail-closed 抛出异常
  let realGameDir;
  try {
    realGameDir = await fsp.realpath(path.resolve(gameDir));
  } catch (err) {
    throw new Error(
      `Fail-closed: Failed to resolve canonical realpath for game directory ${gameDir}: ${err.message}`
    );
  }

  const seenPaths = new Set();

  for (const entry of assets) {
    if (!entry.path || typeof entry.path !== 'string') {
      throw new Error(`Asset entry missing path: ${JSON.stringify(entry)}`);
    }

    validateAssetPath(entry.path);

    const lower = entry.path.toLowerCase();
    if (seenPaths.has(lower)) {
      throw new Error(`Duplicate asset path detected (case-insensitive): ${entry.path}`);
    }
    seenPaths.add(lower);

    if (typeof entry.size !== 'number' || entry.size < 0) {
      throw new Error(`Invalid size for asset '${entry.path}': ${entry.size}`);
    }

    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error(`Invalid lowercase SHA-256 for asset '${entry.path}': ${entry.sha256}`);
    }

    const fullFilePath = path.resolve(gameDir, entry.path);

    // 物理 realpath 校验：防御通过符号链接/联结逃逸出 gameDir (Canonical Containment)
    let realFilePath;
    try {
      realFilePath = await fsp.realpath(fullFilePath);
    } catch (err) {
      throw new Error(`Asset file missing or unresolvable '${entry.path}': ${err.message}`);
    }

    if (!realFilePath.startsWith(realGameDir + path.sep) && realFilePath !== realGameDir) {
      throw new Error(
        `Physical path containment escape: asset '${entry.path}' resolves outside game directory via symlink`
      );
    }

    const { sha256: actualSha, size: actualSize } = await computeFileHashAndSize(fullFilePath);

    if (actualSize !== entry.size) {
      throw new Error(
        `Asset size mismatch for '${entry.path}': expected ${entry.size}, actual ${actualSize}`
      );
    }

    if (actualSha !== entry.sha256) {
      throw new Error(
        `Asset SHA-256 mismatch for '${entry.path}': expected ${entry.sha256}, actual ${actualSha}`
      );
    }
  }

  return { patchReport, assets };
}

/**
 * 核心打包流程
 * @param {{ exe: string, game: string, out: string }} options
 */
export async function packagePortable({ exe, game, out }) {
  if (!exe || !game || !out) {
    throw new Error('All of --exe, --game, and --out parameters are required');
  }

  const exePath = path.resolve(exe);
  const gameDir = path.resolve(game);
  const outDir = path.resolve(out);

  // 1. 拒绝已存在的输出目录，杜绝静默覆盖
  if (fs.existsSync(outDir)) {
    throw new Error(`Target output directory already exists: ${outDir}. Refusing to overwrite.`);
  }

  // 2. 校验 PE 二进制文件
  await verifyPeHeader(exePath);

  // 3. 校验游戏资源目录与清单一致性
  const { assets, patchReport } = await verifyGameDirectory(gameDir);

  // 4. 在与输出目录同父目录下创建临时暂存区 (确保原子 rename 不跨卷)
  const parentDir = path.dirname(outDir);
  await fsp.mkdir(parentDir, { recursive: true });

  const stagingDir = path.join(
    parentDir,
    `.staging-${path.basename(outDir)}-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  );

  await fsp.mkdir(stagingDir, { recursive: true });

  try {
    // 5. 复制主可执行文件为 ashfall-local.exe
    const targetExePath = path.join(stagingDir, 'ashfall-local.exe');
    await fsp.copyFile(exePath, targetExePath);

    // 6. 创建目标 game 目录并只复制 manifest 批准的文件
    const targetGameDir = path.join(stagingDir, 'game');
    await fsp.mkdir(targetGameDir, { recursive: true });

    for (const asset of assets) {
      const srcFile = path.join(gameDir, asset.path);
      const destFile = path.join(targetGameDir, asset.path);
      await fsp.mkdir(path.dirname(destFile), { recursive: true });
      await fsp.copyFile(srcFile, destFile);

      // 防 TOCTOU 竞争与拷贝损坏：在 staging 暂存区重新流式校验目标文件哈希与尺寸
      const { sha256: stagingSha, size: stagingSize } = await computeFileHashAndSize(destFile);
      if (stagingSize !== asset.size) {
        throw new Error(
          `Staging copy verification failed for '${asset.path}': size mismatch (expected ${asset.size}, got ${stagingSize})`
        );
      }
      if (stagingSha !== asset.sha256) {
        throw new Error(
          `Staging copy verification failed for '${asset.path}': SHA-256 mismatch (expected ${asset.sha256}, got ${stagingSha})`
        );
      }
    }

    // 复制清单与报告
    await fsp.copyFile(
      path.join(gameDir, 'assets.json'),
      path.join(targetGameDir, 'assets.json')
    );
    await fsp.copyFile(
      path.join(gameDir, 'patch-report.json'),
      path.join(targetGameDir, 'patch-report.json')
    );

    // 7. Post-Copy 全套复核 (Post-Copy Verification)：
    // (a) EXE 字节完整性与哈希一致性复核：比对原始 exePath 与暂存区 targetExePath 的完整 SHA-256 和大小
    const srcExeMeta = await computeFileHashAndSize(exePath);
    const targetExeMeta = await computeFileHashAndSize(targetExePath);
    if (srcExeMeta.size !== targetExeMeta.size || srcExeMeta.sha256 !== targetExeMeta.sha256) {
      throw new Error(
        `Executable copy integrity mismatch: expected SHA-256 ${srcExeMeta.sha256} (${srcExeMeta.size} bytes), got ${targetExeMeta.sha256} (${targetExeMeta.size} bytes)`
      );
    }
    // (b) EXE PE Header 二次复核
    await verifyPeHeader(targetExePath);

    // (c) Staging Game 目录整套复核：以黑盒视角完整复核暂存区内的 game/ 目录结构、清单与资产流式哈希
    await verifyGameDirectory(targetGameDir);

    // 7. 写入中文便携说明文件
    const readmeContent = `《星际争霸：余烬》本地便携客户端运行说明
======================================================

【运行环境要求】
1. Windows 10 / 11 64位操作系统。
2. 系统已安装 Microsoft Edge WebView2 Runtime（Windows 10/11 系统通常已默认预装）。
3. 当前登录用户对 LocalAppData 目录具备常规读写权限。

【启动与使用】
- 直接双击运行目录下的 ashfall-local.exe。
- 程序为完全免安装、绿色便携设计，解压即用。
- 启动时只监听本地回环网络（127.0.0.1）随机端口，页面在线服务受CSP和门禁限制。
- 本包组装与字节校验成功不等于所有游戏功能或离线网络验收通过。
- 原始快照范围：${patchReport.sourceSnapshot?.scope ?? 'unverified'}；闭包状态：${patchReport.sourceSnapshot?.closure ?? 'unverified'}。
- 明确未提供的候选资源：${patchReport.sourceSnapshot?.exclusions?.length ?? 0}项，详细路径及原因见game/patch-report.json。
- 游戏内支持按 F11 键切换窗口模式与全屏模式。

【存档与数据管理】
- 游戏存档独立存储于操作系统的 LocalAppData 目录中：
  %LOCALAPPDATA%\\StarCraftAshfallClient\\save.json
- 程序移动位置或删除本运行目录，不会导致游戏进度丢失。
- 客户端内置双份原子写入与备份保护（save.previous.json），存档异常时拒绝静默覆盖。

【免责与使用范围】
- 本客户端工具仅供个人离线体验与技术研习使用。
- 游戏素材版权归原作者所有，请勿用于任何商业用途或公开非法分发。
`;
    await fsp.writeFile(path.join(stagingDir, '使用说明.txt'), readmeContent, 'utf-8');

    // 8. 写入第三方版权与资产声明
    const noticesContent = `第三方版权与资产许可声明 (Third-Party Notices)
======================================================

1. 《星际争霸：余烬》（StarCraft: Ashfall）同人网页游戏的原始美术素材、3D模型、
   音频、设定文本及衍生内容，其版权与知识产权归原作者及暴雪娱乐（Blizzard Entertainment / Microsoft）所有。

2. 本便携目录包含从公开站点获取并在用户本机适配的第三方网页、游戏脚本和媒体。
   适配内容与资源排除范围见game/patch-report.json；字节核验不等于完整运行验收或版权授权。

3. 工具源码当前没有LICENSE文件，不宣称已开源，也不代表拥有第三方素材分发权。
   本次仅在用户本机进行本地测试，商业用途或公开传播前须核实相应权利人的许可。
`;
    await fsp.writeFile(path.join(stagingDir, '第三方说明.txt'), noticesContent, 'utf-8');

    // 9. 写入包完整性清单 package-info.json
    const packageInfo = {
      packageDate: new Date().toISOString(),
      executable: 'ashfall-local.exe',
      totalAssetsCopied: assets.length,
      manifestAssetsCount: assets.length,
      sourceSnapshot: patchReport.sourceSnapshot ?? null,
    };
    await fsp.writeFile(
      path.join(stagingDir, 'package-info.json'),
      JSON.stringify(packageInfo, null, 2),
      'utf-8'
    );

    // 10. 原子重命名发布
    await fsp.rename(stagingDir, outDir);

    return {
      success: true,
      outDir,
      totalAssets: assets.length,
    };
  } finally {
    // 若中途失败，清理 stagingDir
    await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

// CLI 执行入口
async function main() {
  const args = process.argv.slice(2);
  let exe = '';
  let game = '';
  let out = '';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--exe' && i + 1 < args.length) {
      exe = args[++i];
    } else if (arg === '--game' && i + 1 < args.length) {
      game = args[++i];
    } else if (arg === '--out' && i + 1 < args.length) {
      out = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node package-portable.mjs --exe <path> --game <path> --out <path>');
      process.exit(0);
    }
  }

  if (!exe || !game || !out) {
    console.error('Error: missing required arguments (--exe, --game, --out)');
    console.error('Usage: node package-portable.mjs --exe <path> --game <path> --out <path>');
    process.exit(1);
  }

  try {
    const res = await packagePortable({ exe, game, out });
    console.log(`[package-portable] Successfully packaged portable client to: ${res.outDir}`);
    console.log(`[package-portable] Total manifest assets verified & packaged: ${res.totalAssets}`);
  } catch (err) {
    console.error(`[package-portable] Packaging failed: ${err.message}`);
    process.exit(1);
  }
}

const currentScriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentScriptPath)) {
  main();
}

// tools/adapt.mjs - 离线适配与紧凑策略补丁工具
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * CSP 策略规范：统一从仓库根目录 config/offline-csp.txt 同步加载
 * 保证与 client-core HTTP server 的 include_str! 完全共用单一真相源
 */
export function offlineCsp() {
  const cspUrl = new URL('../config/offline-csp.txt', import.meta.url);
  return fsSync.readFileSync(cspUrl, 'utf-8').trim();
}

/**
 * 流式计算文件 SHA-256 和大小，大文件不一次性载入内存
 * @param {string} filePath
 * @returns {Promise<{ sha256: string, size: number }>}
 */
export function computeFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let size = 0;
    const stream = fsSync.createReadStream(filePath);
    stream.on('data', (chunk) => {
      size += chunk.length;
      hash.update(chunk);
    });
    stream.on('end', () => {
      resolve({ sha256: hash.digest('hex'), size });
    });
    stream.on('error', reject);
  });
}

/**
 * 严格校验 Policy 模式规范 (schemaVersion: 1)
 * 拒绝未知字段、强制 safe integer 预期正整数计数、绑定原始 manifest 哈希
 * @param {any} policy
 */
export function validatePolicySchema(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('Policy must be a non-null object');
  }

  const allowedTopKeys = new Set(['schemaVersion', 'id', 'sourceManifestSha256', 'files', 'additionalFiles']);
  for (const key of Object.keys(policy)) {
    if (!allowedTopKeys.has(key)) {
      throw new Error(`Unknown field in patch policy: ${key}`);
    }
  }

  if (policy.schemaVersion !== 1) {
    throw new Error(`Unsupported policy schemaVersion: ${policy.schemaVersion} (expected 1)`);
  }

  if (typeof policy.id !== 'string' || policy.id.trim().length === 0) {
    throw new Error('Policy id must be a non-empty string');
  }

  if (typeof policy.sourceManifestSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(policy.sourceManifestSha256)) {
    throw new Error('Policy sourceManifestSha256 must be a 64-character hex string');
  }

  if (!Array.isArray(policy.files)) {
    throw new Error('Policy files must be an array');
  }

  const allowedFileKeys = new Set(['path', 'sourceSha256', 'replacements']);
  for (const file of policy.files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      throw new Error('Policy file entry must be an object');
    }
    for (const key of Object.keys(file)) {
      if (!allowedFileKeys.has(key)) {
        throw new Error(`Unknown field in policy file entry: ${key}`);
      }
    }
    if (typeof file.path !== 'string' || file.path.trim().length === 0) {
      throw new Error('Policy file path must be a non-empty string');
    }
    if (typeof file.sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(file.sourceSha256)) {
      throw new Error(`Policy file ${file.path} sourceSha256 must be a 64-character hex string`);
    }
    if (!Array.isArray(file.replacements)) {
      throw new Error(`Policy file ${file.path} replacements must be an array`);
    }
    const allowedRepKeys = new Set(['search', 'replace', 'expectedCount']);
    for (const rep of file.replacements) {
      if (!rep || typeof rep !== 'object' || Array.isArray(rep)) {
        throw new Error('Replacement must be an object');
      }
      for (const key of Object.keys(rep)) {
        if (!allowedRepKeys.has(key)) {
          throw new Error(`Unknown field in replacement: ${key}`);
        }
      }
      if (typeof rep.search !== 'string' || rep.search.length === 0) {
        throw new Error('Replacement search must be a non-empty string');
      }
      if (typeof rep.replace !== 'string') {
        throw new Error('Replacement replace must be a string');
      }
      if (typeof rep.expectedCount !== 'number' || !Number.isSafeInteger(rep.expectedCount) || rep.expectedCount <= 0) {
        throw new Error(`Replacement expectedCount must be a positive integer, got ${rep.expectedCount}`);
      }
    }
  }

  if (policy.additionalFiles !== undefined) {
    if (!Array.isArray(policy.additionalFiles)) {
      throw new Error('Policy additionalFiles must be an array');
    }
    const allowedAddKeys = new Set(['path', 'content', 'contentType']);
    for (const add of policy.additionalFiles) {
      if (!add || typeof add !== 'object' || Array.isArray(add)) {
        throw new Error('additionalFile entry must be an object');
      }
      for (const key of Object.keys(add)) {
        if (!allowedAddKeys.has(key)) {
          throw new Error(`Unknown field in additionalFile: ${key}`);
        }
      }
      if (typeof add.path !== 'string' || add.path.trim().length === 0) {
        throw new Error('additionalFile path must be a non-empty string');
      }
      if (typeof add.content !== 'string' && !Buffer.isBuffer(add.content)) {
        throw new Error('additionalFile content must be a string or Buffer');
      }
      if (typeof add.contentType !== 'string' || add.contentType.trim().length === 0) {
        throw new Error('additionalFile contentType must be a non-empty string');
      }
    }
  }
}

/**
 * 严格路径安全与物理 realpath 沙盒包含性校验
 * @param {string} relPath
 * @param {string} baseDir
 */
async function validateContainedPath(relPath, baseDir) {
  if (typeof relPath !== 'string' || relPath.trim().length === 0) {
    throw new Error('Asset path must be a non-empty string');
  }

  // 1. 语法检查（杜绝绝对路径、驱动器路径与 UNC 路径）
  if (path.isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath) || relPath.startsWith('/') || relPath.startsWith('\\')) {
    throw new Error(`Invalid asset path: absolute or drive path disallowed (${relPath})`);
  }

  const normalized = path.normalize(relPath);
  if (normalized.startsWith('..') || normalized.split(path.sep).includes('..')) {
    throw new Error(`Path traversal escape disallowed (${relPath})`);
  }

  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(baseDir, normalized);

  if (!resolvedTarget.startsWith(resolvedBase + path.sep) && resolvedTarget !== resolvedBase) {
    throw new Error(`Path containment check failed: ${relPath} escapes base directory`);
  }

  // 2. 物理 realpath 检查（解析符号链接、Junction 与重解析点）
  let realBase;
  try {
    realBase = await fs.realpath(resolvedBase);
  } catch {
    realBase = resolvedBase;
  }

  try {
    const realTarget = await fs.realpath(resolvedTarget);
    if (!realTarget.startsWith(realBase + path.sep) && realTarget !== realBase) {
      throw new Error(`Physical path traversal escape: ${relPath} resolves outside base directory`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
    // 目标尚不存在时（例如暂存区中即将写入的新增文件），溯源其最近已存在祖先目录真实路径
    let currentDir = path.dirname(resolvedTarget);
    while (currentDir.length >= resolvedBase.length) {
      try {
        const realDir = await fs.realpath(currentDir);
        if (!realDir.startsWith(realBase + path.sep) && realDir !== realBase) {
          throw new Error(`Physical path traversal escape: parent of ${relPath} resolves outside base directory`);
        }
        break;
      } catch (e) {
        if (e.code === 'ENOENT') {
          currentDir = path.dirname(currentDir);
        } else {
          throw e;
        }
      }
    }
  }

  return normalized;
}

/**
 * 适配 HTML 辅助函数：逐 script 提取；独立信标移除；混合游戏脚本拒绝；反馈按钮禁用并移除 data-i18n
 * @param {string} html
 * @param {{ returnDetails?: boolean }} [options]
 * @returns {string|{ output: string, replacementCounts: Record<string, number> }}
 */
export function adaptHtml(html, options = {}) {
  let output = html;
  const replacementCounts = {
    cloudflare_beacon: 0,
    feedback_button: 0,
    service_worker: 0,
  };

  const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>\s*/gi;
  output = output.replace(scriptRegex, (fullMatch, attrs, content) => {
    const hasBeaconRef = attrs.includes('static.cloudflareinsights.com');
    const hasBeaconBody = content.includes('__cfBeacon') || attrs.includes('data-cf-beacon');
    const hasSwRegister = content.includes('serviceWorker') && content.includes('register');

    const hasOtherCode = content
      .replace(/<script\b[^>]*>|<\/script>/gi, '')
      .replace(/if\s*\(\s*['"]serviceWorker['"]\s*in\s*navigator\s*\)\s*\{[\s\S]*?navigator\.serviceWorker\.register\s*\([^)]*\);?\s*\}\s*/gi, '')
      .replace(/__cfBeacon[\s\S]*?;?/gi, '')
      .trim().length > 0;

    if (hasBeaconRef || hasBeaconBody) {
      if (hasOtherCode && !hasBeaconRef) {
        throw new Error('Fail-closed: Mixed script detected containing both Cloudflare beacon and game code; cannot safely remove without risking simulation logic');
      }
      replacementCounts.cloudflare_beacon++;
      return '';
    }

    if (hasSwRegister) {
      if (hasOtherCode) {
        throw new Error('Fail-closed: Mixed script detected containing both ServiceWorker registration and game code; cannot safely remove without risking simulation logic');
      }
      replacementCounts.service_worker++;
      return '';
    }

    return fullMatch;
  });

  const feedbackBtnRegex = /<button\b([^>]*\bid=["']feedback-(?:send|open|debrief)["'][^>]*)>([\s\S]*?)<\/button>/gi;
  output = output.replace(feedbackBtnRegex, (match, attrs, content) => {
    const hasDisabled = /\bdisabled\b/.test(attrs);
    const hasOfflineText = content.includes('本地版不提供在线反馈');
    const hasDataI18n = /\bdata-i18n\b/.test(attrs);

    if (hasDisabled && hasOfflineText && !hasDataI18n) {
      return match;
    }

    replacementCounts.feedback_button++;
    let cleanAttrs = attrs
      .replace(/\bdata-i18n\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\bdisabled\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    return `<button ${cleanAttrs} disabled title="本地版不提供在线反馈">本地版不提供在线反馈</button>`;
  });

  if (options.returnDetails) {
    return { output, replacementCounts };
  }
  return output;
}

/**
 * 适配 JS 辅助函数：严格字面量补丁规范；默认拒绝修改以保护仿真完整性
 * @param {string} js
 * @param {{ patchSpec?: { replacements?: Array<{ search: string, replace: string, expectedCount: number }> }, returnDetails?: boolean }} [options]
 * @returns {string|{ output: string, replacementCounts: Record<string, number> }}
 */
export function adaptJs(js, options = {}) {
  const patchSpec = options.patchSpec;
  if (!patchSpec || !Array.isArray(patchSpec.replacements) || patchSpec.replacements.length === 0) {
    throw new Error('Explicit patch spec required: default policy rejects modifying JS to protect simulation from regex truncation');
  }

  let output = js;
  const replacementCounts = {};

  for (const { search, replace, expectedCount } of patchSpec.replacements) {
    if (typeof search !== 'string' || search.length === 0) {
      throw new Error('Invalid replacement search target in patchSpec');
    }
    if (typeof replace !== 'string') {
      throw new Error('Replacement replace must be a string');
    }
    if (typeof expectedCount !== 'number' || !Number.isSafeInteger(expectedCount) || expectedCount <= 0) {
      throw new Error(`Replacement expectedCount must be a positive integer, got ${expectedCount}`);
    }
    const count = output.split(search).length - 1;
    if (count !== expectedCount) {
      throw new Error(`Patch verification failed: expected ${expectedCount} replacements for target, but found ${count}`);
    }
    output = output.replaceAll(search, replace);
    replacementCounts[search] = count;
  }

  if (options.returnDetails) {
    return { output, replacementCounts };
  }
  return output;
}

/**
 * 完整适配资产目录：执行紧凑严格 Policy、绑定原始 manifest 字节哈希、字面量补丁与 policyVerification 生成
 * @param {{
 *   inDir: string,
 *   outDir: string,
 *   patchSpec: any
 * }} options
 */
export async function adaptAssets({ inDir, outDir, patchSpec }) {
  if (!inDir || !outDir) {
    throw new Error('Both inDir and outDir are required');
  }

  // 1. 读取并严格校验 Policy
  if (!patchSpec) {
    throw new Error('patchSpec required: adapting assets requires an explicit patch specification');
  }

  let policy = patchSpec;
  let policySha256 = '';

  if (typeof patchSpec === 'string') {
    const rawPolicy = await fs.readFile(patchSpec, 'utf-8');
    policySha256 = crypto.createHash('sha256').update(Buffer.from(rawPolicy)).digest('hex');
    policy = JSON.parse(rawPolicy);
  } else {
    policySha256 = crypto.createHash('sha256').update(Buffer.from(JSON.stringify(policy))).digest('hex');
  }

  validatePolicySchema(policy);

  const inDirResolved = path.resolve(inDir);
  const outDirResolved = path.resolve(outDir);

  // 2. 拒绝已存在的 outDir（原子单次发布，不覆盖已有目录）
  try {
    const stat = await fs.stat(outDirResolved);
    if (stat) {
      throw new Error(`Target outDir '${outDir}' already exists; refuse to overwrite`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }

  // 3. 校验 snapshot-report.json（必须存在、consistency 必须为 consistent、failures 必须为空数组）
  const reportPath = path.join(inDirResolved, 'snapshot-report.json');
  let reportJson;
  try {
    const reportRaw = await fs.readFile(reportPath, 'utf-8');
    reportJson = JSON.parse(reportRaw);
  } catch (err) {
    throw new Error(`Failed to read required snapshot-report.json: ${err.message}`);
  }

  if (reportJson.consistency !== 'consistent') {
    throw new Error(`Consistency check failed: report.consistency is '${reportJson.consistency}' (expected 'consistent')`);
  }

  if (!Array.isArray(reportJson.failures) || reportJson.failures.length > 0) {
    throw new Error(`Fail-closed: report has ${reportJson.failures?.length ?? 'invalid'} failures`);
  }

  // 4. 校验 assets.json 原始字节与 policy.sourceManifestSha256 的严格绑定
  const manifestPath = path.join(inDirResolved, 'assets.json');
  let rawManifestBytes;
  try {
    rawManifestBytes = await fs.readFile(manifestPath);
  } catch (err) {
    throw new Error(`Failed to read input manifest assets.json: ${err.message}`);
  }

  const actualManifestSha256 = crypto.createHash('sha256').update(rawManifestBytes).digest('hex');
  if (actualManifestSha256 !== policy.sourceManifestSha256) {
    throw new Error(`Policy sourceManifestSha256 mismatch: expected ${policy.sourceManifestSha256}, got ${actualManifestSha256}`);
  }

  let originalAssets;
  try {
    originalAssets = JSON.parse(rawManifestBytes.toString('utf-8'));
    if (!Array.isArray(originalAssets)) {
      throw new Error('assets.json must be a JSON array');
    }
  } catch (err) {
    throw new Error(`Failed to parse assets.json array: ${err.message}`);
  }

  // 4.1 优先校验 manifest 元数据规范与 ASCII 大小写折叠唯一性（先校验策略输入元）
  const asciiCaseFold = (p) => p.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const caseFoldedOriginalPaths = new Map();

  for (const asset of originalAssets) {
    await validateContainedPath(asset.path, inDirResolved);

    if (typeof asset.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(asset.sha256)) {
      throw new Error(`Asset ${asset.path} missing or invalid sha256`);
    }
    if (typeof asset.size !== 'number' || !Number.isSafeInteger(asset.size) || asset.size < 0) {
      throw new Error(`Asset ${asset.path} missing or invalid size`);
    }

    // 检查 originalAssets 内部 ASCII 大小写折叠冲突（防御 NTFS 不区分大小写物理覆盖）
    const folded = asciiCaseFold(asset.path);
    if (caseFoldedOriginalPaths.has(folded)) {
      throw new Error(`Duplicate asset in manifest under ASCII case-folding: '${asset.path}' collides with '${caseFoldedOriginalPaths.get(folded)}'`);
    }
    caseFoldedOriginalPaths.set(folded, asset.path);
  }

  // 4.2 校验物理文件存在性与哈希一致性
  const originalPathMap = new Map();
  for (const asset of originalAssets) {
    const filePath = path.join(inDirResolved, asset.path);
    const { sha256, size } = await computeFileHash(filePath);
    if (sha256 !== asset.sha256 || size !== asset.size) {
      throw new Error(`Asset verification failed for ${asset.path}: hash or size mismatch`);
    }
    originalPathMap.set(asset.path, asset);
  }

  // 5. 校验 policy.additionalFiles 路径与保留文件名冲突（含 ASCII case-folding 防御）
  const reservedNames = new Set(['assets.json', 'snapshot-report.json', 'patch-report.json']);
  const reservedNamesFolded = new Set(Array.from(reservedNames).map(asciiCaseFold));
  const additionalFilesList = policy.additionalFiles || [];
  const caseFoldedAdditional = new Set();

  for (const add of additionalFilesList) {
    await validateContainedPath(add.path, inDirResolved);
    const addFolded = asciiCaseFold(add.path);

    if (caseFoldedOriginalPaths.has(addFolded)) {
      throw new Error(`Collision: additionalFile '${add.path}' cannot overwrite existing asset '${caseFoldedOriginalPaths.get(addFolded)}' (ASCII case collision)`);
    }
    if (reservedNamesFolded.has(addFolded)) {
      throw new Error(`Collision: additionalFile '${add.path}' cannot overwrite reserved manifest/report (ASCII case collision)`);
    }
    if (caseFoldedAdditional.has(addFolded)) {
      throw new Error(`Duplicate additionalFile under ASCII case-folding: '${add.path}'`);
    }
    caseFoldedAdditional.add(addFolded);
  }

  // 6. 校验 policy.files 必须全部存在于 originalAssets 且前置 sourceSha256 吻合
  const policyFilesMap = new Map();
  for (const fileSpec of policy.files) {
    const existing = originalPathMap.get(fileSpec.path);
    if (!existing) {
      throw new Error(`Policy target file '${fileSpec.path}' not found in original assets`);
    }
    if (existing.sha256 !== fileSpec.sourceSha256) {
      throw new Error(`Policy file ${fileSpec.path} sourceSha256 mismatch: expected ${fileSpec.sourceSha256}, got ${existing.sha256}`);
    }
    policyFilesMap.set(fileSpec.path, fileSpec);
  }

  // 7. 暂存区必须位于 outDir 的同级父目录下，保障跨卷安全与 fs.rename 原子重命名
  const outParentDir = path.dirname(outDirResolved);
  await fs.mkdir(outParentDir, { recursive: true });
  const stagingDir = path.join(
    outParentDir,
    `.${path.basename(outDirResolved)}.staging-${Date.now()}-${crypto.randomUUID()}`
  );
  await fs.mkdir(stagingDir, { recursive: true });

  try {
    // 复制所有校验通过的原文件到暂存区
    for (const asset of originalAssets) {
      const srcPath = path.join(inDirResolved, asset.path);
      const dstPath = path.join(stagingDir, asset.path);
      await fs.mkdir(path.dirname(dstPath), { recursive: true });
      await fs.copyFile(srcPath, dstPath);
    }

    const patchedFiles = [];

    // 8. 精确字面量补丁执行与等频计数核验
    for (const [relPath, fileSpec] of policyFilesMap) {
      const filePath = path.join(stagingDir, relPath);
      let content = await fs.readFile(filePath, 'utf-8');
      const replacementDetails = [];

      for (const rep of fileSpec.replacements) {
        const count = content.split(rep.search).length - 1;
        if (count !== rep.expectedCount) {
          throw new Error(`Literal replacement count mismatch for ${relPath} ['${rep.search}']: expected ${rep.expectedCount}, got ${count}`);
        }
        content = content.replaceAll(rep.search, rep.replace);
        replacementDetails.push({
          search: rep.search,
          count,
        });
      }

      await fs.writeFile(filePath, content, 'utf-8');
      const adaptedSha = crypto.createHash('sha256').update(Buffer.from(content)).digest('hex');

      patchedFiles.push({
        path: relPath,
        originalSha256: fileSpec.sourceSha256,
        adaptedSha256: adaptedSha,
        replacementDetails,
      });
    }

    // 9. 写入 additionalFiles
    for (const add of additionalFilesList) {
      const dstPath = path.join(stagingDir, add.path);
      await fs.mkdir(path.dirname(dstPath), { recursive: true });
      await fs.writeFile(dstPath, add.content);
    }

    // 10. 重算生成最终 assets.json（含原文件、补丁后文件及新增文件）
    const adaptedAssets = [];
    for (const asset of originalAssets) {
      const filePath = path.join(stagingDir, asset.path);
      const { sha256, size } = await computeFileHash(filePath);
      adaptedAssets.push({
        ...asset,
        size,
        sha256,
      });
    }

    for (const add of additionalFilesList) {
      const filePath = path.join(stagingDir, add.path);
      const { sha256, size } = await computeFileHash(filePath);
      adaptedAssets.push({
        sourceUrl: `local://policy/${policy.id}/${add.path}`,
        path: add.path,
        contentType: add.contentType,
        size,
        sha256,
      });
    }

    adaptedAssets.sort((a, b) => a.path.localeCompare(b.path));
    const adaptedManifestRaw = Buffer.from(JSON.stringify(adaptedAssets, null, 2), 'utf-8');
    await fs.writeFile(path.join(stagingDir, 'assets.json'), adaptedManifestRaw);
    const adaptedManifestSha256 = crypto.createHash('sha256').update(adaptedManifestRaw).digest('hex');

    // 11. 生成符合 Lead 与 package 契约的 patch-report.json
    const patchReport = {
      timestamp: new Date().toISOString(),
      consistency: 'consistent_adapted',
      sourceManifestSha256: policy.sourceManifestSha256,
      adaptedManifestSha256,
      sourceSnapshot: {
        scope: reportJson.scope ?? 'unverified',
        closure: reportJson.closure ?? 'unverified',
        exclusions: reportJson.exclusions ?? [],
        notCompleteReason: reportJson.notCompleteReason ?? null,
      },
      policyVerification: {
        id: policy.id,
        hashVerified: true,
        countsMatched: true,
        policySha256,
      },
      totalPatched: patchedFiles.length,
      patchedFiles,
      additionalFiles: additionalFilesList.map(f => ({ path: f.path, contentType: f.contentType })),
      csp: offlineCsp(),
    };
    await fs.writeFile(path.join(stagingDir, 'patch-report.json'), JSON.stringify(patchReport, null, 2), 'utf-8');

    // 12. 同盘原子重命名发布
    await fs.rename(stagingDir, outDirResolved);

    return {
      success: true,
      patchedFiles,
      assets: adaptedAssets,
      report: patchReport,
    };
  } finally {
    // 失败时彻底清理暂存区，绝不残留
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

// CLI 执行支持：node tools/adapt.mjs --in <vendor/original> --out <game> --patch-spec <policy.json>
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  let inDir = null;
  let outDir = null;
  let patchSpecPath = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--in' || args[i] === '-i') inDir = args[++i];
    else if (args[i] === '--out' || args[i] === '-o') outDir = args[++i];
    else if (args[i] === '--patch-spec' || args[i] === '-p') patchSpecPath = args[++i];
  }

  if (!inDir || !outDir || !patchSpecPath) {
    console.error('Usage: node tools/adapt.mjs --in <vendor/original> --out <game> --patch-spec <policy.json>');
    process.exit(1);
  }

  adaptAssets({ inDir, outDir, patchSpec: patchSpecPath })
    .then((res) => {
      console.log(`[adapt] Successfully adapted ${res.patchedFiles.length} files with policy ${res.report.policyVerification.id}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`[adapt] Failed: ${err.message}`);
      process.exit(1);
    });
}

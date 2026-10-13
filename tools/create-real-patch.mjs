// tools/create-real-patch.mjs - 真实构建的离线补丁策略生成器
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validatePolicySchema } from './adapt.mjs';

/**
 * 已审核通过的旧浏览器遥测脚本 body 严格 SHA-256（对应 vendor index.html 84-100 行）
 */
export const AUDITED_TELEMETRY_BODY_SHA256 = 'a6715fcd4a7f6029c6ed6624d49f0784d077b959963f0b2b7393f673be5fd70f';

/**
 * 分析指定原始输入目录并生成严格绑定的 schemaVersion:1 补丁策略
 * @param {{
 *   inDir: string,
 *   offlineGateScriptPath?: string,
 *   policyId?: string
 * }} options
 */
export async function generateRealPatchPolicy(options = {}) {
  const inDir = path.resolve(options.inDir || path.join(process.cwd(), 'vendor/original'));
  const offlineGateScriptPath = options.offlineGateScriptPath
    ? path.resolve(options.offlineGateScriptPath)
    : fileURLToPath(new URL('./offline-gate.js', import.meta.url));
  const policyId = options.policyId || 'starcraft-ashfall-offline-v1';

  // 1. 读取并校验 snapshot-report.json
  const reportPath = path.join(inDir, 'snapshot-report.json');
  let reportJson;
  try {
    const rawReport = await fs.readFile(reportPath, 'utf-8');
    reportJson = JSON.parse(rawReport);
  } catch (err) {
    throw new Error(`Failed to read snapshot-report.json: ${err.message}`);
  }

  if (reportJson.consistency !== 'consistent') {
    throw new Error(`Snapshot report consistency must be 'consistent', got '${reportJson.consistency}'`);
  }
  if (!Array.isArray(reportJson.failures) || reportJson.failures.length > 0) {
    throw new Error(`Snapshot report has ${reportJson.failures?.length ?? 'invalid'} failures; require 0 failures`);
  }

  // 2. 读取 assets.json 原始字节并计算 sourceManifestSha256
  const manifestPath = path.join(inDir, 'assets.json');
  let rawManifestBytes;
  try {
    rawManifestBytes = await fs.readFile(manifestPath);
  } catch (err) {
    throw new Error(`Failed to read assets.json: ${err.message}`);
  }

  const sourceManifestSha256 = crypto.createHash('sha256').update(rawManifestBytes).digest('hex');
  const manifestAssets = JSON.parse(rawManifestBytes.toString('utf-8'));
  const indexAsset = manifestAssets.find((a) => a.path === 'index.html');
  if (!indexAsset) {
    throw new Error("Missing 'index.html' entry in assets.json");
  }
  if (typeof indexAsset.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(indexAsset.sha256)) {
    throw new Error("Missing or invalid sha256 (expected 64-hex) for 'index.html' in assets.json");
  }

  // 3. 读取 index.html 并计算原始 SHA-256
  const indexPath = path.join(inDir, 'index.html');
  let rawIndexBytes;
  try {
    rawIndexBytes = await fs.readFile(indexPath);
  } catch (err) {
    throw new Error(`Failed to read index.html: ${err.message}`);
  }

  const indexSha256 = crypto.createHash('sha256').update(rawIndexBytes).digest('hex');
  if (indexAsset.sha256 !== indexSha256) {
    throw new Error(`index.html hash mismatch with assets.json: expected ${indexAsset.sha256}, got ${indexSha256}`);
  }

  const htmlText = rawIndexBytes.toString('utf-8');

  // 4. 读取离线门禁脚本内容
  let offlineGateContent;
  try {
    offlineGateContent = await fs.readFile(offlineGateScriptPath, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to read offline-gate.js at ${offlineGateScriptPath}: ${err.message}`);
  }

  // 5. 精确提取 HTML 中的各候选替换锚点（必须命中且仅命中 1 次，未知结构 fail-closed）
  const replacements = [];

  function registerReplacement(description, search, replace) {
    if (typeof search !== 'string' || search.length === 0) {
      throw new Error(`Cannot register empty search target for ${description}`);
    }
    const count = htmlText.split(search).length - 1;
    if (count !== 1) {
      throw new Error(`Anchor mismatch for [${description}]: expected exact count 1, found ${count}; unknown build structure`);
    }
    replacements.push({
      search,
      replace,
      expectedCount: 1,
    });
  }

  // 5.1 门禁脚本注入：寻找首个游戏主模块脚本标签，注入在其之前
  const mainModuleRegex = /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["'][^"']*game-[^"']*\.js["'][^>]*><\/script>/i;
  const mainModuleMatch = htmlText.match(mainModuleRegex);
  if (!mainModuleMatch) {
    throw new Error('Cannot find main module game script anchor in index.html');
  }
  const mainModuleTag = mainModuleMatch[0];
  registerReplacement(
    'offline_gate_injection',
    mainModuleTag,
    `<script src="./offline-gate.js"></script>\n  ${mainModuleTag}`
  );

  // 5.2 在线状态文本替换为本地状态
  const onlineStatusRegex = /<span\s+class=["']terminal-status["']><i><\/i>\s*ONLINE<\/span>/i;
  const onlineStatusMatch = htmlText.match(onlineStatusRegex);
  if (!onlineStatusMatch) {
    throw new Error('Cannot find terminal-status ONLINE anchor in index.html');
  }
  registerReplacement(
    'online_status_to_local',
    onlineStatusMatch[0],
    '<span class="terminal-status"><i></i> LOCAL</span>'
  );

  // 5.3 反馈按钮 1: feedback-open (保持 ID、移除 data-i18n、添加 disabled 与本地提示)
  const feedbackOpenRegex = /<button\b[^>]*\bid=["']feedback-open["'][^>]*>([\s\S]*?)<\/button>/i;
  const feedbackOpenMatch = htmlText.match(feedbackOpenRegex);
  if (!feedbackOpenMatch) {
    throw new Error('Cannot find feedback-open button anchor in index.html');
  }
  let cleanOpenAttrs = feedbackOpenMatch[0]
    .slice(0, feedbackOpenMatch[0].indexOf('>'))
    .replace(/\bdata-i18n\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .trim();
  registerReplacement(
    'feedback_open_button',
    feedbackOpenMatch[0],
    `${cleanOpenAttrs} disabled title="本地版不提供在线反馈">本地版不提供在线反馈</button>`
  );

  // 5.4 反馈按钮 2: feedback-debrief
  const feedbackDebriefRegex = /<button\b[^>]*\bid=["']feedback-debrief["'][^>]*>([\s\S]*?)<\/button>/i;
  const feedbackDebriefMatch = htmlText.match(feedbackDebriefRegex);
  if (!feedbackDebriefMatch) {
    throw new Error('Cannot find feedback-debrief button anchor in index.html');
  }
  let cleanDebriefAttrs = feedbackDebriefMatch[0]
    .slice(0, feedbackDebriefMatch[0].indexOf('>'))
    .replace(/\bdata-i18n\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .trim();
  registerReplacement(
    'feedback_debrief_button',
    feedbackDebriefMatch[0],
    `${cleanDebriefAttrs} disabled title="本地版不提供在线反馈">本地版不提供在线反馈</button>`
  );

  // 5.5 反馈按钮 3: feedback-send
  const feedbackSendRegex = /<button\b[^>]*\bid=["']feedback-send["'][^>]*>([\s\S]*?)<\/button>/i;
  const feedbackSendMatch = htmlText.match(feedbackSendRegex);
  if (!feedbackSendMatch) {
    throw new Error('Cannot find feedback-send button anchor in index.html');
  }
  let cleanSendAttrs = feedbackSendMatch[0]
    .slice(0, feedbackSendMatch[0].indexOf('>'))
    .replace(/\bdata-i18n\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .trim();
  registerReplacement(
    'feedback_send_button',
    feedbackSendMatch[0],
    `${cleanSendAttrs} disabled title="本地版不提供在线反馈">本地版不提供在线反馈</button>`
  );

  // 5.6 错误重载按钮：禁用内联 onclick 避免 CSP 违规
  const reloadBtnRegex = /<button\b[^>]*\bonclick=["'][^"']*location\.reload\(\)[^"']*["'][^>]*>([\s\S]*?)<\/button>/i;
  const reloadBtnMatch = htmlText.match(reloadBtnRegex);
  if (!reloadBtnMatch) {
    throw new Error('Cannot find inline onclick reload button anchor in index.html');
  }
  registerReplacement(
    'reload_button_csp_safe',
    reloadBtnMatch[0],
    '<button disabled title="关闭后重新打开">关闭后重新打开</button>'
  );

  // 5.7 试装台链接：添加 display: none !important 防止 JS 本地检测解除 hidden 显示
  const labLinkRegex = /<a\b[^>]*\bid=["']lab-link["'][^>]*>([\s\S]*?)<\/a>/i;
  const labLinkMatch = htmlText.match(labLinkRegex);
  if (!labLinkMatch) {
    throw new Error('Cannot find lab-link anchor in index.html');
  }
  let labAttrs = labLinkMatch[0].slice(0, labLinkMatch[0].indexOf('>'));
  if (!labAttrs.includes('style=')) {
    labAttrs += ' style="display: none !important;"';
  } else {
    labAttrs = labAttrs.replace(/style=(["'])/i, 'style=$1display: none !important; ');
  }
  registerReplacement(
    'lab_link_force_hidden',
    labLinkMatch[0],
    `${labAttrs}>${labLinkMatch[1]}</a>`
  );

  // 5.8 旧浏览器遥测脚本移除（严格绑定已审核遥测 body 的 SHA-256，且 script 标签自身必须无属性，防带 src 外部脚本执行被误删）
  let oldBrowserScriptTag = null;
  const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>\s*/gi;
  for (const match of htmlText.matchAll(scriptRegex)) {
    const attrs = match[1];
    const scriptBody = match[2];

    // 若标签带有属性（特别是 src 等外部脚本加载属性），浏览器会执行外部代码而忽略内联 body，绝对不可当做遥测移除
    if (attrs.trim() !== '') {
      continue;
    }

    const bodySha = crypto.createHash('sha256').update(scriptBody).digest('hex');
    if (bodySha === AUDITED_TELEMETRY_BODY_SHA256) {
      oldBrowserScriptTag = match[0];
      break;
    }
  }
  if (!oldBrowserScriptTag) {
    throw new Error('Cannot find audited old-browser telemetry script: body hash mismatch or mixed code detected or foreign attributes/src detected; fail closed');
  }
  registerReplacement(
    'old_browser_telemetry_script',
    oldBrowserScriptTag,
    ''
  );

  // 5.9 Cloudflare 统计信标脚本移除（严格核验 src 域名 static.cloudflareinsights.com 与路径 /beacon.min.js，且 inline body 为空）
  let cfBeaconTag = null;
  for (const match of htmlText.matchAll(scriptRegex)) {
    const attrs = match[1];
    const innerContent = match[2];

    if (innerContent.trim().length > 0) {
      continue; // 非空 inline 脚本绝不能误认为 CF beacon
    }

    const srcMatch = attrs.match(/\bsrc\s*=\s*(?:'([^']*)'|"([^"]*)"|([^\s>]+))/i);
    if (!srcMatch) {
      continue;
    }

    const rawSrc = srcMatch[1] || srcMatch[2] || srcMatch[3];
    try {
      const srcUrl = new URL(rawSrc, 'https://example.com');
      if (srcUrl.hostname === 'static.cloudflareinsights.com' && srcUrl.pathname === '/beacon.min.js') {
        cfBeaconTag = match[0];
        break;
      }
    } catch {
      // 忽略无法解析的非法 URL
    }
  }

  if (cfBeaconTag) {
    const withComments = `<!-- Cloudflare Pages Analytics -->${cfBeaconTag}<!-- Cloudflare Pages Analytics -->`;
    if (htmlText.includes(withComments)) {
      cfBeaconTag = withComments;
    }
  }

  if (!cfBeaconTag) {
    throw new Error('Cannot find Cloudflare beacon script anchor with exact hostname static.cloudflareinsights.com and path /beacon.min.js');
  }
  registerReplacement(
    'cloudflare_beacon_script',
    cfBeaconTag,
    ''
  );

  // 6. 构造紧凑 Policy 对象
  const policy = {
    schemaVersion: 1,
    id: policyId,
    sourceManifestSha256,
    files: [
      {
        path: 'index.html',
        sourceSha256: indexSha256,
        replacements,
      }
    ],
    additionalFiles: [
      {
        path: 'offline-gate.js',
        content: offlineGateContent,
        contentType: 'application/javascript',
      }
    ]
  };

  validatePolicySchema(policy);
  return policy;
}

/**
 * 安全持久化输出 policy JSON 文件，默认使用 wx 标志提供排他防覆盖（非整文件原子写）
 * @param {any} policy
 * @param {string} outPath
 * @param {{ overwrite?: boolean }} [options]
 */
export async function writeRealPatchPolicy(policy, outPath, options = {}) {
  validatePolicySchema(policy);
  const resolvedOut = path.resolve(outPath);
  const overwrite = options.overwrite ?? false;

  await fs.mkdir(path.dirname(resolvedOut), { recursive: true });
  const content = JSON.stringify(policy, null, 2);

  await fs.writeFile(resolvedOut, content, {
    flag: overwrite ? 'w' : 'wx',
    encoding: 'utf-8',
  });
}

// CLI 执行支持：node tools/create-real-patch.mjs --in <vendor/original> --out <config/source-patch.json> [--overwrite]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  let inDir = null;
  let outPath = null;
  let overwrite = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--in' || args[i] === '-i') inDir = args[++i];
    else if (args[i] === '--out' || args[i] === '-o') outPath = args[++i];
    else if (args[i] === '--overwrite' || args[i] === '--force' || args[i] === '-f') overwrite = true;
  }

  if (!inDir || !outPath) {
    console.error('Usage: node tools/create-real-patch.mjs --in <vendor/original> --out <config/source-patch.json> [--overwrite]');
    process.exit(1);
  }

  generateRealPatchPolicy({ inDir })
    .then((policy) => writeRealPatchPolicy(policy, outPath, { overwrite }))
    .then(() => {
      console.log(`[create-real-patch] Successfully generated patch policy to ${outPath}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`[create-real-patch] Failed: ${err.message}`);
      process.exit(1);
    });
}

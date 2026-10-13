// tools/snapshot.mjs - 资源快照获取与离线分析工具
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const WINDOWS_RESERVED_NAMES = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

/**
 * 从 asset-url 脚本中安全非 eval 提取权威映射表
 * 匹配 var t = { "/assets/...": `hash`, ... }
 * @param {string|Buffer} source
 * @returns {Map<string, string>} barePath -> canonicalRelativeUrl (e.g. "/assets/a.png" -> "/assets/a.png?v=1122334455")
 */
export function parseAssetMap(source) {
  const str = typeof source === 'string' ? source : source.toString('utf-8');
  const map = new Map();

  const entryRegex = /(?:["'](\/assets\/[^"']+)["']|`(\/assets\/[^`]+)`)\s*:\s*(?:`([0-9a-fA-F]{6,32})`|["']([0-9a-fA-F]{6,32})["'])/g;
  let match;
  while ((match = entryRegex.exec(str)) !== null) {
    const barePath = match[1] || match[2];
    const hash = match[3] || match[4];
    if (barePath && hash) {
      map.set(barePath, `${barePath}?v=${hash}`);
    }
  }
  return map;
}

/**
 * 从源内容中发现资产引用
 * @param {string|Buffer|Uint8Array} source
 * @param {'html'|'css'|'js'|'json'|'glb'} kind
 * @param {Object} [options]
 * @returns {string[]}
 */
export function discoverRefs(source, kind, options = {}) {
  const refs = new Set();
  const normalizedKind = (kind || '').toLowerCase();

  if (normalizedKind === 'glb') {
    const buf = Buffer.isBuffer(source) ? source : Buffer.from(source);
    if (buf.length >= 20) {
      const magic = buf.subarray(0, 4).toString('ascii');
      if (magic === 'glTF') {
        const chunkLength = buf.readUInt32LE(12);
        const chunkType = buf.subarray(16, 20).toString('ascii');
        if (chunkType === 'JSON' && buf.length >= 20 + chunkLength) {
          try {
            const jsonStr = buf.subarray(20, 20 + chunkLength).toString('utf-8');
            const gltf = JSON.parse(jsonStr);
            scanGltfRefs(gltf, refs);
          } catch {
            // Ignore malformed JSON in chunk
          }
        }
      }
    }
    return Array.from(refs);
  }

  const str = typeof source === 'string' ? source : Buffer.from(source).toString('utf-8');

  if (normalizedKind === 'html') {
    let match;
    // 精准解析 <link ...> 标签：按 rel 语义跳过 canonical 等超链接元数据，保留 stylesheet/icon/preload 等依赖
    const linkTagRegex = /<link\b([^>]*)>/gi;
    let linkMatch;
    while ((linkMatch = linkTagRegex.exec(str)) !== null) {
      const attrs = linkMatch[1];
      const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      const relMatch = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      if (hrefMatch) {
        const hrefVal = hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3];
        const relVal = (relMatch ? (relMatch[1] ?? relMatch[2] ?? relMatch[3]) : '').trim().toLowerCase();
        // 若 rel 包含 stylesheet (如 alternate stylesheet)，优先作为合法样式依赖放行
        if (relVal.includes('stylesheet')) {
          addCleanRef(hrefVal, refs);
          continue;
        }
        const skipRels = ['canonical', 'alternate', 'author', 'help', 'license', 'next', 'prev', 'search', 'pingback'];
        if (skipRels.includes(relVal)) {
          if (options.metadataRefs && hrefVal) {
            options.metadataRefs.add(hrefVal);
          }
          continue;
        }
        addCleanRef(hrefVal, refs);
      }
    }

    // 匹配 anchor 标签中的合法 href (支持发现外链与站内合法导航引用)
    const anchorRegex = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    let anchorMatch;
    while ((anchorMatch = anchorRegex.exec(str)) !== null) {
      const raw = anchorMatch[1] ?? anchorMatch[2] ?? anchorMatch[3];
      addCleanRef(raw, refs);
    }

    // 匹配常规多媒体与脚本标签中的 src
    const srcAttrRegex = /<(?:script|img|audio|video|source|iframe|embed|track)\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    let srcMatch;
    while ((srcMatch = srcAttrRegex.exec(str)) !== null) {
      const raw = srcMatch[1] ?? srcMatch[2] ?? srcMatch[3];
      addCleanRef(raw, refs);
    }

    // 匹配 srcset
    const srcsetRegex = /<(?:source|img)\b[^>]*\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    let srcsetMatch;
    while ((srcsetMatch = srcsetRegex.exec(str)) !== null) {
      const raw = srcsetMatch[1] ?? srcsetMatch[2] ?? srcsetMatch[3];
      if (raw) {
        for (const part of raw.split(',')) {
          const urlPart = part.trim().split(/\s+/)[0];
          if (urlPart) addCleanRef(urlPart, refs);
        }
      }
    }

    // 内联样式中的 url(...)
    const styleBlockRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
    while ((match = styleBlockRegex.exec(str)) !== null) {
      const cssRefs = discoverRefs(match[1], 'css', options);
      for (const r of cssRefs) refs.add(r);
    }

    // 内联脚本中的动态 import 与 Worker
    const scriptBlockRegex = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    while ((match = scriptBlockRegex.exec(str)) !== null) {
      const jsRefs = discoverRefs(match[1], 'js', options);
      for (const r of jsRefs) refs.add(r);
    }
  } else if (normalizedKind === 'css') {
    // url(...)
    const urlRegex = /url\(\s*(?:'([^']*)'|"([^"]*)"|([^'")]+))\s*\)/gi;
    let match;
    while ((match = urlRegex.exec(str)) !== null) {
      const raw = match[1] ?? match[2] ?? match[3];
      addCleanRef(raw, refs);
    }

    // @import
    const importRegex = /@import\s+(?:url\(\s*(?:'([^']*)'|"([^"]*)"|([^'")]+))\s*\)|'([^']*)'|"([^"]*)")/gi;
    while ((match = importRegex.exec(str)) !== null) {
      const raw = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5];
      addCleanRef(raw, refs);
    }
  } else if (normalizedKind === 'js') {
    // Vite会使用静态模板字面量；只提取不含插值/转义的完整路径。
    const staticTemplate = /`([^`\\]*)`/g;
    let templateMatch;
    while ((templateMatch = staticTemplate.exec(str)) !== null) {
      const literal = templateMatch[1];
      if (/\.replace(?:All)?\(\s*$/.test(str.slice(Math.max(0, templateMatch.index - 32), templateMatch.index))) continue;
      if (!literal.includes('${') && /^(?:\.?\/|assets\/)[\w@.\/-]+\.(?:js|mjs|css|glb|gltf|bin|ogg|mp3|wav|png|jpg|jpeg|webp|gif|svg|json|wasm)(?:\?v=[a-zA-Z0-9]+)?$/.test(literal)) {
        addCleanRef(normalizeJsRef(literal, options), refs);
      }
    }
    // 静态与动态 import/export
    const importRegex = /(?:import|export)\s+(?:[\w*\s{},]+from\s+)?['"]([^'"]+)['"]/g;
    let match;
    while ((match = importRegex.exec(str)) !== null) {
      addCleanRef(normalizeJsRef(match[1], options), refs);
    }

    const dynImportRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((match = dynImportRegex.exec(str)) !== null) {
      addCleanRef(normalizeJsRef(match[1], options), refs);
    }

    // Worker 构造: new Worker(new URL('...', import.meta.url))
    const workerRegex = /new\s+Worker\s*\(\s*new\s+URL\s*\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g;
    while ((match = workerRegex.exec(str)) !== null) {
      addCleanRef(normalizeJsRef(match[1], options), refs);
    }

    // Quoted 静态资产扫描（包含 Vite / 站内资源映射如 /assets/..., ./..., 以及常见媒体和模型扩展名）
    // 排除逗号、通配符等非路径字符
    const quotedAssetRegex = /['"]((?:(?:\.?\/|\/assets\/|[a-zA-Z0-9_\-\/]+\/)[a-zA-Z0-9_\-\.\/]+\.(?:js|mjs|css|glb|gltf|bin|ogg|mp3|wav|png|jpg|jpeg|webp|gif|svg|json|wasm))|(?:\/assets\/[a-zA-Z0-9_\-\.\/]+))['"]/g;
    while ((match = quotedAssetRegex.exec(str)) !== null) {
      addCleanRef(normalizeJsRef(match[1], options), refs);
    }

    // 独立扩展名字面量如 "assets/audio/laser.ogg"
    const extAssetRegex = /['"]([a-zA-Z0-9_\-\.\/]+\.(?:js|mjs|css|glb|gltf|bin|ogg|mp3|wav|png|jpg|jpeg|webp|gif|svg|json|wasm))['"]/g;
    while ((match = extAssetRegex.exec(str)) !== null) {
      addCleanRef(normalizeJsRef(match[1], options), refs);
    }
  } else if (normalizedKind === 'json') {
    try {
      const parsed = JSON.parse(str);
      scanJsonRefs(parsed, refs, options);
    } catch {
      // Ignore invalid JSON
    }
  }

  return Array.from(refs);
}

function normalizeJsRef(raw, options = {}) {
  if (!raw || typeof raw !== 'string') return raw;
  const clean = raw.trim();
  // 启用了 assetMap 时，Vite 构建产物中的 assets/... 属于绝对相对站点根目录，补齐前导 / 避免与当前文件路径拼接成 /assets/assets/
  if (options.hasAssetMap && clean.startsWith('assets/')) {
    return '/' + clean;
  }
  return clean;
}

function addCleanRef(raw, set) {
  if (!raw) return;
  const clean = raw.trim();
  if (!clean || clean.startsWith('#') || clean.startsWith('data:') || clean.startsWith('blob:') || clean.startsWith('javascript:') || clean.startsWith('mailto:')) {
    return;
  }
  // 排除通配符星号、逗号 (UI accept pattern 如 image/*,.png)、尖括号与管道符及控制字符
  if (/[*<>|"']/.test(clean) || clean.includes(',') || /[\x00-\x1F]/.test(clean)) {
    return;
  }
  // 排除单纯的 MIME type
  if (['text/css', 'text/html', 'text/javascript', 'application/javascript', 'application/json'].includes(clean.toLowerCase())) {
    return;
  }
  set.add(clean);
}

function scanJsonRefs(val, set, options = {}) {
  const hasAssetMap = Boolean(options.hasAssetMap);
  const metadataSet = options.metadataRefs;

  if (typeof val === 'string') {
    let cleanVal = val.trim();
    if (hasAssetMap) {
      // 若包含 public/assets/...，规范化为 /assets/... 并保留供抓取
      if (cleanVal.startsWith('public/assets/')) {
        cleanVal = '/' + cleanVal.slice('public/'.length);
      } else if (
        cleanVal.startsWith('public/') ||
        cleanVal.startsWith('src/') ||
        cleanVal.startsWith('mods/') ||
        cleanVal.startsWith('rawgithub') ||
        cleanVal.includes('\\')
      ) {
        if (metadataSet) metadataSet.add(cleanVal);
        return;
      }
    }

    if (cleanVal.startsWith('/') || cleanVal.startsWith('./') || /\.(?:js|mjs|css|glb|gltf|bin|ogg|mp3|wav|png|jpg|jpeg|webp|gif|svg|json|wasm)$/i.test(cleanVal)) {
      addCleanRef(cleanVal, set);
    }
  } else if (Array.isArray(val)) {
    for (const item of val) scanJsonRefs(item, set, options);
  } else if (val && typeof val === 'object') {
    for (const key of Object.keys(val)) {
      if (hasAssetMap) {
        // 排除 provenance 与制作流水线字段（如 source, preparation, processing, recipe, attribution, description 等）
        const lowerKey = key.toLowerCase();
        const provenanceKeys = [
          'source', 'sources', 'original', 'sourcepath', 'audition', 'comment',
          'preparation', 'processing', 'recipe', 'attribution', 'description', 'copysources'
        ];
        if (provenanceKeys.includes(lowerKey)) {
          if (metadataSet) {
            const rawVal = val[key];
            if (typeof rawVal === 'string') {
              metadataSet.add(rawVal);
            } else if (Array.isArray(rawVal)) {
              for (const item of rawVal) {
                if (typeof item === 'string') metadataSet.add(item);
              }
            }
          }
          continue;
        }
      }
      scanJsonRefs(val[key], set, options);
    }
  }
}

function scanGltfRefs(gltf, set) {
  if (!gltf || typeof gltf !== 'object') return;
  if (Array.isArray(gltf.buffers)) {
    for (const b of gltf.buffers) {
      if (b && typeof b.uri === 'string' && !b.uri.startsWith('data:')) {
        addCleanRef(b.uri, set);
      }
    }
  }
  if (Array.isArray(gltf.images)) {
    for (const img of gltf.images) {
      if (img && typeof img.uri === 'string' && !img.uri.startsWith('data:')) {
        addCleanRef(img.uri, set);
      }
    }
  }
}

/**
 * 校验并解析目标 URL，严格限定同源与 Windows 安全路径
 * @param {string} ref
 * @param {string|URL} base
 * @returns {URL}
 */
export function checkedUrl(ref, base) {
  if (typeof ref !== 'string') {
    throw new Error('Reference must be a string');
  }

  // Raw 前置安全检查
  if (ref.includes('\\')) {
    throw new Error('Invalid path: backslash rejected');
  }
  if (ref.includes('\0') || /%00/i.test(ref)) {
    throw new Error('Invalid path: NUL rejected');
  }
  if (/%25/i.test(ref)) {
    throw new Error('Invalid path: double percent rejected');
  }
  // 检查 Windows 非法字符 < > " | * 与 ASCII 控制字符 (0x00 - 0x1F)
  if (/[<>|*"]/.test(ref)) {
    throw new Error(`Invalid path: illegal character in reference: ${ref}`);
  }
  if (/[\x00-\x1F]/.test(ref)) {
    throw new Error(`Invalid path: control character in reference: ${ref}`);
  }
  // 检查通配符问号（如 file?.js，? 后面无 = 且直连扩展名，属于 glob 通配符）
  if (/\?[^=&]*\.[a-zA-Z0-9]+$/i.test(ref)) {
    throw new Error(`Invalid path: illegal character in reference: ${ref}`);
  }

  const baseUrl = typeof base === 'string' ? new URL(base) : base;
  if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
    throw new Error(`Unsupported base protocol: ${baseUrl.protocol}`);
  }

  // 检查是否非同源绝对 URL 或相对 URL 试图夹带冒号
  if (!/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//i.test(ref) && ref.includes(':')) {
    throw new Error('Invalid path: colon rejected (ADS)');
  }

  let targetUrl;
  try {
    targetUrl = new URL(ref, baseUrl);
  } catch (e) {
    throw new Error(`Malformed URL: ${ref}`);
  }

  // 严格同源检查 (scheme, hostname, port 必须严格一致)
  if (
    targetUrl.protocol !== baseUrl.protocol ||
    targetUrl.hostname !== baseUrl.hostname ||
    targetUrl.port !== baseUrl.port
  ) {
    const err = new Error(`Cross-origin URL rejected: ${targetUrl.href}`);
    err.isCrossOrigin = true;
    err.url = targetUrl.href;
    throw err;
  }

  // 拒绝 userinfo
  if (targetUrl.username || targetUrl.password) {
    throw new Error('Invalid URL: userinfo rejected');
  }

  // 检查路径安全性
  if (targetUrl.pathname.includes('\\')) {
    throw new Error('Invalid path: backslash rejected');
  }
  if (targetUrl.pathname.includes(':')) {
    throw new Error('Invalid path: colon rejected (ADS)');
  }
  if (targetUrl.pathname.includes('%25')) {
    throw new Error('Invalid path: double percent rejected');
  }

  // 路径穿越防范：若原始 ref 含有 .. 尝试越界
  if (/(?:^|\/)\.\.(?:\/|$)/.test(ref) || ref.includes('..')) {
    // 检查 targetUrl 是否规范化后越界或依然含有 ..
    if (targetUrl.pathname.includes('..')) {
      throw new Error('Path traversal rejected: ..');
    }
    // 若原 ref 试图跨出根路径，如 /../x
    if (ref.startsWith('/..')) {
      throw new Error('Path traversal rejected: ..');
    }
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(targetUrl.pathname);
  } catch {
    throw new Error('Invalid URI encoding');
  }

  if (decodedPath.includes('\0') || decodedPath.includes('\\') || decodedPath.includes(':') || /[<>|?*"\x00-\x1F]/.test(decodedPath)) {
    throw new Error('Invalid path character in decoded pathname');
  }

  // 逐段检查：点点穿越与 Windows 设备保留名
  const segments = decodedPath.split('/');
  for (const seg of segments) {
    if (seg === '..') {
      throw new Error('Path traversal rejected: ..');
    }
    if (WINDOWS_RESERVED_NAMES.test(seg)) {
      throw new Error(`Reserved Windows device name rejected: ${seg}`);
    }
  }

  return targetUrl;
}

/**
 * 将 URL 转为安全的输出相对路径
 * @param {URL} urlObj
 * @returns {string}
 */
function urlToRelativePath(urlObj) {
  let p = decodeURIComponent(urlObj.pathname);
  if (p === '/' || p === '' || p.endsWith('/')) {
    p = `${p}index.html`;
  }
  // 去除开头的 /
  if (p.startsWith('/')) {
    p = p.slice(1);
  }
  return p;
}

/**
 * 判断是否属于关键代码或元数据映射锚点（需前后一致性校验与在线比对）
 * @param {string} relPath
 * @returns {boolean}
 */
function isAnchorAsset(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  return ['.html', '.htm', '.js', '.mjs', '.json', '.css'].includes(ext);
}

/**
 * 格式校验：扩展名 vs MIME 与 Magic Number
 * @param {string} relPath
 * @param {string} contentType
 * @param {Buffer} headBuffer
 * @param {number} totalSize
 */
function validateFormat(relPath, contentType, headBuffer, totalSize) {
  const ext = path.extname(relPath).toLowerCase();
  const cType = (contentType || '').toLowerCase();

  // 任何非 html 文件不得以 html 伪装返回
  if (ext !== '.html' && ext !== '.htm') {
    if (cType.includes('text/html')) {
      throw new Error(`Format validation failed: ${relPath} returned text/html content-type`);
    }
    const headText = headBuffer.subarray(0, 64).toString('utf-8').trimStart().toLowerCase();
    if (headText.startsWith('<!doctype') || headText.startsWith('<html')) {
      throw new Error(`Format validation failed: ${relPath} returned HTML body`);
    }
  }

  if (ext === '.glb') {
    if (headBuffer.length < 4 || headBuffer.subarray(0, 4).toString('ascii') !== 'glTF') {
      throw new Error(`Format validation failed: ${relPath} missing glTF magic`);
    }
  } else if (ext === '.ogg') {
    if (headBuffer.length < 4 || headBuffer.subarray(0, 4).toString('ascii') !== 'OggS') {
      throw new Error(`Format validation failed: ${relPath} missing OggS magic`);
    }
  } else if (ext === '.png') {
    const pngMagic = [0x89, 0x50, 0x4E, 0x47];
    if (headBuffer.length < 4 || !headBuffer.subarray(0, 4).equals(Buffer.from(pngMagic))) {
      throw new Error(`Format validation failed: ${relPath} missing PNG magic`);
    }
  } else if (ext === '.webp') {
    if (
      headBuffer.length < 12 ||
      headBuffer.subarray(0, 4).toString('ascii') !== 'RIFF' ||
      headBuffer.subarray(8, 12).toString('ascii') !== 'WEBP'
    ) {
      throw new Error(`Format validation failed: ${relPath} missing WebP RIFF/WEBP magic`);
    }
  }
}

/**
 * 计算已有文件的 SHA-256 和大小
 * @param {string} filePath
 * @returns {Promise<{ sha256: string, size: number }|null>}
 */
async function getExistingFileHash(filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
    return await new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = createReadStream(filePath);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', () => resolve({ sha256: hash.digest('hex'), size: stat.size }));
      stream.on('error', reject);
    });
  } catch {
    return null;
  }
}

/**
 * 执行站点快照
 * @param {object} options
 * @param {string} options.base
 * @param {string} options.out
 * @param {number} [options.concurrency=4]
 * @param {number} [options.timeoutMs=30000]
 * @param {number} [options.maxAttempts=3]
 * @param {number[]} [options.backoffDelays=[1000, 3000]]
 * @param {number} [options.maxFileSize=536870912] // 512MiB
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ success: boolean, assets: object[], report: object }>}
 */
export async function snapshot(options) {
  const {
    base,
    out,
    concurrency = 4,
    timeoutMs = 30000,
    maxAttempts = 3,
    backoffDelays = [1000, 3000],
    maxFileSize = 512 * 1024 * 1024,
    maxParseBytes = 32 * 1024 * 1024,
    spec,
    specPath,
    signal
  } = options;

  if (!base || !out) {
    throw new Error('base URL and out directory are required');
  }

  const baseUrl = new URL(base);
  const outDir = path.resolve(out);
  await fs.mkdir(outDir, { recursive: true });

  let activeSpec = spec || null;
  if (!activeSpec && specPath) {
    const rawSpec = await fs.readFile(path.resolve(specPath), 'utf-8');
    activeSpec = JSON.parse(rawSpec);
  }

  let knownAssetMap = null;
  const referenceSources = new Map();
  const excludedPaths = new Set();
  const exclusionRecords = [];
  let specReport = null;

  if (activeSpec) {
    if (!activeSpec.assetMap || typeof activeSpec.assetMap !== 'object') {
      throw new Error('Spec requires assetMap object');
    }
    const { file, url, expectedSha256 } = activeSpec.assetMap;
    if (!file || typeof file !== 'string') {
      throw new Error('Spec requires assetMap.file string');
    }
    if (!url || typeof url !== 'string') {
      throw new Error('Spec requires assetMap.url string');
    }

    // 严格同源校验，禁止跨源 URL
    const checkedMapUrl = checkedUrl(url, baseUrl);

    if (!expectedSha256 || typeof expectedSha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(expectedSha256)) {
      throw new Error('Spec requires assetMap.expectedSha256 must be a 64-character hex string');
    }

    const mapFilePath = path.resolve(file);
    const mapContent = await fs.readFile(mapFilePath);
    const actualLocalSha = crypto.createHash('sha256').update(mapContent).digest('hex');

    if (expectedSha256.toLowerCase() !== actualLocalSha.toLowerCase()) {
      throw new Error(`Asset map SHA mismatch: expected ${expectedSha256}, got ${actualLocalSha}`);
    }

    knownAssetMap = parseAssetMap(mapContent);
    specReport = {
      file,
      url: checkedMapUrl.href,
      sha256: actualLocalSha,
      entriesCount: knownAssetMap.size
    };

    if (activeSpec.exclusions !== undefined) {
      if (!Array.isArray(activeSpec.exclusions)) {
        throw new Error('Spec exclusions must be an array');
      }
      for (const item of activeSpec.exclusions) {
        if (!item || typeof item !== 'object' || !item.path || typeof item.path !== 'string' || !item.reason || typeof item.reason !== 'string') {
          throw new Error(`Malformed exclusion entry: every item must have non-empty string path and reason: ${JSON.stringify(item)}`);
        }
        const normPath = item.path.startsWith('/') ? item.path : '/' + item.path;
        const normalized = checkedUrl(normPath, baseUrl);
        if (normalized.search || normalized.hash || normalized.pathname !== normPath) throw new Error('Exclusion must use a canonical bare path');
        let reference;
        if (!knownAssetMap.has(normPath)) {
          const proof = item.reference;
          if (!proof || typeof proof.file !== 'string' || !proof.file || typeof proof.url !== 'string' || !proof.url || !/^[a-fA-F0-9]{64}$/.test(proof.expectedSha256 ?? '')) {
            throw new Error(`Invalid exclusion: path "${item.path}" is not in asset map keys and has no valid reference binding`);
          }
          const proofUrl = checkedUrl(proof.url, baseUrl);
          const body = await fs.readFile(path.resolve(proof.file));
          const sha256 = crypto.createHash('sha256').update(body).digest('hex');
          if (sha256 !== proof.expectedSha256.toLowerCase()) throw new Error('Exclusion reference SHA mismatch');
          const kind = path.extname(proofUrl.pathname).slice(1);
          if (!['js', 'mjs', 'html', 'css', 'json'].includes(kind)) throw new Error('Exclusion reference must be a supported text source');
          const refs = discoverRefs(body, kind === 'mjs' ? 'js' : kind, { hasAssetMap: true });
          if (!refs.some(ref => {
            try { return checkedUrl(ref, proofUrl).pathname === normPath; } catch { return false; }
          })) throw new Error('Exclusion path is not statically referenced by bound source');
          const previous = referenceSources.get(proofUrl.href);
          if (previous && previous !== sha256) throw new Error('Conflicting exclusion reference hashes');
          referenceSources.set(proofUrl.href, sha256);
          reference = { file: proof.file, url: proofUrl.href, expectedSha256: sha256 };
        }
        excludedPaths.add(normPath);
        exclusionRecords.push({
          path: normPath,
          reason: item.reason,
          ...(reference ? { reference } : {}),
        });
      }
    }
  }

  const failures = [];
  const externalRefs = new Set();
  const nonAuthoritativeRefs = new Set();
  const metadataRefs = new Set();
  const physicalPathMap = new Map(); // relPath -> sourceUrl.href
  const assetsMap = new Map(); // relPath -> AssetEntry
  const anchorDigests = new Map(); // urlHref -> initialSha256

  async function fetchResourceDigest(urlHref) {
    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => controller.abort(new Error(`Timeout fetching anchor digest for ${urlHref}`)), timeoutMs);
    try {
      let currentUrl = new URL(urlHref);
      let redirectCount = 0;
      const maxRedirects = 5;

      let res;
      while (true) {
        res = await fetch(currentUrl.href, {
          redirect: 'manual',
          signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
        });

        if ([301, 302, 303, 307, 308].includes(res.status)) {
          redirectCount++;
          if (redirectCount > maxRedirects) {
            throw new Error(`Too many redirects for ${urlHref}`);
          }
          const loc = res.headers.get('location');
          if (!loc) {
            throw new Error(`Redirect with missing location header from ${currentUrl.href}`);
          }
          currentUrl = checkedUrl(loc, currentUrl);
          continue;
        }
        break;
      }

      if (!res.ok) {
        throw new Error(`Failed to fetch anchor digest: ${res.status} ${res.statusText}`);
      }
      if (!res.body) {
        return crypto.createHash('sha256').digest('hex');
      }
      const hasher = crypto.createHash('sha256');
      let bytesRead = 0;
      for await (const chunk of res.body) {
        bytesRead += chunk.length;
        if (bytesRead > maxParseBytes) {
          throw new Error(`parse_limit_exceeded: Anchor response exceeded max parse bytes (${maxParseBytes})`);
        }
        hasher.update(chunk);
      }
      return hasher.digest('hex');
    } finally {
      clearTimeout(timeoutTimer);
    }
  }

  // 1. 获取入口 pre-digest
  let entryPreDigest = null;

  async function fetchEntryRaw() {
    return fetchResourceDigest(baseUrl.href);
  }

  try {
    entryPreDigest = await fetchEntryRaw();
    anchorDigests.set(baseUrl.href, entryPreDigest);
  } catch (err) {
    failures.push({ url: baseUrl.href, reason: `Pre-fetch entry failed: ${err.message}` });
  }

  // 若配置了远端 assetMap.url，进行初次强校验（稳态远端 digest 必须精确匹配 local/expected SHA）
  let mapSourceFailed = false;
  if (specReport && specReport.url) {
    try {
      const mapRemoteUrl = specReport.url;
      const remoteDigest = await fetchResourceDigest(mapRemoteUrl);
      if (remoteDigest.toLowerCase() !== specReport.sha256.toLowerCase()) {
        mapSourceFailed = true;
        failures.push({
          url: mapRemoteUrl,
          reason: `map_source_changed: remote asset map digest (${remoteDigest}) does not match local/expected SHA (${specReport.sha256})`
        });
      } else {
        anchorDigests.set(mapRemoteUrl, remoteDigest);
      }
    } catch (err) {
      mapSourceFailed = true;
      failures.push({ url: specReport.url, reason: `Pre-fetch assetMap URL failed: ${err.message}` });
    }
  }

  for (const [url, expected] of referenceSources) {
    try {
      const actual = await fetchResourceDigest(url);
      if (actual !== expected) throw new Error('reference_source_changed: remote bytes differ from bound source');
      anchorDigests.set(url, expected);
    } catch (error) {
      mapSourceFailed = true;
      failures.push({ url, reason: error.message });
    }
  }

  // 队列与 Worker 设置
  const queue = [];
  const visitedUrls = new Set();
  let activeWorkers = 0;

  function canonicalizeUrl(urlObj) {
    if (!knownAssetMap) return urlObj;
    const bareKey = urlObj.pathname;
    if (knownAssetMap.has(bareKey)) {
      const canonicalRel = knownAssetMap.get(bareKey);
      const canonicalTarget = new URL(canonicalRel, baseUrl);
      // 若当前 URL 没有 query，或 query 恰好匹配权威 query：
      if (!urlObj.search || urlObj.search === canonicalTarget.search) {
        return canonicalTarget;
      }
      // 若带有其他未核准 query：保持原样，后续物理路径冲突检测会判定冲突报错
    }
    return urlObj;
  }

  function enqueue(urlObj) {
    const canonicalUrl = canonicalizeUrl(urlObj);
    const href = canonicalUrl.href;
    if (visitedUrls.has(href)) return;

    // 全局集中拦截 spec 声明的排除项：彻底阻止再次入队与发起请求（无论来自 seed、JS还是JSON）
    if (knownAssetMap && excludedPaths.has(canonicalUrl.pathname)) {
      return;
    }

    visitedUrls.add(href);

    const relPath = urlToRelativePath(canonicalUrl);

    // 冲突检查：不同 URL 映射到同一物理路径
    if (physicalPathMap.has(relPath)) {
      const existing = physicalPathMap.get(relPath);
      if (existing !== href) {
        failures.push({
          url: href,
          path: relPath,
          reason: `Conflict: multiple URLs map to the same physical path "${relPath}": [${existing}] vs [${href}]`
        });
        return;
      }
    } else {
      physicalPathMap.set(relPath, href);
    }

    queue.push(canonicalUrl);
  }

  if (!mapSourceFailed) {
    // 初始入队 baseUrl
    enqueue(baseUrl);

    // 若配置了 assetMap，将未被排除的权威资源作为种子主动入队
    if (knownAssetMap) {
      for (const [bareKey, canonicalRel] of knownAssetMap.entries()) {
        if (excludedPaths.has(bareKey)) {
          continue;
        }
        const seedUrl = new URL(canonicalRel, baseUrl);
        enqueue(seedUrl);
      }
    }
  }

  let queueResolve;
  const queuePromise = new Promise(resolve => {
    queueResolve = resolve;
  });

  function kickWorkers() {
    while (activeWorkers < concurrency && queue.length > 0) {
      const item = queue.shift();
      activeWorkers++;
      processItem(item)
        .catch(err => {
          failures.push({ url: item.href, reason: err.message });
        })
        .finally(() => {
          activeWorkers--;
          if (activeWorkers === 0 && queue.length === 0) {
            queueResolve();
          } else {
            kickWorkers();
          }
        });
    }
  }

  async function processItem(urlObj) {
    const relPath = urlToRelativePath(urlObj);
    const targetPath = path.resolve(outDir, relPath);
    const isEntry = urlObj.href === baseUrl.href;

    const isAnchor = isAnchorAsset(relPath);

    // 检查已有文件是否可复用 (非 entry 文件且存在且 SHA 可算)
    let existing = isEntry ? null : await getExistingFileHash(targetPath);
    let assetEntry = null;
    let fileBufferOrText = null;

    if (existing) {
      if (isAnchor) {
        // 关键脚本与元数据映射锚点：不能旧 SHA 盲目当一致，必须在线核验远端当前 digest
        try {
          const remoteDigest = await fetchResourceDigest(urlObj.href);
          if (remoteDigest !== existing.sha256) {
            // 远端发生变动，不能用旧 SHA 复用伪当一致，标记 anchor changed 失败
            failures.push({
              url: urlObj.href,
              reason: `Anchor changed compared to existing file: local=${existing.sha256} remote=${remoteDigest}`
            });
            anchorDigests.set(urlObj.href, remoteDigest);
          } else {
            // 记录一致锚点供后续二次核验
            anchorDigests.set(urlObj.href, remoteDigest);
          }
        } catch (err) {
          failures.push({ url: urlObj.href, reason: `Anchor verification failed: ${err.message}` });
        }
      }
    }

    if (existing) {
      // 复用已有文件
      const ext = path.extname(relPath).toLowerCase();
      assetEntry = {
        sourceUrl: urlObj.href,
        path: relPath.replace(/\\/g, '/'),
        contentType: getContentTypeByExt(ext),
        size: existing.size,
        sha256: existing.sha256
      };
      assetsMap.set(relPath, assetEntry);

      // 若为文本资源，仍需读入以发现新引用
      if (['.html', '.htm', '.css', '.js', '.mjs', '.json'].includes(ext)) {
        try {
          fileBufferOrText = await fs.readFile(targetPath, 'utf-8');
        } catch {
          // ignore
        }
      } else if (ext === '.glb') {
        try {
          fileBufferOrText = await fs.readFile(targetPath);
        } catch {
          // ignore
        }
      }
    } else {
      // 下载并验证
      const downloaded = await downloadWithRetry(urlObj, targetPath, relPath);
      assetEntry = downloaded.asset;
      fileBufferOrText = downloaded.content;
      assetsMap.set(relPath, assetEntry);

      if (isAnchor) {
        anchorDigests.set(urlObj.href, assetEntry.sha256);
      }
    }

    // 发现引用的子资源
    if (fileBufferOrText) {
      const ext = path.extname(relPath).toLowerCase();
      let kind = 'js';
      if (ext === '.html' || ext === '.htm') kind = 'html';
      else if (ext === '.css') kind = 'css';
      else if (ext === '.json') kind = 'json';
      else if (ext === '.glb') kind = 'glb';

      const refs = discoverRefs(fileBufferOrText, kind, {
        hasAssetMap: Boolean(knownAssetMap),
        knownAssetMap,
        metadataRefs
      });
      for (const ref of refs) {
        try {
          let resolvedRef = ref;
          if (knownAssetMap && resolvedRef.startsWith('assets/')) {
            resolvedRef = '/' + resolvedRef;
          }
          const childUrl = checkedUrl(resolvedRef, urlObj);
          // Asset map是公开候选集，不是完整运行依赖；显式静态引用仍须抓取。
          enqueue(childUrl);
        } catch (err) {
          if (err.isCrossOrigin || /cross-origin/i.test(err.message)) {
            externalRefs.add(ref);
          } else {
            failures.push({
              url: ref,
              parent: urlObj.href,
              reason: `Invalid reference: ${err.message}`
            });
          }
        }
      }
    }
  }

  async function downloadWithRetry(urlObj, targetPath, relPath) {
    let attempt = 0;
    let lastError = null;

    while (attempt < maxAttempts) {
      attempt++;
      try {
        return await downloadSingle(urlObj, targetPath, relPath);
      } catch (err) {
        lastError = err;
        // 如果是跨源重定向、格式错误、404 等，不重试
        if (
          err.isCrossOrigin ||
          /cross-origin|format validation|404/i.test(err.message) ||
          attempt >= maxAttempts
        ) {
          throw err;
        }
        // 退避延迟
        const delay = backoffDelays[attempt - 1] ?? backoffDelays[backoffDelays.length - 1] ?? 1000;
        await new Promise(r => setTimeout(r, delay));
      }
    }

    throw lastError;
  }

  async function downloadSingle(urlObj, targetPath, relPath) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const tempPath = `${targetPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    let currentUrl = urlObj;
    let redirectCount = 0;
    const maxRedirects = 5;

    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => {
      controller.abort(new Error(`Download timeout after ${timeoutMs}ms: ${urlObj.href}`));
    }, timeoutMs);

    const mergedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;

    let res;
    try {
      while (true) {
        res = await fetch(currentUrl.href, {
          redirect: 'manual',
          signal: mergedSignal
        });

        // 处理重定向
        if ([301, 302, 303, 307, 308].includes(res.status)) {
          redirectCount++;
          if (redirectCount > maxRedirects) {
            throw new Error(`Too many redirects for ${urlObj.href}`);
          }
          const loc = res.headers.get('location');
          if (!loc) {
            throw new Error(`Redirect with missing location header from ${currentUrl.href}`);
          }
          // 校验重定向目标同源性（checkedUrl 抛错即失败）
          currentUrl = checkedUrl(loc, currentUrl);
          continue;
        }

        break;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText} for ${urlObj.href}`);
      }

      const contentType = res.headers.get('content-type') || '';
      const hasher = crypto.createHash('sha256');

      let totalBytes = 0;
      const headChunks = [];
      let headBytes = 0;
      const bodyChunks = []; // 收集文本或需要解析的文件内容
      let collectedBytes = 0;

      const ext = path.extname(relPath).toLowerCase();
      const isGlb = ext === '.glb';
      const shouldCollectContent = ['.html', '.htm', '.css', '.js', '.mjs', '.json', '.glb'].includes(ext);

      if (!res.body) {
        throw new Error(`Response body is empty for ${urlObj.href}`);
      }

      let writeStream = null;
      let streamClosed = false;

      try {
        writeStream = createWriteStream(tempPath);

        let streamError = null;
        const onGlobalError = (err) => {
          streamError = err;
        };
        const onGlobalClose = () => {
          streamClosed = true;
        };
        writeStream.on('error', onGlobalError);
        writeStream.on('close', onGlobalClose);

        // 早期捕获：等待流打开（两边 listener 严格配对清除）
        await new Promise((resolve, reject) => {
          if (typeof writeStream.fd === 'number') {
            resolve();
            return;
          }
          const onOpen = () => { cleanup(); resolve(); };
          const onError = (err) => { cleanup(); reject(err); };
          function cleanup() {
            writeStream.removeListener('open', onOpen);
            writeStream.removeListener('error', onError);
          }
          writeStream.once('open', onOpen);
          writeStream.once('error', onError);
        });

        let glbMaxCollect = 16 * 1024 * 1024; // 默认 16MiB

        for await (const chunk of res.body) {
          if (streamError) throw streamError;
          totalBytes += chunk.length;
          if (totalBytes > maxFileSize) {
            writeStream.destroy();
            throw new Error(`File size ${totalBytes} exceeded limit ${maxFileSize}`);
          }

          hasher.update(chunk);

          if (headBytes < 64) {
            headChunks.push(chunk);
            headBytes += chunk.length;
            if (isGlb && headBytes >= 20) {
              const headBuf = Buffer.concat(headChunks);
              if (headBuf.subarray(0, 4).toString('ascii') === 'glTF') {
                const chunk0Len = headBuf.readUInt32LE(12);
                if (chunk0Len > 16 * 1024 * 1024) {
                  writeStream.destroy();
                  throw new Error(`parse_limit_exceeded: GLB JSON chunk length ${chunk0Len} exceeded limit (16MiB)`);
                }
                glbMaxCollect = 20 + chunk0Len;
              }
            }
          }

          if (shouldCollectContent) {
            if (isGlb) {
              // GLB 只缓冲包含外部 URI 的前部 JSON Chunk，大模型其余二进制 BIN 纯流式落盘
              if (collectedBytes < glbMaxCollect) {
                const remaining = glbMaxCollect - collectedBytes;
                if (chunk.length <= remaining) {
                  bodyChunks.push(chunk);
                  collectedBytes += chunk.length;
                } else {
                  bodyChunks.push(chunk.subarray(0, remaining));
                  collectedBytes += remaining;
                }
              }
            } else {
              // 普通文本资源：如果超过 maxParseBytes 必须抛出 parse_limit_exceeded，绝不静默截断伪当成功
              if (collectedBytes + chunk.length > maxParseBytes) {
                writeStream.destroy();
                throw new Error(`parse_limit_exceeded: text asset ${relPath} exceeded maxParseBytes (${maxParseBytes})`);
              }
              bodyChunks.push(chunk);
              collectedBytes += chunk.length;
            }
          }

          if (!writeStream.write(chunk)) {
            // 背压等待（严格配对清除 drain 与 error 监听，防止 MaxListeners 警告）
            await new Promise((resolve, reject) => {
              const onDrain = () => { cleanup(); resolve(); };
              const onError = (err) => { cleanup(); reject(err); };
              function cleanup() {
                writeStream.removeListener('drain', onDrain);
                writeStream.removeListener('error', onError);
              }
              writeStream.once('drain', onDrain);
              writeStream.once('error', onError);
            });
          }
        }

        await new Promise((resolve, reject) => {
          const onFinish = () => { cleanup(); resolve(); };
          const onError = (err) => { cleanup(); reject(err); };
          function cleanup() {
            writeStream.removeListener('finish', onFinish);
            writeStream.removeListener('error', onError);
          }
          writeStream.once('finish', onFinish);
          writeStream.once('error', onError);
          writeStream.end();
        });

        writeStream.removeListener('error', onGlobalError);
      } catch (streamErr) {
        if (writeStream) {
          if (!writeStream.destroyed) {
            writeStream.destroy();
          }
          if (!streamClosed) {
            await new Promise(r => writeStream.once('close', r)).catch(() => {});
          }
        }
        await fs.unlink(tempPath).catch(() => {});
        throw streamErr;
      }

      const headBuffer = Buffer.concat(headChunks);
      validateFormat(relPath, contentType, headBuffer, totalBytes);

      const sha256 = hasher.digest('hex');

      // 校验成功，原子移动至目标文件
      await fs.rename(tempPath, targetPath);

      let content = null;
      if (shouldCollectContent) {
        const fullBuf = Buffer.concat(bodyChunks);
        content = ext === '.glb' ? fullBuf : fullBuf.toString('utf-8');
      }

      return {
        asset: {
          sourceUrl: urlObj.href,
          path: relPath.replace(/\\/g, '/'),
          contentType,
          size: totalBytes,
          sha256
        },
        content
      };
    } catch (err) {
      await fs.unlink(tempPath).catch(() => {});
      throw err;
    } finally {
      clearTimeout(timeoutTimer);
    }
  }

  // 启动 Worker
  if (!mapSourceFailed) {
    kickWorkers();
    await queuePromise;
  }

  // 2. 重新 fetch 检查所有 anchorDigests，确保快照期间没有版本漂移
  let anchorChanged = false;
  if (!mapSourceFailed) {
    for (const [href, initialDigest] of anchorDigests.entries()) {
      try {
        const postDigest = await fetchResourceDigest(href);
        if (postDigest !== initialDigest) {
          anchorChanged = true;
          failures.push({
            url: href,
            reason: `Anchor digest changed during snapshot: initial=${initialDigest} post=${postDigest}`
          });
        }
      } catch (err) {
        anchorChanged = true;
        failures.push({
          url: href,
          reason: `Post-check fetch failed for anchor ${href}: ${err.message}`
        });
      }
    }
  }

  let consistency = 'consistent';
  if (mapSourceFailed) {
    consistency = 'inconsistent_map_source_changed';
  } else if (anchorChanged || failures.some(f => f.reason && f.reason.includes('Anchor changed compared to existing file'))) {
    consistency = 'inconsistent_anchor_changed';
  } else if (!entryPreDigest) {
    consistency = 'inconsistent_entry_fetch_failed';
  }

  // 构建排序后的 assets.json 列表（排除自身与 report）
  const assets = Array.from(assetsMap.values())
    .filter(a => a.path !== 'assets.json' && a.path !== 'snapshot-report.json')
    .sort((a, b) => a.path.localeCompare(b.path));

  const report = {
    failures,
    externalRefs: Array.from(externalRefs).sort(),
    consistency,
    closure: failures.length > 0
      ? 'incomplete'
      : (exclusionRecords.length > 0 ? 'pending_runtime_verification' : 'pending_verification: dynamic string mapping cannot guarantee complete closure without runtime verification')
  };

  if (specReport) {
    report.assetMap = specReport;
  }
  if (knownAssetMap) {
    report.scope = 'limited_by_asset_map';
  }
  if (exclusionRecords.length > 0) {
    report.exclusions = exclusionRecords;
    report.notCompleteReason = `Excluded ${exclusionRecords.length} assets declared in spec; closure is pending runtime verification`;
  }
  if (nonAuthoritativeRefs.size > 0) {
    report.nonAuthoritativeRefs = Array.from(nonAuthoritativeRefs).sort();
  }
  if (metadataRefs.size > 0) {
    report.metadataRefs = Array.from(metadataRefs).sort();
  }

  // 写入 assets.json 与 snapshot-report.json
  await fs.writeFile(path.join(outDir, 'assets.json'), JSON.stringify(assets, null, 2), 'utf-8');
  await fs.writeFile(path.join(outDir, 'snapshot-report.json'), JSON.stringify(report, null, 2), 'utf-8');

  const success = failures.length === 0 && consistency === 'consistent';
  return { success, assets, report };
}

function getContentTypeByExt(ext) {
  switch (ext) {
    case '.html':
    case '.htm':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      case '.mjs':
      return 'application/javascript; charset=utf-8';
    case '.json':
      return 'application/json';
    case '.glb':
      return 'model/gltf-binary';
    case '.ogg':
      return 'audio/ogg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.bin':
      return 'application/octet-stream';
    default:
      return 'application/octet-stream';
  }
}

// CLI 执行入口
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  let base = null;
  let out = null;
  let specPath = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--base' || args[i] === '-b') {
      base = args[++i];
    } else if (args[i] === '--out' || args[i] === '-o') {
      out = args[++i];
    } else if (args[i] === '--spec' || args[i] === '--discovery-spec') {
      specPath = args[++i];
    }
  }

  if (!base || !out) {
    console.error('Usage: node tools/snapshot.mjs --base <URL> --out <DIR> [--spec <SPEC.json>]');
    process.exit(1);
  }

  try {
    const result = await snapshot({ base, out, specPath });
    if (!result.success) {
      console.error('Snapshot failed with issues:');
      console.error(JSON.stringify(result.report, null, 2));
      process.exit(1);
    } else {
      console.log(`Snapshot completed successfully: ${result.assets.length} assets recorded.`);
    }
  } catch (err) {
    console.error('Snapshot encountered fatal error:', err);
    process.exit(1);
  }
}

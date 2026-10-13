import path from 'node:path';

// Win32 常量与 WM_COMMAND 按钮 ID (4retry, 2cancel, 7no, 6yes, 1ok)
export const WIN32_CONSTANTS = {
  IDOK: 1,
  IDCANCEL: 2,
  IDRETRY: 4,
  IDYES: 6,
  IDNO: 7,
  WM_COMMAND: 0x0111,
  WM_CLOSE: 0x0010,
  DM_GETDEFID: 0x0400,
};

export function validateExePath(exePath, projectRoot) {
  if (!exePath) throw new Error('ExePath is required');
  if (!path.isAbsolute(exePath)) throw new Error('ExePath must be an absolute path');

  const normalizedExe = path.normalize(exePath).toLowerCase();
  // 必须严格包含结尾目录分隔符，防止 target/debug-evil 绕过
  let normalizedDebugDir = path.normalize(path.join(projectRoot, 'target', 'debug')).toLowerCase();
  if (!normalizedDebugDir.endsWith(path.sep)) {
    normalizedDebugDir += path.sep;
  }

  if (!normalizedExe.startsWith(normalizedDebugDir)) {
    throw new Error(`ExePath must be located in target/debug directory: ${exePath}`);
  }
  return true;
}

export function isTimeoutWithinBounds(seconds) {
  return seconds >= 4.5 && seconds <= 9.0;
}

export function createBridgeMockScript({ failFlush = false, stallFlush = false, dirtyKey = null, dirtyVal = null } = {}) {
  return `(async () => {
  window.__VALIDATION_ORIGINAL__ = window.__VALIDATION_ORIGINAL__ || window.__ASHFALL_BRIDGE__;
  const orig = window.__VALIDATION_ORIGINAL__;
  if (orig && typeof orig.freeze === 'function') {
    await orig.freeze();
  }
  let isDirty = true;
  window.__ASHFALL_BRIDGE__ = {
    freeze: async () => { if (orig && typeof orig.freeze === 'function') await orig.freeze(); },
    thaw: () => { isDirty = true; },
    isDirty: () => isDirty,
    getRevision: () => (orig && typeof orig.getRevision === 'function') ? orig.getRevision() : 0,
    flush: ${stallFlush ? '() => new Promise(() => {})' : failFlush ? 'async () => { throw new Error("injected flush failure"); }' : 'async () => { if (orig) return await orig.flush(); }'}
  };
  ${dirtyKey && dirtyVal ? `localStorage.setItem(${JSON.stringify(dirtyKey)}, ${JSON.stringify(dirtyVal)});` : ''}
  return { mocked: true, stall: ${stallFlush}, fail: ${failFlush}, frozen: true };
})()`;
}

export function createBridgeRestoreScript() {
  return `(async () => {
  if (window.__VALIDATION_ORIGINAL__) {
    window.__ASHFALL_BRIDGE__ = window.__VALIDATION_ORIGINAL__;
    window.__VALIDATION_ORIGINAL__ = null;
    return { restored: true };
  }
  return { restored: false };
})()`;
}

// ---------------------------------------------------------------------------
// 顶层分支 Guard: --cdp-eval 模式仅作为纯净 CDP Helper，绝不注册或运行 test()
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const isCdpEval = args.includes('--cdp-eval');

if (isCdpEval) {
  const getArg = (name, fallback) => {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : fallback;
  };
  const port = Number(getArg('port', '23389'));
  const b64 = getArg('code-b64', '');
  if (!b64) {
    console.error(JSON.stringify({ success: false, error: 'Missing --code-b64' }));
    process.exit(1);
  }
  const code = Buffer.from(b64, 'base64').toString('utf8');

  try {
    let page;
    for (let i = 0; i < 60; i++) {
      try {
        const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        page = pages.find(p => p.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(p.url) && !p.url.includes('/__bootstrap/'));
        if (page) break;
      } catch (_) {}
      await new Promise(r => setTimeout(r, 250));
    }
    if (!page) {
      console.log(JSON.stringify({ success: false, error: 'WebView page not found on CDP port' }));
      process.exit(1);
    }

    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });

    let nextId = 0;
    const send = (method, params = {}) => {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 10000);
        const onMsg = (event) => {
          const data = JSON.parse(event.data);
          if (data.id === id) {
            clearTimeout(timer);
            socket.removeEventListener('message', onMsg);
            if (data.error) reject(new Error(JSON.stringify(data.error)));
            else resolve(data.result);
          }
        };
        socket.addEventListener('message', onMsg);
        socket.send(JSON.stringify({ id, method, params }));
      });
    };

    try {
      await send('Runtime.enable');
      const evalRes = await send('Runtime.evaluate', {
        expression: code,
        awaitPromise: true,
        returnByValue: true
      });
      if (evalRes.exceptionDetails) {
        console.log(JSON.stringify({ success: false, error: evalRes.exceptionDetails }));
      } else {
        // stdout 纯净输出单一 JSON，无任何测试污染
        console.log(JSON.stringify({ success: true, value: evalRes.result?.value }));
      }
    } finally {
      socket.close();
    }
    process.exit(0);
  } catch (err) {
    console.log(JSON.stringify({ success: false, error: err.message || String(err) }));
    process.exit(1);
  }
} else {
  // ---------------------------------------------------------------------------
  // 单元与行为测试 (Unit & Behavioral Tests) - 仅在普通测试运行时注册
  // ---------------------------------------------------------------------------
  const { default: test } = await import('node:test');
  const { default: assert } = await import('node:assert/strict');

  test('Win32 button IDs and messages conform to specifications', () => {
    assert.equal(WIN32_CONSTANTS.IDOK, 1);
    assert.equal(WIN32_CONSTANTS.IDCANCEL, 2);
    assert.equal(WIN32_CONSTANTS.IDRETRY, 4);
    assert.equal(WIN32_CONSTANTS.IDYES, 6);
    assert.equal(WIN32_CONSTANTS.IDNO, 7);
    assert.equal(WIN32_CONSTANTS.WM_COMMAND, 0x0111);
    assert.equal(WIN32_CONSTANTS.WM_CLOSE, 0x0010);
    assert.equal(WIN32_CONSTANTS.DM_GETDEFID, 0x0400);
  });

  test('validateExePath strictly enforces target/debug with separator and blocks target/debug-evil', () => {
    const root = 'F:\\Documents\\Project\\starcraft-ashfall-client';
    const valid = 'F:\\Documents\\Project\\starcraft-ashfall-client\\target\\debug\\ashfall-local.exe';
    assert.equal(validateExePath(valid, root), true);

    assert.throws(() => validateExePath('relative/path.exe', root), /absolute path/);
    // 关键安全校验：必须拒绝 target/debug-evil
    assert.throws(
      () => validateExePath('F:\\Documents\\Project\\starcraft-ashfall-client\\target\\debug-evil\\ashfall-local.exe', root),
      /target\/debug/
    );
    assert.throws(
      () => validateExePath('F:\\Documents\\Project\\starcraft-ashfall-client\\target\\release\\ashfall-local.exe', root),
      /target\/debug/
    );
    assert.throws(() => validateExePath('C:\\Windows\\notepad.exe', root), /target\/debug/);
  });

  test('isTimeoutWithinBounds validates nominal 5s timeout window and rejects runaway timeouts', () => {
    assert.equal(isTimeoutWithinBounds(4.8), true);
    assert.equal(isTimeoutWithinBounds(5.2), true);
    assert.equal(isTimeoutWithinBounds(8.5), true);

    assert.equal(isTimeoutWithinBounds(4.0), false); // 提前触发（不是 5s 超时）
    assert.equal(isTimeoutWithinBounds(9.1), false); // 超过 9 秒（挂死或超时过界）
    assert.equal(isTimeoutWithinBounds(60.0), false); // 兜底 deadline 拒绝通过
  });

  test('behavioral: bridge mock freezes original before setting dirty state and throws on flush', async () => {
    let freezeCalled = false;
    let stored = {};

    const fakeWindow = {
      __ASHFALL_BRIDGE__: {
        freeze: async () => { freezeCalled = true; },
        thaw: () => {},
        isDirty: () => false,
        getRevision: () => 42,
        flush: async () => 42,
      },
      localStorage: {
        setItem: (k, v) => {
          // 验证：在 setItem 前，原始 freeze 必须已经被调用过，避免 100ms 防抖后台落盘
          assert.equal(freezeCalled, true, 'original bridge.freeze() must be called before storage mutation');
          stored[k] = v;
        },
        getItem: (k) => stored[k] ?? null,
      }
    };

    // 运行由 createBridgeMockScript 生成的代码
    const script = createBridgeMockScript({ failFlush: true, dirtyKey: 'test-k', dirtyVal: 'test-v' });
    const fn = new Function('window', 'localStorage', `return ${script}`);
    const res = await fn(fakeWindow, fakeWindow.localStorage);

    assert.equal(res.mocked, true);
    assert.equal(res.frozen, true);
    assert.equal(freezeCalled, true);
    assert.equal(fakeWindow.localStorage.getItem('test-k'), 'test-v');
    assert.equal(fakeWindow.__ASHFALL_BRIDGE__.getRevision(), 42);
    assert.equal(fakeWindow.__ASHFALL_BRIDGE__.isDirty(), true);

    // 验证 flush 行为
    await assert.rejects(
      async () => { await fakeWindow.__ASHFALL_BRIDGE__.flush(); },
      /injected flush failure/
    );

    // 验证 restore 行为
    const restoreScript = createBridgeRestoreScript();
    const restoreFn = new Function('window', `return ${restoreScript}`);
    const restoreRes = await restoreFn(fakeWindow);
    assert.equal(restoreRes.restored, true);
    assert.equal(fakeWindow.__ASHFALL_BRIDGE__.isDirty(), false);
    assert.equal(await fakeWindow.__ASHFALL_BRIDGE__.flush(), 42);
  });

  test('behavioral: bridge mock stall creates unresolving flush promise', async () => {
    const fakeWindow = {
      __ASHFALL_BRIDGE__: {
        freeze: async () => {},
        thaw: () => {},
        isDirty: () => false,
        getRevision: () => 10,
      },
      localStorage: { setItem: () => {}, getItem: () => null }
    };

    const script = createBridgeMockScript({ stallFlush: true });
    const fn = new Function('window', 'localStorage', `return ${script}`);
    await fn(fakeWindow, fakeWindow.localStorage);

    const flushPromise = fakeWindow.__ASHFALL_BRIDGE__.flush();
    // 验证在 50ms 内不 settle
    const raceResult = await Promise.race([
      flushPromise,
      new Promise(r => setTimeout(() => r('stalled'), 50))
    ]);
    assert.equal(raceResult, 'stalled');
  });
}

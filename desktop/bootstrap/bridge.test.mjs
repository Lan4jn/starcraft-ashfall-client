// desktop/bootstrap/bridge.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { installBridge } from './bridge.js';

// 辅助工具：创建支持模拟的存储对象
function createFakeStorage(initialEntries = []) {
  const store = new Map(initialEntries);
  return {
    _map: store,
    get length() { return store.size; },
    key(i) { return [...store.keys()][i] ?? null; },
    getItem(k) { return store.get(String(k)) ?? null; },
    setItem(k, v) { store.set(String(k), String(v)); },
    removeItem(k) { store.delete(String(k)); },
    clear() { store.clear(); },
  };
}

test('1. 初始恢复完整Map并删除旧键，不产生反向空快照', async () => {
  const storage = createFakeStorage([['stale', '1'], ['old_key', '2']]);
  const sent = [];
  const bridge = installBridge({
    storage,
    seed: {
      schemaVersion: 1,
      revision: 7,
      savedAt: '2026-10-12T00:00:00Z',
      values: { 'capsule-pointer': 'uuid-1', 'capsule-uuid-1': 'payload' },
    },
    invoke: async (command, args) => {
      sent.push({ command, args });
      return args?.snapshot?.revision;
    },
  });

  try {
    // 旧键被清除，种子键值完整回填
    assert.equal(storage.getItem('stale'), null);
    assert.equal(storage.getItem('old_key'), null);
    assert.equal(storage.getItem('capsule-pointer'), 'uuid-1');
    assert.equal(storage.getItem('capsule-uuid-1'), 'payload');

    // 初始化不自动发送快照
    assert.equal(sent.length, 0);

    // 手动flush能正常保存种子状态，revision推进至8
    await bridge.flush();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].command, 'save_snapshot');
    assert.equal(sent[0].args.snapshot.revision, 8);
    assert.equal(sent[0].args.snapshot.values['capsule-uuid-1'], 'payload');
  } finally {
    bridge.dispose();
  }
});

test('2. 动态UUID键支持（不筛前缀，完整恢复）', async () => {
  const dynamicUuidKey1 = '3f7b2c9a-8e1d-4a5f-9b2c-1d8e4a5f9b2c';
  const dynamicUuidKey2 = 'user_pref_8888-9999-aaaa';
  const storage = createFakeStorage();
  const sent = [];

  const bridge = installBridge({
    storage,
    seed: {
      schemaVersion: 1,
      revision: 10,
      savedAt: '2026-10-12T00:00:00Z',
      values: {
        [dynamicUuidKey1]: 'data-1',
        [dynamicUuidKey2]: 'data-2',
        'sc-shooter-board': 'scores',
      },
    },
    invoke: async (command, args) => {
      sent.push({ command, args });
      return args?.snapshot?.revision;
    },
  });

  try {
    // 任意UUID键均同步恢复
    assert.equal(storage.getItem(dynamicUuidKey1), 'data-1');
    assert.equal(storage.getItem(dynamicUuidKey2), 'data-2');
    assert.equal(storage.getItem('sc-shooter-board'), 'scores');

    await bridge.flush();
    assert.equal(sent.length, 1);
    const flushedValues = sent[0].args.snapshot.values;
    assert.equal(flushedValues[dynamicUuidKey1], 'data-1');
    assert.equal(flushedValues[dynamicUuidKey2], 'data-2');
    assert.equal(flushedValues['sc-shooter-board'], 'scores');
  } finally {
    bridge.dispose();
  }
});

test('3. set / remove / clear 完整生命周期及100ms防抖合并', async () => {
  const storage = createFakeStorage();
  const sent = [];
  const bridge = installBridge({
    storage,
    seed: {
      schemaVersion: 1,
      revision: 1,
      savedAt: '2026-10-12T00:00:00Z',
      values: {},
    },
    invoke: async (command, args) => {
      sent.push({ command, args });
      return args?.snapshot?.revision;
    },
  });

  try {
    // 短时间内密集 setItem，100ms合并保存一次
    storage.setItem('k1', 'v1');
    storage.setItem('k2', 'v2');
    storage.setItem('k3', 'v3');

    // 未到100ms前未触发IPC
    assert.equal(sent.length, 0);

    // 等待防抖触发 (150ms)
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].args.snapshot.revision, 2);
    assert.equal(sent[0].args.snapshot.values['k1'], 'v1');
    assert.equal(sent[0].args.snapshot.values['k2'], 'v2');
    assert.equal(sent[0].args.snapshot.values['k3'], 'v3');

    // removeItem 保持全量快照中删除
    storage.removeItem('k2');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(sent.length, 2);
    assert.equal(sent[1].args.snapshot.revision, 3);
    assert.equal(sent[1].args.snapshot.values['k1'], 'v1');
    assert.equal('k2' in sent[1].args.snapshot.values, false);
    assert.equal(sent[1].args.snapshot.values['k3'], 'v3');

    // clear 清空存储
    storage.clear();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(sent.length, 3);
    assert.equal(sent[2].args.snapshot.revision, 4);
    assert.deepEqual(Object.keys(sent[2].args.snapshot.values), []);
  } finally {
    bridge.dispose();
  }
});

test('4. 并发flush单串行链、递增revision且不乱序', async () => {
  const storage = createFakeStorage();
  const invocations = [];
  let inFlightCount = 0;
  let maxConcurrency = 0;

  const bridge = installBridge({
    storage,
    seed: {
      schemaVersion: 1,
      revision: 100,
      savedAt: '2026-10-12T00:00:00Z',
      values: {},
    },
    invoke: async (command, args) => {
      inFlightCount++;
      maxConcurrency = Math.max(maxConcurrency, inFlightCount);
      // 模拟 40ms IPC 延迟
      await new Promise((r) => setTimeout(r, 40));
      inFlightCount--;
      invocations.push({ command, rev: args.snapshot.revision });
      return args.snapshot.revision;
    },
  });

  try {
    // 写入多个键并同时触发多个 flush
    storage.setItem('a', '1');
    const p1 = bridge.flush();
    // 稍后在p1运行中再次写入
    setTimeout(() => { storage.setItem('b', '2'); }, 10);
    const p2 = bridge.flush();
    const p3 = bridge.flush();

    await Promise.all([p1, p2, p3]);

    // IPC必须是严格串行的（最大并发数不超过1）
    assert.equal(maxConcurrency, 1);
    // Revision必须严格递增，不可乱序
    assert.ok(invocations.length >= 1);
    for (let i = 1; i < invocations.length; i++) {
      assert.ok(invocations[i].rev > invocations[i - 1].rev);
    }
  } finally {
    bridge.dispose();
  }
});

test('5. 失败重试：保留脏标记、报告flush_failed、无unhandled rejection', async () => {
  const storage = createFakeStorage();
  const failedReports = [];
  let shouldFail = true;

  const bridge = installBridge({
    storage,
    seed: {
      schemaVersion: 1,
      revision: 5,
      savedAt: '2026-10-12T00:00:00Z',
      values: {},
    },
    invoke: async (command, args) => {
      if (command === 'flush_failed') {
        failedReports.push(args);
        return;
      }
      if (command === 'save_snapshot') {
        if (shouldFail) {
          throw new Error('Disk full or IO error');
        }
        return args.snapshot.revision;
      }
    },
  });

  try {
    storage.setItem('game_save', 'score:999');

    // 调用 flush()，预期抛出真实错误
    await assert.rejects(
      async () => {
        await bridge.flush();
      },
      { message: /Disk full or IO error/ }
    );

    // 确认已向Rust报告 flush_failed
    assert.equal(failedReports.length, 1);
    assert.match(failedReports[0].message, /Disk full or IO error/);

    // 修复故障，再次调用 flush()（脏标记仍保留）
    shouldFail = false;
    const rev = await bridge.flush();
    assert.equal(rev, 6);
  } finally {
    bridge.dispose();
  }
});

test('6. null seed：保留现有存储，不发送空快照，revision从0自增', async () => {
  const storage = createFakeStorage([['existing_user_data', 'keep_me']]);
  const sent = [];

  const bridge = installBridge({
    storage,
    seed: null,
    invoke: async (command, args) => {
      sent.push({ command, args });
      return args?.snapshot?.revision;
    },
  });

  try {
    // 现有数据未被清空
    assert.equal(storage.getItem('existing_user_data'), 'keep_me');
    // 初始化不发快照
    assert.equal(sent.length, 0);

    // 写入新数据并flush
    storage.setItem('new_data', 'val');
    await bridge.flush();

    assert.equal(sent.length, 1);
    assert.equal(sent[0].args.snapshot.revision, 1);
    assert.equal(sent[0].args.snapshot.values['existing_user_data'], 'keep_me');
    assert.equal(sent[0].args.snapshot.values['new_data'], 'val');
  } finally {
    bridge.dispose();
  }
});

test('7. 16MiB限制与多字节Unicode字节数计算', async () => {
  const storage = createFakeStorage();
  const failedReports = [];

  const bridge = installBridge({
    storage,
    seed: null,
    invoke: async (command, args) => {
      if (command === 'flush_failed') {
        failedReports.push(args);
      }
      return args?.snapshot?.revision;
    },
  });

  try {
    // 测试中文字符多字节计算（1个中文字符占3个UTF-8字节）
    const chineseStr = '星际争霸余烬'; // 6个字符 = 18字节
    storage.setItem('title', chineseStr);
    await bridge.flush();

    // 构造超 16MiB 的超大数据
    // 16 * 1024 * 1024 = 16777216 字节
    const hugePayload = 'A'.repeat(16 * 1024 * 1024 + 100);
    storage.setItem('huge', hugePayload);

    await assert.rejects(
      async () => {
        await bridge.flush();
      },
      { message: /16MiB/ }
    );

    assert.ok(failedReports.length >= 1);
    assert.match(failedReports[failedReports.length - 1].message, /16MiB/);
  } finally {
    bridge.dispose();
  }
});

test('8. __proto__ 防原型污染', async () => {
  const storage = createFakeStorage();
  const sent = [];

  const bridge = installBridge({
    storage,
    seed: {
      schemaVersion: 1,
      revision: 1,
      savedAt: '2026-10-12T00:00:00Z',
      values: {
        ['__proto__']: 'malicious_seed_val',
        'safe_key': '123',
      },
    },
    invoke: async (command, args) => {
      sent.push({ command, args });
      return args?.snapshot?.revision;
    },
  });

  try {
    // 原型未被污染
    assert.equal(Object.prototype.malicious_seed_val, undefined);
    assert.equal(storage.getItem('__proto__'), 'malicious_seed_val');

    // 运行中写入 __proto__ 键
    storage.setItem('__proto__', 'malicious_runtime_val');
    assert.equal(Object.prototype.malicious_runtime_val, undefined);

    await bridge.flush();
    assert.equal(sent.length, 1);
    const values = sent[0].args.snapshot.values;
    // values 为无原型对象
    assert.equal(Object.getPrototypeOf(values), null);
    assert.equal(values['__proto__'], 'malicious_runtime_val');
    assert.equal(Object.prototype.malicious_runtime_val, undefined);
  } finally {
    bridge.dispose();
  }
});

test('9. 真实Storage.prototype模拟与sessionStorage不hook', async () => {
  // 模拟真实浏览器的 Storage 类继承机制
  class MockStorage {
    constructor() {
      this._store = new Map();
    }
    get length() { return this._store.size; }
    key(i) { return [...this._store.keys()][i] ?? null; }
    getItem(k) { return this._store.get(String(k)) ?? null; }
    setItem(k, v) { this._store.set(String(k), String(v)); }
    removeItem(k) { this._store.delete(String(k)); }
    clear() { this._store.clear(); }
  }

  const oldStorageGlobal = globalThis.Storage;
  globalThis.Storage = MockStorage;

  const mockLocalStorage = new MockStorage();
  const mockSessionStorage = new MockStorage();
  const sent = [];

  const bridge = installBridge({
    storage: mockLocalStorage,
    seed: null,
    invoke: async (command, args) => {
      sent.push({ command, args });
      return args?.snapshot?.revision;
    },
  });

  try {
    // sessionStorage 写入不应触发桥接的保存
    mockSessionStorage.setItem('session_key', 'session_val');
    assert.equal(mockSessionStorage.getItem('session_key'), 'session_val');
    assert.equal(sent.length, 0);

    await new Promise((r) => setTimeout(r, 150));
    assert.equal(sent.length, 0);

    // localStorage 写入应被拦截并生效
    mockLocalStorage.setItem('local_key', 'local_val');
    assert.equal(mockLocalStorage.getItem('local_key'), 'local_val');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].args.snapshot.values['local_key'], 'local_val');
  } finally {
    bridge.dispose();
    if (oldStorageGlobal === undefined) {
      delete globalThis.Storage;
    } else {
      globalThis.Storage = oldStorageGlobal;
    }
  }
});

test('10. 冻结与取消退出 (freeze / thaw)', async () => {
  const storage = createFakeStorage();
  const sent = [];

  const bridge = installBridge({
    storage,
    seed: {
      schemaVersion: 1,
      revision: 10,
      savedAt: '2026-10-12T00:00:00Z',
      values: { init: '0' },
    },
    invoke: async (command, args) => {
      sent.push({ command, args });
      return args?.snapshot?.revision;
    },
  });

  try {
    // 正常写入
    storage.setItem('before_freeze', '1');

    // 触发 freeze（关闭请求时）：暂停自动写入并立刻 flush 末次快照
    const freezePromise = bridge.freeze();
    await freezePromise;
    assert.equal(sent.length, 1);
    assert.equal(sent[0].args.snapshot.revision, 11);
    assert.equal(sent[0].args.snapshot.values['before_freeze'], '1');

    // 处于冻结状态时写入：不丢弃写入，写入生效并保留脏标记，但不触发自动debounce flush
    storage.setItem('during_freeze', '2');
    assert.equal(storage.getItem('during_freeze'), '2');
    await new Promise((r) => setTimeout(r, 150));
    // 未产生新快照
    assert.equal(sent.length, 1);

    // 取消退出，调用 thaw() 恢复
    bridge.thaw();
    // 恢复后脏标记触发防抖合并
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(sent.length, 2);
    assert.equal(sent[1].args.snapshot.revision, 12);
    assert.equal(sent[1].args.snapshot.values['during_freeze'], '2');
  } finally {
    bridge.dispose();
  }
});

test('11. 同文档一次恢复机制', async () => {
  const storage = createFakeStorage();
  const mockWindow = {
    localStorage: storage,
    location: { origin: 'https://tauri.localhost' },
  };

  const bridge1 = installBridge({
    storage,
    windowObj: mockWindow,
    seed: {
      schemaVersion: 1,
      revision: 1,
      savedAt: '2026-10-12T00:00:00Z',
      values: { initial: 'data' },
    },
    invoke: async () => 1,
  });

  try {
    storage.setItem('initial', 'modified_data');

    // 再次调用 installBridge，不应二次恢复种子清空数据
    const bridge2 = installBridge({
      storage,
      windowObj: mockWindow,
      seed: {
        schemaVersion: 1,
        revision: 1,
        savedAt: '2026-10-12T00:00:00Z',
        values: { initial: 'overwrite_attempt' },
      },
      invoke: async () => 1,
    });

    assert.equal(storage.getItem('initial'), 'modified_data');
    assert.equal(bridge1, bridge2);
  } finally {
    bridge1.dispose();
  }
});

test('12. 错origin不注入', async () => {
  const storage = createFakeStorage([['secret', 'val']]);
  const mockWindow = {
    location: { origin: 'https://malicious.evil.com' },
  };

  const bridge = installBridge({
    storage,
    windowObj: mockWindow,
    expectedOrigin: 'https://tauri.localhost',
    seed: {
      schemaVersion: 1,
      revision: 1,
      savedAt: '2026-10-12T00:00:00Z',
      values: { pwn: 'true' },
    },
    invoke: async () => 1,
  });

  // 不匹配 origin，不注入，返回 null
  assert.equal(bridge, null);
  // 数据完全未被修改
  assert.equal(storage.getItem('secret'), 'val');
  assert.equal(storage.getItem('pwn'), null);
});

test('13. 缺少 invoke 必须抛错，不可默认静默空函数', () => {
  const storage = createFakeStorage();
  assert.throws(
    () => {
      installBridge({ storage });
    },
    { message: /invoke/i }
  );
});

test('14. ack 非预期校验（undefined/null/旧rev/较大rev/NaN/非安全整数）均拒绝、保持dirty并上报flush_failed', async () => {
  const badAcks = [undefined, null, 1, 999, NaN, 2.5, '2', Number.MAX_SAFE_INTEGER + 10];

  for (const badAck of badAcks) {
    const storage = createFakeStorage();
    const failedReports = [];
    const bridge = installBridge({
      storage,
      seed: {
        schemaVersion: 1,
        revision: 1,
        savedAt: '2026-10-12T00:00:00Z',
        values: {},
      },
      invoke: async (command, args) => {
        if (command === 'flush_failed') {
          failedReports.push(args);
          return;
        }
        if (command === 'save_snapshot') {
          return badAck;
        }
      },
    });

    try {
      storage.setItem('key', 'val');
      // 提交时期待 nextRevision = 2，但返回了 badAck
      await assert.rejects(
        async () => {
          await bridge.flush();
        },
        { message: /ack|revision/i }
      );

      // Revision 不得推进
      assert.equal(bridge.getRevision(), 1);
      // Dirty 标记必须保留
      assert.equal(bridge.isDirty(), true);
      // 必须已上报 flush_failed
      assert.ok(failedReports.length >= 1);
      assert.match(failedReports[0].message, /ack|revision/i);
    } finally {
      bridge.dispose();
    }
  }
});

test('15. 错误上报flush_failed失败不得影响保留dirty与主错误抛出', async () => {
  const storage = createFakeStorage();
  const bridge = installBridge({
    storage,
    seed: {
      schemaVersion: 1,
      revision: 1,
      savedAt: '2026-10-12T00:00:00Z',
      values: {},
    },
    invoke: async (command) => {
      if (command === 'save_snapshot') {
        throw new Error('Save failed');
      }
      if (command === 'flush_failed') {
        throw new Error('IPC reporting completely broken');
      }
    },
  });

  try {
    storage.setItem('key', 'val');
    await assert.rejects(
      async () => {
        await bridge.flush();
      },
      { message: /Save failed/ }
    );

    // 即使 flush_failed 也崩了，dirty 仍然必须保留
    assert.equal(bridge.isDirty(), true);
    assert.equal(bridge.getRevision(), 1);
  } finally {
    bridge.dispose();
  }
});


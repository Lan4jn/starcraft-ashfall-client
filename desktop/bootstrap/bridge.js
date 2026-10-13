// desktop/bootstrap/bridge.js

const INSTALLED_MARKER = Symbol.for('ashfall.bridge.installed');

function getUtf8ByteLength(str) {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str).length;
  }
  if (typeof Buffer !== 'undefined') {
    return Buffer.byteLength(str, 'utf8');
  }
  return encodeURI(str).split(/%..|./).length - 1;
}

export function installBridge(options = {}) {
  const windowObj = options.windowObj || (typeof window !== 'undefined' ? window : null);

  // 1. 验证目标 Origin（若指定）
  const expectedOrigin = options.expectedOrigin || options.origin;
  if (expectedOrigin) {
    const currentOrigin = (windowObj && windowObj.location && windowObj.location.origin)
      || (typeof location !== 'undefined' && location.origin)
      || options.currentOrigin;
    if (currentOrigin !== expectedOrigin) {
      // 来源不匹配，拒绝注入并保持原状
      return null;
    }
  }

  // 2. 同文档防重复安装检查（避免反复恢复覆盖）
  if (windowObj && windowObj.__ASHFALL_BRIDGE__) {
    return windowObj.__ASHFALL_BRIDGE__;
  }

  const storage = options.storage || (windowObj && windowObj.localStorage) || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!storage) {
    throw new Error('No storage target available for installBridge');
  }

  if (storage[INSTALLED_MARKER]) {
    return storage[INSTALLED_MARKER];
  }

  const invoke = options.invoke
    || (windowObj && windowObj.__TAURI_INTERNALS__?.invoke)
    || (windowObj && windowObj.__TAURI__?.core?.invoke)
    || (typeof window !== 'undefined' && window.__TAURI_INTERNALS__?.invoke);

  if (typeof invoke !== 'function') {
    throw new Error('No invoke function available for installBridge');
  }

  const seed = options.seed ?? null;

  // 3. 捕获底层原始方法（支持真实 Storage.prototype 以及单元测试 stub）
  const StorageClass = (windowObj && windowObj.Storage) || (typeof Storage !== 'undefined' ? Storage : null);
  const isStorageInstance = Boolean(StorageClass && (storage instanceof StorageClass));

  let savedProtoSetItem = null;
  let savedProtoRemoveItem = null;
  let savedProtoClear = null;

  let savedInstSetItem = null;
  let savedInstRemoveItem = null;
  let savedInstClear = null;

  if (isStorageInstance && StorageClass.prototype) {
    savedProtoSetItem = StorageClass.prototype.setItem;
    savedProtoRemoveItem = StorageClass.prototype.removeItem;
    savedProtoClear = StorageClass.prototype.clear;
  } else {
    savedInstSetItem = storage.setItem;
    savedInstRemoveItem = storage.removeItem;
    savedInstClear = storage.clear;
  }

  function rawClear() {
    if (savedProtoClear && isStorageInstance) {
      savedProtoClear.call(storage);
    } else if (savedInstClear) {
      savedInstClear.call(storage);
    } else if (typeof storage.clear === 'function') {
      storage.clear();
    }
  }

  function rawSetItem(k, v) {
    if (savedProtoSetItem && isStorageInstance) {
      savedProtoSetItem.call(storage, k, v);
    } else if (savedInstSetItem) {
      savedInstSetItem.call(storage, k, v);
    } else if (typeof storage.setItem === 'function') {
      storage.setItem(k, v);
    }
  }

  // 4. 同步恢复种子（仅当 seed 非 null 时恢复，并清除旧键；初始化绝不自动发空快照）
  let currentRevision = 0;
  let isDirty = false;

  if (seed !== null && typeof seed === 'object') {
    if (typeof seed.revision === 'number' && Number.isSafeInteger(seed.revision)) {
      currentRevision = seed.revision;
    }
    // 同步清空旧键
    rawClear();
    // 恢复所有字符串键（包括任意UUID），不筛选前缀；防__proto__污染
    if (seed.values && typeof seed.values === 'object') {
      const keys = Object.getOwnPropertyNames(seed.values);
      for (const k of keys) {
        if (Object.prototype.hasOwnProperty.call(seed.values, k)) {
          const val = seed.values[k];
          if (val !== undefined && val !== null) {
            rawSetItem(k, String(val));
          }
        }
      }
    }
    // 种子已回填，置脏以备手动flush（但绝不自动启动定时器发空快照）
    isDirty = true;
  }

  // 5. 状态变量
  let dirtyVersion = isDirty ? 1 : 0;
  let isFrozen = false;
  let debounceTimer = null;
  let inFlightPromise = null;
  let pendingFlushPromise = null;

  function onMutation() {
    dirtyVersion++;
    isDirty = true;
    if (!isFrozen) {
      scheduleDebounce();
    }
  }

  function scheduleDebounce() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      flush().catch(() => {
        // 防止后台定时器产生 unhandled rejection
      });
    }, 100);
  }

  // 6. 安装 Hook：真实浏览器拦截 Storage.prototype 且仅针对 targetStorage，stub 拦截实例
  if (isStorageInstance && StorageClass.prototype) {
    StorageClass.prototype.setItem = function setItem(key, value) {
      if (this === storage) {
        savedProtoSetItem.call(this, key, value);
        onMutation();
      } else {
        return savedProtoSetItem.apply(this, arguments);
      }
    };

    StorageClass.prototype.removeItem = function removeItem(key) {
      if (this === storage) {
        savedProtoRemoveItem.call(this, key);
        onMutation();
      } else {
        return savedProtoRemoveItem.apply(this, arguments);
      }
    };

    StorageClass.prototype.clear = function clear() {
      if (this === storage) {
        savedProtoClear.call(this);
        onMutation();
      } else {
        return savedProtoClear.apply(this, arguments);
      }
    };
  } else {
    storage.setItem = function setItem(key, value) {
      savedInstSetItem.call(this, key, value);
      onMutation();
    };

    storage.removeItem = function removeItem(key) {
      savedInstRemoveItem.call(this, key);
      onMutation();
    };

    storage.clear = function clear() {
      savedInstClear.call(this);
      onMutation();
    };
  }

  // 7. 快照收集：无原型对象防止 __proto__ 污染
  function getSnapshotValues() {
    const values = Object.create(null);
    if (typeof storage.length === 'number' && typeof storage.key === 'function') {
      const len = storage.length;
      for (let i = 0; i < len; i++) {
        const k = storage.key(i);
        if (k !== null && k !== undefined) {
          const v = storage.getItem(k);
          values[k] = v !== null && v !== undefined ? String(v) : '';
        }
      }
    } else if (storage && typeof storage === 'object') {
      const keys = Object.getOwnPropertyNames(storage);
      for (const k of keys) {
        if (k !== 'length' && typeof storage[k] !== 'function') {
          values[k] = String(storage[k]);
        }
      }
    }
    return values;
  }

  async function reportFlushFailed(err) {
    try {
      const message = (err && err.message) ? err.message : String(err);
      await invoke('flush_failed', { message });
    } catch (_) {
      // 容错：即使上报IPC自身报错也不产生二次未捕获异常
    }
  }

  // 8. 串行落盘执行器
  async function executeSingleFlush() {
    if (!isDirty) {
      return currentRevision;
    }

    const nextRevision = currentRevision + 1;
    if (!Number.isSafeInteger(nextRevision)) {
      const err = new Error('Revision exceeded safe integer limit');
      await reportFlushFailed(err);
      throw err;
    }

    const snapshotVersion = dirtyVersion;
    const values = getSnapshotValues();
    const snapshot = {
      schemaVersion: 1,
      revision: nextRevision,
      savedAt: new Date().toISOString(),
      values,
    };

    const serialized = JSON.stringify(snapshot);
    const byteLength = getUtf8ByteLength(serialized);
    if (byteLength > 16 * 1024 * 1024) {
      const err = new Error(`Snapshot size ${byteLength} bytes exceeds 16MiB limit`);
      await reportFlushFailed(err);
      throw err;
    }

    let res;
    try {
      res = await invoke('save_snapshot', { snapshot });
    } catch (err) {
      // 保留脏标记并上报宿主
      await reportFlushFailed(err);
      throw err;
    }

    if (typeof res !== 'number' || !Number.isSafeInteger(res) || res !== nextRevision) {
      const err = new Error(`Invalid revision ack received from host: expected ${nextRevision}, got ${res}`);
      await reportFlushFailed(err);
      throw err;
    }

    currentRevision = res;
    if (dirtyVersion === snapshotVersion) {
      isDirty = false;
    }
    return currentRevision;
  }

  // 9. 公共 API
  function flush() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }

    if (!isDirty && !inFlightPromise) {
      return Promise.resolve(currentRevision);
    }

    if (inFlightPromise) {
      if (!pendingFlushPromise) {
        pendingFlushPromise = inFlightPromise
          .then(
            () => {
              pendingFlushPromise = null;
              if (isDirty) {
                return flush();
              }
              return currentRevision;
            },
            (err) => {
              pendingFlushPromise = null;
              if (isDirty) {
                return flush();
              }
              throw err;
            }
          );
      }
      return pendingFlushPromise;
    }

    inFlightPromise = executeSingleFlush().finally(() => {
      inFlightPromise = null;
    });
    return inFlightPromise;
  }

  function freeze() {
    isFrozen = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    return flush();
  }

  function thaw() {
    isFrozen = false;
    if (isDirty) {
      scheduleDebounce();
    }
  }

  function dispose() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (isStorageInstance && StorageClass && StorageClass.prototype) {
      if (savedProtoSetItem) StorageClass.prototype.setItem = savedProtoSetItem;
      if (savedProtoRemoveItem) StorageClass.prototype.removeItem = savedProtoRemoveItem;
      if (savedProtoClear) StorageClass.prototype.clear = savedProtoClear;
    }
    if (!isStorageInstance && storage) {
      if (savedInstSetItem) storage.setItem = savedInstSetItem;
      if (savedInstRemoveItem) storage.removeItem = savedInstRemoveItem;
      if (savedInstClear) storage.clear = savedInstClear;
    }
    if (windowObj && windowObj.__ASHFALL_BRIDGE__ === bridgeApi) {
      delete windowObj.__ASHFALL_BRIDGE__;
    }
    if (storage && storage[INSTALLED_MARKER] === bridgeApi) {
      delete storage[INSTALLED_MARKER];
    }
  }

  const bridgeApi = {
    flush,
    freeze,
    thaw,
    dispose,
    getRevision: () => currentRevision,
    isDirty: () => isDirty,
    isFrozen: () => isFrozen,
  };

  if (windowObj) {
    windowObj.__ASHFALL_BRIDGE__ = bridgeApi;
  }
  try {
    storage[INSTALLED_MARKER] = bridgeApi;
  } catch (_) {
    // 忽略在极少数冻结存储对象上的扩展属性失败
  }

  return bridgeApi;
}

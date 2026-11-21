'use strict';
/* VM 测试公共装配件
 *
 * VM 单测此前各自手写最小 util 桩；util 接口面扩充后（randHex / appendTrace /
 * today0 / findById）桩开始漂移。这里改为在沙箱内装载真实 assets/js/util.js，
 * 让随机 id、留痕、日期口径与生产同一实现；测试按需覆写个别成员。
 */

const fs = require('node:fs');
const vm = require('node:vm');

/** localStorage 内存桩；disk 供断言直接读取 */
function storage(map) {
  const disk = map || new Map();
  return {
    disk: disk,
    localStorage: {
      getItem: (k) => (disk.has(k) ? disk.get(k) : null),
      setItem: (k, v) => disk.set(String(k), String(v)),
      removeItem: (k) => disk.delete(k)
    }
  };
}

/**
 * 在沙箱内装载真实 util.js。
 * sandbox 需要：window.ZX 指向测试持有的同一对象（util.js 向其挂载 util）；
 * 可按需携带 localStorage / crypto / Date（如 FixedDate）等沙箱全局。
 */
function installUtil(sandbox) {
  vm.runInNewContext(
    fs.readFileSync(require.resolve('../assets/js/util.js'), 'utf8'),
    Object.assign({ crypto: globalThis.crypto }, sandbox)
  );
}

module.exports = { storage: storage, installUtil: installUtil };

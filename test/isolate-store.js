'use strict';
/* 服务端测试专用存储：每个测试文件进程使用独立目录，绝不指向真实数据。 */
const fs = require('node:fs');
const path = require('node:path');

function isolateStore() {
  const root = path.join(__dirname, '..', '.tmp');
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'server-test-'));
  process.env.NOVA_STORE_FILE = path.join(directory, 'store.json');
  return process.env.NOVA_STORE_FILE;
}

module.exports = { isolateStore };

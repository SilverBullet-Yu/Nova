'use strict';
/* 诺瓦 Nova · CloudBase HTTP 云函数入口
 *
 * 云函数运行时要求：常驻 Web 服务监听 9000 端口（由 scf_bootstrap 拉起）。
 * 这里只做一件事——把仓库里的 server/main.js 启动起来。
 *
 * 目录约定（构建产物，见 scripts/build-cloudbase-fn.js）：
 *   nova/
 *   ├── index.js          ← 本文件
 *   ├── scf_bootstrap
 *   ├── server/           ← 复制自仓库 server/
 *   ├── shared/           ← 复制自仓库 shared/
 *   ├── assets/           ← 复制自仓库 assets/
 *   └── index.html        ← 复制自仓库 index.html
 *
 * server/main.js 的 ROOT = path.resolve(__dirname, '..')，正好落在函数根目录，
 * 因此静态资源与 API 同源，前端 resolveBase() 自动走 window.location.origin。
 *
 * 鉴权部署要求（与 server/auth.js 一致，不存在免鉴权的旁路入口）：
 * 1. 云函数环境变量必须配置 NOVA_AUTH_SECRET（≥32 字节随机串）；
 *    NODE_ENV=production 时缺少该变量 server/auth.js 会直接拒绝启动，避免各实例
 *    密钥不一致——部署清单需同时设置 NODE_ENV=production 与该密钥，缺一不可。
 * 2. HTTP 网关需放行 Authorization 请求头，并强制 HTTPS——凭证是 Bearer 明文传输。
 * 3. 所有业务接口都由同一个 server/main.js 处理鉴权与限流，网关层不要再暴露其他入口。
 */

const { start } = require('./server/main.js');

const PORT = Number(process.env.PORT) || 9000;
const HOST = process.env.HOST || '0.0.0.0';

start(PORT, HOST).then((h) => {
  process.stdout.write('诺瓦 Nova · 云函数已启动 http://' + h.host + ':' + h.port + '\n');
}).catch((e) => {
  process.stderr.write('启动失败：' + (e && e.message ? e.message : String(e)) + '\n');
  process.exit(1);
});

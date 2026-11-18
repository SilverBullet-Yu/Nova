# 诺瓦 Nova · 前后端协作契约（HANDOFF）

> `server/`（后端）与 `assets/`（前端）之间的唯一接口依据。字段名、错误码、限额、默认值一律以源码为准；契约变更顺序：先改本文件，再改代码，最后改测试。

- 运行时：Node.js 22+（验证于 v24.15.0），零第三方依赖，只用 `node:` 内置模块
- 参考文档：`docs/ARCHITECTURE.md`、`docs/FRONTEND-CONTRACT.md`、`docs/IP-DESIGN.md`

## 1. 文档定位与硬边界

| 路径 | 所有者 | 说明 |
|---|---|---|
| `shared/engine/*.js` | 后端（前端只读） | 四个纯函数引擎，UMD 双模，唯一实现 |
| `shared/data/seed.js` | 后端（前端只读） | 共享种子数据，深度冻结 |
| `server/**` | 后端 | HTTP 入口、路由、鉴权、内存存储 |
| `assets/**` | 前端 | 页面脚本与样式 |
| `index.html` | 前端 | 页面骨架与资源引用清单 |
| `scripts/**` | 后端 | `scripts/build-engine.js`、`scripts/css-audit.mjs`、`scripts/build-mascot-v4.js` |
| `test/**` | 后端 | `test/engine.test.js`、`test/api.test.js` |
| `docs/**` | 管理者 | 契约与说明文档 |

跨目录改动规则：

1. `shared/` 是唯一实现源，前端只读引用，禁止在 `assets/` 内重写引擎逻辑。
2. 改了 `shared/engine/*.js`，必须运行 `npm run build:engine` 并提交 `assets/js/rhythm.build.js`；只改源文件不回写产物视为未完成。
3. 改了 `server/api/routes.js` 的路径、请求字段、错误码，必须同步本文件第 5 节与 `test/api.test.js`。
4. 改了引擎入参或出参结构，必须同步 `server/api/routes.js`、`assets/js/engine.js`、`assets/js/api.js`、`test/engine.test.js`。
5. 改了 `shared/data/seed.js`，必须同步 `test/engine.test.js` 与 `test/api.test.js` 的断言。
6. 改了 op 的实体或字段，必须同步 `server/store/memory.js` 的 `applyToState` / `policyOf` 与本文件第 6 节。
7. 契约与实现冲突时以源码为准并回报裁决，不得在任一目录私自改写契约。

## 2. 双模模块规范

`shared/` 下每个文件必须同时能在浏览器 `<script>` 与 Node `require()` 下运行，统一 UMD 形态：`typeof module === 'object' && module.exports` 成立时导出工厂返回值，否则挂载 `root.Rhythm.<name>`；工厂体内 `'use strict'`，返回具名导出对象。

纯函数纪律（硬约束）：不读时钟（`Date.now()`、`new Date()`）、不读随机数（`Math.random()`）、不读环境变量、不做任何 I/O；不依赖 `shared/` 之外的模块；相同输入必得相同输出，需排序时显式 `.sort()`，不依赖对象键序。引擎不读时钟：`replan` 的 `snapshot.timestamp` 由调用方经 `input.timestamp` 注入，缺省 `null`。

产物规则：

- `assets/js/rhythm.build.js` 由 `scripts/build-engine.js` 拼接生成，**禁止手改或手工粘贴**。
- 脚本只收录 `shared/engine/feasibility.js`、`shared/engine/schedule.js`、`shared/engine/replan.js`、`shared/engine/attribute.js`；`shared/data/seed.js` 不进产物，由 `index.html` 单独以 `<script src="shared/data/seed.js">` 引入。
- 构建不写时间戳等易变内容，同源码多次构建字节一致；构建前校验每个源文件仍保留 `root.Rhythm` 挂载，缺失即报错。

## 3. 共享引擎 API

四个纯函数都在 `shared/engine/`，浏览器侧经 `window.Rhythm.<模块>.<函数>` 调用。

### 3.1 `feasibility(input)`

- 入参：`weeklyH`、`weeks`、`discount`、`demand`，均须为有限数值，缺一或非数值抛 `TypeError`；`demand <= 0` 亦抛 `TypeError`。
- 出参：`T`、`D`、`R`、`margin`、`verdict`、`threshold`。
- 计算：`T = Math.round(weeklyH * weeks * discount)`；`R = Number((T / D).toFixed(2))`；`margin = T - D`。
- 四档硬编码：`R >= 1.2` 充裕、`R >= 0.9` 合理、`R >= 0.7` 偏紧、否则阻断；`threshold` 恒为 `{ ample: 1.2, reasonable: 0.9, tight: 0.7 }`。

### 3.2 `schedule(input)`

- 入参：`tasks`、`slots` 必填数组，`params` 可选对象。`tasks[]` 为 `{ id, subject, estMin, weight, date?, startMin?, title? }`，工时**只读** `estMin`；`slots[]` 为 `{ date, startMin, durMin, available, isBuffer }`，仅严格等于 `false` 的 `available` 视为不可用。
- `params` 默认值：`bufferRatio` `0.15`、`maxContiguousMin` `150`、`dailyCapMin` `300`。
- 出参恰好三个键：`blocks`、`unplanned`、`version`（恒 `planner-1.0.0`）。`blocks[]` 为 `{ id, taskId, subject, date, startMin, durMin, isBuffer, locked, reason }`，`unplanned[]` 为 `{ taskId, reason }`。

关键不变量：

1. `available === false` 的时段永不排入。
2. 单日总占用 ≤ `dailyCapMin`（默认 300 min），弹性位占用计入。
3. 非弹性任务当日占用 ≤ `dailyCapMin − Math.round(dailyCapMin × bufferRatio)`。
4. 同日期、同科目的连续占用 ≤ `maxContiguousMin`（默认 150 min）。
5. 弹性 Slot（`isBuffer`）优先级最低，仅在无其他选择时使用；但带 `date` + `startMin` 的刚性任务先入箱，可优先占用弹性位。
6. 排序确定：刚性按 `date` → `startMin` → `id` 升序；柔性按 `weight` 降 → `estMin` 降 → `id` 升序。

### 3.3 `replan(input)`

- 入参：`tasks`、`week` 必填数组；`params`、`history`、`locks` 可选对象；`timestamp` 可选。`tasks[]` 工时读 `est`（与 `schedule` 的 `estMin` 各钉死一种格式，不做别名兼容）；`week[]` 为 `{ date, minutes, buffer, capacity? }`，`capacity` 缺省取 `dailyCapMin`，输入顺序即周内顺序，不排序；`locks` 为 `{ taskId: true }`，只认显式 `true` 的键。
- `params` 默认值：`loadGrowthCap` `0.20`、`compressFloor` `0.60`、`compressedShareCap` `0.30`、`consecutiveNoImproveCap` `3`、`bufferRatio` `0.15`、`dailyCapMin` `300`。
- 出参：`strategies`、`diff`、`loadDelta`、`accepted`、`needsConfirmation`、`verdict`、`snapshot`、`guards`、`nextTasks`、`nextWeek`。`strategies[]` 恒 4 条 `{ level, name, applied, growth, reason }`（`name` 依次为顺延/压缩/替代/放弃）；`diff[]` 为 `{ op, taskId, subject, from, to, detail }`，`op` ∈ `defer`/`compress`/`substitute`/`abandon`；`snapshot` 为 `{ tasks, week, timestamp }`；`guards` 为 `{ loadGrowthOk, bufferPreserved, consecutiveOk, compressedShareOk }`；`verdict` ∈ `ok`/`needsConfirmation`/`blocked`。

四级有序执行，首个通过校验即停止，后续级别不进入：

| 级 | 名称 | 行为 | 回退条件 |
|---|---|---|---|
| 1 | 顺延 | 按权重从高到低填入未来 7 天 `capacity` 内的空闲分钟，不侵占弹性池 | 负载增幅超 `loadGrowthCap` 或容量装不下 |
| 2 | 压缩 | 仅当溢出 `overflow > 0` 触发，按权重从低到高压缩，下限 `est × compressFloor`，目标 `saved >= overflow` | 压到下限仍装不下 / 占比超 `compressedShareCap` / 增幅事后守卫不过 |
| 3 | 替代 | 同 `domain` 内以更高 `freq` 且更高 `weight` 的节点替换，原任务标 `substituted` 退出待办，新节点记 `replaces` | 同域内无更优节点或替换后复核不过 |
| 4 | 放弃 | 标 `abandoned` 并只给建议：`accepted=false`、`needsConfirmation=true`、`verdict='needsConfirmation'` | 未确认 |

三条防雪崩断言（`accepted=true` 须同时成立）：

1. `loadGrowthOk`：未来 7 天负载增幅 ≤ `loadGrowthCap`。
2. `bufferPreserved`：任一日负载不得超其 `capacity`，**弹性位不可清空或侵占**。
3. `consecutiveOk`：连续 `consecutiveNoImproveCap` 次未改善即停止并转目标校准，`verdict='blocked'`。

补充：`locks` 中的锁定任务是硬约束，不参与顺延装载，也不会被压缩、替代或放弃，且不出现在 `diff` 中。`confirmReplan(result)` 只接受 `needsConfirmation === true` 的结果，返回新的 `accepted=true` 对象且不改入参，否则抛 `TypeError`；服务端在确认前不落库。`undoReplan(snapshot)` 返回 `{ tasks, week }`，逐条还原快照，**不重算**。

### 3.4 `attribute(input)`

- 入参：`planLoadRatio`、`consecutiveZeroDays`、`consecutiveTimeoutCount`、`efficiencyRatio`、`completion`、`externalRatio`，缺省分别为 `0`、`0`、`0`、`1`、`0`、`0`。
- 出参恰好四键：`type`、`confidence`、`actions`、`evidence`；`confidence` 取值 0..1，`actions` 至少 1 条，`evidence` 含入参与命中项 `matched`。
- 判定顺序固定（顺序即优先级）：计划过载 `planLoadRatio > 1.1` 或 `consecutiveTimeoutCount >= 3` → 执行中断 `consecutiveZeroDays >= 2` → 效率不足 `efficiencyRatio > 1.4` 且 `completion >= 0.6` → 外部干扰 `externalRatio > 0.3` → 无偏差。

## 4. 种子数据契约

- 导出 `{ seed }`，`deepFreeze` 深度冻结：`Object.isFrozen(seed)` 为 `true`，写入抛 `TypeError`；需修改的一方先深拷贝（如 `JSON.parse(JSON.stringify(seed))`）。
- 顶层键：`user`、`goal`、`feas`、`tasks`、`buffer`、`week`、`weekShift`、`notif`、`weekStats`、`subjectColors`。
- `tasks[]` 字段：`id`、`subject`、`title`、`est`、`time`、`weight`、`done`，可选 `actual`、`why`；共 4 条。
- `week[]` 与 `weekShift[]` 元素：`{ d, segs, buf, total }`，末日带 `today: true`。
- `subjectColors` 沿用现有 CSS 变量名：数学 `var(--m-math)`、英语 `var(--m-en)`、408 `var(--m-408)`、政治 `var(--m-pol)`。

## 5. HTTP API 契约

前缀 `/api`，全部返回 JSON，错误统一形状 `{ error: { code, message } }`。

服务监听：`server/main.js` 默认绑定 `0.0.0.0:8787`，`PORT` 与 `HOST` 环境变量可覆盖。前端在 `http`/`https` 下用同源 `location.origin`，仅 `file://` 打开时用 `http://127.0.0.1:8787`。

中间件顺序：解析 URL → `OPTIONS` 直接 204 → 非 `/api/` 走静态（仅 GET/HEAD，其余 405 `E1001`）→ `/api/` 鉴权 → 限流 → 读请求体 → 路由 → 响应 JSON。

静态资源白名单仅 `/`、`/index.html`、`/assets/*`、`/shared/*`，其余 404 `E2001`；请求体上限 1 MiB，超限 `E4002`。跨域策略：仅本机来源（`127.0.0.1`、`localhost`、`file://` 的 `null` origin）与同源（`Origin` 的 host 与请求 `Host` 相同）放行，其余不放行；放行时返回 `Access-Control-Allow-Methods: GET, POST, OPTIONS`、`Access-Control-Allow-Headers: Content-Type, Authorization`、`Access-Control-Max-Age: 600`。

| 方法 | 路径 | 鉴权 | 请求字段 | 响应 | 失败错误码 |
|---|---|---|---|---|---|
| GET | `/api/health` | 免 | 无 | `{ ok, version, uptimeMs }` | 无 |
| POST | `/api/auth/session` | 免 | 无（不接受任何身份字段） | `{ token, userId, expiresAt }` | E4290 |
| GET | `/api/state` | 需 | 无 | `{ seed, replan, notifications }` | E4010 |
| POST | `/api/feasibility` | 需 | `weeklyH`、`weeks`、`discount`、`demand` 均必填且须为有限数值 | `feasibility()` 返回 | E4010, E1001, E4290 |
| POST | `/api/schedule` | 需 | `tasks`、`slots` 必填数组；`params` 可选对象 | `{ blocks, unplanned, version }` | E4010, E1001, E4290 |
| POST | `/api/replan` | 需 | `tasks`、`week` 必填数组；`params`、`history`、`locks` 可选对象；`timestamp` 可选 | `replan()` 返回 | E4010, E1001, E4290 |
| POST | `/api/replan/confirm` | 需 | `result` 必填对象 | `confirmReplan()` 返回 | E4010, E1001, E4290 |
| POST | `/api/replan/undo` | 需 | `snapshot` 必填对象 | `{ tasks, week }` | E4010, E1001, E4290 |
| POST | `/api/attribute` | 需 | 请求体不得为空；6 个数值字段均可选 | `attribute()` 返回 | E4010, E1001, E4290 |
| POST | `/api/sync/ops` | 需 | `ops` 必填数组；每条须有非空字符串 `opId`、`entity`、`field` 与非空 `entityId`；`clientTs` 可选有限数值 | `{ accepted: [opId], serverSeq }` | E4010, E1001, E4002, E4030, E4290 |

路径不存在返回 `E2001`；路径存在但方法不符返回 `E1001`。

错误码（定义在 `server/api/routes.js` 的 `ERRORS`）：

| code | HTTP | 含义 | 当前是否抛出 |
|---|---|---|---|
| E1001 | 400 | 请求参数非法或缺失 | 是 |
| E2001 | 404 | 资源不存在 | 是 |
| E3001 | 409 | 状态冲突 | 否，仅保留定义 |
| E3002 | 409 | 资源已存在 | 否，仅保留定义 |
| E4001 | 200 | 幂等键重复，已返回首次结果 | 否，幂等命中直接返回 200 |
| E4002 | 400 | 请求体过大或单批超过上限 200 | 是 |
| E4010 | 401 | 未提供有效凭证 | 是 |
| E4030 | 403 | 无权访问该用户数据 | 是 |
| E4290 | 429 | 请求过于频繁 | 是 |
| E5001 | 500 | 服务内部错误 | 是 |
| E9001 | 500 | 未分类异常 | 是 |

限流（`server/auth.js` 的 `WRITE_LIMITS`，单进程固定窗口，单位 次/60 秒）：`POST /api/auth/session` 60（按来源 IP 隔离）、`POST /api/sync/ops` 60、`POST /api/replan` 与 `POST /api/replan/confirm` 与 `POST /api/replan/undo` 各 12、`POST /api/feasibility` 与 `POST /api/schedule` 与 `POST /api/attribute` 各 30；`GET /api/health` 与 `GET /api/state` 不限流。超限返回 `E4290` 与 `Retry-After` 响应头，不排队、不自动重试。

## 6. 前端到后端通信约定

- 入口 `assets/js/api.js`，超时 `3000` ms（`AbortController` 主动中断）。`BASE` 取 `window.__ZX_API_BASE__`（覆盖时去掉末尾斜杠），否则 `http`/`https` 用同源 `location.origin`，`file://` 用 `http://127.0.0.1:8787`。
- 凭证：`POST /api/auth/session` 取得 `{ token, userId, expiresAt }`，存 `localStorage['zx.auth_token']`；本地先按 `expiresAt` 预判过期；收到 401 时清空凭证并重新签发一次，不循环重试。仅 `/api/health` 与 `/api/auth/session` 不带凭证，其余请求统一带 `Authorization: Bearer <token>`。
- 身份只来自凭证：请求体的 `userId` 不参与判定；`POST /api/sync/ops` 中 `op.userId` 若与凭证不一致，直接 `E4030`。
- 降级：`assets/js/engine.js` 后端优先，响应结构不合约定或请求失败即走本地 `assets/js/rhythm.build.js`，并置 `ZX.engine.source` 为 `local`；产物缺失时抛错提示先跑 `npm run build:engine`，不静默换语义。同步入口 `ZX.engine.feasibilityNow` 与 `ZX.engine.attributeNow` 直接用本地产物。
- 离线指示：顶栏同步位在线时为圆点 + 「本地优先 · 已同步」，离线时换为诺瓦的离线褪色头像（`assets/js/main.js` `updateSync()`），形象取自 `assets/js/mascot-inline.js` 的内联 data URI——静态资源以 `Cache-Control: no-cache` 提供，后端不可达时无法加载，故离线指示不依赖网络请求。
- op 队列：写操作先入 `localStorage['zx.op_queue']`；`opId` 形如 `op_<Date.now().toString(36)>_<计数>`，`clientTs` 取 `Date.now()`，`baseSeq` 取 `ZX.state.serverSeq`；队列保存时只保留最后 200 条，故单批上行 ≤ 200，与服务端 `MAX_SYNC_BATCH` 一致，超限服务端返回 `E4002`。
- 幂等键是 `opId`，分区内唯一；重复提交返回首次的 `serverSeq`（HTTP 200，`accepted` 仍含该 `opId`，不报错）。
- 字段级合并（`server/store/memory.js` 的 `policyOf`）：墓碑类 `deleted`、`isDeleted`、`deletedAt` 墓碑优先不可翻转；计数类 `count`、`sessionCount`、`sessions`、`times` 求和；`actual`、`durationMin`、`minutes`、`duration` 取最大值；其余字段最后写入优先（同 `clientTs` 时 `serverSeq` 大者为准）。

## 7. 兼容性硬要求

1. 改 `shared/engine/*.js` → `npm run build:engine` → 提交 `assets/js/rhythm.build.js` → `npm test`。
2. 改路由、请求字段、错误码 → 同步本文件第 5 节与 `test/api.test.js`。
3. 改引擎签名 → 同步 `server/api/routes.js`、`assets/js/engine.js`、`assets/js/api.js`、`test/engine.test.js`。
4. 改 `shared/data/seed.js` → 同步 `test/engine.test.js` 与 `test/api.test.js` 的断言。
5. 改 op 实体或字段 → 同步 `server/store/memory.js` 的 `applyToState` / `policyOf` 与本文件第 6 节。
6. 前端不得内嵌第二份引擎实现；`assets/js/rhythm.build.js` 不得手改。
7. 不引入第三方库或外部 CDN 资源。

## 8. 验收口径

| 检查项 | 命令 | 判定标准 |
|---|---|---|
| 引擎单测 + HTTP 冒烟 | `npm test` | 退出码 0，输出 `pass 58 fail 0`（当前 58 项全绿，来自 `test/engine.test.js` 与 `test/api.test.js`） |
| CSS 审计 | `npm run audit` | 退出码 0；存在 error 时退出码 1，仅 warn 仍为 0 |
| 引擎产物重建校验 | `npm run build:engine` 后重算 `assets/js/rhythm.build.js` 的 SHA256 | 重建前后哈希一致（构建不写时间戳）；当前值 `0f3206b196acd8d72f220e28acdb1026127ff5139ebd908d96ff6cede7434242` |
| 资源引用全量扫描 | 提取 `index.html` 中 `src`/`href` 的相对路径并逐个检查文件存在 | 缺失数为 0（当前 21 个引用） |
| 服务冒烟 | `node server/main.js` 后请求 `GET /api/health` | HTTP 200 且 `ok` 为 `true` |

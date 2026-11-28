# 诺瓦 Nova · 前后端协作契约（HANDOFF）

> `server/`（后端）与 `assets/`（前端）之间的接口依据。**浏览器本地 overlay 是唯一业务主数据；服务端仅保留健康、鉴权与计算能力，旧业务接口与数据仅服务端保留，前端不使用。** 字段名、错误码、限额、默认值一律以源码为准；契约变更顺序：先改本文件，再改代码，最后改测试。

- 服务端运行时：Node.js 22+，零第三方运行时依赖，只用 Node 内置能力；实际版本以 `node --version` 为准。前端使用本地 vendored Three.js r152（包版本 `0.152.2`）与 CSS3DRenderer，不依赖 CDN，不属于全栈零第三方。
- 参考文档：`docs/ARCHITECTURE.md`、`docs/FRONTEND-CONTRACT.md`、`docs/IP-DESIGN.md`

## 1. 文档定位与硬边界

| 路径 | 所有者 | 说明 |
|---|---|---|
| `shared/engine/*.js` | 后端（前端只读） | 四个纯函数引擎，UMD 双模，唯一实现 |
| `shared/data/seed.js` | 后端（前端只读） | 共享种子数据，深度冻结 |
| `shared/workflow.js` | 后端（前端只读） | 本机重排草案生命周期工厂（preview / confirm / reject），由 `assets/js/flows/replan.js` 与测试消费；不创建服务端业务草案 |
| `server/**` | 后端 | HTTP 入口、路由、鉴权、计算服务与按身份分区的历史 JSON 数据；历史业务接口仅服务端保留，前端不使用 |
| `assets/**` | 前端 | 页面脚本与样式；`assets/js/gl/` 为 GL 视觉层，`assets/vendor/` 为本地 Three.js / CSS3DRenderer 产物 |
| `index.html` | 前端 | 页面骨架、首帧视觉偏好闸门（`grid` / `glow` / `motion` / `font`）、`data-gl3d` 初始标记与资源引用清单；加载顺序见 `FRONTEND-CONTRACT.md` §2 |
| `scripts/**` | 后端 | 引擎 / 形象构建与 CSS 审计；`scripts/build-vendor-three.mjs` 从 Three.js `0.152.2` 包生成本地 vendor |
| `test/**` | 后端 | 引擎单测、HTTP 冒烟、前端 Node VM 单测、资产门禁等；测试持续新增，文件清单以 `node -e 'console.log(require("node:fs").readdirSync("test").filter(p=>p.endsWith(".test.js")).sort().join("\n"))'` 实时输出为准 |
| `docs/**` | 管理者 | 契约与说明文档 |

跨目录改动规则：

1. `shared/` 是唯一实现源，前端只读引用，禁止在 `assets/` 内重写引擎逻辑。
2. 改了 `shared/engine/*.js`，必须运行 `npm run build:engine` 并提交 `assets/js/rhythm.build.js`；只改源文件不回写产物视为未完成。
3. 改了 `server/api/routes.js` 的路径、请求字段、错误码，必须同步本文件第 5 节与 `test/api.test.js`。
4. 改了引擎入参或出参结构，必须同步 `server/api/routes.js`、`assets/js/engine.js`、`assets/js/api.js`、`test/engine.test.js`。
5. 改了 `shared/data/seed.js`，必须同步 `test/engine.test.js` 与 `test/api.test.js` 的断言。
6. op 实体 / 字段与合并策略仅是服务端历史能力；若维护这些服务端接口，须同步 `server/store/memory.js` 的 `applyToState` / `policyOf` 与本节历史说明。前端不得据此恢复 op 生成或上行。
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

- 入参：`tasks`、`slots` 必填数组，`params` 可选对象。`tasks[]` 为 `{ id, subject, estMin, weight, date?, startMin?, title? }`，工时**只读** `estMin`；`slots[]` 为 `{ date, startMin, durMin, available, isBuffer }`，仅严格等于 `false` 的 `available` 视为不可用。工时、起点和时长必须是非负整数分钟；任务 ID 必须非空且唯一（缺省 ID 仅由未提供 `id` 时生成）；HTTP 层限制 `tasks ≤ 500`、`slots ≤ 2000`。
- `params` 默认值：`bufferRatio` `0.15`、`maxContiguousMin` `150`、`dailyCapMin` `300`。
- 出参恰好三个键：`blocks`、`unplanned`、`version`（恒 `planner-1.0.0`）。`blocks[]` 为 `{ id, taskId, subject, date, startMin, durMin, isBuffer, locked, reason }`，`unplanned[]` 为 `{ taskId, reason }`。

关键不变量：

1. `available === false` 的时段永不排入。
2. 单日总占用 ≤ `dailyCapMin`（默认 300 min），弹性位占用计入。
3. 非弹性任务当日占用 ≤ `dailyCapMin − Math.round(dailyCapMin × bufferRatio)`。
4. 同日期、同科目的连续占用 ≤ `maxContiguousMin`（默认 150 min）。
5. 弹性 Slot（`isBuffer`）优先级最低，仅在无其他选择时使用；但带 `date` + `startMin` 的刚性任务先入箱，可优先占用弹性位。
6. 排序确定：刚性按 `date` → `startMin` → `id` 升序；柔性按 `weight` 降 → `estMin` 降 → `id` 升序。固定任务选择起点及连续槽位时，不可用或非正时长槽不会遮挡同一时刻的可用正时长槽。

### 3.3 `replan(input)`

- 入参：`tasks`、`week` 必填数组；`params`、`history`、`locks` 可选对象；`allowBuffer` 可选布尔值，默认 `false`；`timestamp` 可选。`tasks[]` 工时读非负整数 `est`（与 `schedule` 的 `estMin` 各钉死一种格式，不做别名兼容）；`week[]` 为 `{ date, minutes, buffer, capacity?, bufferUsed?, releasedMinutes?, releasedBufferMinutes? }`，`capacity` 是普通容量、`buffer` 是弹性容量，缺省分别取 `dailyCapMin` 与 `0`；输入顺序即周内顺序，不排序，日期必须唯一且最多 7 天；`locks` 为 `{ taskId: true }`，只认显式 `true` 的键。
- `params` 默认值：`loadGrowthCap` `0.20`、`compressFloor` `0.60`、`compressedShareCap` `0.30`、`consecutiveNoImproveCap` `3`、`dailyCapMin` `300`、`maxTasks` `500`、`maxOperations` `50000`。`bufferRatio` 为兼容字段，当前不参与重排计算；任务数、周期和计算预算有不可被请求放宽的硬上限。
- 出参：`strategies`、`diff`、`loadDelta`、`growthApplicable`、`accepted`、`needsConfirmation`、`verdict`、`snapshot`、`guards`、`nextTasks`、`nextPlacements`、`nextWeek`。`strategies[]` 恒 4 条 `{ level, name, applied, growth, reason }`（`name` 依次为顺延/压缩/替代/放弃）；`diff[]` 为 `{ op, taskId, subject, from, to, detail }`，`op` ∈ `defer`/`compress`/`substitute`/`abandon`；`snapshot` 为 `{ tasks, week, timestamp, placementModel? }`；`guards` 为 `{ loadGrowthOk, bufferPreserved, consecutiveOk, compressedShareOk }`；`verdict` ∈ `ok`/`needsConfirmation`/`blocked`。零基线时 `loadDelta=null`、`growthApplicable=false`。

四级有序执行，首个通过校验即停止，后续级别不进入：

| 级 | 名称 | 行为 | 回退条件 |
|---|---|---|---|
| 1 | 顺延 | 按权重从高到低填入未来 7 天普通 `capacity` 内的空闲分钟；`allowBuffer=true` 时才使用独立弹性 `buffer` | 普通容量装不下且未启用弹性，或增幅/容量守卫失败 |
| 2 | 压缩 | 仅当溢出 `overflow > 0` 触发，按权重从低到高压缩，下限 `est × compressFloor`，目标 `saved >= overflow` | 压到下限仍装不下 / 占比超 `compressedShareCap` / 增幅事后守卫不过 |
| 3 | 替代 | 同 `domain` 内以更高 `freq` 且更高 `weight` 的节点替换，原任务标 `substituted` 退出待办，新节点记 `replaces` | 同域内无更优节点或替换后复核不过 |
| 4 | 放弃 | 标 `abandoned` 并只给建议：`accepted=false`、`needsConfirmation=true`、`verdict='needsConfirmation'` | 未确认 |

三条防雪崩断言（`accepted=true` 须同时成立）：

1. `loadGrowthOk`：未来 7 天负载增幅 ≤ `loadGrowthCap`。
2. `bufferPreserved`：任一日普通负载不得超过 `capacity`，弹性负载不得超过 `buffer`；两类容量独立检查，未使用弹性不会被清空，显式启用时允许实际占用。
3. `consecutiveOk`：连续 `consecutiveNoImproveCap` 次未改善即停止并转目标校准，`verdict='blocked'`。

补充：`locks` 中的锁定任务是硬约束，不参与顺延装载，也不会被压缩、替代或放弃，且不出现在 `diff` 中；L2 结果仍为锁定任务保留空占位，应用落点时不得释放其原有区块。`confirmReplan(result)` 只接受 `verdict='needsConfirmation'` 且四级策略、diff、快照、guards、nextTasks/nextPlacements 内部结构完整的结果，返回新的 `accepted=true` 对象且不改入参，否则抛 `TypeError`；当前前端只在本机调用它，不创建或确认服务端草案。`undoReplan(snapshot)` 返回 `{ tasks, week, placementModel? }`，逐条还原快照，**不重算**，当前也只在本机执行。服务端旧 confirm / undo 接口仅服务端保留，前端不使用。

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

前缀 `/api`，全部返回 JSON，错误统一形状 `{ error: { code, message } }`；异步错误响应带 `X-Request-Id`，内部异常只回通用消息，细节只进服务端日志。

服务监听：`server/main.js` 默认绑定 `127.0.0.1:8787`，`PORT` 与 `HOST` 环境变量可覆盖；需要局域网或反向代理访问时必须显式设置 `HOST`。前端在 `http`/`https` 下用同源 `location.origin`，仅 `file://` 打开时用 `http://127.0.0.1:8787`。

中间件顺序：解析 URL → `OPTIONS` 直接 204 → 非 `/api/` 走静态（仅 GET/HEAD，其余 405 `E1001`）→ `/api/` 鉴权 → 限流 → 读请求体 → 路由 → 响应 JSON。

静态资源白名单仅 `/`、`/index.html`、`/assets/*`、`/shared/*`，其余 404 `E2001`；请求体上限 1 MiB，超限 `E4002`。Node HTTP 默认 headers 10s、完整 request 130s、keep-alive 5s、最大 128 连接，分别可由 `NOVA_HTTP_HEADERS_TIMEOUT_MS`、`NOVA_HTTP_REQUEST_TIMEOUT_MS`、`NOVA_HTTP_KEEP_ALIVE_TIMEOUT_MS`、`NOVA_HTTP_MAX_CONNECTIONS` 覆盖。`deploy/nginx.conf.example` 提供请求体、慢连接、并发与速率限制示例；旧撤销接口位置不配置 `limit_req`，保持 S3 决策。示例不等于已部署，TLS、真实域名、可信代理与网关策略仍须运维验收。服务端草案与计划收据在进程内已有 TTL 清扫和 FIFO 容量上限，重启不保留，不构成本机主数据或持久回执。跨域策略：仅 `NOVA_ALLOWED_ORIGINS` 中精确匹配的 origin 放行；`file://` 的 `null` origin 默认关闭，需显式设置 `NOVA_ALLOW_NULL_ORIGIN=1`。同源浏览器请求不依赖 CORS 头，不再根据请求 Host 推断可信来源；放行时返回 `Access-Control-Allow-Methods: GET, POST, OPTIONS`、`Access-Control-Allow-Headers: Content-Type, Authorization`、`Access-Control-Max-Age: 600`。

| 方法 | 路径 | 前端状态 | 鉴权 | 请求字段 | 响应 | 失败错误码 |
|---|---|---|---|---|---|---|
| GET | `/api/health` | 使用 | 免 | 无 | `{ ok, version, uptimeMs }` | 无 |
| POST | `/api/auth/session` | 按需使用 | 免 | 无（不接受任何身份字段） | `{ token, userId, expiresAt }` | E4290 |
| GET | `/api/state` | **仅服务端保留，前端不使用** | 需 | 无 | `{ seed, replan, notifications, planBaseline }`；`planBaseline` 为 `null` 或 `{ version, stale }`，仅属服务端历史数据 | E4010 |
| POST | `/api/feasibility` | 使用（计算） | 需 | `weeklyH`、`weeks`、`discount`、`demand` 均必填且须为有限数值 | `feasibility()` 返回 | E4010, E1001, E4290 |
| POST | `/api/schedule` | 使用（计算） | 需 | `tasks`、`slots` 必填数组；`params` 可选对象 | `{ blocks, unplanned, version }` | E4010, E1001, E4290 |
| POST | `/api/plan/review` | **仅服务端保留，前端不使用** | 需 | `id`（UUID）、`base`、`input`、`result`；`ticket` 可选 | `{ status: 'committed', version }` 或 `{ status: 'conflict', reason, version, ticket? }`；同签名重放 24 小时内返回首次收据 | E4010, E1001, E3001, E4290 |
| POST | `/api/replan` | 使用（预览计算） | 需 | `tasks`、`week` 必填数组；`params`、`history`、`locks` 可选对象；`timestamp` 可选 | `replan()` 返回；服务端可能附 `draftId`，前端忽略且不写业务记录 | E4010, E1001, E4290 |
| POST | `/api/replan/confirm` | **仅服务端保留，前端不使用** | 需 | 仅 `draftId` 字符串 | 已确认重排结果；草案同身份、5 分钟内且仍在缓存中，重复确认不重写 | E4010, E1001, E2001, E3001, E4290 |
| POST | `/api/replan/undo` | **仅服务端保留，前端不使用** | 需 | `snapshot` 必填对象 | `{ tasks, week }` | E4010, E1001 |
| POST | `/api/attribute` | **仅服务端保留，前端不使用** | 需 | 请求体不得为空；6 个数值字段均可选 | `attribute()` 返回 | E4010, E1001, E4290 |
| POST | `/api/sync/ops` | **仅服务端保留，前端不使用** | 需 | `ops` 必填数组；每条须有非空字符串 `opId`、`entity`、`field`，`entityId` 为字符串或安全整数（允许空串，落在 `''` 合并桶）；`clientTs` 可选有限数值 | `{ accepted: [opId], serverSeq }` | E4010, E1001, E4002, E4030, E4290 |
| POST | `/api/llm/clarify` | 使用（理解） | 需 | `messages` 必填数组（≤40 条，每条 `role` 为 `user`/`assistant`，`content` 非空字符串）；`profile` 可选对象 | `{ reply, profile, done, missing }`；`profile` 为服务端归一后的白名单画像；`done=true` 时槽位必齐 | E4010, E1001, E5010, E5011, E5012, E4290 |
| POST | `/api/llm/analyze` | 使用（分析建议） | 需 | `profile` 必填对象（goalName/deadline/weeklyH/goalType 齐备）；`history` 可选对象（前端发送聚合近况快照，口径见 §6 澄清条目） | `{ summary, demandH, weeklyH, tasks[{s,title,est,weight}], risks[], advice }`；不含排程块；`est` 15–240、`weight` 0–1、条目 ≤8 | E4010, E1001, E5010, E5011, E5012, E4290 |

路径不存在返回 `E2001`；路径存在但方法不符返回 `E1001`。

错误码（定义在 `server/api/errors.js` 的 `ERRORS`，`routes.js` 原样再导出）：

| code | HTTP | 含义 | 当前是否抛出 |
|---|---|---|---|
| E1001 | 400 | 请求参数非法或缺失 | 是 |
| E2001 | 404 | 资源不存在 | 是 |
| E3001 | 409 | 状态冲突 | 是（重排草案版本过期 / 计划复核请求 ID 冲突） |
| E3002 | 409 | 资源已存在 | 否，仅保留定义 |
| E4001 | 200 | 幂等键重复，已返回首次结果 | 否，幂等命中直接返回 200 |
| E4002 | 400 | 请求体过大或单批超过上限 200 | 是 |
| E4010 | 401 | 未提供有效凭证 | 是 |
| E4030 | 403 | 无权访问该用户数据 | 是 |
| E4290 | 429 | 请求过于频繁 | 是 |
| E5001 | 500 | 服务内部错误 | 是 |
| E5010 | 503 | LLM 服务未配置（LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 缺任一） | 是（前端据此降级表单流程） |
| E5011 | 502 | LLM 调用失败或超时 | 是 |
| E5012 | 502 | LLM 输出无法解析为合法结构 | 是 |
| E9001 | 500 | 未分类异常 | 是 |

限流（阈值随 `server/api/routes.js` 路由注册表的 `limit` 元数据声明，单进程固定窗口，单位 次/60 秒）：`POST /api/auth/session` 60（按来源 IP 隔离）、`POST /api/sync/ops` 60、`POST /api/replan` 与 `POST /api/replan/confirm` 各 12；`POST /api/replan/undo` 当前未配置限流（2026-11-24 用户确认保持现状；前端不调用，部署层保护仍属运维边界）、`POST /api/feasibility` 与 `POST /api/schedule` 与 `POST /api/plan/review` 与 `POST /api/attribute` 各 30、`POST /api/llm/clarify` 与 `POST /api/llm/analyze` 各 10（LLM 有外部成本，从严）；`GET /api/health` 与 `GET /api/state` 不限流。超限返回 `E4290` 与 `Retry-After` 响应头，不排队、不自动重试。

## 6. 本地主数据与前端通信约定

- **唯一业务主数据**：`localStorage['zx.overlay']`，`format='nova-overlay'`、`version=3`、`syncMode='local-only'`，并带 `installId`、`revision`、`updatedAt`。业务快照包含 `planVersion`、`tasks`、`sessions`、`goal`、`feas`、`week`、`weekShift`、`placementModel`、`dayAssign`、`locks`、`avail`、`availSource`、`notif`、`attrCounts`、`replanHistory`、`replanSnapshot`。v3 `placementModel` 保存具体日期、IANA 时区、稳定任务/区块 ID、原始/当前落点、普通容量、弹性容量及由区块推导的实际用量；`week` 只是投影。旧 v1/v2 无模型证据时保持 legacy，不从 `total-buf` 或当前日期反推。服务端状态不得覆盖、合并或回放它。
- **加载熔断**：损坏 JSON、无效格式 / 版本、v3 元数据、落点模型或业务结构损坏、未来 `version>3`，均保留原键并暂停 overlay 覆盖；v3 必须含 `planVersion` 与 `SNAPSHOT_FIELDS` 全部字段（允许字段值为 `null` 的仍按各字段契约校验），缺字段不以种子补齐。旧 v1/v2 仍可读并在下一次成功保存时升级 v3。只有显式导入通过校验的备份或确认删除全部数据才解除。保存失败单独提示，不伪称已持久化。
- **跨标签页冲突**：保存前重读存储并与本页最后持久化的业务快照比较；外部业务变更、删除或非法元数据会拒绝写入并置粘滞 `overlayConflict`。`storage` 事件同步检测本页未保存修改；仅元数据变化且业务相同时接受新 revision。冲突页暂停保存、删除、重排确认/撤销，提示先导出本页备份再刷新；刷新后按当前存储恢复。导入失败回滚先重读当前值，只在仍等于旧值或本次已验证/尝试写入值时恢复；另一页的新写入/删除优先保留，意外当前 raw 不覆盖并进入加载熔断。支持 Web Locks 的浏览器以 `nova-local-overlay` 串行化导入、删除与恢复事务；不支持时使用 fail-closed 顺序检查。不可读 overlay 的强制替换只允许当前 raw 仍等于本次加载的不可读 raw，另一页已修复为有效 overlay 时拒绝覆盖。显式删除先预检，失败时恢复本次回收站写入；损坏/未来版本可显式删除。删除已执行但回读异常时保留 trash 并提示刷新核查。trash 清理与恢复成功后只删除本次读到的 raw；恢复同时还原 `consecutiveZeroDays`、`interrupted`、`rescueRecord`，快照统一布尔化。修复可读的未来版本时保留原 revision 并递增，非法 JSON 无法取得 revision。这不是 localStorage 原子 CAS，不承诺多页同时读写的线性一致性。
- **关键状态事务**：`ZX.state.transact()` 先克隆业务与计时相关状态，执行变更并检查 `saveOverlay()`；失败时恢复内存，且仅当当前存储仍是旧值或本次尝试/验证值时才回滚 raw，外部写入优先保留。目标生效、重排确认、执行记录/跳过/恢复/补录、计划改期/锁定/逐条否决均走该原语。它是补偿回滚，不替代 IndexedDB 原子事务。
- **重排否决与澄清重试**：确认后的压缩/顺延 diff 渲染 `data-veto` 按钮，绑定当前 `draftId` 与 `planVersion`；旧卡或快照不足时整笔拒绝。`goal.apply()` 返回 `Promise<boolean>`，澄清仅在排程提交成功后结束会话；失败保留建议与 draft，并渲染绑定 revision/planVersion 的重试卡，计划变化后旧卡失效。澄清的拆解建议请求附 `history` 聚合快照（`clarify.js` 的 `historySnapshot()`）：近 7 天有效/补录投入分钟、有记录天数、记录条数，重排采纳/总数，连续断更天数与归因计数；**仅聚合数值与产品固定枚举键，不含任务标题、正文或科目名**，供 LLM 调整节奏与风险，不影响排程计算。
- 入口 `assets/js/api.js`，普通计算请求统一 3000 ms `AbortController` 预算；LLM 请求（`/api/llm/clarify`、`/api/llm/analyze`）使用独立 30000 ms 预算（2026-11-28 产品裁决），与服务端 `LLM_TIMEOUT_MS` 缺省值对齐；客户端预算固定，服务端把 `LLM_TIMEOUT_MS` 调高到 30s 以上时客户端仍先中断并按超时降级（测试 `test/api-boundaries.test.js` 锁定两条预算）。`BASE` 取 `window.__ZX_API_BASE__`（去掉末尾斜杠），否则 `http`/`https` 用同源 `location.origin`，`file://` 用 `http://127.0.0.1:8787`。
- **启动与恢复联网**：`main.js` 的 `probeBackend()` 与 `online` 监听只调用 `/api/health`。健康状态仅表示计算可达性；不调用 `getState` / `adopt` / `flush` / `stagePlan` / review / confirm / undo / syncOps，不触发 op 上行或计划自动复核。
- 凭证：计算请求按需经 `POST /api/auth/session` 取得 `{ token, userId, expiresAt }`，存 `zx.auth_token`；本地按 `expiresAt` 预判过期，401 时清空并重签一次，不循环重试。仅 health / auth 不带凭证，其余当前计算请求带 Bearer。凭证不进入业务备份，也不是本地主数据身份。
- 当前允许的计算调用：`/api/feasibility`、`/api/schedule`、`/api/replan`、`/api/llm/clarify`、`/api/llm/analyze`。`assets/js/engine.js` 对可行性 / 排程 / 重排采用服务端优先、失败或结构不合约定走同一 `assets/js/rhythm.build.js`，并记录 `ZX.engine.source`；本机产物缺失须提示重建，不静默换语义。`feasibilityNow` / `attributeNow` 直接使用本地产物；`/api/attribute` 仅服务端保留，前端不使用。
- **本机确认与撤销**：重排预览可来自服务端计算或本机引擎，但确认只写本机 overlay。快照保存确认前后的 `tasks`、`dayAssign`、`locks`、`placementModel`，以及 `afterTasks` / `afterDayAssign` / `afterLocks` / `afterPlacementModel`；撤销前发现任何后续独立修改，或旧快照缺少冲突信息，整笔拒绝且不标记 `undone`。服务端 `/api/replan/confirm`、`/api/replan/undo` 与 `draftId` 仅服务端保留，前端不使用。
- **旧队列隔离**：`zx.op_queue` 原字节保留、只读；`queueOp()` 不再写，`pendingCount()` 恒为 0，`legacyPendingCount()` 只统计旧 `pending` 并显示「N 项已隔离」。`flushQueue()` 是兼容空操作，返回 `status='isolated'`、`sent=0`，不发网络请求。删除本机业务数据也不移除旧队列。
- **旧待复核计划**：`zx.pending_plan` 原样保留，只提供读取入口；不自动复核、不上送、不改变本机计划，删除本机业务数据时仍保留隔离。`zx.server_plan_version` 是历史遗留，当前前端不读不写。
- **M3 暂缓**：`deferred` 只表示今日暂缓，不是真实改期；退出今日任务表 / 时间带、计划普通块、挽救与重排候选，在今日和计划页独立可见、可恢复，计划日期不变。旧 `deferredTo` 只作兼容提示。v3 真实改期由 `placementModel` 保存具体日期与完整跨日区块，按普通/弹性容量校验；legacy 仍只支持旧星期标签，不声称已迁移。
- **R8 统计**：`exec.metrics()` 分列任务数完成率、计划工时完成率、实际投入、剩余预估、部分完成及跳过/暂缓/放弃/替代/锁定数量。旧部分任务缺原始分母时 `plannedBasis='unknown'`、完成率为 `null`，界面显示“未知”；已知零计划显示“—”，助理消息与今日/数据/首页摘要口径一致；补录单列且不混入任务实际投入。
- **R9 演示隔离**：真实挽救按 sessions 与 `rescueRecord.at` 恢复锚点计算断更；未达 3 天不打开真实挽救、不注入演示天数。对话「演示挽救」使用局部 4 天只读预览，显著标注“演示数据 · 不会修改真实计划”，不调用真实 `detect/open/apply`。挽救完成当日断更归零，次日从该锚点重新计为 1 天。
- **备份**：「我的」提供 CSV 与 `nova-backup` v1 完整 JSON。legacy 的 `buffer` 与 `tiredAdopted` 是可选快照字段，旧备份缺字段仍兼容；v3 不保存这两个字段，弹性用量只由 `placementModel` 证明。导入前校验格式、版本、时间、安装标识、snapshot 结构、安全 ID、文本长度及标签 / 控制字符，并拒绝凭据 / 队列字段；用户确认后保存旧 trash 原值，再写覆盖前快照与新 overlay。写入或回读失败时同时回滚 overlay 与 trash；回滚失败明确告警并保留页面。备份不含 token、旧队列或旧待复核计划；v3 备份保留并严格校验 `placementModel`，旧 v1 备份缺该字段时按无模型兼容导入。
- **CSV 与演示预置**：CSV 保持 10 列；任务状态覆盖今日暂缓、已放弃、已替代与未排入。任务行日期只取合法明确计划日期，缺失/未排入留空；记录行取 `startAt`，目标行取截止日，不再把任务日期伪造成导出当天。周报“演示预置”仅保留静态示例并标注不写入日程，已删除名实不符的撤销/恢复按钮及无效 preset op。
- **连接文案**：可达且无加载 / 保存异常、无旧 pending 时为「本地主数据 · 服务端仅计算」；有旧 pending 时顶栏显示「本地主数据 · 旧队列已隔离 N」，「我的」页显示「N 项已隔离」。离线基础文案为「离线 · 本地可用」，有旧 pending 时附加隔离数量。离线头像使用 `mascot-inline.js` 的内联 data URI，不依赖网络，不显示待处理角标。

### 6.1 受控旧 overlay 迁移

`node scripts/overlay-migration.js <input.json> --out <new-backup.json>` 只接受从界面导出的 `nova-backup` v1 或原始 `nova-overlay` v1/v2/v3 JSON；不读取浏览器存储，不覆盖输入，`--out` 必须不存在。输入上限 32 MiB，拒绝凭据/队列字段、重复任务 ID、非法文本与结构冲突。

- **A 类**：已有合法 `placementModel`。保留模型及历史 `originalSegments`，只重建 `week` / `weekShift` / `dayAssign` / `buffer` 投影，输出新的 `nova-backup` v1。不使用 `--rebuild`。
- **B 类**：没有任务区块证据。默认以 `cannotAutoMigrate` 拒绝写出，绝不从 `week.total`、`buf`、旧 `time` 或当前日期猜落点。只有明确选择重建时才执行：`node scripts/overlay-migration.js <input.json> --out <new-backup.json> --rebuild --start-date YYYY-MM-DD --timezone IANA`。起始日不得早于本机今天；使用快照中的 7×4 可用时段和稳定任务 ID 排程，容量不足的任务保留在 `unplanned`，终态任务不复活。新落点的 `originalSegments` 一律为空、`source='legacy-rebuild'`，并清空旧 `replanSnapshot`。存在 deferred 任务、`avail=null` 或 locked 任务缺少可靠星期+时间锚点时拒绝重建。
- **C 类**：损坏、版本/字段冲突、悬空模型引用或未被可信解析的旧区块证据。始终拒绝，不能借 `--rebuild` 绕过。

输出采用随机临时文件、`0600`（POSIX）、可写描述符 `fsync` 与独占硬链接提交；stdout 只报告分类、模式、路径、计数、字节数和 SHA-256，不输出任务正文。迁移产物仍需在「我的」页显式导入才会覆盖本机业务快照，导入保留覆盖前 trash；真实浏览器盘点、备份、切换与写回须分别授权，先关闭或可靠隔离旧页面写入者，不能用本 CLI 代替授权。`0600` 在 Windows 受限，目录 ACL 由运维保障。

### 6.2 服务端历史业务能力（仅服务端保留，前端不使用）

- `/api/state` 返回服务端种子、历史重排 / 通知与 `planBaseline`；`planBaseline.version` 是服务端版本，`stale` 表示历史同步操作后的保守标脏。当前前端不拉取、不接收。
- `/api/plan/review` 可重算客户端排程并返回 `committed` / `conflict`，冲突附 `ticket`；收据在进程内，同签名 24 小时内可重放。新建计划建立服务端基线、冲突重交和文件回填仅属服务端历史能力，当前前端不调用、不挂起、不自动补审。
- `/api/sync/ops` 的 `opId` 是分区内幂等键；`serverSeq` 对应被接受操作，不是单调游标。历史字段合并由 `server/store/memory.js` 的 `policyOf` 实现：墓碑优先，计数求和，`actual` / `durationMin` / `minutes` / `duration` 取最大值，其余最后写入优先；执行记录按 session ID 去重，`plan/dayAssign/moved` 按 taskId 合并。当前前端不生成 op、不上行、不消费 `accepted`。
- 服务端 JSON 持久化先写同目录临时文件，使用可写描述符执行 `fsync` 后再原子改名；Windows 上不能用只读描述符执行 `fsync`，POSIX 另同步目录项。所有写者共用 `STORE_FILE.lock`，锁含 owner token，仅持有者释放；不自动删除无法确认归属的锁，等待超时由 `NOVA_STORE_LOCK_TIMEOUT_MS`（默认 5000ms）控制并提示人工核实。业务写入与 CLI 都在锁内重读最新存储后再修改，避免旧快照复活已删除分区。计划复核/重排确认提交时在锁内核对 expectedRevision，冲突返回 E3001。`applyOps`、`recordReplan`、`recordSchedule`、`reset` 与删除在失败时回滚内存，失败 opId 不占用幂等索引。启动时拒绝 JSON 语法及根、分区、身份、非安全整数序号、状态、实体嵌套、索引、改期桶或重排记录结构损坏，不自动清空或覆盖；恢复失败保留上一份有效内存缓存，不凭空创建 seed。rename 已提交后的目录项同步失败会记录 `getPersistenceWarning()` 并输出警告，不误报事务回滚。默认旧布局仍每次序列化全部分区；`NOVA_STORE_PARTITIONED=1` 可启用内容寻址分区，只写变化分区并以 `<STORE_FILE>.manifest.json` 原子提交，旧版本与孤儿文件保留。首次分区提交前原子写入 `<STORE_FILE>.partitioned.json` 模式标记；检测到标记或 manifest 后关闭该选项会拒绝启动，标记存在但 manifest 缺失、或两者均缺失却存在非空 parts 时也拒绝回退旧 JSON。历史 manifest 仍可读取并在下次写入补标记。全库备份 envelope 与分区 canonical schema 严格校验，legacy 读取继续兼容。分区旧版本可通过 `node scripts/server-data-admin.js compact --store <path>` 只读盘点；`compact --purge --confirm purge --out <audit.json>` 才会先写独占审计再回收未引用 parts/.tmp，当前引用分区绝不删除。全库备份使用 `node scripts/server-data-admin.js backup-all --out <bundle.json>`；`verify-backup --file <bundle.json>` 只读校验；`restore-all --file <bundle.json> --store <new-store.json> --confirm restore-all --out <audit.json>` 只恢复到不存在的新路径，拒绝覆盖现有存储。
- 测试存储隔离使用单例显式接口 `setStoreFile(file, partitioned)` + `reload()`：前者切换路径、布局并刷新预算，后者清空内存后从磁盘恢复；持锁期间两者均拒绝执行。测试不得通过删除 `require.cache` 制造多个存储实例，避免各实例的路径与锁状态互相不可见。
- 资源预算：`NOVA_STORE_MAX_BYTES` 默认 16 MiB（partitioned 含模式标记、manifest 与全部 parts），`NOVA_STORE_MAX_PARTITIONS` 默认 1024；草案/收据分别受 `NOVA_DRAFT_BUDGET_BYTES` 8 MiB 与 `NOVA_RECEIPT_BUDGET_BYTES` 4 MiB 总字节限制并按 FIFO 淘汰；LLM 上下文受 `NOVA_LLM_MAX_REQUEST_BYTES` 256 KiB 限制。重排基准运行 `npm run bench:replan`，覆盖 500 任务，异常或超时非零退出。
- 幂等索引仅支持显式管理：`node scripts/server-data-admin.js prune-op-index --user <id> --keep-recent <N> --confirm prune-op-index --out <backup.json>` 先在同一锁内写完整备份与 prepared/confirmed 审计，再按 serverSeq 保留最新 N 条；旧 opId 回收后重试可能重复应用，保留期限必须由管理员裁定，系统不自动调用。
- 服务端 JSON 文件、进程内草案 / 票据 / 收据和凭证身份继续保留，但不构成本机主数据、云端备份或跨设备同步。重启后文件基线可回填，草案 / 票据 / 收据清空；未固定签名密钥时旧凭证失效，凭证到期后也无账户机制恢复原身份。
- S7/R10 受控 CLI：`node scripts/server-data-admin.js inventory [--store <store.json>] [--include-ids]` 默认只读输出分区计数及 userId/entity/entityId/字段名的 SHA-256 与字节数，不输出字段值或原始键名；`--include-ids` 才显式输出原始标识。敏感输出必须位于 `NOVA_ADMIN_BACKUP_DIR` 内，未设置时默认 `<store 目录>/nova-admin-output`。`node scripts/server-data-admin.js export --user <id> --out <backup.json> [--store <store.json>]`；删除必须额外提供 `--confirm <id>`，先写独占备份、prepared 审计与 confirmed 意图，再按 SHA-256 分区指纹删除并写 deleted 审计。路径已存在、确认不符或指纹变化均拒绝；审计失败时退出码 3 并明确报告“已删除、审计失败”，confirmed 意图仍保留。不开放 HTTP 删除入口。删除同时写入 `<STORE_FILE>.revoked.json` 持久化撤销清单，旧 token 立即返回 `E4030` 且不会静默重建空分区；旋转 `NOVA_AUTH_SECRET` 可撤销全部身份。`0600` 在 POSIX 受限，Windows 目录 ACL 仍需运维保障；真实存储操作须单独授权。

### 6.3 S9 部署参考（公网部署已排除，不属于项目交付）

用户于 2026-11-25 明确不用考虑公网部署，S9 已以反向代理示例、静态契约和本节 runbook 完成结案。以下步骤仅保留为未来运维参考，不是当前待办或验收要求；本项目不执行网关变更、reload 或服务启停。

1. 先备份现有网关配置并确认上游 `127.0.0.1:8787` 的 Nova 服务由既有运维方式管理；本清单不授权启动、停止或重启该服务。
2. 复制 `deploy/nginx.conf.example`，按实际监听地址、域名/证书和上游调整；若前面还有可信网关，只对可信代理配置 `real_ip`，并让 Node 的 `NOVA_TRUST_PROXY` 与网关一致，避免伪造 `X-Forwarded-For` 或所有访客共享限流桶。
3. 在执行目录运行 `nginx -t`；必须退出码 0 才进入 reload。实际 reload/重启由运维授权并执行，本项目不自动运行。
4. 部署后先检查同源 `/api/health`，再检查静态页、file/HTTP 边界和备份交互；确认普通 API 受 120r/m、连接数 64 与请求体 1MiB 约束，`/api/replan/undo` 仍只受连接/超时保护、不出现 `limit_req`。
5. 用受控低流量验证 400/E4002、429/E4290、130s 上游读取超时与真实客户端地址隔离；不要对既有服务做压力或撤销接口压测。
6. 观察网关与 Node 错误日志；出现异常时恢复部署前配置并执行 `nginx -t` 后按运维流程 reload。本节仅为未来参考，公网部署已排除，S9 已结案。

### 6.4 真实浏览器只读盘点

Browser Connector 不允许助手直接读取 Storage 或 CDP DOMStorage。已获授权的只读盘点由 `.tools/browser-storage-inventory.js` 完成：在目标 Nova 页面按 F12，把脚本全文粘贴到 Console 后回车。脚本只调用 `localStorage.getItem`，不调用 `setItem/removeItem`，不导出正文或凭证；输出键名、字节数、SHA-256、版本、数量、结构问题及 A/B/C 提示。

- `page.protocol` 用于区分 `file:` 与 `http:`/`https:` 的存储上下文；不同 origin 的 localStorage 不共享。
- `classificationHint=A` 仅表示存在基本合法的 `placementModel`；最终仍以 `scripts/overlay-migration.js` 的严格分类为准。
- `B` 表示无模型且无旧区块证据，不得自动猜迁移；`C` 表示损坏、悬空引用或旧区块证据，必须保留原 raw 并人工核查。
- `zx.op_queue`/`zx.pending_plan` 只报告存在性、哈希和数量，不输出内容；`zx.auth_token` 不纳入诊断。
- 回传聚合 JSON 前确认没有任务标题、正文、token 或其他字段值。真实切换、导出覆盖或删除仍须单独授权。

2026-11-25 的 `file://` 只读盘点与原样导出已完成。最终导出快照为 `.tmp/nova-overlay-raw.json`（2626 字节，SHA-256 `3628c9ef4d0a147f76f88481fbe746eff591a4a3a8756ac01c108c6dde562655`），迁移 CLI 判定为 C / legacyBlockEvidence。`.tmp/nova-overlay-mapping-report.json` 确认旧 `week/weekShift` 是科目级日汇总而非任务区块，任务无具体日期/dayAssign/锁定/撤销快照；用户已决定保留 legacy、不迁移、不写回，M1/M3 旧数据切换结案。

## 7. 兼容性硬要求

1. 改 `shared/engine/*.js` → `npm run build:engine` → 提交 `assets/js/rhythm.build.js` → `npm test`。
2. 改路由、请求字段、错误码 → 同步本文件第 5 节与 `test/api.test.js`。
3. 改引擎签名 → 同步 `server/api/routes.js`、`assets/js/engine.js`、`assets/js/api.js`、`test/engine.test.js`。
4. 改 `shared/data/seed.js` → 同步 `test/engine.test.js` 与 `test/api.test.js` 的断言。
5. 改服务端历史 op 实体或字段 → 同步 `server/store/memory.js` 的 `applyToState` / `policyOf` 与 §6.1；不得据此恢复前端 op 写入或上行。
6. 前端不得内嵌第二份引擎实现；`assets/js/rhythm.build.js` 不得手改。
7. 服务端保持零第三方运行时依赖；前端已使用本地 vendored Three.js / CSS3DRenderer，不得误记为无第三方。vendor 由 `scripts/build-vendor-three.mjs` 生成，禁止手改；新增或升级依赖须同步资源与契约，不引入 CDN 运行时依赖。

## 8. 验收口径

| 检查项 | 命令 | 判定标准 |
|---|---|---|
| 引擎单测 + HTTP 冒烟 + 前端 VM 单测 + 资产门禁等 | `npm test` | 退出码 0、失败数为 0；测试数与通过 / 跳过情况以本次命令输出为准，不以历史数量证明当前全绿 |
| CSS 审计 | `npm run audit` | 退出码 0；存在 error 时退出码 1，仅 warn 仍为 0 |
| 引擎产物重建校验 | `npm run build:engine` 后重算 `assets/js/rhythm.build.js` 的 SHA256 | 在源文件未变时，重建前后哈希一致（构建不写时间戳）；源文件有改动则以重新生成的产物为准，再构建应幂等，不钉死历史哈希 |
| 资源引用全量扫描 | 使用 `FRONTEND-CONTRACT.md` §9 扫描命令提取 `index.html` 的本地 `src`/`href` 并检查存在 | 缺失数为 0；引用清单与数量取本次扫描结果（包含 GL 与 vendor），不钉死引用总数 |
| 服务冒烟 | `node server/main.js` 后请求 `GET /api/health` | HTTP 200 且 `ok` 为 `true` |
| 隔离真实浏览器验收 | `python .tools/browser-acceptance.py`；随机端口、合成存储、无持久化 Chromium，HTTP 与 `file://` | M1/M2/M3/M4/S1/S2/S5/S6/S8/PC-VISUAL 与当前 `OPTIONAL` 清单全部 pass；不访问真实存储或既有 8787 服务 |
| 真实浏览器 GL 验收 | 按 `FRONTEND-CONTRACT.md` §9 在 HTTP 与 `file://` 下检查 GL 开启 / 关闭 / 不可用场景 | 首帧、WebGL / CSS3D 渲染与层级、导航 / 输入 / 滚动 / 弹层、动效闸门与 DOM 回退均实测；记录浏览器与结果 |
| 本地主数据 / 旧接口隔离 | 按 `FRONTEND-CONTRACT.md` §9 检查启动、`online`、计算、重排、备份导入的 Network 与存储 | overlay v3 元数据与落点模型完整；启动和 `online` 只探测 health；无 state / sync / review / 服务端 confirm / undo 请求；服务端 `draftId` 不参与本机确认 |
| 加载熔断 / 旧数据隔离 | 预置损坏、无效 v3、`version>3`、损坏落点模型及旧队列 / 待复核计划 | 原 overlay 字节保留并暂停覆盖；旧队列 / pending plan 原字节不变；`pendingCount=0`，旧 pending 显示「N 项已隔离」 |
| M3 / 备份恢复 | 按 `FRONTEND-CONTRACT.md` §9 执行暂缓恢复与 CSV / JSON 往返、非法导入 | 暂缓两页可见可恢复且计划日期不变；`nova-backup` v1 不含 token / 旧队列；覆盖前 7 天 trash，校验失败不覆盖，写入失败尝试回滚并告警 |

Node VM 单测验证模拟环境下的逻辑，不能替代真实浏览器的 WebGL 上下文、CSS3D 布局、交互与视觉验收。上述命令和浏览器检查是验收要求，不是本文已执行或已通过的声明。

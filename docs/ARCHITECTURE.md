# 诺瓦 Nova 技术架构

> 本档描述仓库当前实现。事实来源：`../package.json`、`../server/`、`../shared/`、`../assets/`、`../scripts/`、`../test/`。

## 1. 范围与约束

诺瓦 Nova 是面向学生的日程助理 Demo（`../package.json` 的 description）。当前实现的边界：

| 约束 | 现状（源码可验证） |
| --- | --- |
| 确定性引擎 | `../shared/engine/` 四个引擎均为纯函数：不读时钟、不读随机数、不做 I/O，同一输入必得同一输出 |
| 不调用大模型 | 全仓无模型调用与外部服务 SDK，推理全部由本地纯函数完成 |
| 零第三方依赖 | `../package.json` 无 `dependencies`/`devDependencies`；服务端只用 `node:` 内置模块，前端为原生 JS + CSS |
| 内存态存储 | `../server/store/memory.js` 按 `userId` 分区，进程重启即清空，无数据库 |
| 演示账户 | 种子 `user.id = 'u_demo'`（林清，`tz: Asia/Shanghai`），`dailyCapMin: 300`，`weeklyH: 20` |

## 2. 运行形态与分层

两条路径共用同一套前端资产。其一是 **file:// 双击**：`../index.html` 以经典 `<script>`（非 ESM）加载 `../shared/data/seed.js` 与 `../assets/js/rhythm.build.js`，资源全为本地相对路径，`../assets/js/api.js` 在 `file://` 下把 API 基址定为 `http://127.0.0.1:8787`。其二是 **Node 服务端托管**：`../server/main.js` 对 `GET /` 返回 `index.html`，`/assets/*` 与 `/shared/*` 直出，前后端同源，`../assets/js/api.js` 取 `location.origin`。

引擎只有一份实现：`../shared/engine/` 下四个 UMD 双模文件（`module.exports` 或挂 `window.Rhythm.<name>`）。`../scripts/build-engine.js` 把它们拼接为浏览器产物 `../assets/js/rhythm.build.js`；源文件若缺 `root.Rhythm` 挂载则构建失败。该产物禁止手改，`npm start`（`prestart`）与 `npm test`（`pretest`）都会先重建。

## 3. 系统架构

### 3.1 前端分层（`../assets/js/`）

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 状态 | `state.js` | 应用状态、种子归一、本机 overlay 存取、派生计算（`feasInput`/`weekInput`/`replanInput`/`noImproveCount`） |
| 通信 | `api.js` | HTTP 调用（3000 ms 超时）、Bearer 凭证、op 队列、连接状态广播 |
| 引擎桥接 | `engine.js` | 后端优先、本地产物兜底的调用编排；`feasibilityNow`/`attributeNow` 为同步本地入口 |
| 原语 | `ui.js`、`util.js` | 提示/弹层/焦点等 UI 原语与通用工具 |
| 对话 | `assistant.js` | 意图路由，重排/撤销/降载/通知等对话动作 |
| 流程 | `flows/goal.js`、`flows/rescue.js`、`flows/exec.js`、`flows/planedit.js`、`flows/settings.js` | 目标落地、中断挽救、执行记录、计划编辑、设置与数据清理 |
| 视图 | `views/today.js`、`views/plan.js`、`views/data.js`、`views/me.js` | 四个子页渲染 |
| 装配 | `main.js` | 页签（对话/今日/计划/数据/我的，对话为默认）、事件绑定、渲染循环与 overlay 落盘 |

### 3.2 服务端分层（`../server/`）

`../server/main.js`（HTTP 入口：静态托管、CORS、鉴权、限流、请求体上限）→ `../server/api/routes.js`（路由表与入参校验，错误统一形状 `{ error: { code, message } }`）→ `../server/auth.js`（凭证签发校验、写接口限流）→ `../server/store/memory.js`（用户分区、op 合并、幂等索引）。

静态托管白名单仅 `/`、`/index.html`、`/assets/*`、`/shared/*`，并做目录穿越防护；其余路径返回 404 / `E2001`。

## 4. 数据模型

### 4.1 状态对象（`../shared/data/seed.js`，深度冻结）

| 顶层键 | 关键字段 |
| --- | --- |
| `user` | `id`、`name`、`tz`、`dailyCapMin`、`weeklyH` |
| `goal` | `id`、`name`、`target`、`deadline`、`weeks` |
| `feas` | `weeklyH`、`weeks`、`discount`、`demand` |
| `tasks[]` | `id`、`subject`、`title`、`est`、`time`、`weight`、`done`，可选 `actual`、`why` |
| `buffer` | `time`、`free` |
| `week[]` / `weekShift[]` | `d`、`segs`（`[科目, 分钟]`）、`buf`、`total`，`week` 末项带 `today` |
| `notif` | `daily`、`weekly`、`alert`、`rescue`（布尔） |
| `weekStats` | `WEEKS[]`、`kpis`（`effectiveHours`、`targetHours`、`achievementRate`、`achievementDeltaPt`、`replanAdopted`、`replanTotal`、`replanRate`、`recordedDays`、`totalDays`）、`subjectMix`、`attribution`、`actions[]` |
| `subjectColors` | 科目到 CSS 变量名（`var(--m-math)` 等） |

### 4.2 前端运行时字段

`../assets/js/state.js` 在种子之上补充：`sessions[]`（执行记录）、`attrCounts`（归因计数）、`replanHistory[]`（重排历史）、`serverSeq`（初值 88123，与服务端 `BASE_SEQ` 一致）、`replanRecord`、`lastFeas`、`snapshot`、`interrupted` 与 `consecutiveZeroDays`。任务归一同时保留契约名 `subject` 与视图名 `s`。

### 4.3 服务端分区结构

`../server/store/memory.js` 每分区持有 `{ userId, seq, state, entities, opIndex, replanRecords, replanSeq }`：`state` 为种子副本，`entities` 存字段级合并结果，`opIndex` 为 `opId` 到 `serverSeq` 的幂等索引。

## 5. 引擎实现

四个引擎均为纯函数，入参异常以 `TypeError`/`RangeError` 抛出，经路由层映射为 `E1001`。

### 5.1 可行性 `feasibility`

输入 `{ weeklyH, weeks, discount, demand }`；输出 `{ T, D, R, margin, verdict, threshold }`。`T = round(weeklyH × weeks × discount)`，`D = demand`，`R = Number((T / D).toFixed(2))`，`margin = T − D`。四档阈值硬编码、不可随请求变化：`R ≥ 1.2` 充裕、`≥ 0.9` 合理、`≥ 0.7` 偏紧、否则阻断。`demand ≤ 0` 或任一入参非有限数值即抛错。种子输入（`weeklyH 20, weeks 58, discount 0.85, demand 913`）得 `R 1.08`、`T 986`、`margin 73`（`../test/engine.test.js` 断言）。

### 5.2 排程 `schedule`

输入 `{ tasks[], slots[], params }`；输出 `{ blocks[], unplanned[], version: 'planner-1.0.0' }`，不含评分与统计字段。任务字段为 `estMin`（唯一格式，不兼容 `est`）；槽位字段为 `date`、`startMin`、`durMin`、`available`、`isBuffer`。`params` 默认 `bufferRatio 0.15`、`maxContiguousMin 150`、`dailyCapMin 300`，每日预留 `reserveMin = round(dailyCapMin × bufferRatio) = 45`。

- 硬约束：`available === false` 不排入；单日总时长不超过 `dailyCapMin`（弹性位占用计入），非弹性占用不超过 `dailyCapMin − reserveMin`；同日期同科目连续占用不超过 `maxContiguousMin`；弹性槽优先级最低，仅在无其他选择时兜底，带 `date` 与 `startMin` 的刚性任务先入箱故可优先占用弹性位。
- 排序：指定时段的刚性任务优先（`date`、`startMin`、`id`），其余按 `weight` 降序、`estMin` 降序、`id` 升序，保证确定性。
- `blocks[]` 元素含 `id`、`taskId`、`subject`、`date`、`startMin`、`durMin`、`isBuffer`、`locked`、`reason`；未排入项进 `unplanned[]`，带 `taskId` 与 `reason`。

### 5.3 重排 `replan` / `confirmReplan` / `undoReplan`

输入 `{ tasks[], week[], params, history, locks, timestamp }`；输出 `{ strategies[], diff[], loadDelta, accepted, needsConfirmation, verdict, snapshot, guards, nextTasks, nextWeek }`。周元素固定为 `{ date, minutes, buffer, capacity? }`，`capacity` 缺省取 `dailyCapMin`，输入顺序即周内顺序（不排序）；任务工时读 `est`（与排程引擎的 `estMin` 各自钉死）。`params` 默认 `loadGrowthCap 0.20`、`compressFloor 0.60`、`compressedShareCap 0.30`、`consecutiveNoImproveCap 3`、`bufferRatio 0.15`、`dailyCapMin 300`。

- 四级顺序执行，首个通过校验即停：L1 顺延（按权重降序填入未来 7 天 `capacity` 内空闲分钟）、L2 压缩（仅当待排分钟超出剩余容量 `overflow > 0` 时触发，按权重升序压缩，下限 `floor(est × compressFloor)`）、L3 替代（同 `domain` 内 `freq` 与 `weight` 双高者替换低者，原任务标 `substituted` 退出待办）、L4 放弃（只给建议，`accepted=false` 且 `needsConfirmation=true`）。
- 三条防雪崩断言：① 未来 7 天负载增幅不超过 `loadGrowthCap`（`loadGrowthOk`）；② 任何情况下不得侵占弹性位，即任一日负载不得超过该日 `capacity`（`bufferPreserved`）；③ 连续 `consecutiveNoImproveCap` 次未改善即在入口短路，`verdict = 'blocked'` 并转目标校准（`consecutiveOk`）。L2 另有事后守卫 `compressedShareOk`（压缩占比不超过 30%）。
- `locks`（`{ taskId: true }`）是硬约束：不参与装载、压缩、替代、放弃，也不进入 `diff`。
- `snapshot = { tasks, week, timestamp }`，`timestamp` 由调用方注入（引擎不读时钟）；`undoReplan` 反向应用快照，不重算；`confirmReplan` 只接受 `needsConfirmation === true` 的结果，确认后置 `accepted=true`、`verdict='ok'` 方可落库。

### 5.4 归因 `attribute`

输入 `planLoadRatio`、`consecutiveZeroDays`、`consecutiveTimeoutCount`、`efficiencyRatio`、`completion`、`externalRatio`；输出 `{ type, confidence, actions[], evidence }`，`evidence` 含六项入参与 `matched[]`。判定顺序固定（顺序即优先级，先排除计划问题再归因用户侧）：计划过载（`planLoadRatio > 1.1` 或 `consecutiveTimeoutCount >= 3`）→ 执行中断（`consecutiveZeroDays >= 2`）→ 效率不足（`efficiencyRatio > 1.4` 且 `completion >= 0.6`）→ 外部干扰（`externalRatio > 0.3`）→ 无偏差。

## 6. 数据持久化边界

### 6.1 服务端（内存态）

`../server/store/memory.js` 按 `userId` 分区，`BASE_SEQ = 88123`；`applyOps` 逐条合并并返回 `{ accepted[], serverSeq }`，同 `opId` 重复提交返回首次 `serverSeq` 且不推进序列。字段级合并策略：`deleted`/`isDeleted`/`deletedAt` 走墓碑（置位不可翻转），`count`/`sessionCount`/`sessions`/`times` 求和，`actual`/`durationMin`/`minutes`/`duration` 取最大值，其余最后写入优先（同 `clientTs` 比 `serverSeq`）。进程重启后状态全部丢失。

### 6.2 前端（本机）

| 存储键 | 内容 |
| --- | --- |
| `zx.overlay` | `tasks`、`sessions`、`goal`、`feas`、`week`、`weekShift`、`dayAssign`、`locks`、`avail`、`notif`、`attrCounts`、`replanHistory`；任何状态变更后由渲染路径统一落盘 |
| `zx.op_queue` | 待上行 op（`opId`/`entity`/`entityId`/`field`/`value`/`clientTs`/`baseSeq`/`pending`），队列上限 200 条 |
| `zx.auth_token` | `{ token, userId, expiresAt }`，服务端签发，本地不存任何可自造身份字段 |
| `zx.ui_prefs` | `grid`、`glow`、`motion`、`font` |

### 6.3 上行 op 与只写本机的操作

经 `/api/sync/ops` 上行的 op 覆盖：执行记录（`entity: 'session'`）、手工改期与锁定（`entity: 'plan'`）、逐条否决（`field: 'vetoed'`）、重排撤销（`field: 'undone'`）、放弃标记（`entity: 'task'`, `field: 'abandoned'`）、降载顺延（`field: 'deferred'`）、弹性位占用（`entity: 'buffer'`, `field: 'occupied'`）、通知开关（`entity: 'notif'`）、可用时段（`entity: 'avail'`）、预置开关（`entity: 'preset'`）、挽救结果（`entity: 'rescue'`）、数据恢复（`entity: 'data'`）。只写本机 overlay、不发 op 的是：新目标落地及其任务与周表重写（`flows/goal.js`）、排程结果回填、本地视图偏好；`flows/settings.js` 的清空操作会 `dropOverlay()`，避免重载复活已删数据。

## 7. 关键业务流

| 流程 | 路径 | 要点 |
| --- | --- | --- |
| 目标落地→可行性→拆解→排程 | `flows/goal.js` | 折扣 `DISCOUNT 0.85`；基准工时 `{ 考研 913, 考公 660, 项目导学 520 }` 小时；基础系数 `{ 零基础 1.30, 一轮 1.00, 二轮 0.75, 多战 0.60 }`；`R < 0.70` 阻断进入拆解；单计划项 `est` 限 15–240 分钟、步长 15；排程槽位为每天 18:00–22:00 每 30 分钟一格（8 格）加 22:00–23:00 两个 30 分钟弹性位；结果写 `tasks`/`week`/`weekShift`/`buffer` |
| 重排→逐条否决/撤销 | `assistant.js`、`flows/planedit.js` | 重排走 `ZX.engine.replan`；`verdict='blocked'` 即停止并转目标校准；`needsConfirmation` 需 `confirmReplan` 后才落库；否决 `veto` 中压缩项从快照取回原工时并清 `degraded`，顺延项清 `deferred`；撤销 `undoReplan` 反向应用快照 |
| 中断挽救 | `flows/rescue.js` | 由 `sessions` 算连续无记录天数，达 3 天（`THRESHOLD 3`）判定中断；剩余天数 = 7 减断更天数（下限 1）；三选一压缩（`COMPRESS_RATE 0.40`，下限 15 分钟）/顺延/降级，两屏完成（缺口与方式→确认摘要），确认前不写状态 |
| 执行记录→偏差归因 | `flows/exec.js` | 记录 `status` 取 `done`/`partial`/`skip`/`backfill`，感受词独立存 `feel`；完成度 100% 置 `done=true` 且 `actual=minutes`，不足 100% 则累加 `actual` 并按部分完成折算 `est`；记录后立即跑 `attributeNow`，命中结果计入 `attrCounts` |
| 归因→周报 | `views/data.js`、`flows/exec.js` | 周报与归因的数据源是本地执行记录真算，`attrCounts` 与 `replanHistory` 为卡片真实数据源 |

## 8. 非功能与运行时特征

| 项 | 现状 |
| --- | --- |
| 鉴权 | `Authorization: Bearer <token>`；凭证形态 `nj1.<payloadBase64url>.<sigBase64url>`，HMAC-SHA256 签名，密钥取 `NOVA_AUTH_SECRET`（至少 32 字节），有效期 7 天（`TOKEN_TTL_MS`）；身份只从凭证解析，请求体 `userId` 与凭证不一致返回 `E4030` |
| 限流 | 固定窗口、单进程内存，按「身份 + 路由」隔离，未认证路由按来源 IP 隔离。阈值：`POST /api/auth/session` 60/60 s（按 IP）、`POST /api/sync/ops` 60/60 s、`POST /api/replan` 与 `/replan/confirm` 与 `/replan/undo` 12/60 s、`POST /api/feasibility` 与 `/schedule` 与 `/attribute` 30/60 s；超限返回 429 与 `Retry-After`，不排队也不自动重试 |
| CORS | 放行本机来源（`127.0.0.1`/`localhost`/`null`）与同源（`Origin` 的 host 等于请求 `Host`），其余不放行；允许方法 `GET, POST, OPTIONS`，允许头 `Content-Type, Authorization`，`Max-Age 600`，带 `Vary: Origin` |
| 静态资源 | 白名单 `/`、`/index.html`、`/assets/*`、`/shared/*`；非 GET/HEAD 返回 405 |
| 请求体 | 上限 1 MiB（`MAX_BODY_BYTES = 1048576`），超限 `E4002`；JSON 非法 `E1001` |
| 前端降级 | 请求超时 3000 ms；引擎调用失败或结构不合约时回退本地产物（`ZX.engine.source` 记为 `local`）；收到 HTTP 响应即视为在线，仅网络失败或超时判离线；离线时顶栏同步位换为诺瓦的离线褪色头像，取自 `assets/js/mascot-inline.js` 的内联 data URI（不依赖网络），待上行数量以角标显示；输入台头像在用户输入时切聆听形象，同样取自内联副本 |
| 体积 | `assets/css/app.css` 100138 字节；`assets/js/rhythm.build.js` 48410 字节；`assets/js/mascot-inline.js` 3247 字节；仓内 `js`/`css`/`html`/`svg` 共 47 个文件、612967 字节 |
| 第三方资源 | 无第三方脚本、字体、CDN 与埋点；`../index.html` 不引用任何外部 URL，图标与插画均为仓内 SVG |

## 9. 附录

### 9.1 HTTP 接口清单

| 方法与路径 | 鉴权 | 入参 | 返回 |
| --- | --- | --- | --- |
| `GET /api/health` | 否 | 无 | `{ ok, version, uptimeMs }` |
| `POST /api/auth/session` | 否 | 空对象 | `{ token, userId, expiresAt }` |
| `GET /api/state` | 是 | 无 | `{ seed, replan, notifications }` |
| `POST /api/feasibility` | 是 | `weeklyH`/`weeks`/`discount`/`demand` | 可行性结果 |
| `POST /api/schedule` | 是 | `tasks`/`slots`/`params?` | `{ blocks, unplanned, version }` |
| `POST /api/replan` | 是 | `tasks`/`week`/`params?`/`history?`/`locks?`/`timestamp?` | 重排结果（`accepted=true` 才落库） |
| `POST /api/replan/confirm` | 是 | `result` | 确认后的重排结果 |
| `POST /api/replan/undo` | 是 | `snapshot` | `{ tasks, week }` |
| `POST /api/attribute` | 是 | 六个归因数值字段 | `{ type, confidence, actions, evidence }` |
| `POST /api/sync/ops` | 是 | `ops[]`（至多 200 条） | `{ accepted[], serverSeq }` |

已下线端点（返回 404 / `E2001`，见 `../test/api.test.js`）：`POST /api/sessions`、`GET /api/sync`、`GET /api/reports/weekly`。

### 9.2 错误码

| 码 | HTTP | 含义 |
| --- | --- | --- |
| `E1001` | 400 | 参数非法或缺失 |
| `E2001` | 404 | 资源不存在 |
| `E3001` | 409 | 状态冲突 |
| `E3002` | 409 | 资源已存在 |
| `E4001` | 200 | 幂等键重复，返回首次结果 |
| `E4002` | 400 | 请求体过大或单批超过 200 条 |
| `E4010` | 401 | 未提供或凭证无效 |
| `E4030` | 403 | 越权访问 |
| `E4290` | 429 | 请求过于频繁 |
| `E5001` | 500 | 服务内部错误 |
| `E9001` | 500 | 未分类异常 |

### 9.3 配置项（环境变量，样例见 `../.env.example`）

| 变量 | 作用 |
| --- | --- |
| `NOVA_AUTH_SECRET` | HMAC 签名密钥，至少 32 字节；`NODE_ENV=production` 未配置则拒绝启动 |
| `NODE_ENV` | 设为 `production` 时启用生产约束 |
| `PORT` | 监听端口，缺省 8787 |
| `HOST` | 监听地址，缺省 `0.0.0.0` |
| `NOVA_TRUST_PROXY` | 设为 `1` 时按 `X-Forwarded-For` 最后一跳隔离限流桶，默认按 TCP 对端地址 |

### 9.4 命令

`npm start` 构建引擎产物后启动服务（缺省 `http://0.0.0.0:8787`）；`npm run dev` 执行 `node --watch server/main.js`；`npm test` 构建产物后跑 `node --test "test/*.test.js"`；`npm run build:engine` 单独生成 `assets/js/rhythm.build.js`；`npm run audit` 执行 `scripts/css-audit.mjs`，做 CSS 括号平衡、token 引用完整性、硬编码色值与死类审计。

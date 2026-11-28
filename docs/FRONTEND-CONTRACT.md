# 诺瓦 Nova · 前端协作契约（FRONTEND CONTRACT）

> 本文件约束 `index.html` 与 `assets/**` 的前端实现约定，全部结论以仓库当前代码为准。

## 1. 文档定位与适用范围

- 本文件是前端实现约定：改 `assets/js/**`、`assets/css/app.css`、`index.html` 时必须满足第 2–9 章；代码与本文件不一致时，以代码为准并同步改本文件。
- 与其他文档的分工：`docs/HANDOFF.md` 定前后端接口与共享引擎契约（`server/**` ↔ `assets/**`），本文件不重复后端字段定义；`docs/IP-DESIGN.md` 定诺瓦形象设定与画法，本文件只写素材接入点；`docs/ARCHITECTURE.md` 描述整体架构。
- 硬前提：服务端零第三方运行时依赖；前端使用本地 vendored Three.js r152（包版本 `0.152.2`）与 CSS3DRenderer，不依赖 CDN，不是全栈零第三方。脚本为经典 script（非 ESM），业务模块主要挂载 `window.ZX`，GL 模块挂载 `window.ZX_GL*`，vendor 导出 `window.THREE` / `window.ZX_CSS3D`；必须能以 `file://` 双击打开。

## 2. 目录与模块职责

### 2.1 顶层文件

| 文件 | 职责 |
|---|---|
| `index.html` | 页面骨架：`#gl` WebGL 画布、`#css3d` 内容层、顶栏、对话区 `.copilot`、工作台 `.bench`、主导航语义源 `#rail`；首帧前读 `zx.ui_prefs` 写 `html[data-grid/glow/motion/font/gl3d]`（2026-11-28 起 `gl3d` 纳入偏好闸门，详见 §6）。当前五页均以 DOM 显示导航；GL 初始化状态不改变当前页面呈现 |
| `assets/js/util.js` | 通用工具与视觉偏好（`ZX.util`）：`esc` / `hm` / `num` / 日期时段 / `prefs`·`applyPrefs`·`savePrefs`·`togglePref`·`setPref` |
| `assets/js/ui.js` | 共享 UI 原语（`ZX.ui`）：`sheet` / `confirm` / `toast` / `fold` / `flowSheet` / `footNav` / `countTo` |
| `assets/js/api.js` | 健康检查、Bearer 凭证与计算接口；旧 op 队列只读隔离，不提供业务状态读写（`ZX.api`） |
| `assets/js/engine.js` | 计算桥接：可行性 / 排程 / 重排后端优先 → 同一本地产物兜底；确认与撤销只走本机纯函数（`ZX.engine`） |
| `assets/js/state.js` | 全局状态与派生计算（`ZX.state`）；种子来自 `shared/data/seed.js` |
| `assets/js/assistant.js` | 对话消息、意图路由与对话内流程（`ZX.assistant`）；重排域路由转发到 `flows/replan.js` |
| `assets/js/main.js` | 引导、事件委托、页签切换、启动序列（`ZX.render` / `ZX.setTab` / `ZX.renderRail`） |
| `assets/css/app.css` | 唯一样式来源；顶部 `:root` 块为视觉配置区 |
| `assets/js/rhythm.build.js` | 生成产物（`scripts/build-engine.js` → `shared/engine/*.js`），禁止手改 |
| `assets/img/*.svg` | 生成产物（`scripts/build-mascot-v4.js`），禁止手改 |
| `assets/js/mascot-inline.js` | 生成产物（`scripts/build-mascot-v4.js`），待机 / 聆听 / 离线三枚头像的 base64 data URI 内联副本，导出 `window.ZX_MASCOT.idleAvatar` / `listenAvatar` / `offlineAvatar`，禁止手改 |

### GL 与 vendor 目录

| 目录 / 文件 | 职责与导出 |
|---|---|
| `assets/vendor/three.min.js`、`three-css3d.js` | Three.js r152 与 CSS3DRenderer 本地经典 script，分别导出 `window.THREE` / `window.ZX_CSS3D`；由 `scripts/build-vendor-three.mjs` 从 `three@0.152.2` 包复制 / 转换，禁止手改 |
| `assets/js/gl/engine.js` | `window.ZX_GL`：双渲染器、相机、帧循环、拾取与初始化失败回退 |
| `assets/js/gl/background.js` | `window.ZX_GL_BG`：GL 背景与氛围 |
| `assets/js/gl/nav.js` | `window.ZX_GL_NAV`：3D 页签、拾取与导航联动 |
| `assets/js/gl/mascot3d.js` | `window.ZX_GL_MASCOT`：3D 诺瓦形象 |
| `assets/js/gl/stage.js` | `window.ZX_GL_STAGE`：CSS3D 内容层，将业务 DOM 克隆呈现并同步，克隆剔除 id，保留事件委托链路 |

`index.html` 当前顺序（以实际引用清单为准，改动前确认依赖）：

1. head 内联脚本先读取首帧偏好（`grid` / `glow` / `motion` / `font` / `gl3d`），随后加载 `assets/css/app.css`。
2. 共享层：`shared/data/seed.js` → `shared/placement-model.js` → `assets/js/rhythm.build.js`。
3. vendor：`assets/vendor/three.min.js` → `assets/vendor/three-css3d.js`。
4. GL 模块：`assets/js/gl/engine.js` → `background.js` → `nav.js` → `mascot3d.js` → `stage.js`（后四项同属 `assets/js/gl/`）。此时注册模块，实际初始化在 `main.js` 完成 DOM 启动之后。
5. 业务基础：`assets/js/mascot-inline.js` → `util.js` → `ui.js` → `api.js` → `engine.js` → `state.js`（后五项同属 `assets/js/`）。
6. 视图：`assets/js/views/today.js` → `plan.js` → `data.js` → `me.js`（同目录）。
7. 工作流：`shared/workflow.js` → `assets/js/assistant.js` → `assets/js/flows/replan.js` → `clarify.js` → `goal.js` → `rescue.js` → `exec.js` → `planedit.js` → `settings.js`（后六项同属 `assets/js/flows/`）。
8. 首页摘要：`assets/js/home-summary.js`。
9. 装配：`assets/js/main.js`；仅当 `data-gl3d="on"` 且 `window.ZX_GL` 存在时调用 GL 初始化。

### 2.2 流程模块 `assets/js/flows/`

| 模块 | 挂载点 | 职责 | 关键常量 |
|---|---|---|---|
| `replan.js` | `ZX.flows.replan` | 重排域：四级重排预览（后端优先 → 本地引擎）、本机草案生命周期（`shared/workflow.js`）、本机确认、快照撤销；留痕 `zx.replanTrace`；服务端 `draftId` 不参与业务确认；`replanFlow` / `confirmReplan` / `undoReplan` 由意图路由与 `data-act` 委托消费 | `REPLAN_RULES_VERSION` `nova-replan-p0-1`；24h 重跑去重窗口 |
| `clarify.js` | `ZX.flows.clarify` | LLM 多轮需求澄清与拆解建议；失败时降级到目标表单，排程仍由共享引擎完成；排程失败保留建议并提供 revision/planVersion 绑定重试 | 配置与边界见 `HANDOFF.md` |
| `goal.js` | `ZX.flows.goal` | 新建目标：设定 → 可行性 →（R<0.70 校准）→ 拆解草案 → 确认生效；生效后走 `ZX.engine.schedule` 排程 | `BASE_HOURS` 考研 913 / 考公 660 / 项目导学 520；`BASE_COEF` 零基础 1.30 / 一轮 1.00 / 二轮 0.75 / 多战 0.60；`DISCOUNT` 0.85；`GATE` 0.70；`TARGET_R` 0.90；`MIN_EST` 15；`MAX_EST` 240；`STEP` 15；`OVER_RATIO` 1.15；`AMP_LIMIT` 0.30 |
| `rescue.js` | `ZX.flows.rescue` | 真实连续无记录天数识别、中断横幅、三步挽救（压缩 / 顺延 / 降级）与独立只读演示预览 | `THRESHOLD` 3 天；`DEMO_ZERO_DAYS` 4；`COMPRESS_RATE` 0.40；`MIN_EST` 15；`DEFER_DAYS` 7；`DOWN_POINTS` 30 |
| `exec.js` | `ZX.flows.exec` | 执行记录：暂停 / 继续、部分完成、跳过与恢复、补录；`metrics()` 是全站 KPI 唯一口径 | `PCTS` 25 / 50 / 75 / 100；`FEELS` 顺利 / 吃力 / 分心 / 疲惫；`REASONS` 临时有事 / 状态不好 / 任务过难 / 其他；`MIN_EST` 15 |
| `planedit.js` | `ZX.flows.planedit` | 计划页日程块：v3 按具体日期/分段拖拽、普通/弹性容量校验、锁定与逐条否决；legacy 保留 `dayAssign` 星期模式 | v3 使用 `placementModel.days`；legacy 使用 `DAYS`/`ORIGIN` 与 `dailyCapMin` |
| `settings.js` | `ZX.flows.settings` | 可用时段 7×4 网格、批量操作、CSV 导出、`nova-backup` v1 完整 JSON 导出 / 校验导入、覆盖前 7 天 trash、删除全部数据（7 天可恢复）、字号 | `SLOTS` 08–12 / 12–18 / 18–22 / 22–24；`SLOT_H` 4 / 6 / 4 / 0；`TTL` 7 天；备份不含 token / 旧队列 |

### 2.3 视图模块 `assets/js/views/`

每个视图导出 `ZX.views.<id>()` 并返回 HTML 字符串；事件一律走 `data-act` 委托，不写内联 `onclick`。

| 模块 | 挂载点 | 职责 |
|---|---|---|
| `today.js` | `ZX.views.today` | 今日页：KPI、07:00–23:00 时间带、任务表、弹性位、已记录 / 已跳过折叠区；「今日暂缓（未改期）」独立展示并可恢复 |
| `plan.js` | `ZX.views.plan` | 计划页：可行性 R 与刻度、学期节律带、未来 7 天负载周图、本周日程块；暂缓项独立展示并可恢复，不占普通日程块 |
| `data.js` | `ZX.views.data` | 数据页：本周概览、三段式周报（结论 / 依据 / 已执行）、趋势、科目结构与偏差归因 |
| `me.js` | `ZX.views.me` | 我的页：可用时段、通知策略、数据与隐私（导出 / 删除）、显示与动效 |

### 2.4 前端调用面（`assets/js/api.js`）

浏览器本地 overlay 是唯一业务主数据。前端只经 `assets/js/api.js` 访问后端，全部为 JSON；当前调用面如下：

| 方法 | 路径 | 前端用途 |
|---|---|---|
| GET | `/api/health` | 健康 / 计算可达性探测（免鉴权）；启动与 `online` 事件只调它 |
| POST | `/api/auth/session` | 计算请求按需签发 Bearer 凭证（免鉴权）；健康探测不签发 |
| POST | `/api/feasibility` | 可行性计算；失败走本地产物 |
| POST | `/api/schedule` | 排程计算；失败走本地产物 |
| POST | `/api/replan` | 四级重排预览计算；失败走本地产物，不创建业务草案 |
| POST | `/api/llm/clarify` | 多轮需求澄清，输出归一画像 |
| POST | `/api/llm/analyze` | 画像分析与任务拆解建议，不产出排程块 |

`/api/attribute` 仅由服务端保留，前端不调用；归因走本机 `ZX.engine.attributeNow` → `Rhythm.attribute`。以下旧业务接口与数据**仅服务端保留，前端不使用**：`GET /api/state`、`POST /api/plan/review`、`POST /api/replan/confirm`、`POST /api/replan/undo`、`POST /api/sync/ops`。前端不得恢复 `getState` / `adopt` / `flush` / `stagePlan` / 服务端 review / confirm / undo / syncOps 调用；重排确认和撤销均在本机完成，服务端 `draftId` 不参与业务确认。字段级历史契约见 `docs/HANDOFF.md` 第 5 节。

## 3. 状态模型

### 3.1 全局状态 `ZX.state`

- 种子与归一：`state.js` 从 `window.Rhythm.seed` 取 `shared/data/seed.js`；种子缺失直接抛错（装配错误不静默替换）。契约字段 `subject` 与视图字段 `s` 由 `normTask()` 双向保留。
- 计时四元组：`running` / `timerStart` / `pausedAt` / `pausedTotal`，由 `state.resetTimer()` 复位。
- 视图开关：`tab`、`folds`、`skippedOpen`、`tiredAdopted`、`movedOut`、`exportLog`。
- 重排相关：`replanned`、`snapshot`、`replanRecord`、`replanHistory`；待确认草案 ID 由 `replan.js` 模块内维护，不持久化，也不是服务端 `draftId`。`replanInput().params` 为 `loadGrowthCap` 0.20、`compressFloor` 0.60、`compressedShareCap` 0.30、`consecutiveNoImproveCap` 3、`bufferRatio` 0.15。
- 中断相关：`consecutiveZeroDays`、`interrupted`、`rescueRecord`。
- 计划项交互：v3 权威落点为 `placementModel.placements[].originalSegments/currentSegments`，`dayAssign` 仅为兼容投影；legacy 保留稀疏 `dayAssign`（缺省「日」）与 `locks`。
- 临时草稿：`goalDraft` / `planDraft`，打开时初始化、关闭时置 `null`。
- KPI 口径：计划 / 已投入 / 剩余 / 达成率 / 补录一律取 `ZX.flows.exec.metrics()`；过滤 `skipped` 与 `deferred`，未完成项排除 `abandoned` / `substituted`，视图与对话页共用同一口径。

### 3.2 本机持久化键（localStorage）

| 键 | 所在 | 内容 | 写入 / 读取时机 |
|---|---|---|---|
| `zx.overlay` | `state.js` | 唯一业务主数据。元数据固定 `format='nova-overlay'`、`version=3`、`syncMode='local-only'`、`installId`、`revision`、`updatedAt`（兼容保留 `at`）；业务白名单为 `planVersion`、`tasks`、`sessions`、`goal`、`feas`、`week`、`weekShift`、`placementModel`、`dayAssign`、`locks`、`avail`、`availSource`、`notif`、`attrCounts`、`consecutiveZeroDays`、`interrupted`、`rescueRecord`、`replanHistory`、`replanSnapshot`；legacy 另可选保存 `buffer` 与 `tiredAdopted`，v3 不保存这两个双重真值 | `ZX.render()` 末尾统一 `saveOverlay()`；关键流程使用 `ZX.state.transact()` 做快照、保存校验与安全回滚；启动 `applyOverlay()` 恢复；删除全部数据时 `dropOverlay()`；显式备份导入时 `commitSnapshot()` |
| `zx.install_id` | `state.js` | 本机安装标识 `install-<hex>` | 首次生成后保留；写 overlay 时带入，不表示云端账户 |
| `zx.folds` | `ui.js` | 折叠区展开态（只保留值为 `true` 的键） | 点击 `data-act="fold"` 切换后 `ZX.ui.saveFolds()` |
| `zx.op_queue` | `api.js` / `settings.js` | 旧 op 原始字节，只读隔离 | 正常启动、渲染、计算、恢复、备份导入与删除本机业务数据均不改写；`queueOp()` 为空操作，`pendingCount()` 恒为 0；`legacyPendingCount()` 只统计旧 `pending`，界面显示「N 项已隔离」；`flushQueue()` 不发请求 |
| `zx.auth_token` | `api.js` | `{ token, userId, expiresAt }`，仅用于服务端计算鉴权 | `POST /api/auth/session` 成功后写入；本地按 `expiresAt` 预判失效；不进入备份 |
| `zx.pending_plan` | `api.js` | 旧待复核计划原样保留 | 只提供读取入口；不自动复核、不上送、不影响本机计划；删除本机业务数据时仍保留隔离 |
| `zx.server_plan_version` | 历史遗留 | 旧服务端计划版本记录 | 当前前端不读取、不写入；不得作为本机计划真值 |
| `zx.ui_prefs` | `util.js` / `index.html` | util 与首帧脚本处理 `{ grid, glow, motion, gl3d, font }` | 「我的 → 显示与动效」保存这些项；`gl3d` 为 3D 舞台偏好开关（2026-11-28 加入），运行期 WebGL 异常降级仍由引擎写入 `data-gl3d="off"`，见 §6 |
| `zx.trash` | `settings.js` | 删除全部数据或备份导入覆盖前的业务快照 `{ at, snapshot }`；snapshot 含 `planVersion` | 覆盖 / 删除前写入；保留 7 天，到期清除；可显式恢复；保存或回读失败时业务字段与计划版本均回滚；不含 token / 旧队列 |
| `zx.flash` | `settings.js` | 一次性提示文案 | 删除后写入，重载时由 `settings.init()` 消费并 toast |

加载保护：JSON 损坏、格式 / 版本不受支持、v3 元数据缺失或业务结构损坏，以及 `version > 3` 的未来版本，都会保留 `zx.overlay` 原键并置 `localLoadFailed`，暂停后续覆盖；只有显式导入通过校验的完整备份或确认删除全部数据才解除熔断。保存失败置 `overlaySaveFailed` 并提示刷新可能丢失。`replanSnapshot` 须含 `tasks` 数组，否则 `replanned` 回落为 `false`。

跨标签页保护：每个页面保存 `lastOverlayRaw` 与已持久化业务快照基线；写前重读 `zx.overlay`，发现业务内容变化、外部删除或非法元数据时拒绝覆盖并置粘滞 `overlayConflict`。`storage` 事件在发现本页有未保存修改时同样锁定冲突；仅元数据变化且业务相同时可接受新 revision。冲突页暂停保存、删除、重排确认和撤销，提示先导出本页备份再刷新；显式重载后按当前存储恢复。导入失败回滚比较当前 raw 与旧值/本次已验证或尝试写入值，另一页的新写入或删除不被旧快照覆盖；意外当前 raw 保留并熔断。支持 Web Locks 时导入/删除/恢复事务以 `nova-local-overlay` 串行化，不支持时使用 fail-closed 顺序检查。不可读 overlay 的强制替换只允许当前 raw 仍等于本次加载的不可读 raw。显式删除先预检并恢复失败时的本次 trash 写入，损坏/未来版本可显式删除；删除已执行但回读异常时保留 trash。trash 清理与恢复成功后只删除本次读到的 raw。未来版本修复保留可读 revision 并递增。该保护不是 localStorage 原子 CAS，不承诺多标签页同时读写的线性一致性，也不替代旧写入者隔离。

刷新后保留：有效 overlay 的全部业务字段与元数据、`zx.install_id`、`zx.folds`、`zx.ui_prefs`、只读旧队列 / 旧待复核计划 / 历史版本键、计算凭证，以及 7 天内的 `zx.trash`。刷新后不保留：计时四元组、`replanRecord`、模块内待确认草案 ID、`goalDraft` / `planDraft`、当前页签；`consecutiveZeroDays` / `interrupted` / `rescueRecord` 纳入 overlay/备份，当日已挽救状态不会被旧 sessions 再次判为中断。

启动只应用本机 overlay；`main.js` 的 `probeBackend()` 仅请求 `/api/health`，`online` 事件同样只探测健康状态，不拉取、接收、重放或提交任何服务端业务状态。

### 3.3 M1 统一落点、M3 改期与备份契约

- `shared/placement-model.js` 提供 v3 纯函数模型：`createModel/normalizeModel/summary/projectWeek/taskSegments/replanWeek/applyReplan/moveTask/resizeTask/releaseTask/restoreTask`。模型含 `startDate`、IANA `timezone`、连续 7 天 `days`、稳定 `placementId/blockId/taskId`、原始/当前 segment、普通容量、弹性容量和 `unplanned`。segment 为 `{blockId,taskId,date,startMin,durMin,isBuffer}`。
- 新建目标持久化全部任务，不只保存今日片段；模型窗口跨日后按原日期索引滚动到今天，`originalSegments` 保留历史证据，currentSegments 不得落在过去；`week/weekShift` 从 currentSegments 重算，`total` 只含实际任务分钟，不含未使用弹性容量。普通/弹性已用与容量分列，跨日任务按日分段显示。
- v3 重排输入先释放未完成、未跳过、未暂缓、未放弃、未替代且未锁定的 currentSegments，再装载；锁定与非待办占用保留。允许使用弹性容量但记录 `isBuffer` 和实际用量。零基线 `loadDelta=null`，界面显示“增幅不适用”，只由容量守卫决定。
- 真实改期写入具体日期和完整区块；容量或重叠不足整笔拒绝。完成清空 currentSegments 但保留 originalSegments 与 `completedAt`；跳过释放落点但保留当日 actual，恢复时按原始终段重排，冲突则拒绝。
- `deferred` 是「今日暂缓」，不是真实改期：按 `deferredAt` 的本地日期失效，跨日自动清除；不改变计划日期，退出今日任务表 / 时间带、计划普通块、中断挽救与重排候选；今日页和计划页均展示独立的「今日暂缓（未改期）」列表，可逐项恢复。旧 `deferredTo` 只作兼容提示。
- 已跳过任务不通过旧「记录 / 完成」按钮直接改写为完成；`openRecord`、`finishTask` 与 `commitRecord` 均拒绝 `skipped`。「开始」仍是显式恢复入口，清除跳过原因后开始计时，不把其他退役状态一并复活。
- 重排快照保存确认前后任务、落点、锁和模型。撤销前若当前任务、`dayAssign`、`locks` 或 `placementModel` 已有任何后续独立修改，或旧快照缺少冲突信息，整笔拒绝，不恢复、不标记 `undone`、不发送逆向操作。
- 「我的」CSV 是计划与记录导出，不等于完整备份。任务行状态覆盖已完成、部分完成、已跳过、今日暂缓、已放弃、已替代、未排入与未开始；任务日期只取合法明确计划日期，无日期或未排入留空，记录行取 `startAt`，目标行取截止日。完整 JSON 为 `format='nova-backup'`、`version=1`，含 `createdAt`、`installId` 与 `snapshot`；snapshot 使用 §3.2 的业务白名单并严格校验 `placementModel`，不含 token、`zx.op_queue` 或旧待复核计划；旧备份缺模型字段时按 legacy 兼容。
- 导入顺序：解析并校验格式 / 版本 / 时间 / 安装标识 / snapshot 结构 / 安全 ID / 文本长度 / 标签与控制字符 / 凭据队列禁用字段 → 用户确认 → 保存旧 trash 原值并写覆盖前快照 → 写入 overlay 并回读校验 → 失败同时回滚 overlay 与 trash；回滚也失败时明确告警并保留页面。成功导入后真实重载校验并复位计时四元组。备份导入不触发服务端复核或同步。

### 3.4 R8 统计与 R9 演示隔离

- `exec.metrics()` 的率均为 `0..1`：`taskRate=完成任务数/今日任务数`，`plannedRate=（完成项原计划工时+部分项原计划工时×完成度）/原计划工时`；`worked` 为今日任务 actual，`remain` 为未完成且未退役任务 est，`backfill` 单列；部分完成按累计完成度从原计划工时计算剩余。旧部分任务无原始分母时 `plannedBasis='unknown'`、`plannedRate=null`，UI 显示“未知”。
- v3 弹性位不提供旧布尔占用开关，用量由任务 segment 自动记账；真实挽救不注入演示天数；对话「演示挽救」走 `assistant.demoRescueFlow()` / `rescue.preview(days)`，只读计算局部示例，不调用真实 `detect/open/apply`，不写目标、任务、周期、断更或落点。

## 4. 共享 UI 原语

弹层 / 确认 / 轻提示只用 `ZX.ui`，不另造弹窗。

- `ZX.ui.sheet({ eyebrow, title, sub, body, footer, wide, onClose })` → `{ root, $, close(result), setBody(html), setFooter(html) }`。结构 `.ovl > .ovl-bg + .sheet(.sheet-h / .sheet-b / .sheet-f)`；ESC 关闭、`Tab` 在弹层内循环、开窗时 `html.no-scroll` 锁滚动；`wide` 切 840px 宽。
- `ZX.ui.confirm({ eyebrow, title, text, body, okText, danger })` → `Promise<boolean>`；取消或关闭 resolve `false`，`danger` 时主按钮取 `.btn.danger`。
- `ZX.ui.toast(text, kind)`：`kind` 取 `''` / `'ok'` / `'warn'` / `'bad'`；`role="status"` 供读屏播报；多条同现按 46px 向上错开；对话页存在 `.cp-foot` 时抬高到输入台上沿（`offsetHeight + 24`），避免落进输入台；2.2s 后进入 `.out`，2.6s 移除。
- 层级：`.ovl` z-index 60 → `.toast` 80 → `.skip-link` 90；toast 始终浮在弹层之上。
- 多步弹层：`ZX.ui.flowSheet({ ns, step, steps, beforeRender, bind, onClose })`，`ns` 为焦点记忆用的委托属性名（goal `'sa'`、rescue `'sb'`、exec `'sc'`）；配套 `setHead` / `recallFocus` / `restoreFocus` / `footNav`。
- 折叠区：`ZX.ui.fold(key, { title, meta, body })`，key 形如 `today:done`、`data:trend`、`me:data`、`me:display`；默认收起，展开态存 `zx.folds`。
- 数字滚动：`ZX.ui.countTo(el, to, fmt, dur)`；动效关闭或首次调用时同步落值，不做无意义动画。

## 5. 样式规范

- 唯一样式来源是 `assets/css/app.css`；顶部 `:root` 块是视觉配置区，主题色与 token 都在其中定义，`:root` 之外不得出现硬编码十六进制色（`mask` 的 `#000` 除外）。
- 当前视觉语言为 Claymorphism（黏土）：以 `app.css` 的有效 token 与组件规则为准，旧奶油纸 / 天空蓝 / 墨线无阴影的注释不再是现行规范。薰衣草纸 `--bg: #EFE9F7`、白面板 `--panel: #FFFFFF`、浅纸 `--panel2: #F7F4FC`；文本为墨紫 / 灰紫 `--txt: #4A4463`、`--txt2: #655E86`、`--txt3: #736D92`；主行动色为深薄荷 `--ac: #178265`、`--ac-deep: #126B52`。`--line` / `--line2` 为低透明度薰衣草功能分隔，不再承担结构墨框。
- 粉彩辅助色由 `--lav` / `--mint` / `--peach` 提供；`--pink` 与 `--cinnabar` 虽沿用旧名，当前值均为蜜桃 `#E8955B`，不应再按樱花粉 / 朱砂解释。语义色 `--warn: #A9713A`、`--bad: #C25B4E`、`--ok: #1E8F6C`；科目色沿用 `--m-*`；划重点 `--hlbg: #EFE7FF`。正文 `--fs-body: 15px`、`--lh-body: 1.62`；通用圆角 `--r: 14px`、大圆角 `--r-lg: 26px`，面板按组件采用大圆角；动效仍用 `--ease` 与 `--dur*` token。
- DOM 背景由薰衣草 / 薄荷静态光斑与纸底组成；`body::before` 为细点纹（`--grid-size: 26px`，`opacity: var(--grid-opacity)`），`body::after` 为软纤维（`opacity: calc(.8 * var(--glow-opacity))`）。`data-grid="off"` / `data-glow="off"` 分别将对应透明度归零；GL 背景另由 `gl/background.js` 绘制，不能仅检查 DOM 伪元素便认定 GL 视觉已验收。
- 高度靠明度差与轻阴影表达：卡片 `--shadow-card` 是外部彩色投影 + 内暗 + 内亮三层（基础值为 `4px 6px 18px rgba(143,130,217,.12)`、`inset -3px -3px 10px rgba(143,130,217,.06)`、`inset 3px 3px 10px rgba(255,255,255,.85)`）；浮出物 `--shadow-pop` 是两层更深的外投影、无 inset，不能设为 `none`。断点覆盖以 CSS 为准。GL 主格 `.gl-frame` 使用纸底 `--bg`，气泡 / 内容卡用白色 `--panel` 浮出，不再框套框。
- 当前五个页签均展示真实 DOM：对话页与四个工作台页隐藏 `#gl` / `#css3d`，使用相同左侧导航和浅色画布；桌面工作台有按页切换的提示侧栏，小屏改为纵向堆叠。GL 模块仍可初始化，但隐藏画布不参与指针拾取、不调度 rAF、不克隆 DOM；重新显示时恢复渲染并同步当前页。弹层 60 → toast 80 → 跳转链接 90。
- 断点：`@media (max-width:860px)` 为主移动断点（另有 1080px、640px、360px）。≤860px 时顶栏改两行网格：第一行品牌与计算连接位，`.tnav`（唯一主导航 `#rail`）占满第二行（`grid-row:2`、`grid-column:1/-1`，高度 `--nav-row`）；`.bench-head` 隐藏；任务表隐藏 `.tt-head` 与 `.c-idx` / `.c-time` / `.c-est` / `.c-wt`，数值改由 `.tt-m` 元行承载。
- 科目色不写死在 CSS：由 `state.js` 的 `SUBJ` 与 `shared/data/seed.js` 的 `subjectColors` 注入行内 `--c` 变量。
- 新样式追加到 `app.css` 末尾对应区块，不重排既有规则；新增类名沿用现有前缀族（`.sa-` 目标、`.sb-` 挽救、`.sc-` 执行、`.sc2-` 计划交互、`.sd-` 设置）。
- PC（>860px）视图标题与统计使用两列网格，长说明独占一行；主任务标题不低于 15px，次级说明不低于 12px。浏览器验收 `PC-VISUAL` 覆盖 1440/1366/1024/1920 四种桌面宽度、五页标题单行、内容宽度、字号、章节间距、控件触达与横向溢出；超宽屏正文列居中并限制阅读宽度。

## 6. 动效与视觉偏好闸门

- 唯一总闸是 `html[data-motion="off"]`：`animation-duration` 与 `transition-duration` 归 0，`body::before` 取消动画，`.cp-body` 取消平滑滚动。所有动效必须能被它关掉。
- 裁决顺序：显式用户选择优先于系统 `prefers-reduced-motion`。只有 `zx.ui_prefs.motion` 缺省（从未选择过）时才跟随系统 reduce；一旦用户显式置 `true`，即使系统开启「减少动态效果」也照常播放。
- 落点三处：`assets/js/util.js` 的 `prefs()` / `applyPrefs()`、`index.html` 首帧内联脚本（避免主题闪烁）、`assets/css/app.css` 的 `html[data-motion="off"]` 段。
- 可配置项（均存 `zx.ui_prefs`）：`grid` 细点底纹、`glow` 纸面纹理、`motion` 界面动效、`font` 字号 `''` / `'m'` / `'l'`（映射 `html[data-font]` 与 `--fs-body` 15px / 16px / 17px）、`gl3d` 3D 舞台。布尔项白名单 `PREF_KEYS` 为 `['grid','glow','motion','gl3d']`（2026-11-28 起），`font` 走 `setPref()` 单值路径。
- 首帧 GL 闸门：`index.html` 首帧脚本按 `zx.ui_prefs.gl3d` 写 `html[data-gl3d]`（缺省/非 `false` 一律 `on`）；`main.js` 在 DOM 启动后仅于 `on` 时尝试 `ZX_GL.init()`；隐藏舞台不分配 renderer，待 resize 或属性/可见性变化后懒初始化。「我的」开关切换经 `applyPrefs()` 写 `data-gl3d`，GL 引擎的 MutationObserver 监听该属性：`off` 暂停渲染循环，重新 `on` 且未初始化过则懒初始化；引擎自身渲染失败置 `failed` 后不再随开关重试（写 `data-gl3d="off"` 并加 `.gl-off`，回退 DOM）。GL 引擎 / CSS 注释与运行时闸门统一使用 **`data-gl3d`**；首帧偏好脚本的读取异常不影响该闸门（保持静态 `on` 初始标记语义）。
- `zx.ui_prefs` 含 `util.js` 白名单中的 `grid` / `glow` / `motion` / `gl3d` 与单值 `font`；`gl3d` 缺省 `true`，与静态初始标记一致，老用户存储无该字段时行为不变。当前五页均为 DOM-first，`#gl`/`#css3d` 隐藏，GL 模块保留但正常产品路径不呈现可见舞台；S1 验收的是隐藏时暂停与异常降级，不将其表述为可见 GL/CSS3D 视觉验收。

## 7. 文案与语气

- 人格「诺瓦」：第二人称、克制、不催促；设定见 `docs/IP-DESIGN.md`，本节只列实现约束。
- 助理消息右下角带「诺」印落款（`.seal-no`），颜色以当前 CSS 为准（`--cinnabar` 已映射为蜜桃），形象设定仍留待 `IP-DESIGN.md` 人审；消息 meta 固定为说话人标签（诺瓦 / 你）+ 时间戳（`ZX.util.nowStr()`）+ 领域标记。
- 兜底诚实：关键词未命中走 `ZX.assistant.fallback()`，配 `mascot-v4-unknown.svg`，明说「这句话我还没接住」并列出可用意图，不臆造能力。
- 数值必须来自 `ZX.state` 或引擎返回值，不得写死与状态矛盾的演示数字；引擎结果未就位前不渲染结论。
- 禁止恐吓式表达（如「仅剩 X 天」「你已落后 X%」），也不得承诺未实现的能力。

## 8. 形象接入

已接入的形象素材与产品场景映射（引用点均在前端代码内；②⑧ 两态只接头像形态，未接入的全身立绘见 `docs/IP-DESIGN.md` §4）：

| 素材 | 场景 | 引用点 |
|---|---|---|
| `mascot-v4.svg` | 待机 / 欢迎语主立绘（132×116） | `assets/js/main.js` `greetingHtml()` |
| `mascot-v4-calc.svg` | 计算中（对话「处理中」，24×21） | `assets/js/assistant.js` `typing()` |
| `mascot-v4-focus.svg` | 专注态（计时中的任务行，24×30） | `assets/js/views/today.js` |
| `mascot-v4-done.svg` | 达成（任务完成消息、挽救完成横幅，32×28） | `assets/js/flows/exec.js`、`assets/js/flows/rescue.js` |
| `mascot-v4-rescue.svg` | 挽救（今日页中断横幅，32×28） | `assets/js/flows/rescue.js` `banner()` |
| `mascot-v4-warn.svg` | 提醒（数据页偏差归因、计划页负载预警，22×19） | `assets/js/views/data.js`、`assets/js/views/plan.js` |
| `mascot-v4-unknown.svg` | 兜底（关键词未命中，32×28） | `assets/js/assistant.js` `fallback()` |
| `avatar-v4.svg` | 输入台聆听/待机头像（24×24）与 JS 回退路径 | `index.html` `#cpListen`、`assets/js/main.js` `avatarSrc()` |
| `avatar-v4-sprite.svg` | 顶栏品牌位 `.seal`（26×26，8 帧横排 768×96） | `assets/css/app.css`：静态显示第 1 帧；`ZX` 发送管线加 `.play` 触发 `steps(7)` 逐帧动画（耳朵扇动 + 轻微上浮，0.7s 一轮，750ms 定时清理）；`html[data-motion="off"]` 下停格第 1 帧 |
| `avatar-v4-offline.svg` | 顶栏离线指示（24×24，褪色涂装） | `assets/js/main.js` `updateSync()`，经 `assets/js/mascot-inline.js` 的内联副本加载 |
| `avatar-v4-listen.svg` | 输入台聆听指示（24×24，用户输入时） | `assets/js/main.js` `updateListen()`，经 `assets/js/mascot-inline.js` 的内联副本加载 |
| `favicon-v4.svg` | 站点图标（16px） | `index.html` |

- 素材由 `scripts/build-mascot-v4.js` 生成到 `assets/img/`，禁止手改；改形象改脚本后重跑 `node scripts/build-mascot-v4.js`。生成器另有全身立绘 `mascot-v4-listen.svg`、`mascot-v4-offline.svg` 与原味涂装 `mascot-v4-classic.svg`，这三张当前未被产品代码引用：②⑧ 两态只接头像形态，classic 按 §3.3 不进产品 UI。
- 头像另有内联副本 `assets/js/mascot-inline.js`（同一脚本生成，含待机 / 聆听 / 离线三枚）：静态资源以 `Cache-Control: no-cache` 提供，后端不可达时重新加载必然失败，而离线指示与聆听切换恰好在这种时刻发生，故改用不依赖网络的内联 data URI；`main.js` 优先取 `window.ZX_MASCOT.*Avatar`，缺失时回退 `assets/img/` 下的静态路径。
- 上表为 DOM / SVG 素材接入点：SVG 内部不做动画，动效加在产品侧元素上。GL 模式另有 `assets/js/gl/mascot3d.js` 构建的 3D 形象，并由 CSS 控制 DOM 立绘显隐，不能再概括为「形象只作为 img 出现」；不在本次契约修订中改写 `IP-DESIGN.md` 的形象设定。

## 9. 验证协议

每个前端改动必须跑完以下检查。测试持续新增：测试文件清单用 `HANDOFF.md` §1 的命令实时查看，测试总数与通过 / 失败 / 跳过情况以本次 `npm test` 输出为准，不保留固定数量快照。Node VM 单测只验证模拟环境中的逻辑，**不替代真实浏览器验收**；`.tools/browser-acceptance.py` 在随机端口、合成存储和无持久化 Chromium 中验证当前 DOM-first 产品路径、隐藏 GL 暂停、异常降级、交互与有限语义场景。`optional-a7` 另建强制可见夹具，覆盖 100/500 任务批量分段与 200 条长对话增量克隆，不把隐藏舞台通过当作可见视觉验收。下表是验收要求，不代表本文已执行或已通过。

| 检查 | 命令 | 判定标准 |
|---|---|---|
| 语法 | `node --check assets/js/<改动文件>.js` | 退出码 0 |
| 单测与冒烟 | `npm test` | 退出码 0、失败数为 0，覆盖与数量按实时输出记录；`pretest` 先跑 `build:engine` |
| 形象门禁 | `npm test`（`test/mascot.test.js`） | 当前测试声明的素材齐全（含品牌位 sprite）；内联副本与源素材逐字节一致；生成器幂等——在临时目录运行 `build-mascot-v4.js`，将产物与工作区逐字节比对；失败也不写工作区 |
| 引擎产物同步 | `npm run build:engine` 后确认 `assets/js/rhythm.build.js` 无差异 | 改过 `shared/engine/*.js` 必须重跑；产物与源码字节一致 |
| CSS 审计 | `npm run audit` | 退出码 0；仅 warn（死 token / 死类候选）可过，存在 error 必须先修 |
| 服务冒烟 | `npm start`（默认监听 `127.0.0.1:8787`，浏览器访问 `http://127.0.0.1:8787`） | `GET /api/health` 返回 200 且含 `"ok":true`；首页返回 200 |
| 资源引用 | 见下方扫描命令；浏览器另查 Network | 本地 `src` / `href` 文件全部存在（包含 vendor 与 GL），数量取扫描实时输出；HTTP 加载无 404，不能以存在性扫描替代实际执行验证 |
| DOM-first / GL 降级 | 五页确认 `#gl`/`#css3d` 隐藏且无应用 rAF/clone；`optional-a7` 强制可见并检查 WebGL 不可用、CSS3D 异常、上下文丢失、DOM 回退与增量克隆；`optional-a10` 在 `file://` 下强制可见并覆盖 SVG→Canvas→WebGL 纹理路径 | 正常产品路径不得把隐藏舞台通过称为可见 GL 验收；强制可见夹具需单独记录，不替代真实设备/驱动测试 |
| 离线链路 | 双击 `index.html` 以 `file://` 打开；`optional-a8` 真实开始/结束任务、导出备份、导入并刷新 | 顶栏显示离线褪色形象，`alt` / `title` 为「离线 · 本地可用」；排程 / 记录 / 本机确认 / 撤销 / CSV 与 JSON 备份可用，执行记录与导入结果刷新后保留；不把 CORS 失败伪装成业务失败 |
| 本地模式在线提示 | 启动服务后刷新；仅允许 `/api/health` 成功 | 无旧 pending 时顶栏为圆点 +「本地主数据 · 服务端仅计算」；Network 中启动和 `online` 事件无 `/api/state`、`/api/sync/ops`、`/api/plan/review`、`/api/replan/confirm`、`/api/replan/undo` 请求 |
| 离线指示与旧队列 | 停服后刷新；预置含旧 pending 的 `zx.op_queue` | 顶栏出现 `.sync-offline` 头像且不破图，基础文案为「离线 · 本地可用」；离线顶栏附「旧队列已隔离 N」，「我的」页显示「N 项已隔离」，`.sync-pending` 不显示待处理数字；恢复服务后顶栏显示「本地主数据 · 旧队列已隔离 N」，只更新计算可达状态 |
| 本机确认 / 撤销 / 否决 | 生成重排并确认，在确认卡点击压缩/顺延否决，再撤销；分别断网与联网执行 | 业务结果一致，确认/否决/撤销只修改本机 overlay；否决按钮绑定 draft/planVersion，旧卡拒绝；不请求服务端 confirm / undo，不使用服务端 `draftId` 判定生效 |
| 同时写边界 | `optional-a8` 两页在同一基线修改后经 BroadcastChannel 同时调用 `saveOverlay()` | 记录两页返回值、最终标题与冲突状态；当前可能两页均返回 true 并发生后写覆盖，属于 A1 未解决边界，不得把该场景表述为原子 CAS 通过 |
| M3 暂缓 | 将任务标记为 `deferred`，在今日 / 计划页检查并恢复 | 任务退出今日待办 / 时间带、计划普通块、挽救与重排候选；两页独立列表均可见「今日暂缓（未改期）」和「恢复」；计划日期不变，旧 `deferredTo` 不视为改期 |
| overlay 加载保护 | 分别预置损坏 JSON、无效 v3、`version>3`、损坏落点模型，刷新后检查原键 | 原 `zx.overlay` 字节不变，显示「本地数据加载失败 · 已暂停覆盖」；启动渲染不覆盖；显式导入有效备份或确认删除后才恢复写入 |
| 旧数据隔离 | 记录 `zx.op_queue` / `zx.pending_plan` 原始字节，执行启动、渲染、排程、重排、备份导入 | 两键原字节不变；无 op 上行或计划自动复核；`pendingCount=0`，`legacyPendingCount` 仅统计旧 pending；界面显示「N 项已隔离」 |
| 完整备份往返 | 导出 JSON，修改业务数据后导入；另注入非法格式 / 版本 / 结构 / 凭据队列字段 | 导出为 `nova-backup` v1 且不含 token / 旧队列；非法导入在覆盖前失败且原数据不变；有效导入前保存 7 天 trash，写入回读一致，失败按协议回滚；回滚失败有明确告警，恢复后业务快照一致 |
| 聆听态 | 在输入框输入文字，再清空、再发送 | 输入台 `.cp-listen` 头像换为聆听形象（`alt` 为「诺瓦正在聆听」）；清空或发送后回待机；停服时同样可显示 |
| 降级与动效 | 停服后重复关键操作；`html[data-motion="off"]` 下复看 | 计算走本地引擎，业务主数据仍写本机；关动效后不破版——聆听态的呼吸动画随之停止，形象切换不变 |

`index.html` 资源引用全量扫描（在仓库根目录执行）：

```bash
node -e 'const fs=require("fs");const h=fs.readFileSync("index.html","utf8");const re=/(?:src|href)=[\x22\x27]([^\x22\x27]+)[\x22\x27]/g;let m,bad=[],refs=[];while((m=re.exec(h))){const p=m[1];if(/^(https?:|#|data:)/.test(p))continue;refs.push(p);if(!fs.existsSync(p))bad.push(p);}console.log(refs.join("\n"));console.log("本地引用数: "+refs.length+"; 缺失数: "+bad.length);if(bad.length){console.log("MISSING: "+bad.join(", "));process.exit(1);}'
```

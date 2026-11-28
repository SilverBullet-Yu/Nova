# 诺瓦 Nova 技术架构

> 本档描述仓库当前实现。事实来源：`../package.json`、`../server/`、`../shared/`、`../assets/`、`../scripts/`、`../test/`。

## 1. 范围与约束

诺瓦 Nova 是面向学生的日程助理 Demo（`../package.json` 的 description）。当前实现的边界：

| 约束 | 现状（源码可验证） |
| --- | --- |
| 确定性引擎 | `../shared/engine/` 四个引擎均为纯函数：不读时钟、不读随机数、不做 I/O，同一输入必得同一输出 |
| LLM 只做理解与分析 | `../server/llm.js` 仅承担对话式澄清与拆解建议（OpenAI 兼容协议，`node:` 内置 fetch，无 SDK）；输出一律结构化 JSON 并经 schema 归一与边界夹紧，R 值判定与排程块仍由本地纯函数产出，LLM 不产出任何排程块 |
| 依赖边界 | 服务端零第三方运行时依赖，只用 Node 内置能力；前端为原生 JS + CSS，并使用 `../assets/vendor/` 中本地 vendored Three.js r152（包版本 `0.152.2`）与 CSS3DRenderer，不依赖 CDN。`../package.json` 无 `dependencies`/`devDependencies` 不等于全栈无第三方 |
| 业务主数据 | 浏览器 `localStorage['zx.overlay']` 是唯一业务主数据；服务端 JSON 文件只保留历史业务数据，前端不拉取、不接收、不上行 |
| 服务端持久化 | `../server/store/memory.js` 按 `userId` 分区并写入 JSON 文件，启动时读取；重排草案和复核收据仍只在进程内，无数据库；这些均不构成本机主数据或云端备份 |
| 演示账户 | 种子 `user.id = 'u_demo'`（林清，`tz: Asia/Shanghai`），`dailyCapMin: 300`，`weeklyH: 20`；当前业务不依赖该服务端身份 |

## 2. 运行形态与分层

两条路径共用同一套前端资产与同一份本机 overlay。其一是 **file:// 双击**：`../index.html` 以经典 `<script>`（非 ESM）加载 `../shared/data/seed.js` 与 `../assets/js/rhythm.build.js`，脚本和本地素材使用相对路径，CSS 使用本地渐变背景，历史 Wikimedia 素材仅保留来源注释，不加载远程图片；`../assets/js/api.js` 在 `file://` 下把计算 API 基址定为 `http://127.0.0.1:8787`。其二是 **Node 服务端托管**：`../server/main.js` 对 `GET /` 返回 `index.html`，`/assets/*` 与 `/shared/*` 直出，前后端同源，`../assets/js/api.js` 取 `location.origin`。两种入口启动及 `online` 事件都只探测 `/api/health`；业务读写、重排确认与撤销始终在本机完成。

引擎只有一份实现：`../shared/engine/` 下四个 UMD 双模文件（`module.exports` 或挂 `window.Rhythm.<name>`）。`../scripts/build-engine.js` 把它们拼接为浏览器产物 `../assets/js/rhythm.build.js`；源文件若缺 `root.Rhythm` 挂载则构建失败。该产物禁止手改，`npm start`（`prestart`）与 `npm test`（`pretest`）都会先重建。

## 3. 系统架构

### 3.1 前端分层（`../assets/js/`）

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 状态 | `state.js` | 应用状态、种子归一、唯一业务主数据 overlay v3 的存取 / 熔断、v3 落点投影与派生计算（`feasInput`/`weekInput`/`replanInput`/`noImproveCount`） |
| 落点模型 | `shared/placement-model.js` | 具体日期/时区、稳定任务与区块 ID、原始/当前落点、普通/弹性容量与用量、跨窗滚动、改期/重排/执行状态同步的纯函数真值 |
| 通信 | `api.js` | health、Bearer 凭证与计算调用（普通超时 3000 ms）；旧 op 队列只读隔离；连接状态仅表示计算可达性 |
| 引擎桥接 | `engine.js` | 可行性 / 排程 / 重排后端优先、本地产物兜底；确认与撤销只调用本机纯函数；`feasibilityNow`/`attributeNow` 为本地入口 |
| 原语 | `ui.js`、`util.js` | 提示/弹层/焦点等 UI 原语与通用工具 |
| 对话 | `assistant.js` | 意图路由，重排/撤销/降载/通知等对话动作 |
| 流程 | `flows/replan.js`、`flows/clarify.js`、`flows/goal.js`、`flows/rescue.js`、`flows/exec.js`、`flows/planedit.js`、`flows/settings.js` | 本机重排确认 / 撤销、对话式需求澄清（LLM 驱动，含降级链）、目标落地、中断挽救、执行记录、计划编辑、CSV / 完整备份、覆盖前 trash 与数据清理 |
| 视图 | `views/today.js`、`views/plan.js`、`views/data.js`、`views/me.js` | 四个子页渲染 |
| GL 视觉层 | `gl/engine.js`、`gl/background.js`、`gl/nav.js`、`gl/mascot3d.js`、`gl/stage.js` | WebGL / CSS3D 双渲染器、背景、导航、3D 形象与 DOM 内容克隆同步；当前五页为统一首页风格而显示真实 DOM 并隐藏舞台；隐藏时不创建 renderer、不拾取、不调度 rAF、不克隆 DOM，显示后懒初始化并 refresh；对话按源节点/dirty 集合增量克隆；模块仍挂载 `window.ZX_GL*`，不重写业务引擎 |
| 装配 | `main.js` | 页签（对话/今日/计划/数据/我的，对话为默认）、事件绑定、渲染循环与 overlay 落盘；DOM 初始化后按首帧开关启动 GL |

第三方目录 `../assets/vendor/` 包含 `three.min.js`（`window.THREE`）与 `three-css3d.js`（`window.ZX_CSS3D`），由 `../scripts/build-vendor-three.mjs` 从 Three.js `0.152.2` 包复制 / 转换为经典 script。加载顺序：head 内联偏好脚本 → 共享种子与引擎产物 → vendor（Three → CSS3DRenderer）→ `gl/`（engine → background → nav → mascot3d → stage）→ 业务脚本 → `main.js`；完整清单见 `FRONTEND-CONTRACT.md` §2。

3D 舞台不受偏好存储控制：`html[data-gl3d="on"]` 为初始标记，`main.js` 仅在 `data-gl3d="on"` 时尝试初始化 GL；隐藏舞台直接跳过，待 resize 或属性/可见性变化后懒初始化。初始化失败写 `off` 并加 `.gl-off`，成功加 `.gl-on`。GL 引擎 / CSS 注释与运行时闸门统一使用 `data-gl3d`；`zx.ui_prefs.gl3d` 不再被首帧读取，也不接入「我的」页开关，详见前端契约。

### 3.2 服务端分层（`../server/`）

`../server/main.js`（HTTP 编排：CORS、鉴权与限流、请求体上限、headers/request/keep-alive 超时与最大连接数）；`../deploy/nginx.conf.example` 提供反向代理边界示例→ `../server/api/routes.js`（路由注册表：路径 / 处理器 / `public` / `limit` 元数据单一声明，入参校验，错误统一形状 `{ error: { code, message } }`；handler 可同步返回或返回 Promise，LLM 端点为异步）→ `../server/api/errors.js`（错误码表与 `ApiError`，llm.js 与 routes.js 共用、避免 require 环）→ `../server/llm.js`（LLM 理解与分析层，见 3.3）→ `../server/auth.js`（凭证签发校验、限流桶机制）→ `../server/store/memory.js`（历史用户分区、op 合并、幂等索引）。当前前端只使用 health / auth / feasibility / schedule / replan / LLM；`state`、`plan/review`、`replan/confirm`、`replan/undo`、`sync/ops` 与 attribute 仅服务端保留，前端不使用。响应原语与静态托管分别拆至 `../server/resp.js` 与 `../server/static.js`（白名单 `/`、`/index.html`、`/assets/*`、`/shared/*`，目录穿越防护）。

### 3.3 LLM 理解与分析层（`../server/llm.js`，2026-11-22 新增）

目标工作流「多轮澄清 → 确认需求 → 分析制订 → 可视化执行」中，LLM 只承担前两段的「理解」与第三段的「分析建议」：

| 职责 | 入口 | 说明 |
| --- | --- | --- |
| 多轮澄清 | `clarifyTurn(messages, profile)` → `{ reply, profile, done, missing }` | 诺瓦人设 system prompt + 槽位定义（goalType/goalName/deadline/weeklyH/level/subjects/preferences）；每轮只追问缺失槽位；画像深合并（LLM 未给的槽位不覆盖既有值）；`done` 与槽位齐备性由服务端复核，防幻觉放行 |
| 拆解建议 | `analyzeProfile(profile, history)` → `{ summary, demandH, weeklyH, tasks[], risks[], advice }` | 只产出「学什么 / 各科多少时间 / 风险」；`est` 夹紧 15–240、`weight` 夹紧 0–1、条目上限 8；**不含排程块**，排程仍由 `schedule()` 纯函数执行 |

接入与安全：OpenAI 兼容 `POST {LLM_BASE_URL}/chat/completions`，`LLM_API_KEY` 只在服务端进程内，不进仓库不下发前端；未配置抛 `E5010`（503）、调用失败/超时 `E5011`（502）、输出不可解析 `E5012`（502）；LLM 输出先 `parseJsonContent`（容忍围栏与噪声）再经白名单归一（`normalizeProfile` / `normalizeSuggestion`），未知字段不透传、长度截断。前端 `flows/clarify.js` 按错误码降级到现有关键词 + 四步表单流程。

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

`../assets/js/state.js` 在种子之上补充：`sessions[]`（执行记录）、`attrCounts`（归因计数）、`replanHistory[]`（重排历史）、`replanRecord`、`lastFeas`、`snapshot`、`interrupted` 与 `consecutiveZeroDays`。任务归一同时保留契约名 `subject` 与视图名 `s`。`serverSeq` 仍保留初值 88123 以兼容旧代码，但当前前端不消费服务端序号；本机计划版本由 `currentPlanVersion()` 生成并写入 overlay / 完整备份。

### 4.3 服务端历史分区结构（仅服务端保留，前端不使用）

`../server/store/memory.js` 每分区持有 `{ userId, seq, state, entities, opIndex, dayAssignWrites, replanRecords, replanSeq, planBaseline }`：`state` 为种子副本，`entities` 存历史字段级合并结果，`opIndex` 为 `opId` 到 `serverSeq` 的幂等索引。当前前端不读取、不接收、不写入这些数据，也不将其视为业务主数据。

持久化采用同目录临时文件、可写描述符 `fsync`、原子改名与共享文件锁；每次写入锁内重读最新存储，业务失败回滚分区快照，失败操作不占用幂等索引。启动时校验 JSON 与分区结构，损坏文件拒绝加载且不自动覆盖。默认旧布局仍重写全部分区；`NOVA_STORE_PARTITIONED=1` 可启用只写变化分区的内容寻址布局，首次提交前原子写入 `<STORE_FILE>.partitioned.json` 模式标记，manifest 原子提交且禁止静默回退旧 JSON。标记存在但 manifest 缺失、或两者均缺失却存在非空 parts 时，启动即 fail-closed；历史 manifest 仍可读取并在下次写入补标记。全库备份对 envelope 与分区 canonical schema 做严格校验，legacy 加载继续保留兼容路径。锁使用 owner token，不自动删除无法确认归属的锁；超时可配置并提示人工核实。计划提交在锁内核对 revision；rename 后目录同步失败记录耐久性警告而非误报回滚。旧版本支持显式审计后 `compact --purge` 回收；opIndex 支持先完整备份再按 `--keep-recent` 显式回收；全库支持 `backup-all` / `verify-backup` / 仅恢复到新路径的 `restore-all`，旧 op 重试风险由管理员裁定。R10 提供 `scripts/server-data-admin.js` 只读 entityId 盘点、单分区独占备份、指纹校验和显式确认删除；审计失败明确报告已删除，真实操作须单独授权。

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

输入 `{ tasks[], week[], params, history, locks, allowBuffer?, timestamp? }`；输出 `{ strategies[], diff[], loadDelta, growthApplicable, accepted, needsConfirmation, verdict, snapshot, guards, nextTasks, nextPlacements, nextWeek }`。周元素为 `{ date, minutes, buffer, capacity?, bufferUsed?, releasedMinutes?, releasedBufferMinutes? }`，普通容量 `capacity` 缺省取 `dailyCapMin`，弹性容量 `buffer` 缺省为 0；日期唯一且最多 7 天。任务工时读非负整数 `est`。`params` 默认 `loadGrowthCap 0.20`、`compressFloor 0.60`、`compressedShareCap 0.30`、`consecutiveNoImproveCap 3`、`dailyCapMin 300`、`maxTasks 500`、`maxOperations 50000`；`bufferRatio` 当前仅为兼容字段。

- 四级顺序执行，首个通过校验即停：L1 顺延（按权重降序填入未来 7 天普通容量；`allowBuffer=true` 时才使用独立弹性容量）、L2 压缩（仅当待排分钟超出剩余容量 `overflow > 0` 时触发，按权重升序压缩，下限 `floor(est × compressFloor)`）、L3 替代（同 `domain` 内 `freq` 与 `weight` 双高者替换低者，原任务标 `substituted` 退出待办）、L4 放弃（只给建议，`accepted=false` 且 `needsConfirmation=true`）。
- L3 按域预索引候选，已在 pending 的候选产生同一待排集合，首次放置失败后不再重复计算；L4 只排序一次并逐项移除。结果合并使用 ID 索引。`npm run bench:replan` 覆盖 8–500 任务，子进程 1500ms 硬超时、单次 250ms 软预算，异常或超预算均非零退出；当前 500 任务合成基准约 82ms。暂不引入 Worker，保留同步纯函数契约与操作上限，后续若预算扩大再评估可终止线程池。
- `placementModel.taskSegmentsMap()` 一次归一化并返回按 taskId 索引的独立分段集合；`state.taskSegmentsMap()` 以模型引用为键缓存，今日、计划、日期查询和投影复用，单任务查询仍返回克隆，避免调用方修改缓存。
- `nextWeek` 按日期携带本轮已装入待办的 `releasedMinutes` / `releasedBufferMinutes`，同一结果回灌为 week 输入时先释放再装载，不重复放大基线。v3 挽救把 `unplanned` backlog 纳入缺口与压缩预估；未排入任务只更新剩余工时，不伪造落点。可用时段变化通过 `placementModel.matchesSlots` 检测并提示当前窗口仍保留旧时段，是否立即重建仍待产品裁定。
- 三条防雪崩断言：① 未来 7 天负载增幅不超过 `loadGrowthCap`（零基线下 `loadDelta=null`、`growthApplicable=false`）；② 普通负载不得超过 `capacity`、弹性负载不得超过 `buffer`，两类容量独立检查；③ 连续 `consecutiveNoImproveCap` 次未改善即在入口短路，`verdict = 'blocked'` 并转目标校准（`consecutiveOk`）。L2 另有事后守卫 `compressedShareOk`（压缩占比不超过 30%）。
- `locks`（`{ taskId: true }`）是硬约束：不参与装载、压缩、替代、放弃，也不进入 `diff`。
- `snapshot = { tasks, week, timestamp, placementModel? }`，`timestamp` 由调用方注入（引擎不读时钟）；`undoReplan` 反向应用快照，不重算；`confirmReplan` 要求 `verdict='needsConfirmation'` 且策略、diff、快照和下一步落点结构完整，确认后置 `accepted=true`、`verdict='ok'`。当前前端在确认后写入本机 overlay，不写服务端；服务端旧 confirm / undo 仅服务端保留，前端不使用。

### 5.4 归因 `attribute`

输入 `planLoadRatio`、`consecutiveZeroDays`、`consecutiveTimeoutCount`、`efficiencyRatio`、`completion`、`externalRatio`；输出 `{ type, confidence, actions[], evidence }`，`evidence` 含六项入参与 `matched[]`。判定顺序固定（顺序即优先级，先排除计划问题再归因用户侧）：计划过载（`planLoadRatio > 1.1` 或 `consecutiveTimeoutCount >= 3`）→ 执行中断（`consecutiveZeroDays >= 2`）→ 效率不足（`efficiencyRatio > 1.4` 且 `completion >= 0.6`）→ 外部干扰（`externalRatio > 0.3`）→ 无偏差。

## 6. 数据持久化边界

### 6.1 服务端历史数据（仅服务端保留，前端不使用）

`../server/store/memory.js` 按 `userId` 分区，`BASE_SEQ = 88123`；`applyOps` 逐条合并并返回 `{ accepted[], serverSeq }`，同 `opId` 重复提交返回首次 `serverSeq` 且不推进序列。字段级合并策略：`deleted`/`isDeleted`/`deletedAt` 走墓碑（置位不可翻转），`count`/`sessionCount`/`sessions`/`times` 求和，`actual`/`durationMin`/`minutes`/`duration` 取最大值，其余最后写入优先（同 `clientTs` 比 `serverSeq`）。持久化文件默认 `server/data/nova-store.json`，可通过 `NOVA_STORE_FILE` 指定；启动时回填历史分区和计划基线，草案、票据、收据在重启时清空。上述 op、基线与 `/api/state`、`/api/sync/ops`、`/api/plan/review` 仅服务端保留，前端不调用，不构成本机主数据、云端备份或跨设备同步。

### 6.2 前端（本机唯一业务主数据）

| 存储键 | 内容与边界 |
| --- | --- |
| `zx.overlay` | 唯一业务主数据。固定 `format='nova-overlay'`、`version=3`、`syncMode='local-only'`、`installId`、`revision`、`updatedAt`；业务白名单为 `planVersion`、`tasks`、`sessions`、`goal`、`feas`、`week`、`weekShift`、`placementModel`、`dayAssign`、`locks`、`avail`、`availSource`、`notif`、`attrCounts`、`replanHistory`、`replanSnapshot`。渲染路径统一落盘 |
| `zx.install_id` | 本机安装标识；写 overlay 时带入，不是云端账户 |
| `zx.op_queue` | 旧 op 原字节只读隔离；`queueOp` 不写，`pendingCount=0`，`legacyPendingCount` 统计旧 pending 并显示「N 项已隔离」；无上行或补传；删除本机业务数据时仍保留 |
| `zx.auth_token` | `{ token, userId, expiresAt }`，仅用于计算鉴权；不进入完整备份 |
| `zx.pending_plan` | 旧待复核计划原样保留，不自动复核、不上送；删除本机业务数据时仍保留隔离 |
| `zx.server_plan_version` | 历史遗留版本键；当前前端不读不写，不作本机计划真值 |
| `zx.ui_prefs` | `util.js` 管理 `grid`、`glow`、`motion`、`font`；首帧内联脚本只写这四项，`gl3d` 不再读取（3D 由运行时闸门控制） |
| `zx.trash` / `zx.flash` | 删除全部数据或备份导入覆盖前的 7 天恢复快照，以及删除后的一次性提示 |

overlay 损坏、格式 / 版本无效、v3 元数据、v3 必填业务快照缺字段、落点模型或业务结构不符、未来 `version>3` 会保留原键并暂停覆盖；旧 v1/v2 无模型证据时保持 legacy，不反推日期或从 `total-buf` 猜容量。显式导入有效备份或确认删除才解除熔断。保存失败会单独告警。启动只恢复本机 overlay；启动与 `online` 只探测 health，不拉取或接收服务端状态。

跨标签页采用业务快照基线检查：写前重读 `zx.overlay`，外部业务变更/删除/非法元数据即拒绝覆盖并置粘滞冲突；`storage` 事件检测本页未保存修改。冲突时暂停保存、删除、重排确认和撤销，用户先导出本页备份再刷新。仅元数据变化且业务相同可接受新 revision。导入回滚保留另一页的新写入/删除；支持 Web Locks 时导入/删除/恢复事务串行化。不可读 overlay 只能替换本次加载的同一 raw。显式删除先预检并恢复本次 trash 写入，损坏/未来版本仍可显式删除；删除回读异常保留 trash；trash 清理/恢复只删本次 raw；未来版本修复保留可读 revision。该机制不是原子 CAS，只提供顺序旧版本保护，不承诺多页同时写线性一致。

### 6.3 本机写入、备份与隔离

所有目标、任务、执行记录、改期、锁定、通知、可用时段、挽救、重排确认 / 撤销和数据恢复均只写本机。旧代码中的 `queueOp()` 调用保留为兼容空操作，不产生 op；`flushQueue()` 不发请求。`zx.pending_plan` 与 `zx.server_plan_version` 不参与本机业务判定。

关键提交由 `ZX.state.transact()` 包装：先克隆状态，执行 model/projection/task/session 变更并检查保存结果，失败恢复内存；仅当存储仍是旧值或本次写入值时才恢复旧 raw，外部写入优先保留。该原语已接入目标、重排、执行和计划编辑，但它仍是 localStorage 补偿回滚，不等于 A1 的 IndexedDB 原子 CAS。确认后的压缩/顺延卡提供绑定 draft/planVersion 的逐条否决；澄清排程失败保留建议并显示绑定 revision/planVersion 的重试卡，成功后才结束会话。

「我的」CSV 导出计划与记录；完整 JSON 备份为 `format='nova-backup'`、`version=1`，含 `createdAt`、`installId` 和 overlay 业务白名单快照，不含 token、旧队列或旧待复核计划。导入先校验格式 / 版本 / 时间 / 安装标识 / snapshot 结构 / 安全 ID / 文本长度 / 标签与控制字符 / 禁用字段，用户确认后保存旧 trash 原值并写覆盖前快照，再写 overlay 并回读校验；失败同时回滚 overlay 与 trash，回滚也失败时明确告警并保留页面。删除全部数据会先保存 7 天 trash，再移除 overlay，避免重载复活；旧队列与旧待复核计划仍原样隔离，不随本机业务删除清除。

M3 的 `deferred` 仅表示今日暂缓，不是真实改期：任务退出今日待办 / 时间带、计划普通块、挽救与重排候选，在今日和计划页独立展示并可恢复，计划日期不变；旧 `deferredTo` 只作兼容提示。v3 真实改期已接入具体日期与完整区块；legacy 未自动迁移。

## 7. 关键业务流

| 流程 | 路径 | 要点 |
| --- | --- | --- |
| 目标落地→可行性→拆解→排程 | `flows/goal.js` | 折扣 `DISCOUNT 0.85`；基准工时 `{ 考研 913, 考公 660, 项目导学 520 }` 小时；基础系数 `{ 零基础 1.30, 一轮 1.00, 二轮 0.75, 多战 0.60 }`；`R < 0.70` 阻断进入拆解；单计划项 `est` 限 15–240 分钟、步长 15；排程槽位来自可用时段网格，30 分钟一格，各可用日末两格保留为弹性位；今日任务保留全部正工时条目，估时只计当天排入分钟，落点与弹性位时间取实际槽位；结果只写本机 `tasks`/`week`/`weekShift`/`buffer`，不建立服务端基线或自动复核 |
| 重排→逐条否决/撤销 | `flows/replan.js`、`flows/planedit.js` | 重排计算走 `ZX.engine.replan`（服务端优先、本机兜底）；`verdict='blocked'` 即停止并转目标校准；`needsConfirmation` 经本机 `confirmReplan` 后写 overlay，服务端 `draftId` 不参与；v3 否决在克隆模型上恢复该任务重排前落点，压缩项同时恢复原工时并清理压缩标记，legacy 顺延否决不改落点；两者均不清除 `deferred`（今日暂缓）；撤销由本机 `undoReplan` 反向应用快照，不请求服务端 |
| 中断挽救 | `flows/rescue.js` | 由 `sessions` 算连续无记录天数，达 3 天（`THRESHOLD 3`）判定中断；剩余天数 = 7 减断更天数（下限 1）；三选一压缩（`COMPRESS_RATE 0.40`，下限 15 分钟）/顺延/降级，两屏完成（缺口与方式→确认摘要），确认前不写状态，确认后只写本机；`deferred` 今日暂缓项不进入候选，也不是改期 |
| 执行记录→偏差归因 | `flows/exec.js` | 记录 `status` 取 `done`/`partial`/`skip`/`backfill`，感受词独立存 `feel`；完成度 100% 置 `done=true` 且 `actual=minutes`，不足 100% 则累加 `actual` 并按部分完成折算 `est`；记录后立即跑 `attributeNow`，命中结果计入 `attrCounts` |
| 归因→周报 | `views/data.js`、`flows/exec.js` | 周报与归因的数据源是本地执行记录真算，`attrCounts` 与 `replanHistory` 为卡片真实数据源 |

## 8. 非功能与运行时特征

| 项 | 现状 |
| --- | --- |
| 鉴权 | 当前计算接口使用 `Authorization: Bearer <token>`；凭证形态 `nj1.<payloadBase64url>.<sigBase64url>`，HMAC-SHA256 签名，密钥取 `NOVA_AUTH_SECRET`（至少 32 字节），有效期 7 天（`TOKEN_TTL_MS`）。health / auth 免鉴权；业务主数据不依赖服务端身份，凭证不进入完整备份 |
| 限流 | 服务端固定窗口、单进程内存，按「身份 + 路由」隔离，未认证路由按来源 IP 隔离。阈值：`POST /api/auth/session` 60/60 s（按 IP）、`POST /api/sync/ops` 60/60 s、`POST /api/replan` 与 `/replan/confirm` 12/60 s（`/api/replan/undo` 当前不设限流，2026-11-24 已确认保持现状；前端不调用）、`POST /api/feasibility` 与 `/schedule` 与 `/plan/review` 与 `/attribute` 30/60 s，`/api/llm/clarify` 与 `/api/llm/analyze` 10/60 s；超限返回 429 与 `Retry-After`，不排队也不自动重试。旧业务接口限额仅服务端保留，前端不使用 |
| CORS | 仅对 `NOVA_ALLOWED_ORIGINS` 精确白名单中的来源返回 CORS 头；`file://` 的 `null` origin 默认关闭，仅显式列入白名单或设置 `NOVA_ALLOW_NULL_ORIGIN=1` 时放行。同源浏览器请求不依赖 CORS；允许方法 `GET, POST, OPTIONS`，允许头 `Content-Type, Authorization`，`Max-Age 600`，带 `Vary: Origin` |
| 静态资源 | 白名单 `/`、`/index.html`、`/assets/*`、`/shared/*`；非 GET/HEAD 返回 405 |
| 请求体 | 上限 1 MiB（`MAX_BODY_BYTES = 1048576`），超限 `E4002`；JSON 非法 `E1001` |
| 前端计算降级 | 普通请求超时 3000 ms；可行性 / 排程 / 重排调用失败或结构不合约时回退同一本地产物（`ZX.engine.source` 记为 `local`）；确认 / 撤销与归因始终本机执行。顶栏在线基础文案为「本地主数据 · 服务端仅计算」，有旧 pending 时改为「本地主数据 · 旧队列已隔离 N」；离线基础文案为「离线 · 本地可用」并附隔离数量，「我的」页显示「N 项已隔离」；不显示待处理角标。离线 / 聆听头像取自 `mascot-inline.js` 内联 data URI；`zx.pending_plan` 不自动复核，无补传或自动补审 |
| 体积 | 不保留文件数 / 字节数固定快照。文件磁盘体积用 Node `fs.statSync(path).size` 实测；汇总时声明目录与扩展名范围，计入 `assets/vendor/`，注明是否含测试 / 服务端及是否压缩。浏览器实际传输量另用开发者工具 Network 在禁用缓存后刷新测量，并记录浏览器、协议与压缩口径，不与磁盘字节混用 |
| 第三方资源 | `../index.html` 以本地相对路径加载 vendored Three.js r152 与 CSS3DRenderer，无 CDN、远程字体或埋点依赖；SVG 素材位于仓内，GL 形象由 `gl/mascot3d.js` 构建；CSS 使用本地渐变背景；历史 Wikimedia Commons 素材仅保留来源注释，不加载远程图片。业务 API / 可选服务端 LLM 也可能发起网络请求 |

## 9. 附录

### 9.1 HTTP 接口清单

| 方法与路径 | 前端状态 | 鉴权 | 入参 | 返回 |
| --- | --- | --- | --- | --- |
| `GET /api/health` | 使用 | 否 | 无 | `{ ok, version, uptimeMs }` |
| `POST /api/auth/session` | 按需使用 | 否 | 空对象 | `{ token, userId, expiresAt }` |
| `GET /api/state` | **仅服务端保留，前端不使用** | 是 | 无 | `{ seed, replan, notifications, planBaseline }` |
| `POST /api/feasibility` | 使用（计算） | 是 | `weeklyH`/`weeks`/`discount`/`demand` | 可行性结果 |
| `POST /api/schedule` | 使用（计算） | 是 | `tasks`/`slots`/`params?` | `{ blocks, unplanned, version }` |
| `POST /api/plan/review` | **仅服务端保留，前端不使用** | 是 | `id`/`base`/`input`/`result`/`ticket?` | `committed` 或 `conflict` 历史收据 |
| `POST /api/replan` | 使用（预览计算） | 是 | `tasks`/`week`/`params?`/`history?`/`locks?`/`timestamp?` | 重排预览；服务端 `draftId` 被前端忽略 |
| `POST /api/replan/confirm` | **仅服务端保留，前端不使用** | 是 | `draftId` | 服务端历史确认结果与基线 |
| `POST /api/replan/undo` | **仅服务端保留，前端不使用** | 是 | `snapshot` | `{ tasks, week }` |
| `POST /api/attribute` | **仅服务端保留，前端不使用** | 是 | 六个归因数值字段 | `{ type, confidence, actions, evidence }` |
| `POST /api/sync/ops` | **仅服务端保留，前端不使用** | 是 | `ops[]`（至多 200 条） | `{ accepted[], serverSeq }` |
| `POST /api/llm/clarify` | 使用（理解） | 是 | `messages`/`profile?` | `{ reply, profile, done, missing }` |
| `POST /api/llm/analyze` | 使用（分析建议） | 是 | `profile`/`history?` | 拆解建议，不含排程块 |

已下线端点（返回 404 / `E2001`，见 `../test/api.test.js`）：`POST /api/sessions`、`GET /api/sync`、`GET /api/reports/weekly`。

服务端历史基线有两条建立路径：重排确认（`/api/replan/confirm`）按凭证身份记录并持久化基线；计划复核（`/api/plan/review` 返回 `committed`）写入排程版本基线。读接口返回 `null` 或 `{ version, stale }`，冲突可附 `ticket` 重交，收据在进程内且同签名 24 小时内幂等。**以上仅服务端保留，前端不使用**：当前前端不建立 / 读取服务端基线，不挂起离线复核，也不在恢复联网后自动补审。本机计划版本与重排快照保存在 overlay，确认和撤销均在本机完成。

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
| `E5010` | 503 | LLM 服务未配置（前端据此降级表单流程） |
| `E5011` | 502 | LLM 调用失败或超时 |
| `E5012` | 502 | LLM 输出无法解析 |
| `E9001` | 500 | 未分类异常 |

### 9.3 配置项（环境变量，样例见 `../.env.example`）

| 变量 | 作用 |
| --- | --- |
| `NOVA_AUTH_SECRET` | HMAC 签名密钥，至少 32 字节；`NODE_ENV=production` 未配置则拒绝启动 |
| `NODE_ENV` | 设为 `production` 时启用生产约束 |
| `PORT` | 监听端口，缺省 8787 |
| `HOST` | 监听地址，缺省 `127.0.0.1` |
| `NOVA_TRUST_PROXY` | 设为 `1` 时按 `X-Forwarded-For` 最后一跳隔离限流桶，默认按 TCP 对端地址 |
| `NOVA_ALLOWED_ORIGINS` / `NOVA_ALLOW_NULL_ORIGIN` | 跨域精确白名单；null origin 默认关闭 |
| `NOVA_ADMIN_BACKUP_DIR` | CLI 敏感输出根目录，默认 store 同级的 `nova-admin-output` |
| `NOVA_STORE_FILE` | 服务端 JSON 文件路径，默认 `server/data/nova-store.json` |
| `NOVA_STORE_PARTITIONED` | 默认 `0`；设为 `1` 启用内容寻址分区，写入 `.partitioned.json` 模式标记；标记/manifest/parts 不一致时拒绝回退旧 JSON |
| `NOVA_STORE_MAX_BYTES` | 持久化字节预算，默认 16 MiB；partitioned 含标记、manifest 与全部 parts |
| `NOVA_STORE_MAX_PARTITIONS` | 最大分区数，默认 1024 |
| `NOVA_DRAFT_BUDGET_BYTES` / `NOVA_RECEIPT_BUDGET_BYTES` | 进程内草案/收据总字节预算，默认 8/4 MiB，超限 FIFO 淘汰 |
| `NOVA_STORE_LOCK_TIMEOUT_MS` | 共享锁等待上限，默认 `5000`ms |
| `NOVA_HTTP_HEADERS_TIMEOUT_MS` | 请求头超时，默认 `10000`ms，范围 1000–60000 |
| `NOVA_HTTP_REQUEST_TIMEOUT_MS` | 完整请求超时，默认 `130000`ms，范围 1000–300000 |
| `NOVA_HTTP_KEEP_ALIVE_TIMEOUT_MS` | keep-alive 超时，默认 `5000`ms，范围 1000–60000 |
| `NOVA_HTTP_MAX_CONNECTIONS` | 最大连接数，默认 `128`，范围 1–10000 |
| `NOVA_LLM_MAX_REQUEST_BYTES` | LLM 上下文请求字节上限，默认 256 KiB，联网前校验 |

### 9.4 命令

`npm start` 构建引擎产物后启动服务（缺省 `http://127.0.0.1:8787`）；`npm run dev` 执行 `node --watch server/main.js`；`npm test` 构建产物后跑 `node --test "test/*.test.js"`；`npm run check:engine` 只读校验产物与源码同步；`npm run build:engine` 单独生成 `assets/js/rhythm.build.js`；`npm run bench:replan` 运行 8–500 任务有界基准；`npm run audit` 执行 `scripts/css-audit.mjs`，做 CSS 括号平衡、token 引用完整性、硬编码色值与死类审计。

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
| `index.html` | 页面骨架：`#gl` WebGL 画布、`#css3d` 内容层、顶栏、对话区 `.copilot`、工作台 `.bench`、主导航语义源 `#rail`；首帧前读 `zx.ui_prefs` 写 `html[data-*]`，其中 `gl3d` 写 `data-gl3d`（详见 §6）。GL 开启时导航由 3D 卡呈现，DOM 回退时显示原导航 |
| `assets/js/util.js` | 通用工具与视觉偏好（`ZX.util`）：`esc` / `hm` / `num` / 日期时段 / `prefs`·`applyPrefs`·`savePrefs`·`togglePref`·`setPref` |
| `assets/js/ui.js` | 共享 UI 原语（`ZX.ui`）：`sheet` / `confirm` / `toast` / `fold` / `flowSheet` / `footNav` / `countTo` |
| `assets/js/api.js` | 后端通信、超时降级、凭证与 op 写队列（`ZX.api`） |
| `assets/js/engine.js` | 引擎桥接：后端优先 → 本地产物兜底（`ZX.engine`） |
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

1. head 内联脚本先读取首帧偏好（含 `gl3d`），随后加载 `assets/css/app.css`。
2. 共享层：`shared/data/seed.js` → `assets/js/rhythm.build.js`。
3. vendor：`assets/vendor/three.min.js` → `assets/vendor/three-css3d.js`。
4. GL 模块：`assets/js/gl/engine.js` → `background.js` → `nav.js` → `mascot3d.js` → `stage.js`（后四项同属 `assets/js/gl/`）。此时注册模块，实际初始化在 `main.js` 完成 DOM 启动之后。
5. 业务基础：`assets/js/mascot-inline.js` → `util.js` → `ui.js` → `api.js` → `engine.js` → `state.js`（后五项同属 `assets/js/`）。
6. 视图：`assets/js/views/today.js` → `plan.js` → `data.js` → `me.js`（同目录）。
7. 工作流：`shared/workflow.js` → `assets/js/assistant.js` → `assets/js/flows/replan.js` → `clarify.js` → `goal.js` → `rescue.js` → `exec.js` → `planedit.js` → `settings.js`（后六项同属 `assets/js/flows/`）。
8. 装配：`assets/js/main.js`；仅当 `data-gl3d="on"` 且 `window.ZX_GL` 存在时调用 GL 初始化。

### 2.2 流程模块 `assets/js/flows/`

| 模块 | 挂载点 | 职责 | 关键常量 |
|---|---|---|---|
| `replan.js` | `ZX.flows.replan` | 重排域：四级重排预览（后端优先 → 本地引擎）、草案生命周期（`shared/workflow.js`）、在线草案确认、快照撤销；留痕 `zx.replanTrace`；`replanFlow` / `confirmReplan` / `undoReplan` 由意图路由与 `data-act` 委托消费 | `REPLAN_RULES_VERSION` `nova-replan-p0-1`；24h 重跑去重窗口 |
| `clarify.js` | `ZX.flows.clarify` | LLM 多轮需求澄清与拆解建议；失败时降级到目标表单，排程仍由共享引擎完成 | 配置与边界见 `HANDOFF.md` |
| `goal.js` | `ZX.flows.goal` | 新建目标：设定 → 可行性 →（R<0.70 校准）→ 拆解草案 → 确认生效；生效后走 `ZX.engine.schedule` 排程 | `BASE_HOURS` 考研 913 / 考公 660 / 项目导学 520；`BASE_COEF` 零基础 1.30 / 一轮 1.00 / 二轮 0.75 / 多战 0.60；`DISCOUNT` 0.85；`GATE` 0.70；`TARGET_R` 0.90；`MIN_EST` 15；`MAX_EST` 240；`STEP` 15；`OVER_RATIO` 1.15；`AMP_LIMIT` 0.30 |
| `rescue.js` | `ZX.flows.rescue` | 连续无记录天数识别、中断横幅、三步挽救（压缩 / 顺延 / 降级）与生效 | `THRESHOLD` 3 天；`DEMO_ZERO_DAYS` 4；`COMPRESS_RATE` 0.40；`MIN_EST` 15；`DEFER_DAYS` 7；`DOWN_POINTS` 30 |
| `exec.js` | `ZX.flows.exec` | 执行记录：暂停 / 继续、部分完成、跳过与恢复、补录；`metrics()` 是全站 KPI 唯一口径 | `PCTS` 25 / 50 / 75 / 100；`FEELS` 顺利 / 吃力 / 分心 / 疲惫；`REASONS` 临时有事 / 状态不好 / 任务过难 / 其他；`MIN_EST` 15 |
| `planedit.js` | `ZX.flows.planedit` | 计划页日程块：拖拽改期（写 `state.dayAssign`）、锁定（`state.locks`）、日上限校验、逐条否决 | `DAYS` 一…日；`ORIGIN`「日」；日上限取 `state.user.dailyCapMin`（缺省 300） |
| `settings.js` | `ZX.flows.settings` | 可用时段 7×4 网格、批量操作、CSV 导出、删除全部数据（7 天可恢复）、字号 | `SLOTS` 08–12 / 12–18 / 18–22 / 22–24；`SLOT_H` 4 / 6 / 4 / 0；`TTL` 7 天 |

### 2.3 视图模块 `assets/js/views/`

每个视图导出 `ZX.views.<id>()` 并返回 HTML 字符串；事件一律走 `data-act` 委托，不写内联 `onclick`。

| 模块 | 挂载点 | 职责 |
|---|---|---|
| `today.js` | `ZX.views.today` | 今日页：KPI、07:00–23:00 时间带、任务表、弹性位、已记录 / 已跳过折叠区 |
| `plan.js` | `ZX.views.plan` | 计划页：可行性 R 与刻度、学期节律带、未来 7 天负载周图、本周日程块 |
| `data.js` | `ZX.views.data` | 数据页：本周概览、三段式周报（结论 / 依据 / 已执行）、趋势、科目结构与偏差归因 |
| `me.js` | `ZX.views.me` | 我的页：可用时段、通知策略、数据与隐私（导出 / 删除）、显示与动效 |

### 2.4 前端调用面（`assets/js/api.js`）

前端只经 `assets/js/api.js` 访问后端，调用清单以该文件为准，全部为 JSON：

| 方法 | 路径 | 前端用途 |
|---|---|---|
| GET | `/api/health` | 健康探测（免鉴权） |
| POST | `/api/auth/session` | 签发 Bearer 凭证（免鉴权） |
| GET | `/api/state` | 拉取初始状态；响应含 `planBaseline: null` 或 `{ version, stale }`，前端以该字段驱动计划离线复核（见 `/api/plan/review`） |
| POST | `/api/feasibility` | 可行性评估 |
| POST | `/api/schedule` | 排程 |
| POST | `/api/plan/review` | 计划离线复核：排程生效后上送 `{ id, input, result, base? }`，服务端重算比对基线；`conflict` 时携 `ticket` 重交直至 `committed`，离线时挂起待恢复联网补审 |
| POST | `/api/replan` | 四级重排预览（不写业务记录） |
| POST | `/api/replan/confirm` | 按 `draftId` 确认在线重排（含普通和放弃项）；不兼容旧 `result` 请求 |
| POST | `/api/replan/undo` | 撤销重排 |
| POST | `/api/sync/ops` | 批量上行本地 op |
| POST | `/api/llm/clarify` | 多轮需求澄清，输出归一画像 |
| POST | `/api/llm/analyze` | 画像分析与任务拆解建议，不产出排程块 |

`/api/attribute`（偏差归因）**前端不调用**：归因走本地产物即时出结果（`ZX.engine.attributeNow` → `Rhythm.attribute`），与排程「后端优先」的路径不同。字段级契约见 `docs/HANDOFF.md` 第 5 节。

## 3. 状态模型

### 3.1 全局状态 `ZX.state`

- 种子与归一：`state.js` 从 `window.Rhythm.seed` 取 `shared/data/seed.js`；种子缺失直接抛错（装配错误不静默替换）。契约字段 `subject` 与视图字段 `s` 由 `normTask()` 双向保留。
- 计时四元组：`running` / `timerStart` / `pausedAt` / `pausedTotal`，由 `state.resetTimer()` 复位。
- 视图开关：`tab`、`folds`、`skippedOpen`、`presetActive`、`tiredAdopted`、`movedOut`、`exportLog`。
- 重排相关：`replanned`、`snapshot`、`replanRecord`、`pendingReplan`、`replanHistory`；`replanInput().params` 为 `loadGrowthCap` 0.20、`compressFloor` 0.60、`compressedShareCap` 0.30、`consecutiveNoImproveCap` 3、`bufferRatio` 0.15。
- 中断相关：`consecutiveZeroDays`、`interrupted`、`rescueRecord`。
- 计划项交互：`dayAssign`（稀疏表，缺省落点为「日」）、`locks`。
- 临时草稿：`goalDraft` / `planDraft`，打开时初始化、关闭时置 `null`。
- KPI 口径：计划 / 已投入 / 剩余 / 达成率 / 补录一律取 `ZX.flows.exec.metrics()`（过滤 `skipped`），视图与对话页共用同一口径。

### 3.2 本机持久化键（localStorage）

| 键 | 所在 | 内容 | 写入时机 |
|---|---|---|---|
| `zx.overlay` | `state.js` | `tasks` / `sessions` / `goal` / `feas` / `week` / `weekShift` / `dayAssign` / `locks` / `avail` / `notif` / `attrCounts` / `replanHistory` + `at` | `ZX.render()` 末尾统一调 `saveOverlay()`；启动时 `applyOverlay()` 恢复；删除全部数据时 `dropOverlay()` |
| `zx.folds` | `ui.js` | 折叠区展开态（只保留值为 `true` 的键） | 点击 `data-act="fold"` 切换后 `ZX.ui.saveFolds()` |
| `zx.op_queue` | `api.js` | 待上行 op 数组，上限 200 条 | `ZX.api.queueOp()`；服务端确认后置 `pending: false` |
| `zx.auth_token` | `api.js` | `{ token, userId, expiresAt }` | `POST /api/auth/session` 成功后写入；本地按 `expiresAt` 预判失效 |
| `zx.pending_plan` | `api.js` | 待复核计划 `{ id, input, result, base?, localVersion? }` | 排程生效后 `stagePlan()` 写入；复核 `committed` 或删除全部数据时清除 |
| `zx.server_plan_version` | `api.js` | `{ version }`，取自服务端 `planBaseline.version` | `getState()` 成功且无待复核计划时写入；复核 `committed` 后更新 |
| `zx.ui_prefs` | `util.js` / `index.html` | util 管理 `{ grid, glow, motion, font }`；首帧脚本另读 `gl3d` | 「我的 → 显示与动效」保存 util 白名单字段；`gl3d` 尚未接入该保存路径，见 §6 |
| `zx.trash` | `settings.js` | 删除全部数据前的快照 | 「删除全部数据」时写入；超 7 天自动清除 |
| `zx.flash` | `settings.js` | 一次性提示文案 | 删除后写入，重载时由 `settings.init()` 消费并 toast |

刷新后保留：`zx.overlay` 覆盖的用户数据、`zx.folds`、`zx.ui_prefs`、`zx.op_queue`、`zx.auth_token`、`zx.pending_plan`、`zx.server_plan_version`、7 天内的 `zx.trash`。
刷新后不保留：计时四元组、`snapshot` / `replanned` / `replanRecord` / `pendingReplan`、`consecutiveZeroDays` / `interrupted` / `rescueRecord`、`goalDraft` / `planDraft`、当前页签。

本地优先：`applyOverlay()` 只在启动时或服务端状态被采纳后执行——`main.js` 的 `probeBackend()` 仅当 `bootOverlayLoaded()` 为真才回读，避免启动渲染写下的种子投影覆盖服务端回放。

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
- 渲染层级：`#gl` z-index 0 → `#css3d` z-index 1（`.gl-ui` 可交互）；`.app` 保留品牌 / 同步 / 输入台，GL 开启时隐藏原 `.bench` / `.cp-body`，由 CSS3D 克隆承载内容。弹层 60 → toast 80 → 跳转链接 90，不能被 GL / CSS3D 内容遮挡。
- 断点：`@media (max-width:860px)` 为主移动断点（另有 1080px、640px、360px）。≤860px 时顶栏改两行网格：第一行品牌与同步位，`.tnav`（唯一主导航 `#rail`）占满第二行（`grid-row:2`、`grid-column:1/-1`，高度 `--nav-row`）；`.bench-head` 隐藏；任务表隐藏 `.tt-head` 与 `.c-idx` / `.c-time` / `.c-est` / `.c-wt`，数值改由 `.tt-m` 元行承载。
- 科目色不写死在 CSS：由 `state.js` 的 `SUBJ` 与 `shared/data/seed.js` 的 `subjectColors` 注入行内 `--c` 变量。
- 新样式追加到 `app.css` 末尾对应区块，不重排既有规则；新增类名沿用现有前缀族（`.sa-` 目标、`.sb-` 挽救、`.sc-` 执行、`.sc2-` 计划交互、`.sd-` 设置）。

## 6. 动效与视觉偏好闸门

- 唯一总闸是 `html[data-motion="off"]`：`animation-duration` 与 `transition-duration` 归 0，`body::before` 取消动画，`.cp-body` 取消平滑滚动。所有动效必须能被它关掉。
- 裁决顺序：显式用户选择优先于系统 `prefers-reduced-motion`。只有 `zx.ui_prefs.motion` 缺省（从未选择过）时才跟随系统 reduce；一旦用户显式置 `true`，即使系统开启「减少动态效果」也照常播放。
- 落点三处：`assets/js/util.js` 的 `prefs()` / `applyPrefs()`、`index.html` 首帧内联脚本（避免主题闪烁）、`assets/css/app.css` 的 `html[data-motion="off"]` 段。
- 可配置项（均存 `zx.ui_prefs`）：`grid` 细点底纹、`glow` 纸面纹理、`motion` 界面动效、`font` 字号 `''` / `'m'` / `'l'`（映射 `html[data-font]` 与 `--fs-body` 15px / 16px / 17px）。布尔项白名单 `PREF_KEYS` 为 `['grid','glow','motion']`，`font` 走 `setPref()` 单值路径。
- 首帧 GL 闸门：`index.html` 内联脚本另读 `zx.ui_prefs.gl3d`，显式 `false` 写 `html[data-gl3d="off"]`，正常读取且未显式关闭时写 `on`。`main.js` 在 DOM 启动后仅于 `on` 时调用 `ZX_GL.init()`；成功加 `.gl-on`，初始化失败写 `data-gl3d="off"` 并加 `.gl-off`，回退 DOM。运行时读取的是 **`data-gl3d`**，不是 HTML 初始标记 / 旧注释中的 `data-3d`。存储读取或解析异常时脚本跳过赋值，不应把该情况描述成保证启动 GL。
- `gl3d` 尚未进入 `util.js` 的 `PREF_KEYS` / `prefs()`，也不是「我的」页已实现的开关；经 util 保存其他偏好会丢失该额外字段。验收时需合并写入 `zx.ui_prefs` 的 `gl3d` 后刷新并检查实际模式，不得宣称完整持久化开关链路已实现。GL 帧循环通过引擎读取 `data-motion`，其静止帧、切页与交互须在真实浏览器单独检查。

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

每个前端改动必须跑完以下检查。测试持续新增：测试文件清单用 `HANDOFF.md` §1 的命令实时查看，测试总数与通过 / 失败 / 跳过情况以本次 `npm test` 输出为准，不保留固定数量快照。Node VM 单测只验证模拟环境中的逻辑，**不替代真实浏览器 GL 验收**（WebGL 上下文、CSS3D 布局 / 层级、输入拾取与滚动均需实测）。下表是验收要求，不代表本文已执行或已通过。

| 检查 | 命令 | 判定标准 |
|---|---|---|
| 语法 | `node --check assets/js/<改动文件>.js` | 退出码 0 |
| 单测与冒烟 | `npm test` | 退出码 0、失败数为 0，覆盖与数量按实时输出记录；`pretest` 先跑 `build:engine` |
| 形象门禁 | `npm test`（`test/mascot.test.js`） | 当前测试声明的素材齐全（含品牌位 sprite）；内联副本与源素材逐字节一致；生成器幂等——在临时目录运行 `build-mascot-v4.js`，将产物与工作区逐字节比对；失败也不写工作区 |
| 引擎产物同步 | `npm run build:engine` 后确认 `assets/js/rhythm.build.js` 无差异 | 改过 `shared/engine/*.js` 必须重跑；产物与源码字节一致 |
| CSS 审计 | `npm run audit` | 退出码 0；仅 warn（死 token / 死类候选）可过，存在 error 必须先修 |
| 服务冒烟 | `npm start`（默认监听 `0.0.0.0:8787`，浏览器访问 `127.0.0.1:8787`） | `GET /api/health` 返回 200 且含 `"ok":true`；首页返回 200 |
| 资源引用 | 见下方扫描命令；浏览器另查 Network | 本地 `src` / `href` 文件全部存在（包含 vendor 与 GL），数量取扫描实时输出；HTTP 加载无 404，不能以存在性扫描替代实际执行验证 |
| 真实浏览器 GL | HTTP 与 `file://` 下分别刷新；合并设置 `zx.ui_prefs.gl3d` 为 `true` / `false` 后重载，并测试 WebGL 不可用 | 检查首帧模式、GL / CSS3D 层级、五页导航、对话输入 / 滚动、工作台交互与弹层 / toast；关闭或初始化失败时 DOM 可操作，无未处理错误；记录浏览器 / 视口 / 实际结果，不用 VM 通过情况代替 |
| 离线链路 | 双击 `index.html` 以 `file://` 打开 | 顶栏显示离线褪色形象（`alt` / `title` 为「离线 · 本地计算」），排程 / 记录 / 导出可用，控制台无报错 |
| 离线指示 | 停服后刷新首页；有待上行 op 时复看 | 顶栏出现 `.sync-offline` 头像且不破图；待上行 N 时 `.sync-pending` 角标显示 N；恢复服务后回到圆点 + 「本地优先 · 已同步」 |
| 聆听态 | 在输入框输入文字，再清空、再发送 | 输入台 `.cp-listen` 头像换为聆听形象（`alt` 为「诺瓦正在聆听」）；清空或发送后回待机；停服时同样可显示 |
| 降级与动效 | 停服后重复关键操作；`html[data-motion="off"]` 下复看 | 操作走本地引擎兜底；关动效后不破版——聆听态的呼吸动画随之停止，形象切换不变 |

`index.html` 资源引用全量扫描（在仓库根目录执行）：

```bash
node -e 'const fs=require("fs");const h=fs.readFileSync("index.html","utf8");const re=/(?:src|href)=[\x22\x27]([^\x22\x27]+)[\x22\x27]/g;let m,bad=[],refs=[];while((m=re.exec(h))){const p=m[1];if(/^(https?:|#|data:)/.test(p))continue;refs.push(p);if(!fs.existsSync(p))bad.push(p);}console.log(refs.join("\n"));console.log("本地引用数: "+refs.length+"; 缺失数: "+bad.length);if(bad.length){console.log("MISSING: "+bad.join(", "));process.exit(1);}'
```

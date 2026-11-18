# 诺瓦 Nova · 学生日程助理

面向学生的、可运行、可解释、可复现的日程助理 Demo。左侧对话栏用自然语言驱动右侧工作台，后端提供确定性调度引擎与 REST API；**同一套引擎代码**既供后端在线计算，也供前端离线兜底。

> **定位**：意图识别是关键词匹配，排程 / 重排 / 归因全部由纯函数计算，**不调用大模型**——相同输入必得相同输出，每个排程决策都附一句人类可读的理由。
>
> **视觉**：日漫清晰线（奶油纸白 + 天空蓝单一活性色，2px 实墨线全框，云朵气泡对话），助理人格「诺瓦」贯穿品牌标记与各场景，设定见 [`docs/IP-DESIGN.md`](docs/IP-DESIGN.md)。

---

## 核心能力

| 能力 | 说明 |
|---|---|
| 目标与可行性 | 新建目标 → 可行性判定（工时 `T` 与需求 `D` 求 `R`，四档：充裕 ≥ 1.2 / 合理 ≥ 0.9 / 偏紧 ≥ 0.7 / 阻断；`R < 0.7` 阻断并给三条校准路径）→ 拆解草案可改工时 / 增删 / 排序 → 确认生效 |
| 排程与重排 | 30 分钟粒度装箱（不可用时段、日上限、单科目连续时长、弹性位优先级四条硬约束，违反即不排入）；四级重排 L1 顺延 → L2 压缩 → L3 替代 → L4 放弃，有序执行，首个通过防雪崩校验即停，支持逐条否决 |
| 重排可撤销 | 重排前写快照，撤销即反向应用，**不重算**，与重排前逐条一致 |
| 执行与挽救 | 计时 / 暂停 / 部分完成（25–100%）/ 跳过 / 补录，全部写入幂等 op 队列；连续 ≥ 3 天无记录进入挽救，缺口量化后压缩 / 顺延 / 降级三选一，零惩罚回归 |
| 归因与周报 | 偏差归因固定顺序（计划过载 → 执行中断 → 效率不足 → 外部干扰）；周报三段式（结论 / 依据 / 已执行动作），含达成率趋势、科目结构、归因占比 |
| 计划与设置 | 本周日程块拖动改期（日上限 300 分钟）、手动锁定、显性「重新安排」入口；可用时段 7×4 网格与批量复制、CSV 导出、删除全部数据（7 天内可恢复） |
| 离线与移动端 | 无后端时降级到本地引擎；≤860px 单列 + 顶端导航条（对话为首页） |

**三条防雪崩断言**（同时成立才采纳重排）：单次重排后未来 7 天负载增幅 ≤ 20%；任何情况下不得清空弹性位；连续 3 次重排未改善即停止并转目标校准。

---

## 快速开始

**只开前端（零环境）**：双击 `index.html`，浏览器以 `file://` 打开即走本地引擎，全部功能可用，顶栏显示「离线 · 本地计算」。

**前后端完整运行**：

```bash
npm start     # 启动服务，默认端口 8787
npm test      # 引擎单测 + HTTP 冒烟
```

打开 `http://127.0.0.1:8787/`：服务同时静态托管前端，前后端同源，顶栏显示「本地优先 · 已同步」。

**环境要求**：Node.js **22+**（仅 `npm start` / `npm test` 需要，双击打开 `index.html` 不需要任何环境）；**零第三方依赖**，只用 `node:http` / `node:fs` / `node:path` / `node:url` / `node:crypto` 等内置模块，无需 `npm install`。

### 命令

| 命令 | 作用 | 备注 |
|---|---|---|
| `npm start` | 启动 HTTP 服务（API + 静态托管前端） | `prestart` 会先重建引擎产物 |
| `npm test` | 引擎单测 + HTTP 端到端冒烟 | `pretest` 会先重建引擎产物 |
| `npm run build:engine` | 由 `shared/engine/*.js` 生成 `assets/js/rhythm.build.js` | **改过引擎必须重跑**，否则前端离线兜底跑旧逻辑 |
| `npm run audit` | CSS 审计（括号平衡 / 硬编码色 / 破损选择器） | 脚本见 `scripts/css-audit.mjs` |
| `npm run build:cloudbase` | 生成云函数包 `.deploy/cloudbase-functions/nova` | 产物不入库（`.gitignore` 已忽略 `.deploy/`） |

> `shared/engine/` 是排程逻辑的**唯一实现**，`assets/js/rhythm.build.js` 是它的浏览器产物，禁止手改。引擎改动必须重跑 `npm run build:engine` 并提交产物，否则后端在线与前端离线会跑出两套行为。

### 环境变量

本项目不自动读取 `.env`（零第三方依赖），请通过 shell 或部署平台注入；清单见 [`.env.example`](.env.example)（只含变量名与说明，无真实值，`.env` 已被 `.gitignore` 忽略）。

| 变量 | 缺省 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口（`server/main.js` 的 `DEFAULT_PORT`） |
| `HOST` | `0.0.0.0` | 监听地址（`DEFAULT_HOST`）；本机自用建议显式设 `127.0.0.1` |
| `NOVA_AUTH_SECRET` | 本地随机 / 生产必填 | 凭证 HMAC 密钥，需 ≥32 字节随机串；`NODE_ENV=production` 未配置直接拒绝启动 |
| `NOVA_TRUST_PROXY` | 未设置 | 置于网关 / 反代之后时设为 `1`，按 `X-Forwarded-For` 最后一跳隔离限流桶；不设则按不可伪造的 TCP 对端地址 |
| `CORS_MODE` | 未设置 | 云函数经 HTTP 网关暴露时设为 `off`，避免与网关回填的 `Access-Control-Allow-Origin` 冲突 |
| `NODE_ENV` | 未设置 | 设为 `production` 启用生产约束（鉴权密钥必填等） |

> 缺省值以 `server/main.js` 为准：`.env.example` 里的 `PORT=8080` / `HOST=127.0.0.1` 是示例取值，不是缺省。缺省绑定 `0.0.0.0`，启动横幅打印 `http://0.0.0.0:8787`，浏览器请用 `http://127.0.0.1:8787/` 访问。

---

## 部署到腾讯云 CloudBase

本项目可打包为 CloudBase HTTP 云函数部署，函数包由构建脚本生成，零第三方依赖。

| 项目 | 值 |
|---|---|
| 部署形态 | HTTP 云函数 `nova`（常驻监听 `9000`，由 `scf_bootstrap` 拉起） |
| 运行时 | `Nodejs20.19`（代码只用 Node 20 起稳定的内置模块，与本地 Node 22+ 跑同一份逻辑） |
| 函数包 | `.deploy/cloudbase-functions/nova`（约 529 KB / 45 个文件，零依赖） |

> 环境 ID、访问域名等云资源标识由部署方在自己的 CloudBase 环境中确定，不在本仓库固化。

**为什么是云函数而不是云托管**：本服务无状态——只做「请求进来 → 纯函数计算 → 响应」，无 WebSocket / SSE 长连接、不需常驻后台进程、不访问 VPC 内数据库、无自定义系统依赖。按请求计费且可缩容到 0，无需初始化云托管环境。

**构建与更新**：

```bash
npm run build:cloudbase   # 产出 .deploy/cloudbase-functions/nova
```

构建脚本把 `index.html` / `assets/` / `shared/` / `server/` 复制到 `.deploy`，再落入口文件（`deploy/cloudbase/function/index.js`、`scf_bootstrap`），源仓库结构不变。更新线上代码：重新构建，再用 CloudBase 的 `manageFunctions(action="updateFunctionCode", functionName="nova")` 上传。

**部署相关的三处适配**：

1. **CORS**：`CORS_MODE=off` 时关闭响应头——网关已按环境安全域名回填 `Access-Control-Allow-Origin`，函数再写一次会得到 `<origin>,*` 非法多值头，浏览器直接判为 CORS 失败。`scf_bootstrap` 默认关闭，本地 `npm start` 不受影响。
2. **入口与引导**：`deploy/cloudbase/function/index.js` 复用 `server/main.js` 导出的 `start()` 并绑定 `9000`；`scf_bootstrap` 使用 `/var/lang/node20/bin/node`，与 `Nodejs20.19` 严格对应。
3. **鉴权**：云函数必须配置 `NOVA_AUTH_SECRET`（≥32 字节随机串），网关需放行 `Authorization` 请求头并强制 HTTPS；网关 / 反代场景建议设 `NOVA_TRUST_PROXY=1`，避免全部访客共享同一限流桶。本地未设密钥时自动用进程级随机密钥，无感。

---

## 使用指引

### 界面

顶栏为品牌、主导航（**对话 / 今日 / 计划 / 数据 / 我的**）、同步状态与引擎状态，按 `/` 进入对话页。**对话是主页面**：消息历史跨页签保留，诺瓦驱动其余工作台子页；每页只保留首要信息，次要内容默认收起（展开态写入本机 `zx.folds`，刷新后保持）。

| 视图 | 内容与操作 |
|---|---|
| 今日 | 任务卡、达成率、弹性位；开始后可暂停 / 继续，结束后选 25–100% 完成度与状态，未开始可跳过，区标题「补录」可事后记录 |
| 计划 | 新建目标 / 重新安排；可行性 `R` 与四档刻度、「本周日程块」（拖动改期、锁定）、未来 7 天负载 |
| 数据 | 本周概览、三段式周报与预置调整优先展示；8 周趋势、科目结构、偏差归因默认收起 |
| 我的 | 可用时段 7×4 网格（点选 / 复制到工作日 / 清空 / 恢复默认）、通知开关优先展示；数据与隐私、显示与动效默认收起 |

九态形象全部落地：等待响应「计算中」、计时「专注」、完成「达成」、中断「挽救」、归因与负载预警「提醒」、无后端「离线」、未命中「兜底」。

### 对话指令

关键词命中即触发，无需固定句式：

| 你说 | 效果 |
|---|---|
| 新建目标 / 定目标 / 改目标 | 打开「设定你的目标」四步流程 |
| 我断了四天 / 中断 / 挽救 | 进入中断挽救，缺口量化后三选一 |
| 今天学什么 / 安排 / 任务 | 列出今日任务与剩余时长 |
| 我的计划可行吗 / R 值 / 来得及吗 | 输出可行性评估与判定档位 |
| 这周落下了 / 帮我重排 / 来不及 / 崩了 | 走四级重排，给出策略、diff 与负载变化 |
| 撤销 / 恢复 / 撤回 | 回滚上一次重排 |
| 数学多给两小时 / 加时间 | 调整单科配额并重算 |
| 生成周报 / 复盘 / 这周怎么样 | 输出周报 |
| 我有点累 / 状态不好 / 压力 | 降载：把低权重项顺延到弹性位，不计断更 |
| 开始 / 计时 / 专注 | 对当前任务启动计时 |
| 确认放弃 | 确认采纳含「放弃」项的重排（L4 经确认才生效） |

未命中任何关键词时返回兜底说明，不臆造结果。

### 已知边界

- **数据不持久化**：`server/store/memory.js` 是内存态，服务重启 / 函数实例回收后回到种子数据。新目标、打卡记录、跳过 / 补录经本机 overlay（`zx.overlay`）跨刷新存活；改期、锁定只写本机 op 队列，未接服务端持久化。
- **单人演示账户**：已内置 Bearer 凭证鉴权（`server/auth.js`，401 / 403 与写接口 429 限流，凭证由 `POST /api/auth/session` 签发），但无注册 / 多用户体系。
- **默认域名中间页**：CloudBase 默认测试域名（`*.app.tcloudbase.com`）首次导航会展示一次「风险提醒 / 确定访问」中间页，点击一次后 Cookie 有效期内不再出现；唯一移除方式是绑定已备案的自定义域名。程序化调用（fetch / curl）不受影响。
- **通知开关仅记录意图**，不实际投递推送；CSV 导出为浏览器本地生成，不经过服务端；**删除全部数据**会先在本机留存 7 天快照，恢复入口在「我的」。
- **种子数据**（用户「林清」及全部任务、记录）均为虚构演示数据，不含真实个人信息；**页面不加载第三方脚本、字体或统计代码**，无埋点、无 Cookie，业务数据仅存于本机内存与 `localStorage`。

---

## 目录结构

```
.
├── index.html                # 前端入口，支持 file:// 双击打开
├── .env.example              # 环境变量模板（仅变量名与说明）
├── LICENSE                   # MIT 许可证
├── assets/
│   ├── css/app.css           # 样式（单一来源，CSS 变量驱动）
│   ├── img/                  # 诺瓦 v4 形象素材（build-mascot-v4.js 生成）
│   └── js/
│       ├── api.js            # 后端通信 + 超时降级 + op 队列
│       ├── engine.js         # 引擎桥接（后端优先 → 本地引擎产物）
│       ├── rhythm.build.js   # 自动生成：由 shared/engine/* 拼接的浏览器产物
│       ├── state.js          # 应用状态
│       ├── assistant.js      # 对话意图路由与重排流程
│       ├── ui.js             # 共享 UI 原语：弹层 / 确认 / 轻提示
│       ├── util.js           # 通用工具与视觉偏好
│       ├── main.js           # 引导、事件绑定、移动端导航
│       ├── flows/            # 目标落地 / 中断挽救 / 执行记录 / 计划交互 / 设置
│       └── views/            # 今日 / 计划 / 数据 / 我的 四视图
├── shared/
│   ├── engine/               # 确定性引擎（双模 UMD，前端只读引用）
│   │   ├── feasibility.js    # 可行性评估：T / D → R 与判定
│   │   ├── schedule.js       # 排程装箱（硬约束 + 弹性位）
│   │   ├── replan.js         # 四级重排 + 快照撤销
│   │   └── attribute.js      # 偏差归因（固定判定顺序）
│   └── data/seed.js          # 共享种子数据
├── server/
│   ├── main.js               # HTTP 入口（API + 静态托管 + CORS + 限流）
│   ├── auth.js               # Bearer 凭证鉴权（签发 / 校验 / 429 限流）
│   ├── api/routes.js         # REST 路由
│   └── store/memory.js       # 内存存储
├── scripts/                  # 构建脚本（引擎产物 / 云函数包 / 形象 / CSS 审计）
├── design-preview/mascot/    # 形象预览页与各版形象稿（archive-v3 为历史归档）
├── deploy/cloudbase/         # 云函数入口与引导脚本（构建时落入 .deploy/）
├── test/                     # engine.test.js 引擎单测 / api.test.js HTTP 冒烟
└── docs/                     # ARCHITECTURE / HANDOFF / FRONTEND-CONTRACT / IP-DESIGN
```

`shared/` 下全部为纯函数模块：不读时钟、不读随机数、不做 I/O，采用 UMD 形态以同时支持浏览器 `<script>` 与 Node `require()`。

---

## 文档索引

| 文档 | 内容 | 何时看 |
|---|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 架构说明与生产形态设计稿摘编 | 理解分层、数据流与设计意图 |
| [`docs/HANDOFF.md`](docs/HANDOFF.md) | 前后端接口契约（字段级定义 + 错误码附录） | 改 API 或做前后端对接 |
| [`docs/FRONTEND-CONTRACT.md`](docs/FRONTEND-CONTRACT.md) | 前端开发约定与阶段记录 | 改前端视图与交互 |
| [`docs/IP-DESIGN.md`](docs/IP-DESIGN.md) | 「诺瓦」形象设定与版权边界 | 改形象素材或对外文案 |

---

## API

基址 `http://127.0.0.1:8787/api`，全部返回 JSON，错误统一为 `{ error: { code, message } }`。字段级契约见 [`docs/HANDOFF.md`](docs/HANDOFF.md) 第 5 节。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/health` | 健康检查（免鉴权） |
| POST | `/api/auth/session` | 签发 Bearer 演示凭证（免鉴权；其余接口均需凭证） |
| GET | `/api/state` | 初始全量状态 |
| POST | `/api/feasibility` | 可行性评估 |
| POST | `/api/schedule` | 排程 |
| POST | `/api/replan` | 四级重排（含快照） |
| POST | `/api/replan/confirm` | 确认采纳含「放弃」项的重排（`{ result }`，L4 经确认才生效） |
| POST | `/api/replan/undo` | 撤销重排 |
| POST | `/api/attribute` | 偏差归因 |
| POST | `/api/sync/ops` | 批量上行（单批 ≤ 200；打卡 / 执行记录也经此上行） |

> 2026-11-15 简化批下线：`POST /api/sessions`（打卡统一走 `/api/sync/ops`）、`GET /api/sync?since=N`（op 日志只写不读，增量拉取撤除）、`GET /api/reports/weekly`（周报由前端本地渲染）。三者返回 404。

---

## License

[MIT](LICENSE)

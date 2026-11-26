# 诺瓦 · IP 形象设定（v4）

> 「诺瓦 Nova」的视觉 IP 规范。本文件只描述**当前 v4 形象的实际规范**。
> 唯一事实来源：[`scripts/build-mascot-v4.js`](../scripts/build-mascot-v4.js)（几何与色板）、[`assets/img/`](../assets/img/)（实际产出）、[`assets/css/app.css`](../assets/css/app.css)（产品主题色）、[`assets/js/`](../assets/js/)（接入点）。
> 历史方案（v1 / v2 / v3）已不作为规范。

## 1. 名字与人格

### 1.1 名称与身份锚点

- 产品名与助理同名：`诺瓦 Nova`。页面标题为「诺瓦 Nova · 大学生日常助理」，顶栏品牌区为「Nova诺瓦 / 大学生日常助理」（`index.html`）。
- 助理侧消息署名固定为「诺瓦」，用户侧署名为「你」（`assets/js/assistant.js`）。助理消息右下角有蜜桃「诺」印落款 `.seal-no`（15×15，`--peach-dk` 底 + `--ac-ink` 字）。
- 身份锚点是消息右下角的蜜桃落款印 `.seal-no`（CSS 绘制，与形象同源）；立绘（`assets/img/mascot-v4*.svg`）**不刻字、不带印章**——小字号在形象缩放尺寸下不可读，机身保持素净。

### 1.2 性格定位（对应可验证的产品行为）

| 性格 | 在产品里的落点 | 证据 |
|---|---|---|
| 确定性 | 同一输入必得同一输出，排程可复现 | `README.md`、`shared/engine/` |
| 给理由 | 排程与重排决策都带一句 `reason` | `shared/engine/replan.js`、`shared/engine/feasibility.js` |
| 兜底诚实 | 关键词未命中就直说没接住，不臆造结果 | `assets/js/assistant.js` 的 `fallback()`（对应状态 ⑨） |
| 不催促 | 只陈述事实与选项；九种表情的情绪上限是「平静—关切—欣喜」 | 状态系统（§4） |

### 1.3 说话风格约定

- 短句、口语、不卖萌；`assets/js/` 全部话术不使用感叹号。
- 调整计划时给理由（对应引擎 `reason`），不只报结论；听不懂就直说不知道，并列出已支持的动作类别（`fallback()` 的既有行为）。
- 自称「诺瓦」；用户侧署名为「你」。

## 2. 造型规范（v4）

### 2.1 画布

| 素材 | 画布 | viewBox | 用途 |
|---|---|---|---|
| 主立绘 `mascot-v4*.svg` | 240×210 | `0 0 240 210` | 对话区 / 工作台插画 |
| 脸形头像 `avatar-v4*.svg` | 96×96 | `0 0 96 96` | 顶栏品牌标记；`avatar-v4-sprite.svg` 为 8 帧横排（768×96）品牌位待机动画——首末帧与 `avatar-v4.svg` 同构，中间帧双耳绕耳根对称外摆 / 内收并整体轻微上浮，供 CSS `steps()` 逐帧触发 |
| 应用图标 `favicon-v4.svg` | 16×16 | `0 0 16 16` | 浏览器标签页 / 手机桌面 |

### 2.2 结构与部件

绘制顺序（生成脚本 `body()` 的次序）：飞溅碎片 → 双耳光柱 → 耳根透镜 → 机身（冷边线 + 边缘内阴影环 + 左上缘光 + 下部接缝弧） → 机身暗部 → 机身高光 → 耳根关节盘 → 面罩组（底 + 顶部反光带 + 底部压暗弧 + 描边 + 内圈 + 脸） → 状态装饰 → 地面投影（双层）。

| 部件 | 规格（坐标与尺寸取自生成脚本） |
|---|---|
| 机身 | 椭圆 cx 130 cy 142 rx 55 ry 47，填 `#FFFFFF`，外加 1px `rgba(18,26,40,.10)` 冷边线；内侧一圈 7px `rgba(18,26,40,.06)` 边缘内阴影环（rx 51.5 ry 43.5，裁切机身内，体积感）；左上缘光弧 2.2px `rgba(255,255,255,.8)`（M 89 111 → 166 108，opacity .75）；下部接缝弧 1.5px `rgba(18,26,40,.08)`（M 86 172 → 174 172，机械细节） |
| 机身暗部 / 高光 | 椭圆 cx 148 cy 170 rx 34 ry 16 `rgba(18,26,40,.07)`（裁切在机身轮廓内）／椭圆 cx 108 cy 119 rx 18 ry 9 rotate −22° `rgba(224,234,248,.55)` |
| 面罩 | 椭圆 cx 138 cy 141 rx 34 ry 35，整组 rotate 20°；底 `#1A2230`，描边 5px `#4C7FD0`，内圈 1px `rgba(255,255,255,.07)`；玻璃舱层次——顶部内侧反光带 7px `rgba(255,255,255,.13)`（M 114 127 → 162 127 弧）+ 底部压暗弧 5px `rgba(0,0,0,.3)`（M 120 163 → 156 163 弧），叠在纯色底上，不改涂装面色 |
| 面罩反光片 | 矩形 x 140 y 104，31×23 rx 8，`rgba(255,255,255,.42)`，压住右眼上缘 |
| 眼（待机） | 左 x 117 y 131，7×24 rx 3.5；右 x 151 y 122，6.5×22 rx 3.25；各带一条白色高光条与一层低辉光垫层（外扩 3px 同色 `opacity .2` rx 6，仅待机族竖眼） |
| 左耳 | 根部 (98,108) → 尖端 (28,30)；根部半宽 11.5 → 尖端半宽 2.2 |
| 右耳 | 根部 (128,100) → 尖端 (152,16)；根部半宽 9.5 → 尖端半宽 1.8 |
| 耳杆分段 | 在 0.42 / 0.78 处两段切分，三档不透明度由实到淡，尖端补一枚同色圆与一圈低辉光晕（r 2.2×端点半宽，`opacity .3`） |
| 耳根透镜 / 关节盘 | 透镜左 (91,100.2) rx 10.5 ry 5 rotate 48°、右 (131.4,88.2) rx 8 ry 4.5 rotate −74°，各含一枚更小亮芯与一枚白高光点（r 1.5 / 1.2，`rgba(255,255,255,.85)`）；关节盘左 (95.5,105.5) r 5.5、右 (129.5,95.5) r 5，各带 1px `rgba(18,26,40,.14)` 细描边 |
| 进度环（仅专注态） | (85,171) r 14，2.6px `#A03B2C` 虚线（dasharray `38 50`），rotate −90°；原套在胸口印外，印移除后独立成环 |
| 悬浮飞溅 | 8 片椭圆（主档 6 + 次档 2）：左下组 rotate −18°~−26°，右侧组 rotate +24°~+28° |
| 地面投影 | 双层：椭圆 cx 130 cy 196 rx 41 ry 6.5 `rgba(18,26,40,.11)` opacity .5 ＋ rx 29 ry 4.2 同色实档 |
| 朱砂「诺」印 | ——已移除：立绘不刻字（小字号在 96–132px 显示下不可读），身份锚点由消息落款印 `.seal-no` 承担 |
| 机身倾角 | 仅挽救态：整体 rotate −7°（支点 130,142） |

### 2.3 描边与配色使用规则

- 机身不加粗勾线；分缘靠明暗（暗部 + 高光）与 1px 冷边线。面罩的 5px 描边是全片唯一粗描边。
- 眼与耳条纹本体仍是「亮色」：不画渐变、不加投影；允许**低辉光**——单层同色低透明垫层 / 端点晕（opacity ≤ .3，无扩散多层、无模糊滤镜），读作「微微发光」而非光污染。
- 朱砂只出现在「正在进行」语义（专注态的耳、面罩描边、进度环）与身份锚点（消息落款印）；**立绘不刻字**。
- 各状态之间只改四样：面罩里的脸、涂装色板、状态装饰、耳的色相与透明度；机身 / 面罩 / 耳杆 / 关节盘的骨架各态一致。

### 2.4 经典版与产品版

同一几何、两套皮肤，差异只在色板：产品版为墨蓝涂装（机身 `#FFFFFF`、面罩 `#1A2230`、描边与眼 `#4C7FD0`、关节盘 `#E7ECF3`），经典版为原味涂装（机身 `#F7FAFB`、面罩 `#05070B`、描边与眼 `#2FE3F2`、关节盘 `#FFFFFF`），完整色值见 §3.2 与 §3.3。

经典版还原「球形机身 + 亮青光柱耳」的周边气质，只用于表情包、周边与宣传物料，**不进产品界面**。

## 3. 配色规范

### 3.1 产品主题色（`assets/css/app.css` 的 `:root`）

现行视觉语言为 Claymorphism（黏土，2026-11-22 选定），以 `docs/FRONTEND-CONTRACT.md` §5 与 `assets/css/app.css` 的有效 token 为准；旧奶油纸 / 天空蓝配色已不再是规范。下表取自 `app.css` 的首个 `:root` 块（`data-*` 深色档为断点覆盖，不改基础规范）。

| 角色 | token | 值 |
|---|---|---|
| 页面底 / 卡片面 / 次级面 | `--bg` / `--panel` / `--panel2` | `#EFE9F7` / `#FFFFFF` / `#F7F4FC` |
| 分隔线 | `--line` / `--line2` | `rgba(143,130,217,.20)` / `rgba(143,130,217,.30)` |
| 正文 / 次级 / 元信息 | `--txt` / `--txt2` / `--txt3` | `#4A4463` / `#655E86` / `#736D92` |
| 活性色（主色）/ 半透 / 浅底 | `--ac` / `--ac2` / `--acbg` | `#178265` / `rgba(23,130,101,.5)` / `rgba(59,175,142,.10)` |
| 活性色按钮上的字色 | `--ac-ink` | `#0a1a10` |
| 蜜桃（承接旧 `--pink` / `--cinnabar` 两名） | `--pink` / `--cinnabar` | `#E8955B` / `#E8955B` |
| 荧光笔底（不承载语义） | `--hlbg` | `#EFE7FF` |
| 警示 / 危险 / 正常 | `--warn` / `--bad` / `--ok` | `#A9713A` / `#C25B4E` / `#1E8F6C` |

衍生层（`--ac-a08`…`--ac-a45`、`--warn-a*`、`--bad-a*`、`--ok-a*`）由 `color-mix()` 从基础色派生，换肤只改 `:root` 基础值。

**主题色与形象用色不是同一套值**，分三种关系：

- 形象主色 `#4C7FD0`（面罩描边 / 竖条眼 / 耳根透镜）属冷蓝，与 UI 活性色 `--ac #178265`（深薄荷）既不同值也不同色系，互不引用；改 UI 主色不必改形象。
- 消息落款印已由朱砂改为蜜桃：`--peach-dk #E8955B` 底 + `--ac-ink` 字；专注态的耳、面罩描边与进度环仍用形象侧朱砂 `#A03B2C`，两套色板互不影响。
- `favicon-v4.svg` 底色 `#FBF7EF` 是图标专用纸底；`index.html` 的 `<meta name="theme-color" content="#07130D">` 对应 `app.css` 深色档的 `--bg`，二者与浅色档 `--bg #EFE9F7` 均不同值，不构成同源同值关系。

### 3.2 墨蓝涂装（产品内使用）

色值取自生成脚本的 `BLUE` 色板：

| 色 | 值 | 用途 |
|---|---|---|
| 机身纸白 / 高光 / 暗部 | `#FFFFFF` / `rgba(224,234,248,.55)` / `rgba(18,26,40,.07)` | 机身主体与分缘 |
| 面罩 / 描边与眼 / 墨蓝亮芯 | `#1A2230` / `#4C7FD0` / `#A9C4E8` | 面罩底、描边与竖条眼、耳内亮芯 |
| 眼高光 / 面罩反光片 | `rgba(255,255,255,.55)` / `rgba(255,255,255,.42)` | 玻璃光感 |
| 耳杆三档 | `rgba(76,127,208,.94)` / `.55` / `.28` | 根段 / 中段 / 尖端 |
| 耳根透镜 / 亮芯 | `rgba(76,127,208,.94)` / `rgba(169,196,232,.88)` | 耳根 |
| 朱砂「诺」印 | ——已移除：立绘不刻字（小字号在 96–132px 显示下不可读），身份锚点由消息落款印 `.seal-no` 承担；专注态进度环保留原位 (85,171) |
| 飞溅两档 / 地面投影 | `rgba(76,127,208,.16)` / `.11` 与 `rgba(18,26,40,.11)` | 悬浮碎片与落地感 |

### 3.3 原味涂装（`mascot-v4-classic.svg` 专用，不进产品 UI）

| 色 | 值 | 用途 |
|---|---|---|
| 机身近白 / 面罩纯黑 | `#F7FAFB` / `#05070B` | 机身与面罩底 |
| 亮青 / 眼亮芯 | `#2FE3F2` / `#C9F4FC` | 面罩描边与竖条眼、耳与眼亮芯 |
| 耳杆两档 | `rgba(161,234,236,.6)` / `.28` | 中段 / 尖端 |
| 耳根透镜 / 亮芯 | `rgba(120,226,232,.94)` / `rgba(201,244,252,.9)` | 耳根 |
| 关节盘 | `#FFFFFF` | 耳根关节 |
| 飞溅两档 | `rgba(47,227,242,.2)` / `.13` | 悬浮碎片 |

### 3.4 离线褪色涂装（⑧ 专用）

整体褪为低饱和暖灰：机身 `#EAEDF2`、面罩 `#333B47`、描边与眼 `#A9B2BE`、眼亮芯 `#C8CFD8`、耳杆 `rgba(18,26,40,.10)` 与 `.06`、耳根透镜 `rgba(18,26,40,.22)`、关节盘 `#DDE2EA`、纸条纸底 `#F4F6F9`、地面投影 `rgba(18,26,40,.08)`。

## 4. 状态系统（9 态素材 = 9 个场景设定）

| # | 状态 | 视觉变化 | 素材文件 | 触发场景 | 前端接入点 |
|---|---|---|---|---|---|
| ① | 待机 idle | 标准竖条眼（右眼略高） | `mascot-v4.svg` | 进入对话页的欢迎语首屏 | `assets/js/main.js` `greetingHtml()`（132×116） |
| ② | 聆听 listening | 眼高 ×1.28 + 耳侧声弧 | `mascot-v4-listen.svg`、`avatar-v4-listen.svg` | 用户在对话页输入框输入时 | `assets/js/main.js` `updateListen()`（输入台头像，24×24） |
| ③ | 计算中 scheduling | 面罩内六点矩阵（右列抬高 2px） | `mascot-v4-calc.svg` | 助理正在处理、等待回复 | `assets/js/assistant.js` `typing()`（24×21） |
| ④ | 专注 focusing | 耳与面罩描边转朱砂 + 朱砂进度环 | `mascot-v4-focus.svg` | 今日页任务计时进行中 | `assets/js/views/today.js` 任务行（24×30） |
| ⑤ | 达成 done | 月牙眼 + 笑弧 + 纸屑 | `mascot-v4-done.svg` | 任务完成；挽救完成后的横幅 | `assets/js/flows/exec.js`、`assets/js/flows/rescue.js`（32×28） |
| ⑥ | 挽救 rescue | 闭眼下弯 + 机身 −7° + 递出纸条 | `mascot-v4-rescue.svg` | 今日页顶部的中断横幅 | `assets/js/flows/rescue.js`（32×28） |
| ⑦ | 提醒 warn | 紧张眼「><」+ 耳变深墨蓝 + 耳尖闪线 | `mascot-v4-warn.svg` | 数据页「偏差归因」面板；重排后未来 7 天负载增幅 ≥ 20% 的预警旗标 | `assets/js/views/data.js`、`assets/js/views/plan.js`（22×19） |
| ⑧ | 离线 offline | 横条眼 + 整体褪色 | `mascot-v4-offline.svg`、`avatar-v4-offline.svg` | 后端不可达（网络失败或超时）时的顶栏同步位 | `assets/js/main.js` `updateSync()`（24×24 头像，褪色涂装） |
| ⑨ | 兜底 unknown | 单眼 + 「?」 + o 嘴 | `mascot-v4-unknown.svg` | 关键词未命中的兜底回复 | `assets/js/assistant.js` `fallback()`（32×28） |

九态素材**全部已接入产品**：② 聆听 与 ⑧ 离线 以头像形态接入（24×24），其余七态为立绘；②⑧ 的全身立绘（`mascot-v4-listen.svg`、`mascot-v4-offline.svg`）未接入。`mascot-v4-classic.svg` 为原味涂装，按 §3.3 不进产品 UI。

情绪上限为「平静—关切—欣喜」三档：⑧是状态性褪色而非情绪，⑦是紧张但克制（只改眼形与耳色，无红色、无尖角）。

## 5. 产品接入

### 5.1 生成与来源

- 全部 15 个 SVG（10 个 `mascot-v4*.svg` + 4 个 `avatar-v4*.svg` + `favicon-v4.svg`）由 `node scripts/build-mascot-v4.js` 生成到 `assets/img/`；同一脚本还生成 `assets/js/mascot-inline.js`。脚本零依赖，只写这两个产物位置，不读其它目录。该命令不在 `package.json` 的 scripts 里，需直接用 node 执行；重新生成的结果与仓库内文件逐字节一致。
- 同一脚本另生成 `assets/js/mascot-inline.js`：待机 / 聆听 / 离线三枚头像（`avatar-v4.svg`、`avatar-v4-listen.svg`、`avatar-v4-offline.svg`）的 base64 data URI 内联副本，导出 `window.ZX_MASCOT.idleAvatar` / `listenAvatar` / `offlineAvatar`。静态资源以 `Cache-Control: no-cache` 提供，后端不可达时无法加载，而离线指示与聆听切换恰好在这种时刻发生，故用不依赖网络的内联副本。该文件同属产物，禁止手改。
- 素材只走本地相对路径，不加载第三方资源。

### 5.2 favicon 与首屏形象

| 位置 | 引用方式 | 尺寸 |
|---|---|---|
| 标签页 / 桌面图标 | `index.html`：`<link rel="icon" href="assets/img/favicon-v4.svg" type="image/svg+xml" />` | 16×16，底色 `#FBF7EF` |
| 顶栏品牌标记 `.seal` | `index.html`：`<div class="seal" aria-hidden="true"></div>`；`app.css` 以 `assets/img/avatar-v4-sprite.svg` 作 `background` 逐帧动画 | 26×26，8 帧 |
| 顶栏离线指示 | `assets/js/main.js` `updateSync()`：`<img class="sync-offline" …>`，`src` 取 `window.ZX_MASCOT.offlineAvatar`，回退 `assets/img/avatar-v4-offline.svg` | 24×24 |
| 输入台聆听指示 | `index.html`：`<img class="cp-listen" id="cpListen" src="assets/img/avatar-v4.svg" …>`；`assets/js/main.js` `updateListen()` 按「焦点在输入框且有非空文本」在 `window.ZX_MASCOT.listenAvatar` / `idleAvatar` 间切换 | 24×24 |
| 对话欢迎语首屏 | `assets/js/main.js` `greetingHtml()`：`<img class="msg-mascot" src="assets/img/mascot-v4.svg" width="132" height="116" alt="诺瓦" />` | 132×116 |

`favicon-v4.svg` 底色为 `#FBF7EF`；`<meta name="theme-color" content="#07130D">` 取 `app.css` 深色档 `--bg`，与浅色档 `--bg #EFE9F7` 不同值，详见 §3.1。

### 5.3 状态图的使用位置

见 §4 表。对应样式类在 `assets/css/app.css`：`.msg-mascot`（132×116）、`.msg-state` / `.msg-state.state-calc`（32×28 / 24×21）、`.tk-mascot`（24×30）、`.sb-mascot`（32×28）、`.warn-flag`（22×19）、`.sync-offline`（24×24，顶栏离线头像）、`.sync-pending`（保留兼容类，本地模式不再显示待上行角标）、`.cp-listen` / `.cp-listen.listening`（24×24，输入台聆听头像与聆听态呼吸）。助理消息落款印由 `.seal-no` 渲染（`--peach-dk` 底 + `--ac-ink` 字），不占用独立素材。

### 5.4 动效归属

SVG 内不含任何动画（经 `<img>` 引用也读不到页面上的 `data-motion` 开关）；动效只加在产品侧的 `img` 元素上：漂浮 `novaFloat`、呼吸 `novaBreathe`、到场 `novaEnter`、盖章 `novaStamp`、弹跳 `novaPop`、歪头 `novaWobble`、摇头 `novaShake`。总闸唯一：`html[data-motion="off"]`（`assets/css/app.css`）。聆听态的输入台头像（`.cp-listen.listening`）复用 `novaBreathe`（2.6s，幅度 1.06）——24px 下两态静态差异仅在眼高，靠这层呼吸让状态可辨；关动效后即停止，不改形象切换。

## 6. 禁用清单

- 禁止手改 `assets/img/` 下的任何 SVG：素材是 `scripts/build-mascot-v4.js` 的产物，手改会被下一次生成覆盖；要改造型就改生成脚本再重新生成。
- 禁止把 `mascot-v4-classic.svg`（原味涂装）接入产品界面；它只用于表情包、周边与宣传物料。
- 禁止给眼、耳透镜、耳杆加渐变与投影；辉光仅限 §2.3 的低辉光档（单层、opacity ≤ .3，无扩散多层、无模糊滤镜）。
- 禁止用朱砂做装饰（按钮底色、贴纸、边框）；朱砂只承担「正在进行」语义与身份锚点（消息落款印）。
- 禁止更换机身轮廓语言：椭圆机身 + 斜向细长光柱耳 + 椭圆大面罩 + 竖条眼是识别度所在，不改回方盒、不加棱角；也禁止给机身加粗勾线（分缘靠明暗与 1px 冷边线）。
- 禁止在 SVG 内写动画或自己做动效判断：动效统一在产品侧，总闸是 `html[data-motion="off"]`。
- 禁止对《赛尔号》超能 NoNo 原设做描摹、拼贴或换色混用；本形象为原创构型，生成脚本与产出的 SVG 内均标注了该边界。

## 7. 验证方式

| 目标 | 命令 | 判定标准 |
|---|---|---|
| 素材、内联副本与门禁 | `node scripts/build-mascot-v4.js` 后比对；`npm test`（`test/mascot.test.js`） | `assets/img/` 下 15 个文件与重新生成的结果逐字节一致；`assets/js/mascot-inline.js` 的三枚 data URI 解码后分别与 `avatar-v4.svg`、`avatar-v4-listen.svg`、`avatar-v4-offline.svg` 逐字节一致；生成器幂等（重跑无差异；测试在临时目录重建，失败不写工作区，也不存在自动还原工作区） |
| 状态素材齐全 | 列出 `assets/img/` | 10 个 `mascot-v4*.svg` + 4 个 `avatar-v4*.svg`（含 `avatar-v4-sprite.svg`）+ `favicon-v4.svg`，共 15 个 |
| 画布尺寸正确 | 读 SVG 根元素 | 主立绘 240×210、头像 96×96、图标 16×16，`viewBox` 与宽高一致 |
| 状态映射与素材一致 | 在 `assets/js/` 与 `index.html` 中检索 `assets/img/` 引用 | 每个被引用的文件名都在 `assets/img/` 中存在；§4 表中 9 行与实际文件逐字一致；接入状态以 §4 表末列为准 |
| 主题色一致 | 读 `assets/css/app.css` 的 `:root` | `--bg #EFE9F7`、`--ac #178265`、`--pink` / `--cinnabar #E8955B`、`--warn #A9713A` 等与 §3.1 表一致 |
| 接入无报错 | `npm start` 后打开首页 | 控制台无错误；首屏出现 `mascot-v4.svg`，顶栏出现 `avatar-v4.svg`，标签页出现 `favicon-v4.svg` |
| 离线与聆听形象 | 停服后刷新首页；在输入框输入文字，随后发送 | 顶栏出现 `.sync-offline` 离线头像且不破图（`alt` / `title` 为「离线 · 本地可用」，有旧队列时追加「旧队列已隔离 N」）；输入台头像换为聆听形象（`alt` 为「诺瓦正在聆听」），发送后回待机 |
| 内联副本一致 | `node scripts/build-mascot-v4.js` 后比对 | `assets/js/mascot-inline.js` 的三枚 data URI 解码后分别与 `assets/img/avatar-v4.svg`、`avatar-v4-listen.svg`、`avatar-v4-offline.svg` 逐字节一致 |
| 回归 | `npm test` | 引擎单测与 HTTP 冒烟全绿 |

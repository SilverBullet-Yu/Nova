# Summer Checkin · Reference Design System

> **Nova boundary:** this is an external reference, not Nova's implementation contract. Do not copy its React/Tailwind mappings, `--theme-*` token system, photographic backdrop, veil, fixed reveal deadlines, or product-page shells into Nova. Follow `SKILL.md` and the repository's DOM-first contracts first.

The bundled visual language, distilled from the product's canonical spec page:
**深色玻璃 · 单一强调色 · 克制圆角 · 有光影层次的质感 + 克制但丰富的动效**. Read this file
*after* the audit step in `SKILL.md`, and only when you decide to apply this treatment.

Applying this language means the full finish — color tokens **plus** the surface/lighting
「质感」 recipes **plus** the motion palette — never just a recolor. This file is a **self-contained
distillation of the real Summer Checkin product** (its token/glass scenes, buttons, and signature
motion): it requires no external project to read, and it is the authority for component, button,
and motion fidelity. When the user grants web-imagery
consent (§0 of `SKILL.md`), that finish also includes §2's single fixed photographic backdrop; when
consent is withheld, that backdrop slot renders from §2's built-in no-photo fallback and the language
still holds.

## 1. Scenes & Tokens

Components read tokens only; **never hardcode hex in a component**. The page re-skins by swapping
the same 16 variables per scene. Mechanism: scene selection is carried on `<html data-scene="…">`
(or a wrapping `.tk-<scene>` element); a `.tk-<scene>` rule redefines only the 16 `--theme-*`
tokens, and every semantic class stays unchanged.

Three scenes — `rain` (深绿 / default), `snow` (冷调蓝白), `cloud` (暖灰夜色):

```css
.tk-rain{
  --theme-bg:#07130d; --theme-bg2:#0a1b13;
  --theme-surface:rgba(16,36,28,.52); --theme-surface2:rgba(12,28,21,.66);
  --theme-glass:rgba(9,22,17,.72);
  --theme-primary:#d7ef83; --theme-primary-fg:#0a1a10;
  --theme-fg:#eaf3ec; --theme-fg2:#b9cfc2;
  --theme-muted:rgba(255,255,255,.06); --theme-muted-fg:#a2beb1;
  --theme-border:rgba(255,255,255,.11); --theme-border2:rgba(255,255,255,.18);
  --theme-accent:rgba(190,214,198,.12); --theme-destructive:#e85555;
  --theme-ring:rgba(215,239,131,.55);
}
.tk-snow{
  --theme-bg:#0a1118; --theme-bg2:#101a25;
  --theme-surface:rgba(24,34,46,.55); --theme-surface2:rgba(17,25,35,.66);
  --theme-glass:rgba(14,21,30,.72);
  --theme-primary:#d4e2f0; --theme-primary-fg:#182430;
  --theme-fg:#e8edf3; --theme-fg2:#c0ccd8;
  --theme-muted:rgba(255,255,255,.06); --theme-muted-fg:#a7b4c1;
  --theme-border:rgba(255,255,255,.10); --theme-border2:rgba(255,255,255,.17);
  --theme-accent:rgba(186,202,220,.12); --theme-destructive:#e06b5e;
  --theme-ring:rgba(212,226,240,.5);
}
.tk-cloud{
  --theme-bg:#13110f; --theme-bg2:#1b1815;
  --theme-surface:rgba(40,36,31,.55); --theme-surface2:rgba(29,26,22,.66);
  --theme-glass:rgba(24,21,18,.72);
  --theme-primary:#e0d4b8; --theme-primary-fg:#191512;
  --theme-fg:#edeae5; --theme-fg2:#cbc5bc;
  --theme-muted:rgba(255,255,255,.06); --theme-muted-fg:#b0aba2;
  --theme-border:rgba(255,255,255,.10); --theme-border2:rgba(255,255,255,.17);
  --theme-accent:rgba(224,212,184,.12); --theme-destructive:#e26b5e;
  --theme-ring:rgba(224,212,184,.5);
}
```

Semantic roles (rain = the numbers shown):

| Token | Role |
|---|---|
| `bg` / `bg2` | 页面深色基底 / 顶部略浅段 |
| `surface` / `surface2` | 卡片面板 / 更实的面(导航、弹出) |
| `glass` | 毛玻璃条(吸顶导航、底部 tab) |
| `primary` / `primary-fg` | **唯一**强调色及其上的前景(全页面只用它做高亮与主按钮) |
| `fg` / `fg2` | 正文 / 次要文字 |
| `muted` / `muted-fg` | 弱底 / 说明文字 |
| `border` / `border2` | 发丝描边 / 更明显的描边 |
| `accent` | 选中/悬停的柔和底 |
| `destructive` | 删除 / 错误 |
| `ring` | focus ring、发光描边，常用主色低透明度 |

Mapping in Tailwind/Shadcn sources: `background`→`bg`, `foreground`→`fg`, `card`/`muted`→`surface`
/`muted`, `muted-foreground`→`muted-fg`, `primary-foreground`→`primary-fg`, `popover`→`glass`,
`border`/`input`→`border`, `ring`→`ring`.

**Custom palette（用户自定主色）。** When the user asks for their own theme color instead of one of
the three scenes, derive a *fourth* full 16-token set from the single accent they name. Components
and every recipe stay untouched — only the color family changes:

- Treat the supplied color as the accent → `primary`. If it is too dark or muddy to pop on a deep
  glass base, lift it toward a readable bright accent while keeping its hue.
- `bg`/`bg2` take the accent's hue family, very low saturation, near-black depth (about `rain`'s
  luminance band), so the page still reads deep-dark glass but tinted to match: warm hue → warm
  neutral base, cool hue → cool neutral base.
- `primary-fg` is the accent's high-contrast deep foreground (near-black tinted by the same hue), so
  filled primary buttons stay readable.
- `fg`/`fg2`/`muted-fg` are near-white neutrals tinted by the hue; `muted`/`border`/`border2` remain
  `rgba(255,255,255,.06/.10/.18)` hairlines; `accent` = `color-mix(in srgb, var(--theme-primary)
  ~12%, transparent)`; `ring` = primary at ~50–55% alpha; `destructive` stays red.
- Emit every derived value as a `--theme-*` token and nothing else. The page selects the palette by
  swapping the same 16 tokens, and all 「质感」 + motion specs in the sections below hold unchanged.

## 2. Photography — 摄影作为内容

Real photography carries the atmosphere; it is content, not decoration. In this language each page
runs on **one** photograph — a full-bleed picture pinned **behind the whole page** as a fixed
backdrop. It never scrolls and never zoom/parallaxes, so the crop on screen is stable at any scroll
offset. The backdrop only ever meets the page through darkness: every picture↔page transition is a
dark gradient (暗过渡), never a bright seam, and copy is never set on busy midtones of the photo.
Mid-page set-pieces stay optional and sparse:

- **单张固定背景图（backdrop，贯穿到底）** — one mood-matching photo, `position:fixed`, behind every
  block from the opening to the footer. The opening headline + lead + primary CTA (first block) and
  the closing CTA (last block) are the two moments that seat text *over* the picture's field; the
  sections between scroll above the same picture, so the atmosphere never scrolls away.
- **Optional set-pieces** — hairline-framed `figure.media` (fixed `aspect-ratio`: 2/1 · 16/9 · 4/3 ·
  3/4, mono corner caption) and full-bleed `.strip` bands with a floating glass card can add mid-page
  mood. Sparse enough that the page never reads as a gallery — fewer of them over a live backdrop.

**Mood match（图片要符合意境）.**
Pick photographs that feel *from* the chosen scene, not dropped onto it:
`rain` 雨林 → 雾气林冠 / 叶上晨露 / 雨落水面 / 深绿荫影；`snow` 雪境 → 极地峡湾渔村 / 蓝调时刻 / 极光 /
雪中暖灯木屋；`cloud` 云端 → 暮色城市灯火 / 暖窗 / 入夜港湾；自定义主色 → 顺着主色与产品故事取景
（暖调 → 金色时刻、城市光；冷调 → 阴雨、水面）。Every photo's `alt` names subject + mood in one
Chinese sentence.

**Source & attribution（页面不显示任何来源标注）.**
The page is a clean, directly usable deliverable: **no source/credit label anywhere** — no footer
credit band, no "photo © …" line, no watermark. So pick images that need no on-page attribution:
Wikimedia **CC0 / public domain** files, or the **user's own** images. Wikimedia's
`upload.wikimedia.org/.../thumb/.../1920px-`（或 `960px-`）variants keep download size small. If a
CC BY / CC BY-SA file is genuinely the only good fit, keep its author + license **only in an HTML
comment** next to the asset — never rendered. Never use copyrighted fan-art, watermarked stock, or
random search hits as a background.

**Backdrop（固定层，永远在内容后面）.**
Place one photo as the first child of `body`, pinned to the viewport under everything; `nav`, `main`,
and `footer` are lifted above it:

```html
<img class="backdrop" src="https://upload.wikimedia.org/…/1920px-….jpg"
     alt="雪山的峡湾与渔村，笼罩在极夜蓝光之中">
<nav class="nav">…</nav>
<main>…opening copy · dark/glass sections · closing CTA…</main>
<footer>…底部文字…</footer>
```

```css
.backdrop{position:fixed;inset:0;z-index:0;width:100%;height:100%;
  object-fit:cover;object-position:center 58%;pointer-events:none}
.nav,main,footer{position:relative;z-index:2}   /* 内容永远盖在背景图之上 */
```

- `.backdrop` is `pointer-events:none` and never captures clicks or scroll. A fixed `background-image`
  layer works just as well; the `<img>` form keeps a real Chinese `alt`. The page's single grain
  layer stays at the top z (recipe 5 in §3).
- Because the layer is fixed, the visible crop never changes while scrolling — tune
  `object-position` once so the subject sits where copy is thinnest, and it holds for every viewport
  height.

**暗过渡 veil — 图与页面唯一的相遇方式.**
A fixed dark veil above the backdrop makes the picture dissolve into the page instead of starting or
ending on a photo edge, and holds it dim enough that translucent glass panels and `fg2` text stay
readable at every scroll offset:

```css
.veil{position:fixed;inset:0;z-index:1;pointer-events:none;background:
  linear-gradient(180deg,
    var(--theme-bg) 0%,
    color-mix(in srgb,var(--theme-bg) 78%,transparent) 12%,
    color-mix(in srgb,var(--theme-bg) 48%,transparent) 30%,
    color-mix(in srgb,var(--theme-bg) 48%,transparent) 70%,
    color-mix(in srgb,var(--theme-bg) 78%,transparent) 88%,
    var(--theme-bg) 100%)}
```

- The first and last stops are solid `--theme-bg`: the top dissolves under the glass nav, the bottom
  ends the page on ink — never a photo seam at either edge.
- Between the edges the dimming stays **roughly uniform** (≈ 48–50% `--theme-bg`), so the picture
  reads as one continuous, quiet atmosphere. Do not carve a bright "window" through the middle —
  content scrolls across the whole field, and a mid-tone band crossing behind text is exactly the
  defect this veil exists to prevent.
- Adjust the middle percentage against the real photo until translucent `surface` panels and `fg2`
  body copy read over it. Where a block must carry dense copy straight on the picture (a set-piece
  caption, a short lead), give *that block* a local gradient fading to `--theme-bg` behind its text —
  the dark-transition rule applies locally too. Reduced motion is trivially satisfied: the layer is
  static; nothing animates.

> **The veil is only for a real photographic backdrop.** If the page has no actual photograph — the
> no-photo fallback, or any plain UI with no imagery — do not render a veil; lay the ambient / material
> layer directly so the base stays bright and clean. A veil over material-only color is what makes a
> page look "没有图片却整页发暗".

**Every photo element**
- The backdrop is above the fold → load it eagerly (no `lazy`); keep a Chinese `alt` on the `<img>`.
  Set-pieces below the fold keep `loading="lazy" decoding="async"`.
- Fixed geometry only: the backdrop is `position:fixed` full-viewport; set-piece frames keep their
  `aspect-ratio`; every raster is `object-fit:cover`.
- No zoom / parallax on scroll — the backdrop is fixed and every other photo is static, so
  `prefers-reduced-motion` is trivially met.
- Do not add extra noise over a photo; the page's single grain layer (recipe 5 in §3) already covers all.
- No source/credit label is rendered anywhere on the page — author + license, when a licensed file
  requires it, lives only in an HTML comment.
- Never ship a broken image: if a source is blocked/removed, swap to another licensed photo or to
  the fallback below before finishing.

**No-photo fallback（不允许联网 / 必须离线时）.**
Keep the backdrop slot's *composition*, but draw it with the system's own materials and **no veil**:
the ambient-light layer from §3 + optional hairlines / skyline / a big numeral or wordmark scaled
like a horizon sit directly on the dark base. **Do not render the 暗过渡 veil when there is no real
photograph** — the veil exists only to dissolve a photograph into the page; layered on pure
materials it double-darks the page for no reason. Opening and closing still read as designed seats,
just without a raster — keep them bright and clean.

**Inline-SVG fallback（外链图被 CORS/ORB 拦截时的硬性兜底）.**
> *沉淀（2026-09 电商数码页+商城页踩坑）：Chromium 的 ORB（Origin Restriction Blocking）会静默拦
> 截 upload.wikimedia.org / cdn.pixabay.com / pexels 等第三方 CDN 的图片（报
> `net::ERR_BLOCKED_BY_ORB`），即使文件真实存在也不渲染。**当使用 `<img src="https://…">` 热链时必须做
> "首帧即能看见画面"的兜底**，不能让用户首屏看到一片灰白占位图。推荐方案：把场景画成 1920×1080 的
> `<svg>` **直接 inline** 进 body，零外链、零 CORS、零 ORB、零网络请求失败。**

Inline SVG 的结构和 token 规范：
- `viewBox="0 0 1920 1080"` + `preserveAspectRatio="xMidYMid slice"`，**class 仍然是 `.backdrop`**
  （接受所有 backdrop 的 CSS：`position:fixed / inset:0 / width:100% / height:100%`），
  `aria-hidden="true"`；它替代 `<img>`，grain/veil 层不变。
- 分层顺序（与 §2 摄影构图一致）：天空渐变 → 太阳柔光 → 远山 → 中景 → 前景 → 主体物（热气球群 /
  城市灯火 / 峡湾渔村等）→ 尘埃粒子（opacity ≤ .22）。
- 所有填料用 `<defs>` 里的 gradient，因为 SVG 读不到 CSS var，**必须为三种场景各固化一份 hex 色板**
  （用户自定义主色时 HSL 旋转最近场景的色相）：

| 场景 | 天空 stops | 山/前景 stops | 主体物配色 |
|---|---|---|---|
| `rain` 雨林 | #08130e → #0b1e15 → #0f3a28 → #226a3b | #0e2a1e / #081b13 / #040e09 | 绿/金/青蓝渐变气囊 |
| `snow` 雪境 | #09131e → #0e1d2d → #203a58 → #4a6a93 | #142232 / #0d1823 / #060b11 | 冷蓝/冰白/浅紫 |
| `cloud` 云端 | #1e2a3d→#3d3d5c→#c47a4a→#efb069→#f6d47e→#e9c07a | #4d4a5e / #3c373a / #2a2628 | 红/蓝/黄/绿/紫 5 只热气球 |

**cloud 场景的可复制 inline-SVG 模板**（直接替换 `<img class="backdrop"…>`）：见 SKILL 仓库 `examples/`
下一个 135 行左右的 SVG 片段，三段结构是：
- 天空 `<linearGradient>` + 太阳 `<radialGradient>`（金色 0/30/65/100% stops）
- 远山/中景/前景 3 段 `<path>` 锯齿 fairy-chimney 轮廓 + 各自 `<linearGradient>`
- 5 只 `<ellipse>` 气囊 + `<rect>`/`<path>` 吊篮 + `<line>` 缝线（大小错落 280,370 位置紫；560,300 蓝；
  1280,260 黄最大；960,430 绿；1580,400 红）
- 最后一组 9 个 `<circle r=1-2 opacity=0.22>` 晨雾尘埃

**§2.1 Broken-image checklist（交付前硬过一遍）**
在 SKILL.md §5 Verify 的"图片加载"检查基础上，再加三条：
1. **Ctrl+F5 硬刷新后 200ms 内**：肉眼可见画面，不是 404 灰白占位 → fail 立即换 inline SVG。
2. **Network 状态码 ≠ 200** 或 **`ERR_BLOCKED_BY_ORB`** → 视为 broken，inline SVG 兜底；不要给 `<img>`
   加 `crossorigin="anonymous"`（加了它才触发 CORS → 触发 ORB，`crossorigin` 删掉）。
3. **首屏首屏文字不叠照片花斑部**：调整 `object-position` 或本地加深块级文字背景渐变，保证字可读。

## 3. 质感 — Lighting & Surface Recipe

The premium feel is five layered techniques working together. Omitting any one makes it read flat.

**1. Ambient top light.** Never a flat background. A radial wash of the accent color at very low
alpha, top-center, sits over a short linear gradient into the deep base:

```css
body{background:
  radial-gradient(1100px 560px at 50% -12%, color-mix(in srgb, var(--theme-primary) 7%, transparent), transparent 62%),
  linear-gradient(180deg, var(--theme-bg2), var(--theme-bg) 220px);}
```

Repeat the same trick *inside* device screens / CTA bands (slightly higher alpha, ~9%) so every
contained "screen" catches its own accent light at the top.

**2. Glass bevel.** Every card/panel carries an inner top catchlight — the single rule that sells
"glass edge":

```css
.surface{background:var(--theme-surface);border:1px solid var(--theme-border);
  box-shadow:0 1px 0 rgba(255,255,255,.06) inset, 0 12px 28px -20px rgba(0,0,0,.5);}
```

**3. Hairline discipline.** Borders are `rgba(255,255,255,.10–.18)` at 1px — never heavier.
Stronger `border2` only for the most prominent edges (phone shell).

**4. Color glow on primary.** Anything filled with the accent casts light in its own color, and
"today/active" highlights add a ring glow:

```css
.btn-primary{background:var(--theme-primary);color:var(--theme-primary-fg);
  box-shadow:0 1px 0 rgba(255,255,255,.25) inset,
    0 6px 20px -8px color-mix(in srgb, var(--theme-primary) 55%, transparent);}
.active-dot{background:var(--theme-primary);box-shadow:0 0 8px var(--theme-ring);}
```

**5. Film grain.** One fixed, full-viewport noise layer at low opacity kills the sterile vector
look. Must stay ≤ ~3% or it reads as dirt:

```css
.grain{position:fixed;inset:0;z-index:80;pointer-events:none;opacity:.03;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");}
```

**Glass strips.** Sticky nav & bottom tab bars use `backdrop-filter: blur(14px)` on
`var(--theme-glass)` with a bottom/top hairline. Large "set pieces" (phone shell, CTA band) sit on
a deep ambient shadow with a strong inner highlight:

```css
.set-piece{box-shadow:0 40px 80px -28px rgba(0,0,0,.6), 0 1px 0 rgba(255,255,255,.14) inset;}
```

**§3.b Hard-solid lane（当用户明确说「不要渐变 / 不要荧光阴影 / 实打实主题色 / 界限分明」时切换这条）.**
> 沉淀（2026-09 数码页 6 张 feature 卡）：默认的「5 层玻璃质感」对部分用户显得"色不纯、脏、荧光绿
> 丑的要死"。当用户原话出现「不要渐变」「不要光」「丑死了」「界限分明」「像 xxx 按钮那样实
> 心」时，必须**整页切换到 Hard-solid 配方**，不能再用径向光晕、catchlight、彩色 box-shadow，也不
> 能留半透明玻璃叠色。

Hard-solid 的 4 条铁律（**比玻璃配方更短更硬**）：

1. **背景一律纯色**。卡片/面板：`background:#141d19;`（rain）或其他场景对应的实色 hex，**禁止
   `color-mix` 半透明 surface + 径向渐变 + 页面网格叠出脏色**；背景只写一个值，不写多
   `,` 分隔的 layer。
2. **描边 1.5px 实线、单一主色混色**。`.feat/.surface { border: 1.5px solid color-mix(in srgb,
   var(--theme-primary) 28%, #2a3a31); }`，边框必须"看得见"、厚且实；禁止 `rgba(255,255,255,.06)`
   那种发丝淡到看不见。
3. **`box-shadow:none;` 全局** — 任何卡片/按钮/图标都不能有外发光、彩色投影、内顶光。`.btn-primary`
   例外：保留 1 条轻微 inset 顶高光（`0 1px 0 rgba(255,255,255,.3) inset`）+ 柔投影，但删除主色
   glow。**`::before` 顶部光条（light-streak 渐变装饰）和任何 radial-gradient halo 一律
   `display:none`。**
4. **徽章/药丸 = 主色实心底**。用户对标 `btn-primary` 的「查看详细参数」手感 → `.badge`/`.chip`
   用 `background:var(--theme-primary); color:var(--theme-primary-fg); border:none; border-radius:8px`
   （紧凑圆角方，不是 `border-radius:999px` 超长胶囊）；禁止透明底+空心描边（用户原话"抽的
   要死"）。

Hard-solid 示例 `.feat` 卡片：
```css
.feat{
  background:#141d19; /* 1) 纯色，不是半透明玻璃 */
  border:1.5px solid color-mix(in srgb,var(--theme-primary) 28%,#2a3a31); /* 2) 实边 */
  border-radius:12px; padding:28px 26px; display:flex; flex-direction:column; gap:16px;
  box-shadow:none; /* 3) 无任何阴影光晕 */
  transition:transform .18s ease, background-color .18s ease, border-color .18s ease;
}
.feat::before{display:none} /* 删除顶部主色渐变光条装饰 */
.feat:hover{transform:translateY(-2px); background:#17221d; border-color:color-mix(in srgb,var(--theme-primary) 55%,#2a3a31);}
.feat-foot{margin-top:auto; padding-top:16px; border-top:1.5px solid #26322b; /* 实色实线 */
  display:flex; align-items:center; justify-content:space-between;}
.feat-foot .badge{
  font-family:"JetBrains Mono",monospace; font-size:10.5px; font-weight:800;
  padding:6px 14px; border-radius:8px; /* 紧凑圆角方 */
  background:var(--theme-primary); /* 4) 实心底 */
  color:var(--theme-primary-fg); /* 深色字 */
  border:none; /* 不描边空心 */
  letter-spacing:.04em; text-transform:uppercase;
}
```
Hard-solid lane 的 icon-box：`background:#0f1713; border:1.5px solid var(--theme-primary); color:var(--theme-primary);
box-shadow:none;` —— 图标字符**绝对不能用彩色 emoji**（如 ⚡ 闪电），因为 emoji 自带黄橙色、不服从 CSS
`color`。正确做法是用单调 Unicode 字符（↯↔◎✦⬢≋⋮⋯）或 SVG path。

## 4. Typography

- **中文**：`"Microsoft YaHei","PingFang SC","Noto Sans CJK SC","Source Han Sans SC",sans-serif`.
- **数据/等宽**：`"JetBrains Mono","Cascadia Code",SFMono-Regular,Consolas,monospace` — used for
  all digits, counters, timestamps, eyebrows and code. All numerals get
  `font-variant-numeric:tabular-nums` so columns and live counters never jitter.
- Body 14–15px, `line-height 1.75`; dense panels at 11–13px. Never scale type with viewport width.
  Keep `letter-spacing:0`.
- Display/h1–h3 use `text-wrap:balance`; reserved for true heroes.
- Eyebrows are 11px mono, letterspaced uppercase, preceded by a short primary dash
  (`::before{content:"";width:22px;height:1px;background:var(--theme-primary)}`).
- Long labels `truncate`/`line-clamp-1` + themed tooltip with the full value.

## 5. Radius & Shape

- Base surface radius 8–12px. Cards/panels ≤ 8px (`rounded-lg`); restrained, geometric, fixed —
  never content-driven.
- Full circles only for avatars, chips/pills, and round icon buttons.
- Bubbles: rounded with a smaller corner on the sender side (`border-bottom-left/right-radius:4px`).
- Controls keep **fixed geometry** (never content-driven heights). Button heights follow the product's
  size set: `default` ≈ 32px (`h-8`) · `sm` ≈ 28px · `lg` ≈ 36px · `icon` ≈ 32px（icon 另有
  xs/sm/lg ≈ 24/28/36）; inputs ≈ 36–40px; the pill primary CTA ≈ 40px. Radii scale from `--radius`
  (0.75rem): buttons ≈ 8–12px `rounded-lg`; full circle only for pills / round icon controls.

## 6. Motion — 动效规格

Purposeful motion only: every animation announces the state change it belongs to. One easing
family throughout; no animation libraries needed. Timing scale:

| Motion | Duration | Easing |
|---|---|---|
| hover / focus / press / tooltip | 150–200ms | ease-out |
| theme cross-fade (whole page) | 380ms | `cubic-bezier(.4,0,.2,1)` |
| scroll reveal | 650ms | ease |
| bar fill (progress / counters) | 500ms | `cubic-bezier(.4,0,.2,1)` |
| ambient float (one hero object only) | 7s loop | ease-in-out |

**1. Reveal on scroll, with stagger.** Sections assemble as you scroll; siblings get incremental
`--d` delays (`.05/.1/.15/.2`) for a choreographed cascade:

```css
.reveal{opacity:0;transform:translateY(16px);
  transition:opacity .65s ease, transform .65s ease;
  transition-delay:var(--d,0s);}
.reveal.in{opacity:1;transform:none;}
```

```js
// 沉淀（2026-09 shop.html）：首屏 reveal 必须立即 in，不能等 IO 回调，否则用户看到"刷新消失"
var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
var reveals = document.querySelectorAll('.reveal');
if (reduce || !('IntersectionObserver' in window)) {
  reveals.forEach(el => el.classList.add('in'));
} else {
  // ——— 首屏立即 in（核心修复）———
  var vh = window.innerHeight || document.documentElement.clientHeight;
  reveals.forEach(function (el) {
    var r = el.getBoundingClientRect();
    if (r.top < vh * 0.85 && r.bottom > 0) { // 任一像素露在首屏 → 点亮
      var d = parseFloat(el.style.getPropertyValue('--d') || '0') * 1000;
      setTimeout(function () { el.classList.add('in'); }, d);
    }
  });
  // ——— rootMargin 不能裁切，要扩张 +12% bottom
  var io = new IntersectionObserver(function (es) {
    es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { threshold: .06, rootMargin: '0px 0px 12% 0px' });
  reveals.forEach(function (el) { if (!el.classList.contains('in')) io.observe(el); });
}
```

> **首屏文案叠背景图时，颜色必须写死、不能再用 fg token**（同一沉淀：shop.html 首屏
> `.hero h1/lead/eyebrow` 用 `var(--theme-fg)` 米白，叠暖色天空背景几乎看不见）。正确写
> 法：`color:#ffffff; text-shadow:0 2px 12px rgba(0,0,0,.55), 0 1px 2px rgba(0,0,0,.35);`，副标题
> `color:#f4f1ea; text-shadow:0 1px 3px rgba(0,0,0,.4);`；`btn-outline`（叠亮区的副 CTA）改
> 半实心米白玻璃：`background:rgba(255,255,255,.16); border:2px solid rgba(255,255,255,.58);
> color:#fff; font-weight:800; backdrop-filter:blur(8px);` —— 修这些要直接改 `.btn-outline`
> 原始定义（和 `.btn` 在同一区块），不要靠后定义覆盖，否则 cascade 优先级没吃全就变成"改了也 1px
> 还是淡"。

**2. Theme cross-fade.** When the scene changes, the *whole page* recolors in one smooth morph by
animating only color-family properties (`background-color, border-color, color, box-shadow`) —
never layout/transform:

```css
.tk-rain *, .tk-snow *, .tk-cloud *{
  transition-property:background-color,border-color,color,box-shadow;
  transition-duration:.38s;transition-timing-function:cubic-bezier(.4,0,.2,1);}
```

Declare it before elements' own transitions (or on a wrapping element with only color props), so
transform-based motion — reveal, hover lift, press — never collides with it. On scene switch, also
swap the token labels shown on the page.

**3. Hover lift** on clickable cards/panels (raise + deepen shadow, not a recolor):

```css
.card{transition:transform .2s ease, box-shadow .2s ease, border-color .2s ease;}
.card:hover{transform:translateY(-3px);box-shadow:0 24px 48px -24px rgba(0,0,0,.55);}
```

**4. Press feedback.** Buttons press without layout shift: the general button set nudges down 1px
(`active:translate-y-px`, product base); the pill primary CTA and round icon controls press with a
light scale (`active:scale(.95)`). Primary fills respond on hover by alpha / color-mix dimming
(`hover:bg-primary/80`…`/92`) — the product does not use a brightness filter.

**5. One ambient float** — allowed only for a hero set-piece (e.g. device mock), gentle ±9px:

```css
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-9px)}}
.hero-mock{animation:float 7s ease-in-out infinite;}
```

**6. Primary CTA micro-interaction.** The product's single "commit" action gets a tactile beat:
on click it toggles its done/undo state, updates live text + counters, fires a quick scale pulse
(`scale(.94)` for ~120ms), and the streak/progress fill animates its width. One beat, not a parade.
Secondary rows it completes fade their timestamps in over ~200ms.

**7. Themed tooltip** as the replacement for native `title`: dark glass popover + arrow + hairline,
fade-and-rise 4px over ~160ms, positioned to the target with a below-screen fallback.

**8. Reduced motion — mandatory:**

```css
@media (prefers-reduced-motion: reduce){
  html{scroll-behavior:auto}
  .reveal{opacity:1;transform:none;transition:none}
  .hero-mock{animation:none}
  *,*::before,*::after{transition-duration:.01ms !important;animation-duration:.01ms !important}}
```

Nothing may be *permanently* hidden: if reduced motion or no IntersectionObserver, reveal instantly.

**9. Product-signature animations（复刻动画动效 — 规格内嵌，不依赖外部项目）.**
Replicate these only where the moment earns them — a few per surface, never a loop parade; §8's
reduced-motion override collapses all of them:

- **Entrance cascade** — page/top-level blocks enter `product-enter`: `opacity 0 → 1` +
  `translateY(12px → 0)`, 560ms `cubic-bezier(.22,1,.36,1)`, siblings delayed ~55/100/145ms.
  Panels/drawers slide via `rf-slide-in` (fade + `translateX(12px → 0)`, 200ms ease-out).
- **Commit pulse（胶囊主 CTA）** — hover sweeps a sheen across the fill (`via-white/10` gradient
  revealed on `group-hover`), press `scale(.95)`, loading swaps content to an in-button border
  spinner. One tactile beat, not a parade.
- **Ambient（仅当画面有对应母题）** — rainforest: halo `rainforest-breathe` 3.2s
  (`scale .96↔1.06`, `opacity .55↔1`), leaf sway `rainforest-leaf` 4s (±7°), sparks
  `rainforest-spark` 2.8s (stagger ~1.2s). Energy sweep `energy-flow` 1.2s linear over a primary
  gradient + glow; orbs bob `energy-bob` 1s (±4px). Use ≤ one or two such motifs per page.
- **Status / loading** — indeterminate bar `translateX(-100% → 400%)` 1.4s; in-button spinner =
  border ring (`border-2 … border-t-primary`, `animate-spin`); bars/fills animate width ~480ms
  `cubic-bezier(.22,1,.36,1)`.

## 7. Component Rules (per this language)

**Buttons（Summer Checkin 产品按钮规格 — 内嵌，直接照做）.**

- **基础按钮集** — variants `default / outline / secondary / ghost / destructive / link` × sizes
  `default / xs / sm / lg / icon`（icon 另有 `icon-xs/sm/lg`）；固定高度、`whitespace-nowrap`、
  `shrink-0`、圆角 ≈ 8–12px（随 `--radius` 缩放），图标 `size-4`。
- **状态动效** — base `transition-all`；hover 按变体改填料：default `hover:bg-primary/80`、
  outline/secondary/ghost `hover:bg-muted`（+`hover:text-foreground`）；按下 1px 下移
  `active:translate-y-px`（不缩放、不动布局）；focus `focus-visible:ring-3 ring-ring/50`
  （≈3px ring）；disabled `opacity-50` + `pointer-events-none`；icon 按钮圆角收敛、
  按钮组内相邻圆角连通。
- **胶囊主 CTA（打卡 / 提交）** — `rounded-full`，`bg-primary` + `border-primary/30` 发丝描边，
  `shadow-lg shadow-black/20`；hover `hover:bg-primary/92` 且扫过一道高光（
  `bg-gradient-to-r from-primary/0 via-white/10 to-primary/0`，`group-hover` 显示）；按下
  `active:scale(.95)`；载入时内容换成同尺寸边框转圈（`border-2 …/25 border-t-primary-foreground`
  `animate-spin`）+ 占位文案并禁点。这是页面里唯一"提交/打卡"动作的手感。


- **Status chips** — pill, 24px, muted base; colored variants tint the primary only by mixing it
  in (`color-mix(primary 14%, transparent)` bg, primary text, 28% border). One `chip-red` for
  overdue/destructive.
- **Check-in / primary button** — the pill CTA above (hover sheen, `active:scale(.95)`, in-button
  spinner); an optional *done / undo* beat toggles text + live counters, never a layout shift.
- **Progress/heat visuals** — translucent track, accent fill; "today" columns get the ring glow and
  read full-alpha. Render heat maps deterministically (a fixed intensity pattern), not randomly.
- **Metric cards** — accent-colored delta mono, large tabular number, mini bar row where "today" is
  emphasized with glow.
- **Avatars** — `rounded-full`, inner top highlight, hairline ring; hash a stable name→preset-color
  mapping (own = accent gradient) so a member never changes color.
- **Chat bubbles** — opposite alignment; own = accent fill + its foreground, others = translucent
  surface; quotes/replies render as a small framed block **inside** the outer bubble, never a
  detached card. Mono timestamp inside bubble.
- **Inputs** — transparent interior, container border, `focus-within` ring in the primary; auto-grow
  textarea; themed tooltip on icon controls, never native `title`.
- **Feeds** — list of surface rows with hairline; input as a pill with a round send button.

**feat-card / 特性卡网格（§3.b Hard-solid 默认附一段 DOM）。**
6 张卡片的 3×2 网格：`.feat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;}`
每张卡 DOM 是：
```html
<div class="feat">
  <div class="feat-icon">↯</div>
  <h4>端侧 AI 智能</h4>
  <p>描述：14px line-height 1.82，颜色 fg2。</p>
  <div class="feat-foot">
    <span class="badge">72 TOPS · 7B 端侧</span>
    <span class="arrow">AI 场景演示 →</span>
  </div>
</div>
```
两个不可触犯铁律（2026-09 沉淀）：
1. `.feat-icon` 里的符号**不能是彩色 emoji**（⚡ → 橙黄不绿；❤️ → 红）。用单调 Unicode 替
   换：↯(闪电) / ◎(主环) / ✦(星标) / ⬢(六边防护) / ≋(波形)。
2. `.badge` 永远实心主题色 + 紧凑圆角方 8px，不要 999px 胶囊，不要空心描边，不要
   `.1em uppercase` 夸张字距；用户只要"像查看详细参数那样"的按钮手感。

**首屏副 CTA btn-outline（叠摄影/亮区）。**
不要沿用亮版 token 的 `transparent 底 + border2 发丝边 + fg 字`（叠图上直接没了）。§6 沉淀给
的半实心玻璃样式必须覆盖原始 `.btn-outline` 定义（与 `.btn` 紧邻），不要在后面追加"覆盖规
则"（会被 cascade 吞掉）。

## 8. Accessibility & Verify

- Icon-only buttons: `aria-label` **+ themed tooltip**, not `title`. Hairlines stay cosmetic;
  text contrast driven by `fg`/`muted-fg` is readable.
- Focus-visible ring = `var(--theme-ring)`, offset 2px; destructive actions red but visible.
- Text must never clip/overlap: wrap or clamp the longest token in any fixed-format control.
- Verify theme switching animates smoothly, micro-interactions fire without JS errors, and the
  `prefers-reduced-motion` path reveals everything instantly with no lingering opacity.

## 9. 产品页版式 — Product-page shells（内页同款）

When the ask is a **产品页 / 内部界面**（仪表盘、列表、工作台、数据卡页）— not a marketing hero page —
assemble it from the product's own shell so it matches the Summer Checkin app page-for-page. Use the
class names below as the page vocabulary (self-contained; they mirror the real product).

**页壳（container）**
- `.product-page` — `min-height:calc(100dvh - 4.5rem); max-width:1440px; margin-inline:auto;
  padding:2.25rem clamp(1rem,3vw,3rem) 4rem`. Variants: `--redesigned` → `max-width:1320px;
  padding-top:7rem`（内容区顶光更足）; `--narrow` → `960px`; `--wide` → `1600px`.
  Stack its top-level children `space-y-6`; on `--redesigned`, each top-level child enters with
  `product-enter 560ms cubic-bezier(.22,1,.36,1) both` and 55/100/145ms cascade (§6 #9).
- Mobile: `padding:1.5rem … 3rem`; header stacks to a column.

**页头 `.product-header`（眉标 + 大标题 + 右侧操作）**
- `display:flex; align-items:flex-end; justify-content:space-between; gap:1.5rem;
  margin-bottom:2rem`. Optional `border-bottom` hairline under it.
- `.product-eyebrow` — 眉标：`0.68rem / weight 600 / letter-spacing .16em / uppercase`,
  `color:var(--text-eyebrow)`（≈ primary）。`.product-title` — `clamp(1.85rem, 3vw, 2.35rem) /
  weight 650 / line-height 1.12`，`--text-title`。`.product-subtitle` — `0.84rem / muted`,
  `max-width 38rem`。右侧放操作（按钮组）。

**玻璃面板层级（全部由 §1 的 `--surface-*` token 供料，`backdrop-filter` + 发丝边）**
| 类 | 用途 | blur / 说明 |
|---|---|---|
| `.surface` / `.product-panel` | 页面主体卡、面板 | `blur(22–26px) saturate(120–125%)`, radius `0.65rem`, hairline + token 投影 |
| `.glass-panel` | 弹层、侧栏、浮卡 | `blur(28px) saturate(130%)` |
| `.glass-panel-strong` / `.page-surface` | 强毛玻璃（导航浮层、整页沉浸） | `blur(32px) saturate(140%)` |
| `.dark-glass` | 更实的深色面 | `blur(28px) saturate(130%)`, 半透明深底 |
| `.rainforest-glass` | 氛围页的轻玻璃 | `blur(18px) saturate(118%)` |

- 面板内左侧可加一条 `w-1 bg-gradient-to-b from-primary to-primary/70` 的主色竖杠作"重点签名"。
- 输入/文本域/选择器：radius `0.45rem`、`--surface-input-*` 底与边、placeholder muted、focus ring primary。

**数据条 / 指标（metric）**
- `.product-metrics` — `display:grid`（列数随内容，mobile 1 列）；`border-block` hairline +
  底层 `blur(22px) saturate(120%)`；相邻格以 1px 竖线分隔，隔断用 `gap:1px + hairline` 也可。
- 每格 `.product-metric` — `flex items-center gap-3`：左侧图标瓦片
  `size-9 rounded-md border border-white/8 bg-white/[0.035] text-primary`（duotone 图标 ≈18px）；
  标签 `11px / white ~38%`；数值 `≈1.35rem / semibold / tabular-nums`（单位 `xs / ~34%`）。
- 区块小标题：`.section-heading` = 标题 `0.88rem/600` + 右侧说明 `0.72rem` 一行两端对齐；
  段内字段名 `.field-label` = `0.75rem/500 muted`。

**列表行 / 卡**
- `.product-row` hover = `border-color`→`--surface-row-hover-border`(≈primary 20%)、`background`→
  `--surface-row-hover-bg`、`translateY(-2px)`，`transition 220ms ease`。统计小卡（`.rf-stat-item`）
  hover 只改 `border-color`（200ms）到主色描边。空状态 = 虚线框卡（`border-dashed white/10`）+ 居中说明。
- 进度条：轨道 `h-1 … bg-white/8`，填充 `bg-primary transition-all duration-700`（或 §6 #9 480ms 系）。

**工作台 / 三栏页（focus 房间等沉浸型）**
- `.rainforest-workbench` — `grid-template-columns:220px minmax(380px,1fr) 380px; height:100dvh(或
  min(780px,…))`；左/右栏 hairline 分隔，栏内 `backdrop-filter: blur(22px) saturate(120%)`，右栏内容
  `padding:14px`、面板入场 `rf-slide-in 200ms`。移动端：塌成单列 + 58px 底部 3 格 tab 导航。
- 极简沉浸（focus 计时）——全屏固定 `.immersive-stage`，巨号计时数字带主色辉光、按住退出条用
  `immersive-hold` 1.4s 进度填充；右上 32px 圆钮调环境音。这类只出现在真正的沉浸场景里。

**导航（页面顶部）**
- `scenic-shell` 页壳：`relative flex min-h-[100dvh] flex-col` → 顶部 `TopNav`（玻璃药丸）
  + `main flex-1`。药丸 nav（`.atomic-nav`）折叠态 `176×48px` 圆角全，hover/focus 展开到 `510px`
  （宽 480ms `cubic-bezier(.22,1,.36,1)`，链接淡入）；左品牌、中链接、右上工具钮 32px 图标。
- 常规顶部导航为 `height:62–80px` 的玻璃条（发丝底边 + `backdrop-blur(14–24px)`）。

> 版式规则叠加在 §1–§8 之上：颜色/文字/按钮/动效一律沿用前面各节的 token 与状态规格，本节的类
> 只负责"内页骨架"。生成"产品页"时用这套骨架 + §7 按钮 + §6 动效，即为产品内页同款。

## 10. 设备陈列 — Device showcase（手机格子：把产品装进同一只手机壳）

When the target is a **product showcase whose centerpiece is the product's own screens** — a hero built
around one app view, a page exhibiting several views of an App, or any 科技产品页 that wants the device
frame itself as the set-piece — render the UI inside **one consistent phone shell** and present it in two
canonical arrangements:

- **版式 A · Hero 单机** — 左文右机，手机上浮：给首屏一个"产品即主角"的锚。
- **版式 B · 手机格子（screens-grid）** — 同一产品的多台手机并排，每台装一个**不同**的真实视图 + 居中
  mono 说明："产品不是一个界面，是几个面"。

This register is the source of the Summer Checkin spec page's hero phone and 记录/社群 screens grid. It adds
**no new tokens or materials** — §1 tokens, §3 质感, §4 type, §6 motion, §7 controls all hold unchanged;
§10 only wraps them at **phone density**. Never a recolor: shell chrome reads `--theme-*` only.

**Register rules**

- **One shell, many screens.** Every phone shares identical chrome — bezel, notch, status row, bottom tab
  bar. Only the `.ph-body` content changes per phone; the shell is a fixed asset, never redrawn per phone.
  Each screen is a *real view* of the product with its own bottom tab highlighted (`.on`).
- **Shell = tokens + §3 materials only.** Bezel `linear-gradient(180deg, var(--theme-surface2),
  var(--theme-glass))`、发丝 `border2`、深投影 + 内顶高光（§3 #2/#3）；屏内补自己的顶部环境光
  (accent ~9%, §3 recipe 1)。
- **Phone register for touch, product register for states.** 屏内 commit CTA 全宽高 ≈44、行与控件 hit 面积
  更松；但 hover/focus/press 仍是 §6 的 150–200ms + primary focus ring——只放大触控、不放大状态规格。
- **Deterministic, concrete mock content** — 具体日期、mono 时间、固定 pattern 的热力（§7），不写 lorem、
  不出随机条；状态行恒为 `9:41`。
- **Reduced motion** — 唯一允许的整机动效是 Hero 单机上浮（§6.5，7s）；格子里的手机全静态，并照 §6 #8 降级。

**A · 手机壳（shell）CSS** — fixed geometry：壳 290×596、radius 36、内边 9；屏 radius 28；notch 92×22。

```css
.phone-shell{position:relative;width:290px;height:596px;border-radius:36px;padding:9px;
  background:linear-gradient(180deg,var(--theme-surface2),var(--theme-glass));
  border:1px solid var(--theme-border2);
  box-shadow:0 40px 80px -28px rgba(0,0,0,.6),0 1px 0 rgba(255,255,255,.14) inset;}
.phone-notch{position:absolute;top:15px;left:50%;transform:translateX(-50%);
  width:92px;height:22px;border-radius:12px;background:rgba(0,0,0,.5);z-index:3;}
.phone-screen{width:100%;height:100%;border-radius:28px;overflow:hidden;position:relative;
  display:flex;flex-direction:column;border:1px solid rgba(255,255,255,.08);
  background:radial-gradient(420px 240px at 50% -8%,
      color-mix(in srgb,var(--theme-primary) 9%,transparent),transparent 65%),
    linear-gradient(180deg,var(--theme-bg2),var(--theme-bg));}
.ph-status{display:flex;align-items:center;justify-content:space-between;
  padding:16px 22px 4px;
  font:500 12px "JetBrains Mono","Cascadia Code",Consolas,monospace;}   /* 时间 + 右侧信号格 */
.ph-sig{display:flex;align-items:flex-end;gap:3px}                       /* 4 根 3px 细条，高 5/7/9/11 */
.ph-sig i{width:3px;background:var(--theme-fg2);border-radius:1px}
.ph-body{flex:1;min-height:0;padding:14px 16px;display:flex;flex-direction:column;gap:12px;overflow:hidden;}
.ph-nav{display:flex;border-top:1px solid var(--theme-border);
  background:var(--theme-glass);padding:8px 14px 12px;}
.ph-nav button{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;
  background:none;border:none;color:var(--theme-muted-fg);font-size:9.5px;padding:4px 0;cursor:pointer}
.ph-nav button svg{width:18px;height:18px}
.ph-nav button.on{color:var(--theme-primary)}    /* 当前视图的 tab；图标 stroke=currentColor */
```

每台手机一个 wrapper（任何出现设备的地方复用同一段 chrome）：

```html
<div class="phone"><div class="phone-shell">
  <div class="phone-notch" aria-hidden="true"></div>
  <div class="phone-screen">
    <div class="ph-status"><span>9:41</span><span class="ph-sig" aria-hidden="true"><i></i><i></i><i></i><i></i></span></div>
    <div class="ph-body"><!-- 屏内内容 --></div>
    <div class="ph-nav"><!-- 4 个 tab，当前视图加 .on --></div>
  </div>
</div></div>
```

响应式：**不重排壳内布局**——多台手机就堆成列；仅 ≈360px 以下可 `transform:scale(.92)` 缩放整个 wrapper
(`transform-origin:top center`)。壳不发散变形。

**B · 屏内组件装配（phone density）** — `.ph-body` 内组装 §7 组件，再补下面几个"手机档"装配：

- **问候头部** — 称谓（16/700）+ mono 日期行（11 muted）靠左，右侧 `.ph-ava`（§7 头像）。
- **提交主卡（today / commit）** — `.ph-card`（surface + radius ≈14 + 内顶高光）：状态 `chip`（主色系）
  + 连击数字 `b`（primary、mono）一行 → **全宽 commit CTA**（高 44、radius ≈10、primary 填充 + 自发光
  §3 #4；`active:scale(.975)`）→ 一行元信息 `已完成 x / y · …` → 4px 圆角进度条（fill=primary，宽 500ms
  动画）。done/undo 微交互照 §6 #6：done 态 CTA 转 outline（primary 描边、透明底），勾选任务 + 数字/文案联动。
- **任务行** — 17px 方形勾选框（radius 6：未选发丝 `border2`；选中 primary 填充 + 其前景勾）、名称 ellipsis、
  右侧 mono 时间戳（完成才淡入，~200ms）。
- **记录/历史屏** — 7 列热力格（gap 4；强度 0 / 26% / 55% / 100% primary，今日格外描边），强度用固定 pattern
  确定性生成（§7，不随机）；格下 7 日周柱（今日满色 + 辉光），汇总虚线行 `已打卡 x 天 · 最佳 y · 均值 z`。
- **社群/feed 屏** — §7 feed 收到手机列宽：头像 30、正文 11、时间 9.5 mono、行内 chip；底部胶囊输入 +
  圆形发送钮（primary 描边 round icon）。

数字都是"设备档"；状态 / 字阶 / token 一律回 §4/§6/§7，不在手机里另造一套。

**C · 版式 A：Hero 左文右单机。** 左栏 copy（eyebrow + H1 + lead + meta），右栏一台悬浮手机。单机上浮是
§6.5 唯一的 hero set-piece 动效。

```css
.hero{display:grid;grid-template-columns:minmax(0,1.05fr) auto;gap:56px;align-items:center}
.hero-phone{display:grid;place-items:center;animation:float 7s ease-in-out infinite}   /* §6.5 */
@media (max-width:1020px){.hero{grid-template-columns:1fr}.hero-phone{justify-self:center}}
```

copy 与手机各自 `reveal` + 错峰 `--d`（手机 ~.1–.15s）；文案区不宽于 ~560px，hero 内不套卡。

**D · 版式 B：手机格子（screens-grid）。** 多台手机并排 + 每台一条居中 mono 说明——"一个产品，几个面"的陈列：

```css
.screens{display:grid;grid-template-columns:repeat(2,1fr);gap:24px;justify-items:center}
.screen-fig{display:flex;flex-direction:column;gap:16px;align-items:center}
.screen-cap{font:400 12px "JetBrains Mono","Cascadia Code",Consolas,monospace;
  color:var(--theme-muted-fg);text-align:center}
.screen-cap b{color:var(--theme-fg);font-weight:600}
@media (max-width:900px){.screens{grid-template-columns:1fr}}
```

- 默认两列、每格一台完整手机壳；同一产品 3–4 个面就排两行。**为塞更多台而缩小壳**是不允许的——加行不加列。
- 每台屏内都是**不同**的真实视图，且各自底栏高亮当前 tab；同一屏内容不出现两次。
- 说明格式一句话：`<b>记录</b> · 月度热力与趋势`（名字 · 一句功能）。
- 适用：App 产品展示 / 落地页"界面"段 / 文档页的"各屏"画廊。当目标页是这类"以屏为内容"的展示时，Q2 即
  "不搜图"，不使用 §2 的整页摄影背板。

**§10.b 产品条三卡组合（数码旗舰条的三件套：手机 + 镜头模组 + 芯片）的裁切陷阱。**
> 沉淀（2026-09 nebula-tech-product）：`.strip-card { overflow:hidden; display:grid; grid-template-columns:1.15fr 1fr; }`
> 的媒体区放三件套：中央大屏手机（`position:absolute; left:50%; top:50%; transform:translate(-50%,-50%)`）
> + 右上镜头卡片 + 左下芯片。为了给右边镜头让路，把手机 `translateX(-58%)` 多往左推 8% → **超出
> `overflow:hidden` 媒体区左边，左边机身+日期文字被一刀切断**，呈现用户说的"断了半截"。

**三件套的 4 条刚性几何规则：**

1. **中央设备只能 `translate(-50%,-50%)` 正居中**，不能再用 `-52/-55/-58%` 强行腾空间。
2. **左右贴边物品（cam/chip/remote 卡/耳机盒等）的 `left / right ≥ 8%`，不得 < 6%。**
3. **媒体容器 `aspect-ratio` 不低于 4/3（1.33）**，细长手机不要塞 16/11（1.45）这种更扁的框，
   否则顶底会被裁；容器宽给足：`grid-template-columns: 1.3fr 1fr`（媒体列不低于 1.3），不要
   1:1 或 1.15:1。
4. **物品宽度要留呼吸空**：中央主设备 ≤ 媒体列宽的 40%，两侧副卡 ≤ 23~26%（不能用 46/30/26% 的组合，
   否则互相顶到边）。

反例（绝对不要再写）：
```css
/* ❌ 断半截的组合 */
.strip-card{grid-template-columns:1.15fr 1fr}  /* 媒体列不够宽 */
.strip-media{aspect-ratio:16/11}              /* 框太扁上下裁切 */
.sphone{transform:translate(-58%,-50%); width:46%} /* 推太左 + 太宽 */
.cam{right:6%; width:30%}   .chip{left:4%; width:26%}  /* 贴边 */
```
正例（三件套 100% 不裁）：
```css
/* ✅ 有呼吸的组合 */
.strip-card{grid-template-columns:1.3fr 1fr}
.strip-media{aspect-ratio:4/3}
.sphone{transform:translate(-50%,-50%); width:40%}
.cam{right:9%; width:26%}   .chip{left:8%; width:23%}
```
写完第一件事**浏览器截图看四边**：所有物品的 left/right/top/bottom 圆角必须完整可见，标签文字不
得有"首字或末字被切一半"。然后 Ctrl+F5 再确认一次。

## 11. Lessons Learned · UI 迭代踩坑清单（持续增长）

> 本节是 skill 的**活经验库**。每次用户纠正视觉问题、或交付后还需打补丁，都必须在本节追加一条
> 「沉淀 + 正确配方 + 错误反例」，并把对应规则同步回上面的 §1–§10 技术规范里。本条的作用是让技
> 术规范的"为什么"清晰，避免同坑踩两次。

---

### L1 · 用户说「不要渐变 / 不要荧光」→ 整页切换 Hard-solid lane
**原话信号词**：「色不纯」「荧光阴影丑死了」「实打实的主题色」「界限分明」「实心色占主导」。
**错误**：继续用 `radial-gradient` 光晕、`box-shadow:…color-mix(primary 30%,…)` 发光、半透明
surface 叠底纹 → 视觉混成"脏绿色/土色/尿色"。
**正确**：触发 §3.b Hard-solid，4 条铁律一次性贯彻（纯色底、1.5px 实边、box-shadow:none、
徽章实心底），不能只改一两处。
**同步位置**：§3.b + §7 feat-card。

### L2 · 彩色 emoji 不服从 CSS `color`，feat-icon 一律换单调 Unicode
**错误**：`feat-icon` 里写 ⚡ → 系统自带橙黄色，`color:var(--theme-primary)` 无效。类似：
❤️/🌞/🎵/✅ 都不可靠。
**正确**：用几何单调符号 ↯(闪电) / ◎ / ✦ / ⬢ / ≋ / ◐ / ◈ / ⊞ / ⊡，或内联 SVG path，字符和描边
都走 `currentColor`。
**同步位置**：§3.b Hard-solid 末尾。

### L3 · 药丸 badge 必须实心主色底 + 紧凑圆角方 8px，不要空心描边 999 胶囊
**原话信号词**：「空心的抽的要死」「像 查看详细参数 那样」（对标 `btn-primary`）。
**错误**：`background:color-mix(primary 10%,transparent); border:1px solid …; border-radius:999px;`
→ 显得小气、虚、没质感。
**正确**：`background:var(--theme-primary); color:var(--theme-primary-fg); border:none;
border-radius:8px; font-weight:800; letter-spacing:.04em; padding:6px 14px;`
**同步位置**：§3.b 示例 CSS + §7 feat-card 铁律。

### L4 · 首屏 reveal 必须首帧立即 in，不要纯 IO `threshold:.12 + rootMargin -6%`
**原话信号词**：「为什么刷新一下就消失了」。
**错误**：`.reveal{opacity:0}` + 只靠 IntersectionObserver 触发、rootMargin 还裁切 6% → 首屏元素刚
好还在"裁切线以下"，用户看不到任何首屏内容。
**正确**：脚本在 IO 之前**先检查视口边界**，把 `r.top < 0.85*vh && r.bottom > 0` 的立即加 `.in`
（带 `--d` delay），剩下的交给 IO；rootMargin 改成**扩张 12%** 而不是裁切。
**同步位置**：§6 #1 reveal JS 整段重写。

### L5 · 叠在照片上的首屏文案不要再用 `--theme-fg`，写死纯白 + 深色阴影
**原话信号词**：「颜色还这么淡」「看不清」。
**错误**：`.hero h1{color:var(--theme-fg)}`（≈米白 #f3efe8）叠在暖色晚霞天空/热气球照片上 →
字和背景"顺色"，对比度 ≈1.1:1，人眼读不出来。
**正确**：`color:#ffffff; text-shadow:0 2px 12px rgba(0,0,0,.55),0 1px 2px rgba(0,0,0,.35);`；副标
题 `#f4f1ea` + 轻 shadow；btn-outline 改半实心玻璃。
**同步位置**：§6 #1 沉淀注。

### L6 · btn-outline 叠图样式要改 .btn-outline**原始定义**，不能后追加覆盖
**错误**：`.btn-outline{border:1px solid var(--theme-border2);…}`（在 .btn 块里，1px 细边），然
后在文件后半段追加 `.btn-outline{border:2px solid rgba(255,255,255,.58);}`，浏览器 computed 显
示 border-width 还是 1px。
**正确**：修改 `.btn-outline` 和 `.btn` 紧邻的那条定义（源代码第 162 行左右），用简写 `border:
2px solid rgba(255,255,255,.58)` 覆盖掉前面的 1px 值。双类 `.btn.btn-outline` 只能当保险，
不能当主策。
**同步位置**：§7 btn-outline 注 + §6 沉淀。

### L7 · 跨域热链图片 → 一律 inline SVG 兜底，不要赌 ORB/WAF/CDN
**原话信号词**：「刷新消失」「灰白占位」「为什么显示不出来」。
**错误**：`<img src="https://upload.wikimedia.org/…/thumb/…/1920px-…jpg" crossorigin="anonymous">`
→ Chromium ORB 直接拦截 `net::ERR_BLOCKED_BY_ORB`，naturalWidth=0，**整页背景没了**，还
不报错。
**正确**：**默认 inline SVG 背景**（零网络、零 CORS、能渲染就是能渲染）；用户明确要真照片
时再 `<img>`，并把 crossorigin 删掉，加载失败立即切换 SVG fallback。
**同步位置**：§2 Inline-SVG fallback + §2.1 Broken-image checklist。

### L8 · 三件套设备陈列的 translate/left/right/width 碰边必裁
**原话信号词**：「这里断了半截」。
**错误**：中央手机 translate(-58%,-50%)、左芯片 4%、右镜头 6%、media aspect-ratio 16/11（扁
平）、媒体列只给 1.15fr → 四边总有一边被 `overflow:hidden` 切断。
**正确**：§10.b 4 条刚性几何：translate(-50%,-50%) 不超；left/right ≥ 8%；aspect-ratio ≥ 4/3；
媒体列 ≥ 1.3fr。写完第一件事截图看 4 边完整圆角。
**同步位置**：§10.b 三卡组合规则 + 反例/正例。

### L9 · veil 的两端不能 solid theme-bg（首/尾会压死 100% 暗）
**原话信号词**：「怎么这么暗」「闷」。
**错误**：veil stop 0% 和 100% 写 `var(--theme-bg)` solid 色 → 顶/尾 100% 都是近黑，整页像被罩黑布。
**正确**：两端 stop 用 `color-mix(in srgb, var(--theme-bg) 42% ~ 44%, transparent)` 留呼吸空；
中间 stop ≤ 25% alpha（薄护读，不要 50%+）。cloud 场景甚至可以再减一档（中段 18-22%）。
**同步位置**：§2 veil（原 veil 的百分比在 shop.html 沉淀中已下调约 10-20%）。

### L10 · 不要遗漏 `.spec-list` 这类清单网格的定义——重做/重构卡片时容易整块删
**原话信号词**：「核心配置下面文案排列太密」「像墙一样挤在一起」。
**错误**：重构产品条 strip-copy 时，旧的 `.spec-list/.spec/.spec k/.spec v` 定义被删掉，但 DOM 没删
→ 没有 grid、没有 gap、没有 padding → 6 项配置（工艺/CPU/GPU/NPU/屏幕/电池）堆成连续字块，
间距 0。
**正确**：**改完结构后第一件事 grep 检查 DOM 里出现过的 className 在 CSS 中有没有定义**。
`.spec-list{display:grid; grid-template-columns:1fr 1fr; column-gap:36px; row-gap:26px;}` 是最起
码的清单呼吸空间，绝不能 fallback 成浏览器默认。
**同步位置**：§9 产品页版式（核心配置段）。

### L11 · 手机模型「主色太少」的固定配方：壁纸 + 状态栏 + 时间渐变 + 小组件 + Dock 5 处染主色
**原话信号词**：「手机模型主题色太少了」「几乎全黑」「没有酸橙绿」。
**错误**：壁纸纯暗绿、状态栏纯白灰图标、时间实心白、小组件纯玻璃灰 → 主色只出现在页面标题。
**正确**（rain 场景为例）：
1. 壁纸：左下 70% 主色光斑 + 右上主色白日斑 + 星芒点；
2. 状态栏：信号 bars/battery 填主色 + glow；
3. 时间 hh:mm：白 → 主色 85% 渐变字 + 主色 text-shadow；
4. 4 个小组件：主色 16% 底 + 主色描边 + 主色单位/标签 + 数字主色阴影；
5. Dock 栏：主色玻璃底 + 主色描边，App 主色渐变图标。
同一配方可批量用在 hero 锁屏 + 产品条大屏手机 + 手机格子。
**同步位置**：§10 手机屏内 A CSS（屏内容的主色渗透）。

### L12 · 核心配置 copy 区的 spec 清单要加「主色节奏条」才不会堆字
**紧接 L10**：即便 grid/gap 正确，6 条清单看起来仍然会像"满满一堵字墙"。
**解决**：给每个 `.spec` 加 `padding-left:16px; border-left:2px solid …`，奇数项用
`var(--theme-primary)` + 小 box-shadow glow，偶数项用主色 55% 混 border。视觉"切分"一
下，用户才会觉得每项是独立一条，不是 12 行堆在一起。
**同步位置**：§9 strip-copy 的 spec 渲染规范。

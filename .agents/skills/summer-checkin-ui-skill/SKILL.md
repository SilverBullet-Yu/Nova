---
name: summer-checkin-ui-skill
description: Audit and polish Nova's vanilla-JavaScript, DOM-first visual and interaction layer without changing business logic, data, APIs, or backend behavior. Use for layout, hierarchy, typography, controls, responsive behavior, accessibility, motion, CSS tokens, and GL fallback work in this repository.
---

# Nova UI Optimization Skill

## Product Constraints

Nova is a classic-script, zero-build frontend that must work from `file://` and from the Node static server. Preserve that contract.

- Do not introduce React, Next.js, Tailwind, a bundler, a framework runtime, or new dependencies.
- Business truth lives in `assets/js/state.js` and `shared/placement-model.js`; this skill must not change it.
- The visible DOM is the product. GL/CSS3D is optional and hidden by default; never make it required for reading or operating the UI.
- The active background is the local gradient in `assets/css/app.css`. Do not restore remote photography, a dark veil, or a network-dependent backdrop.
- Content must be visible without an observer, animation, timer, or WebGL. Motion is an enhancement only.

## Read Before Editing

1. `index.html` for structure, script order, and static `data-gl3d` state.
2. `assets/css/app.css` for existing tokens, components, breakpoints, and cascade order.
3. `docs/FRONTEND-CONTRACT.md` and `docs/ARCHITECTURE.md` for current behavior and acceptance boundaries.
4. The named view/flow file and its nearest tests. Do not edit business logic as a styling side effect.

## Design Rules

- Reuse existing semantic tokens such as `--bg`, `--bg2`, `--panel`, `--txt`, `--txt2`, `--txt3`, `--ac`, `--warn`, `--bad`, `--line`, `--line2`, and spacing/font tokens. Do not hardcode new hex colors in components.
- Keep the current dark, quiet, mint-accented identity. Fix hierarchy, density, contrast, and alignment rather than introducing a new theme.
- Use full-width sections and restrained framed elements. Avoid nested cards, decorative card stacks, oversized hero copy, gradient orbs, and unrelated visual churn.
- Typography uses the existing scale and `var(--fs-body)`. Do not scale body text with viewport width. Long labels wrap or truncate without overlapping controls.
- Every interactive control has visible `:hover`, `:focus-visible`, `:active`, and `disabled` states. Touch targets are at least 44px; secondary actions cannot depend on hover.
- Icon-only controls need an accessible name. Preserve `lang="zh-CN"`, one main landmark, navigation semantics, dialog focus behavior, and live-region attributes.
- Respect `zx.ui_prefs.motion` and `prefers-reduced-motion`. Collapse nonessential transitions under reduced motion; never hide content until an animation callback runs.
- Do not impose fixed 100ms/200ms reveal deadlines. Verify that content is readable immediately and that no failed observer can leave it transparent.
- For GL work, preserve DOM fallback, hidden-stage pause/lazy initialization, context-loss handling, and single rAF ownership.

## Workflow

1. Reproduce the named issue in the real DOM at desktop and mobile widths.
2. Identify the smallest token, layout, state-style, or interaction change that fixes it.
3. Edit existing CSS/HTML/view code only. Keep selectors specific enough to avoid late cascade overrides.
4. Verify keyboard, touch, long-text, disabled, empty, and error states.
5. Run the relevant Node tests, `npm run audit`, and the isolated Chromium acceptance when behavior or rendering changed.

## Verification

- `npm run audit`
- Relevant `node --test test/<area>.test.js`
- `PYTHONIOENCODING=utf-8 python .tools/browser-acceptance.py` for interaction changes
- `npm run bench:placement` and browser `optional-a7` when changing model rendering or GL synchronization

Do not start or restart an existing 8787 service. Acceptance starts its own random-port server and ephemeral Chromium context.

## Reference Boundary

`references/design-system.md` documents an external Summer Checkin visual language. It is optional inspiration only. Its React/Tailwind mappings, `--theme-*` token system, photographic backdrop, veil, fixed reveal deadlines, and product-page shells are not Nova requirements and must not override this file or the repository contracts.

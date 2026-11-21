const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');

const shell = readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');

test('入口只提供一个主导航区域', () => {
  assert.equal([...shell.matchAll(/<nav\b[^>]*aria-label="主导航"/g)].length, 1);
});

test('应用启动前不声称已有目标、同步结果或引擎在线', () => {
  for (const id of ['ctxGoal', 'ctxR', 'btMeta', 'syncText', 'plannerText']) {
    assert.match(shell, new RegExp(`id="${id}">\\s*</`));
  }
});

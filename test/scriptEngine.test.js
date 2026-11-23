'use strict';
/**
 * B0-3：LLM 剧本归一化。复现缺陷：text 为对象时曾产生 `[object Object]` 污染；
 * speaker 别名与奇偶数兜底保证严格双人交替。
 */
const test = require('node:test');
const assert = require('node:assert');
const { normalizeDialogue } = require('../src/services/scriptEngine');

test('B0-3：非字符串 text 整行丢弃，绝不产生 [object Object]', () => {
  const dialogue = normalizeDialogue([
    { speaker: '阿泽', text: '正常台词' },
    { speaker: '阿泽', text: { evil: 'object' } }, // 曾产生 [object Object]
    null,
    '不是对象',
    { speaker: '小晓', text: '   ' }, // 空白
    { speaker: '小晓', text: 12345 }, // 数字
    { speaker: '小晓', text: '第二句正常台词' },
  ]);
  assert.deepStrictEqual(dialogue, [
    { speaker: '阿泽', text: '正常台词' },
    { speaker: '小晓', text: '第二句正常台词' },
  ]);
  assert.ok(!JSON.stringify(dialogue).includes('[object Object]'));
});

test('speaker 别名归一到阿泽/小晓', () => {
  const dialogue = normalizeDialogue([
    { speaker: '主持人阿泽', text: '一' },
    { speaker: '嘉宾小晓', text: '二' },
    { speaker: 'Host', text: '三' },
    { speaker: 'guest', text: '四' },
  ]);
  assert.deepStrictEqual(
    dialogue.map((d) => d.speaker),
    ['阿泽', '小晓', '阿泽', '小晓']
  );
});

test('未知 speaker 按奇偶位置归位，已知角色保留不强制交替', () => {
  const dialogue = normalizeDialogue([
    { speaker: '???', text: '一' },
    { speaker: '', text: '二' },
    { speaker: '神秘人', text: '三' },
  ]);
  assert.deepStrictEqual(
    dialogue.map((d) => d.speaker),
    ['阿泽', '小晓', '阿泽']
  );
});

test('已知角色连续同说话人保留，不强制交替', () => {
  const dialogue = normalizeDialogue([
    { speaker: '阿泽', text: '一' },
    { speaker: '阿泽', text: '二' },
    { speaker: '小晓', text: '三' },
  ]);
  assert.deepStrictEqual(
    dialogue.map((d) => d.speaker),
    ['阿泽', '阿泽', '小晓']
  );
});

test('emotion 仅在为非空字符串时保留', () => {
  const dialogue = normalizeDialogue([
    { speaker: '阿泽', text: '一', emotion: ' 开心 ' },
    { speaker: '小晓', text: '二', emotion: { bad: 'object' } },
    { speaker: '阿泽', text: '三', emotion: '   ' },
  ]);
  assert.strictEqual(dialogue[0].emotion, '开心');
  assert.ok(!('emotion' in dialogue[1]));
  assert.ok(!('emotion' in dialogue[2]));
});

test('全部无效时报错而不是返回空剧本', () => {
  assert.throws(() => normalizeDialogue([{ speaker: '阿泽', text: {} }]), /没有有效台词/);
  assert.throws(() => normalizeDialogue('不是数组'), /dialogue/);
});

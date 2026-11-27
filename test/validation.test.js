'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  InputError,
  MAX_TITLE_LENGTH,
  MAX_CONTENT_LENGTH,
  MAX_DIALOGUE_LINES,
  MAX_LINE_TEXT_LENGTH,
  requireText,
  validateScriptRequest,
  validateDialogueList,
  validateEditedDialogue,
  validateVoiceMapping,
  redactSecrets,
} = require('../src/services/validation');
const { AVAILABLE_VOICE_IDS } = require('../src/services/ttsService');

test('requireText：类型/空/超长均报 400 输入错误', () => {
  assert.throws(() => requireText(123, '文章正文', { max: 100 }), (e) => e instanceof InputError && e.statusCode === 400);
  assert.throws(() => requireText('   ', '文章正文', { max: 100 }), /请填写文章正文/);
  assert.throws(() => requireText('abcdef', '文章正文', { max: 5 }), /超过 5 字上限/);
  assert.strictEqual(requireText(' 正文 ', '文章正文', { max: 100 }), '正文');
});

test('validateScriptRequest：确定性截断并置 truncated', () => {
  const long = '字'.repeat(MAX_CONTENT_LENGTH + 1000);
  const result = validateScriptRequest({ title: ' 标题 ', content: long, url: ' https://a.example.com/p ' });
  assert.strictEqual(result.title, '标题');
  assert.strictEqual(result.truncated, true);
  assert.strictEqual(result.content.length, MAX_CONTENT_LENGTH);
  assert.strictEqual(result.url, 'https://a.example.com/p');
});

test('validateScriptRequest：不超长则 truncated=false', () => {
  const result = validateScriptRequest({ title: '', content: '短正文', url: '' });
  assert.strictEqual(result.truncated, false);
  assert.strictEqual(result.content, '短正文');
});

test('validateScriptRequest：标题超长 / 正文为空 / 非 http 链接均报 400', () => {
  assert.throws(
    () => validateScriptRequest({ title: '标'.repeat(MAX_TITLE_LENGTH + 1), content: '正文' }),
    /标题超过/
  );
  assert.throws(() => validateScriptRequest({ title: '标题', content: '' }), /请填写文章正文/);
  assert.throws(
    () => validateScriptRequest({ title: '', content: '正文', url: 'javascript:alert(1)' }),
    /链接格式不正确/
  );
});

test('validateDialogueList：空/超行数/坏行均报 400', () => {
  assert.throws(() => validateDialogueList([]), /对话内容为空/);
  assert.throws(() => validateDialogueList('不是数组'), /对话内容为空/);
  assert.throws(
    () => validateDialogueList(Array.from({ length: MAX_DIALOGUE_LINES + 1 }, () => ({ speaker: '阿泽', text: 'x' }))),
    /超过 300 行上限/
  );
  assert.throws(() => validateDialogueList([{ speaker: '阿泽' }]), /不是文本/);
  assert.throws(() => validateDialogueList([{ speaker: '阿泽', text: '  ' }]), /台词为空/);
  assert.throws(
    () => validateDialogueList([{ speaker: '阿泽', text: 'x'.repeat(MAX_LINE_TEXT_LENGTH + 1) }]),
    /超过 2000 字上限/
  );
  assert.throws(() => validateDialogueList([null]), /格式无效/);
});

test('validateDialogueList：合法列表原样返回', () => {
  const dialogue = [
    { speaker: '阿泽', text: '你好' },
    { speaker: '小晓', text: '嗨' },
  ];
  assert.strictEqual(validateDialogueList(dialogue), dialogue);
});

test('validateVoiceMapping：白名单外音色报 400', () => {
  assert.strictEqual(validateVoiceMapping(undefined), undefined);
  const ok = { 阿泽: AVAILABLE_VOICE_IDS[0] };
  assert.deepStrictEqual(validateVoiceMapping(ok), ok);
  assert.throws(() => validateVoiceMapping({ 阿泽: 'evil-voice-id' }), /不支持的音色/);
  assert.throws(() => validateVoiceMapping('不是对象'), /格式无效/);
  assert.throws(() => validateVoiceMapping([AVAILABLE_VOICE_IDS[0]]), /格式无效/);
});

test('redactSecrets：API Key 形态凭据被脱敏', () => {
  const text = '请求失败：Authorization: Bearer abcdef123456 token=supersecretvalue key sk-abcdef123456';
  const redacted = redactSecrets(text);
  assert.ok(!redacted.includes('abcdef123456'), `未脱敏：${redacted}`);
  assert.ok(!redacted.includes('supersecretvalue'), `未脱敏：${redacted}`);
  assert.ok(redacted.includes('***'));
  // 普通文案不受影响
  assert.strictEqual(redactSecrets('生成播客失败: 连接超时'), '生成播客失败: 连接超时');
});

test('商业服务允许自定义音色且限定角色与字符；服务商凭据形态脱敏', () => {
  for (const provider of ['minimax', 'volcengine']) {
    const mapping = { 阿泽: 'Chinese (Mandarin)_Radio_Host', 小晓: 'S_cloned:2.0' };
    assert.deepStrictEqual(validateVoiceMapping(mapping, provider), mapping);
    for (const invalid of [{ 旁白: 'S_new' }, { 阿泽: '../path' }, { 小晓: 'a'.repeat(121) }]) {
      assert.throws(() => validateVoiceMapping(invalid, provider), InputError);
    }
  }
  for (const field of ['X-Api-Key', 'X-Api-Access-Key', 'X-Api-App-Id', 'accessKey', 'appId', 'endpoint']) {
    assert.ok(!redactSecrets(JSON.stringify({ [field]: 'private-value' })).includes('private-value'));
  }
});

test('空串和纯空白不会破坏正文，带空格的凭据按实际值脱敏', () => {
  assert.equal(redactSecrets('连接失败：test-credential', ['', '   ', '\t', ' test-credential ']), '连接失败：***');
});

test('微调台词只接受有效的角色、文本和单行情绪，返回全新的公开字段', () => {
  const line = { speaker: '小晓', text: ' 正文 ', emotion: ' 温和 ', index: 7, audioUrl: '/wrong' };
  assert.deepStrictEqual(validateEditedDialogue([line]), [{ speaker: '小晓', text: '正文', emotion: '温和' }]);
  for (const emotion of [null, undefined, '', '   ']) {
    assert.deepStrictEqual(validateEditedDialogue([{ ...line, emotion }]), [{ speaker: '小晓', text: '正文' }]);
  }
  for (const lines of [null, [], Array(301).fill(line), Array(1), [null], [[]], [{}], ['text'],
    [{ ...line, speaker: '嘉宾' }], [{ ...line, speaker: ' 小晓 ' }], [{ ...line, text: false }], [{ ...line, text: ' ' }],
    [{ ...line, text: '字'.repeat(2001) }], ...[0, '字'.repeat(21), '温和\n', 'a\u007fb', 'a\u2028b'].map(emotion => [{ ...line, emotion }])]) {
    assert.throws(() => validateEditedDialogue(lines), { statusCode: 400 });
  }
  assert.strictEqual(validateEditedDialogue(Array(300).fill({ ...line, text: ' ' + '字'.repeat(2000) } )).length, 300);
});

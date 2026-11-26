const { InputError } = require('./validation');

const SPEECH_SPEEDS = Object.freeze(['relaxed', 'standard']);

function normalizeSpeechSpeed(value, defaultSpeed = 'relaxed') {
  const speed = value === undefined ? defaultSpeed : value;
  if (!SPEECH_SPEEDS.includes(speed)) throw new InputError('语速仅支持舒缓（relaxed）或标准（standard）');
  return speed;
}

const CALENDAR_YEAR = /^(?:1[1-9]\d{2}|20\d{2})$/;
const CHINESE_DIGITS = '零一二三四五六七八九';
const URL_OR_SPOKEN_SPEC = /((?:[a-z][a-z\d+.-]*:\/\/|www\.)[^\s"'<>()（）《》【】，。！？；：、]+)|(?<![A-Za-z0-9._/])(?:(\d+(?:\.\d+)?)\s*([-~～—–至到])\s*)?(\d+)\s*(年代?)|(?<![A-Za-z0-9._/-])((?:480|720|1080|1440|2160)p|1080i)(?![A-Za-z0-9_/-]|\.[A-Za-z0-9])/gi;
const STRICT_DURATION_PREFIX = /(?:历时|长达|持续|跨越|经过|相隔|距今|已有|超过|不到|不足|将近|满|整整|一共|共计|总共|累计|短短|为期)\s*$/;
const APPROXIMATE_PREFIX = /(?:大约|约|近|前后)\s*$/;
const DURATION_SUFFIX = /^(?:的?(?:历史|时间|之久|岁月|沧桑|光阴|历程)|多|余|间)/;
const RESOLUTIONS = {
  '480p': '四百八十P',
  '720p': '七百二十P',
  '1080p': '一千零八十P',
  '1440p': '一千四百四十P',
  '2160p': '两千一百六十P',
  '1080i': '一千零八十i',
};

function normalizeSpeechText(text) {
  if (typeof text !== 'string') throw new Error('合成文本必须是非空字符串');
  const readDigits = number => number.replace(/\d/g, digit => CHINESE_DIGITS[Number(digit)]);
  return text.replace(URL_OR_SPOKEN_SPEC, (match, url, start, separator, end, unit, resolution, offset) => {
    if (url) return match;
    if (resolution) return RESOLUTIONS[resolution.toLowerCase()];
    if (unit === '年') {
      const prefix = text.slice(0, offset);
      if (STRICT_DURATION_PREFIX.test(prefix) ||
          (APPROXIMATE_PREFIX.test(prefix) && DURATION_SUFFIX.test(text.slice(offset + match.length)))) return match;
    }
    if (start) {
      if (!CALENDAR_YEAR.test(start) || !CALENDAR_YEAR.test(end)) return match;
      return `${readDigits(start)}${separator === '至' ? '至' : '到'}${readDigits(end)}${unit}`;
    }
    if (CALENDAR_YEAR.test(end) || (unit === '年代' && /^[1-9]0$/.test(end))) return `${readDigits(end)}${unit}`;
    return match;
  });
}

const MINIMAX_PRONUNCIATIONS = [
  '重算/(chong2)(suan4)',
  '重新/(chong2)(xin1)',
  '重来/(chong2)(lai2)',
  '重复/(chong2)(fu4)',
  '重建/(chong2)(jian4)',
  '重演/(chong2)(yan3)',
  '重塑/(chong2)(su4)',
  '重启/(chong2)(qi3)',
  '重做/(chong2)(zuo4)',
  '重写/(chong2)(xie3)',
  '重排/(chong2)(pai2)',
  '重估/(chong2)(gu1)',
  '重温/(chong2)(wen1)',
  '重申/(chong2)(shen1)',
  '处理/(chu3)(li3)',
  '行长/(hang2)(zhang3)',
  '行业/(hang2)(ye4)',
  '银行/(yin2)(hang2)',
  '下载/(xia4)(zai4)',
  '转载/(zhuan3)(zai3)',
  '调侃/(tiao2)(kan3)',
  '调校/(tiao2)(jiao4)',
  '校对/(jiao4)(dui4)',
  '角色/(jue2)(se4)',
  '主角/(zhu3)(jue2)',
  '勉强/(mian3)(qiang3)',
  '强迫/(qiang3)(po4)',
  '暴露/(bao4)(lu4)',
  '单薄/(dan1)(bo2)',
  '着重/(zhuo2)(zhong4)',
  '着迷/(zhao2)(mi2)',
  '长远/(chang2)(yuan3)',
  '成长/(cheng2)(zhang3)',
];

function extractMinimaxPronunciationDict(text) {
  if (typeof text !== 'string') return [];
  return MINIMAX_PRONUNCIATIONS.filter(entry => text.includes(entry.slice(0, entry.indexOf('/'))));
}

module.exports = { SPEECH_SPEEDS, normalizeSpeechSpeed, normalizeSpeechText, extractMinimaxPronunciationDict };

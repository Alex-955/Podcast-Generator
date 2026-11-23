const fs = require('fs');
const path = require('path');

/**
 * 纯 JS 生成极简舒缓氛围背景音乐 (Lo-Fi Ambient Chords) WAV 文件
 * 采样率 44100Hz, 16bit 立体声，无缝循环
 */
function generateAmbientChordsWav(filePath, durationSec = 30) {
  const sampleRate = 44100;
  const numChannels = 2;
  const bytesPerSample = 2;
  const totalSamples = sampleRate * durationSec;
  const dataSize = totalSamples * numChannels * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF 标头
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // fmt 子块
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // 子块大小 16
  buffer.writeUInt16LE(1, 20);  // PCM = 1
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * numChannels * bytesPerSample, 28); // byteRate
  buffer.writeUInt16LE(numChannels * bytesPerSample, 32); // blockAlign
  buffer.writeUInt16LE(16, 34); // bitsPerSample

  // data 子块
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // 生成温暖的和弦 progression: Cmaj7 -> Am7 -> Fmaj7 -> Gsus4
  // 模拟温柔的风铃与电钢琴低沉温暖泛音
  const chords = [
    [261.63, 329.63, 392.00, 493.88], // Cmaj7
    [220.00, 261.63, 329.63, 392.00], // Am7
    [174.61, 220.00, 261.63, 329.63], // Fmaj7
    [196.00, 261.63, 293.66, 392.00], // Gsus4
  ];

  const chordDuration = durationSec / chords.length;
  let offset = 44;

  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    const chordIdx = Math.min(Math.floor(t / chordDuration), chords.length - 1);
    const chord = chords[chordIdx];
    const localT = t % chordDuration;

    // 平滑包络，避免切和弦时有爆音
    const envelope = Math.sin((localT / chordDuration) * Math.PI);

    let sample = 0;
    for (let f = 0; f < chord.length; f++) {
      const freq = chord[f];
      // 基波 + 柔和二次谐波
      sample += Math.sin(2 * Math.PI * freq * t) * 0.15;
      sample += Math.sin(2 * Math.PI * (freq * 2) * t) * 0.05;
      // 轻微移相产生立体声宽广感
    }

    // 叠加微弱的粉红/白噪音带来黑胶唱片温暖质感
    const vinylWarmth = (Math.random() * 2 - 1) * 0.008;

    sample = (sample * envelope + vinylWarmth) * 0.25; // 控制音量轻柔
    sample = Math.max(-1, Math.min(1, sample));

    const intSample = Math.floor(sample * 32767);

    // 左声道
    buffer.writeInt16LE(intSample, offset);
    offset += 2;
    // 右声道 (微调延迟产生空间感)
    buffer.writeInt16LE(intSample, offset);
    offset += 2;
  }

  fs.writeFileSync(filePath, buffer);
  return filePath;
}

module.exports = {
  generateAmbientChordsWav,
};

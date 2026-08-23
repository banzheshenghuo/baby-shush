(() => {
  'use strict';

  const circle = document.getElementById('circle');
  const stateLabel = document.getElementById('stateLabel');
  const hint = document.getElementById('hint');

  // ---------- 「嘘」声音源：程序化生成（棕噪声 + 缓慢起伏 + 首尾交叉淡化的无缝循环） ----------
  // 用固定种子保证每次生成的声音一致
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const SAMPLE_RATE = 22050;
  const LOOP_SECONDS = 12;

  function generateShushWav() {
    const rate = SAMPLE_RATE;
    const n = LOOP_SECONDS * rate;
    const fadeN = rate; // 首尾 1 秒交叉淡化，保证循环衔接处无爆音
    const rand = mulberry32(20260823);

    // 棕噪声（白噪声积分，接近子宫内的低频环境声）叠加两个不相关低频起伏，避免机械感
    const raw = new Float32Array(n + fadeN);
    let brown = 0;
    for (let i = 0; i < raw.length; i++) {
      const white = rand() * 2 - 1;
      brown = (brown + 0.02 * white) / 1.02;
      const t = i / rate;
      const lfo = 1 + 0.13 * Math.sin(2 * Math.PI * 0.13 * t) + 0.06 * Math.sin(2 * Math.PI * 0.047 * t + 1.7);
      raw[i] = brown * 3.2 * lfo;
    }

    // 首尾交叉淡化：结尾 fadeN 个采样混入开头，循环点两侧是连续采样，天然无缝
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (i < fadeN) {
        const w = Math.sin((Math.PI / 2) * (i / fadeN));
        out[i] = raw[i] * w + raw[n + i] * Math.cos((Math.PI / 2) * (i / fadeN));
      } else {
        out[i] = raw[i];
      }
    }

    // 峰值归一化到 0.35（约 -9 dBFS，柔和起始音量，具体由音量条调节）
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
    const gain = peak > 0 ? 0.35 / peak : 1;

    // PCM16 单声道 WAV 编码
    const dataSize = n * 2;
    const buf = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buf);
    const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); writeStr(8, 'WAVE');
    writeStr(12, 'fmt '); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);   // PCM
    view.setUint16(22, 1, true);   // 单声道
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data'); view.setUint32(40, dataSize, true);
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, out[i] * gain));
      view.setInt16(44 + i * 2, s * 32767, true);
    }
    return new Blob([view], { type: 'audio/wav' });
  }

  // ---------- 播放（HTMLAudioElement：可被系统媒体通知接管，锁屏 / 息屏继续播放） ----------
  const audio = new Audio();
  audio.loop = true;
  audio.preload = 'auto';

  let hasStarted = false; // 是否发生过用户交互（区分「未开始」与「已暂停」文案）

  function updateUI() {
    const playing = !audio.paused;
    circle.classList.toggle('playing', playing);
    stateLabel.textContent = playing ? '嘘…' : (hasStarted ? '已暂停' : '轻触开始');
    hint.textContent = playing
      ? '轻触圆圈暂停 · 锁屏 / 息屏继续播放'
      : (hasStarted ? '轻触圆圈继续' : '轻触中间的圆圈开始播放');
    if (navigator.mediaSession) {
      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    }
  }

  async function tryPlay() {
    try {
      await audio.play();
    } catch (_) {
      // 浏览器自动播放策略拦截：等待用户轻触圆圈后重试
    }
  }

  circle.addEventListener('click', () => {
    hasStarted = true;
    if (audio.paused) {
      tryPlay();
    } else {
      audio.pause();
    }
  });

  // 播放状态变化统一由元素事件驱动（锁屏控件、耳机按键也会触发）
  audio.addEventListener('play', updateUI);
  audio.addEventListener('pause', updateUI);

  // ---------- 锁屏 / 耳机 / 车载控制（Media Session） ----------
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: '嘘嘘哄睡',
        artist: '婴儿哄睡白噪音',
        album: 'Baby Shush',
        artwork: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      });
      navigator.mediaSession.setActionHandler('play', () => tryPlay());
      navigator.mediaSession.setActionHandler('pause', () => audio.pause());
      navigator.mediaSession.setActionHandler('stop', () => audio.pause());
    } catch (_) {
      // 不支持时忽略
    }
  }

  // ---------- 启动：生成音源并尝试自动播放 ----------
  (function init() {
    audio.src = URL.createObjectURL(generateShushWav());
    updateUI();
    tryPlay(); // 进入页面即播放；被浏览器策略拦截时等待轻触圆圈
  })();

  // 注册 Service Worker（本地 file:// 打开时自动跳过）
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  // 供仿真测试与调试使用
  window.__babyShush = { audio, generateShushWav };
})();

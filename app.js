(() => {
  'use strict';

  const circle = document.getElementById('circle');
  const stateLabel = document.getElementById('stateLabel');
  const hint = document.getElementById('hint');

  // ---------- 「嘘」声兜底音源：程序化合成（棕噪声 + 缓慢起伏 + 首尾交叉淡化的无缝循环） ----------
  // 常规播放使用本地录音 audio/xuxu.mp3；仅当录音加载失败时回退到这里。固定种子保证每次生成一致
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

    // 峰值归一化到 0.35（约 -9 dBFS，柔和音量，最终由设备音量键调节）
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
  const AUDIO_FILE = 'audio/xuxu.mp3'; // 随仓库分发的真实「嘘」声录音，循环播放
  const audio = new Audio();
  audio.loop = true;
  audio.preload = 'auto';
  audio.autoplay = true; // 数据就绪即刻起播；play() 再主动触发一次双保险

  let hasStarted = false; // 是否真正播放过（区分「未开始」与「已暂停」文案）
  let usingFallback = false; // 录音加载失败后切换为程序化合成音源

  function updateUI() {
    const playing = !audio.paused;
    circle.classList.toggle('playing', playing);
    stateLabel.textContent = playing ? '嘘…' : (hasStarted ? '已暂停' : '轻触开始');
    hint.textContent = playing
      ? '轻触圆圈暂停 · 锁屏 / 息屏继续播放'
      : (hasStarted ? '轻触圆圈继续' : '轻触屏幕任意位置开始播放');
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
    if (audio.paused) {
      tryPlay();
    } else {
      audio.pause();
    }
  });

  // 自动播放被浏览器策略拦截时，轻触屏幕任意位置即可开始（点在圆圈上仍交给圆圈自身处理）
  window.addEventListener('pointerdown', (e) => {
    if (hasStarted || !audio.paused) return;
    if (e && e.target && e.target.closest && e.target.closest('#circle')) return;
    tryPlay();
  });

  // 播放状态变化统一由元素事件驱动（锁屏控件、耳机按键也会触发）
  // hasStarted 以「真正出过声」为准：手势兜底、圆圈点按、锁屏控件都能置位
  audio.addEventListener('play', () => { hasStarted = true; updateUI(); });
  audio.addEventListener('pause', updateUI);

  // 录音文件加载失败（如缓存被清理且离线）时，回退到程序化合成，保证页面始终有声
  audio.addEventListener('error', () => {
    if (usingFallback || audio.src.startsWith('blob:')) return;
    usingFallback = true;
    audio.src = URL.createObjectURL(generateShushWav());
    tryPlay();
  });

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

  // ---------- 播放计时与历史记录 ----------
  const timerEl = document.getElementById('timer');
  const historyBtn = document.getElementById('historyBtn');
  const historyModal = document.getElementById('historyModal');
  const historyClose = document.getElementById('historyClose');
  const historyTotal = document.getElementById('historyTotal');
  const historyList = document.getElementById('historyList');
  const historyClear = document.getElementById('historyClear');

  const HISTORY_KEY = 'babyShush.history';
  const SESSION_KEY = 'babyShush.session';
  const HISTORY_LIMIT = 100;

  const storage = {
    get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (_) { return null; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {} },
    remove(key) { try { localStorage.removeItem(key); } catch (_) {} },
  };

  let accumulatedMs = 0; // 本次会话已播放的累计毫秒（暂停期间不增长）
  let playingSince = 0;  // 当前连续播放段的起点（墙钟，息屏 / 后台播放照常累计）
  let tickTimer = null;
  let lastFlush = 0;

  function sessionMs() {
    return accumulatedMs + (audio.paused || !playingSince ? 0 : Date.now() - playingSince);
  }

  function fmtClock(ms) { // 本次计时 MM:SS（满 1 小时显示 H:MM:SS）
    const s = Math.floor(ms / 1000);
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    const two = (n) => String(n).padStart(2, '0');
    return hh > 0 ? `${hh}:${two(mm)}:${two(ss)}` : `${two(mm)}:${two(ss)}`;
  }

  function fmtDuration(ms) { // 历史条目用的自然语言时长
    const s = Math.round(ms / 1000);
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    if (hh > 0) return `${hh}时${mm}分`;
    if (mm > 0) return `${mm}分${String(ss).padStart(2, '0')}秒`;
    return `${ss}秒`;
  }

  function persistSession() {
    lastFlush = Date.now();
    storage.set(SESSION_KEY, { d: Math.floor(sessionMs()), t: lastFlush });
  }

  function renderTimer() {
    timerEl.textContent = `本次 ${fmtClock(sessionMs())}`;
    // 播放中每 10 秒落一次盘，应用被强杀也能在历史里找回这段时长
    if (!audio.paused && Date.now() - lastFlush > 10000) persistSession();
  }

  function loadHistory() {
    const list = storage.get(HISTORY_KEY);
    return Array.isArray(list) ? list : [];
  }

  function appendHistory(entry) {
    const list = loadHistory();
    list.push(entry);
    while (list.length > HISTORY_LIMIT) list.shift();
    storage.set(HISTORY_KEY, list);
  }

  // 上次运行残留的未归档会话（关闭或被强杀前落盘的）转入历史，本次计时从零开始；
  // 不足 1 分钟的会话视为误触/试听，不记录
  function recoverPreviousSession() {
    const prev = storage.get(SESSION_KEY);
    storage.remove(SESSION_KEY);
    if (prev && typeof prev.d === 'number' && prev.d >= 60 * 1000) {
      appendHistory({ t: typeof prev.t === 'number' ? prev.t : Date.now(), d: prev.d });
    }
  }

  audio.addEventListener('play', () => {
    playingSince = Date.now();
    timerEl.hidden = false;
    renderTimer();
    clearInterval(tickTimer);
    tickTimer = setInterval(renderTimer, 500);
  });

  audio.addEventListener('pause', () => {
    if (!playingSince) return;
    accumulatedMs += Date.now() - playingSince;
    playingSince = 0;
    clearInterval(tickTimer);
    renderTimer(); // 冻结显示
    persistSession();
  });

  // 页面关闭 / 切后台时落盘；播放中的时长照常累计（锁屏播放是主场景）
  window.addEventListener('pagehide', persistSession);
  document.addEventListener('visibilitychange', () => { if (document.hidden) persistSession(); });

  function fmtWhen(ms) {
    const d = new Date(ms);
    const two = (n) => String(n).padStart(2, '0');
    const now = new Date();
    const date = d.getFullYear() === now.getFullYear()
      ? `${d.getMonth() + 1}月${d.getDate()}日`
      : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
    return `${date} ${two(d.getHours())}:${two(d.getMinutes())}`;
  }

  function renderHistory() {
    historyList.innerHTML = '';
    const list = loadHistory();
    if (!list.length) {
      historyTotal.textContent = '';
      historyList.innerHTML = '<li class="empty">还没有哄睡记录</li>';
      return;
    }
    const total = list.reduce((sum, e) => sum + (e.d || 0), 0);
    historyTotal.textContent = `共 ${list.length} 次 · 累计 ${fmtDuration(total)}`;
    for (let i = list.length - 1; i >= 0; i--) {
      const li = document.createElement('li');
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = fmtWhen(list[i].t);
      const dur = document.createElement('span');
      dur.className = 'dur';
      dur.textContent = fmtDuration(list[i].d);
      li.append(when, dur);
      historyList.append(li);
    }
  }

  historyBtn.addEventListener('click', () => {
    renderHistory();
    historyModal.hidden = false;
  });
  historyClose.addEventListener('click', () => { historyModal.hidden = true; });
  historyModal.addEventListener('click', (e) => {
    if (e.target === historyModal) historyModal.hidden = true;
  });
  historyClear.addEventListener('click', () => {
    if (!loadHistory().length || confirm('确定清空全部哄睡记录吗？')) {
      storage.remove(HISTORY_KEY);
      renderHistory();
    }
  });

  // ---------- 启动：归档上次会话 → 加载录音并尝试自动播放 ----------
  (function init() {
    recoverPreviousSession();
    lastFlush = Date.now(); // 节流起点，避免刚启动就误触发落盘
    audio.src = AUDIO_FILE;
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
  window.__babyShush = { audio, generateShushWav, isUsingFallback: () => usingFallback };
})();

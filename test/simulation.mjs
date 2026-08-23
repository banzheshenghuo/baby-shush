// 嘘嘘哄睡 · 全逻辑仿真测试（零依赖，node test/simulation.mjs 即可运行）
//
// 原理：把真实的 app.js 放入 Node 虚拟机，用模拟的 Audio/MediaSession/localStorage 驱动，
// 断言：自动播放尝试、点按呼吸圆圈切换播放/暂停、被浏览器拦截后的兜底流程、
//       锁屏控件（Media Session handlers）、音量交由设备控制、WAV 音源格式与确定性。
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const APP_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app.js');
const flush = () => new Promise(r => setImmediate(r));

function attachClassList(el) {
  const classes = new Set();
  el.classList = {
    add: c => classes.add(c),
    remove: c => classes.delete(c),
    toggle: (c, force) => {
      const on = force === undefined ? !classes.has(c) : !!force;
      on ? classes.add(c) : classes.delete(c);
      return on;
    },
    contains: c => classes.has(c),
  };
  return el;
}

function makeElement(id) {
  const el = {
    id,
    style: {},
    className: '',
    textContent: '',
    value: '',
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    click() { (this.listeners.click || []).forEach(fn => fn({ target: this })); },
    fire(type) { (this.listeners[type] || []).forEach(fn => fn({ target: this })); },
  };
  return attachClassList(el);
}

// 可配置的 Audio 模拟：blocked = 首次 play() 被浏览器自动播放策略拒绝
function makeAudioClass(log, blocked) {
  return class FakeAudio {
    constructor() {
      this.paused = true;
      this.loop = false;
      this.volume = 1;
      this.src = '';
      this.preload = '';
      this.blocked = blocked;
      this.listeners = {};
    }
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
    async play() {
      log.push('play');
      if (this.blocked) {
        this.blocked = false;
        throw new Error('NotAllowedError: autoplay blocked');
      }
      this.paused = false;
      (this.listeners.play || []).forEach(fn => fn());
    }
    pause() {
      log.push('pause');
      this.paused = true;
      (this.listeners.pause || []).forEach(fn => fn());
    }
  };
}

const store = new Map(); // 多次加载共享，模拟 localStorage

function loadApp({ blocked = false } = {}) {
  const audioLog = [];
  const msHandlers = {};
  const mediaSession = {
    metadata: null,
    playbackState: 'none',
    setActionHandler: (action, fn) => { msHandlers[action] = fn; },
  };

  const els = {};
  for (const id of ['circle', 'stateLabel', 'hint']) {
    els[id] = makeElement(id);
  }

  const sandbox = {
    document: { getElementById: (id) => els[id] },
    navigator: { mediaSession },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
    },
    Audio: makeAudioClass(audioLog, blocked),
    MediaMetadata: class { constructor(m) { Object.assign(this, m); } },
    URL,    // Node 原生，支持 createObjectURL(Blob)
    Blob,   // Node 原生
    Math, parseInt, console,
  };
  sandbox.window = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(APP_JS, 'utf8'), sandbox);

  return {
    els, store, audioLog, msHandlers, mediaSession,
    audio: sandbox.__babyShush.audio,
    generateShushWav: sandbox.__babyShush.generateShushWav,
  };
}

// ---------- 场景 A：进入页面自动播放成功 ----------
const appA = loadApp();
await flush();
assert.strictEqual(appA.audioLog.filter(x => x === 'play').length, 1, '加载后应尝试自动播放一次');
assert.ok(!appA.audio.paused, '自动播放成功后应为播放中');
assert.ok(appA.audio.loop, '应循环播放');
assert.ok(appA.audio.src.startsWith('blob:'), '音源应为 blob URL');
assert.strictEqual(appA.els.stateLabel.textContent, '嘘…', '状态文案应为 嘘…');
assert.ok(appA.els.circle.classList.contains('playing'), '圆圈应为播放态样式');

// ---------- 场景 B：点按呼吸圆圈切换播放 / 暂停 ----------
appA.els.circle.click();
await flush();
assert.ok(appA.audio.paused, '播放中点按应暂停');
assert.strictEqual(appA.els.stateLabel.textContent, '已暂停', '状态文案应为 已暂停');
assert.ok(!appA.els.circle.classList.contains('playing'), '圆圈应退出播放态样式');
appA.els.circle.click();
await flush();
assert.ok(!appA.audio.paused, '暂停中点按应继续播放');

// ---------- 场景 C：自动播放被拦截 → 轻触圆圈开始 ----------
const appC = loadApp({ blocked: true });
await flush();
assert.ok(appC.audio.paused, '被拦截时应保持暂停');
assert.strictEqual(appC.els.stateLabel.textContent, '轻触开始', '应提示轻触开始');
appC.els.circle.click();
await flush();
assert.ok(!appC.audio.paused, '轻触后应开始播放');
assert.strictEqual(appC.els.stateLabel.textContent, '嘘…');

// ---------- 场景 D：锁屏控件（Media Session） ----------
assert.strictEqual(typeof appA.msHandlers.play, 'function', '应注册 play 处理器');
assert.strictEqual(typeof appA.msHandlers.pause, 'function', '应注册 pause 处理器');
assert.strictEqual(appA.mediaSession.metadata.title, '嘘嘘哄睡', '锁屏应显示标题');
assert.strictEqual(appA.mediaSession.metadata.artwork.length, 2, '锁屏封面应有两档图标');
appA.msHandlers.pause();
await flush();
assert.ok(appA.audio.paused, '锁屏暂停控件应生效');
appA.msHandlers.play();
await flush();
assert.ok(!appA.audio.paused, '锁屏播放控件应生效');

// 音量完全由设备硬件控制，不应设置程序音量（保持元素默认值 1）
const appD = loadApp();
await flush();
assert.strictEqual(appD.audio.volume, 1, '不应再设置程序音量');

// ---------- 场景 E：WAV 音源格式与确定性（真实 Blob） ----------
const bytes = Buffer.from(await appD.generateShushWav().arrayBuffer());
assert.strictEqual(bytes.length, 44 + 12 * 22050 * 2, 'WAV 总长 = 44 字节头 + 12s×22050×2B');
assert.strictEqual(bytes.toString('ascii', 0, 4), 'RIFF');
assert.strictEqual(bytes.toString('ascii', 8, 12), 'WAVE');
assert.strictEqual(bytes.readUInt16LE(22), 1, '单声道');
assert.strictEqual(bytes.readUInt32LE(24), 22050, '采样率 22050');
assert.strictEqual(bytes.readUInt16LE(34), 16, '16 位 PCM');
const bytes2 = Buffer.from(await appD.generateShushWav().arrayBuffer());
assert.ok(bytes2.equals(bytes), '固定种子应生成完全一致的音源');

console.log('✓ 场景A：进入页面自动播放（loop、blob 音源、播放态 UI 正确）');
console.log('✓ 场景B：点按呼吸圆圈在 播放/暂停 间切换，文案与样式同步');
console.log('✓ 场景C：自动播放被浏览器拦截时提示「轻触开始」，轻触后正常播放');
console.log('✓ 场景D：锁屏/耳机播放暂停控件与元数据（Media Session）正确；音量交由设备硬件控制');
console.log('✓ 场景E：WAV 音源格式、长度与确定性校验通过');

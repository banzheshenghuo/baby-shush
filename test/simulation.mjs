// 嘘嘘哄睡 · 全逻辑仿真测试（零依赖，node test/simulation.mjs 即可运行）
//
// 原理：把真实的 app.js 放入 Node 虚拟机，用模拟的 Audio/MediaSession/localStorage 驱动，
// 断言：自动播放尝试、点按呼吸圆圈切换播放/暂停、被浏览器拦截后的兜底流程、
//       锁屏控件（Media Session handlers）、音量交由设备控制、本地录音音源与加载失败回退、
//       合成兜底 WAV 的格式与确定性、播放计时（走表/停表）、关闭归档与历史面板。
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
    append(...kids) { (this.children ||= []).push(...kids); },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._innerHTML || ''; },
    set(v) { if (v === '') this.children = []; this._innerHTML = v; },
  });
  return attachClassList(el);
}

// 可控时钟：app.js 的计时全部走 Date.now() / new Date()，测试里统一替换为可拨动的假时钟
const RealDate = Date;
let fakeNow = RealDate.parse('2026-08-22T14:00:00');
class FakeDate extends RealDate {
  constructor(...args) { if (args.length === 0) args = [fakeNow]; super(...args); }
  static now() { return fakeNow; }
}
const advanceClock = (ms) => { fakeNow += ms; };

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
  for (const id of ['circle', 'stateLabel', 'hint', 'timer', 'historyBtn', 'historyModal', 'historyClose', 'historyTotal', 'historyList', 'historyClear']) {
    els[id] = makeElement(id);
  }

  const intervalFns = [];
  const winListeners = {};

  const sandbox = {
    document: {
      getElementById: (id) => els[id],
      hidden: false,
      addEventListener: () => {},
      createElement: () => makeElement(''),
    },
    navigator: { mediaSession },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    },
    addEventListener: (t, fn) => { (winListeners[t] ||= []).push(fn); },
    setInterval: (fn) => { intervalFns.push(fn); return intervalFns.length; },
    clearInterval: () => {},
    confirm: () => true,
    Date: FakeDate,
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
    isUsingFallback: sandbox.__babyShush.isUsingFallback,
    tick: () => intervalFns.forEach(fn => fn()),
    fireWindow: (t) => (winListeners[t] || []).forEach(fn => fn()),
  };
}

// ---------- 场景 A：进入页面自动播放成功 ----------
const appA = loadApp();
await flush();
assert.strictEqual(appA.audioLog.filter(x => x === 'play').length, 1, '加载后应尝试自动播放一次');
assert.ok(!appA.audio.paused, '自动播放成功后应为播放中');
assert.ok(appA.audio.loop, '应循环播放');
assert.strictEqual(appA.audio.src, 'audio/xuxu.mp3', '音源应为本地录音文件');
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

// ---------- 场景 F：录音文件加载失败 → 回退程序化合成并重新播放 ----------
const appF = loadApp();
await flush();
assert.strictEqual(appF.audio.src, 'audio/xuxu.mp3', '初始音源为录音文件');
assert.ok(!appF.isUsingFallback(), '初始不在回退模式');
(appF.audio.listeners.error || []).forEach(fn => fn());
await flush();
assert.ok(appF.audio.src.startsWith('blob:'), '加载失败后应切换到合成 blob 音源');
assert.ok(!appF.audio.paused, '回退后应重新尝试播放');
assert.ok(appF.isUsingFallback(), '应标记为回退模式');
const before = appF.audio.src;
(appF.audio.listeners.error || []).forEach(fn => fn());
await flush();
assert.strictEqual(appF.audio.src, before, '重复 error 不应再次切换音源');

// ---------- 场景 G：本次播放计时（播放走表、暂停停表、恢复后继续累加） ----------
const appG = loadApp();
await flush();
advanceClock(5000);
appG.tick();
assert.strictEqual(appG.els.timer.textContent, '本次 00:05', '播放中应走表');
appG.els.circle.click();
await flush();
advanceClock(10000);
appG.tick();
assert.strictEqual(appG.els.timer.textContent, '本次 00:05', '暂停后应停表且不累计');
appG.els.circle.click();
await flush();
advanceClock(5000);
appG.tick();
assert.strictEqual(appG.els.timer.textContent, '本次 00:10', '恢复播放应从原值继续累加');

// ---------- 场景 H：关闭应用 → 上次时长归档进历史，重新进入计时归零 ----------
appG.fireWindow('pagehide');
assert.strictEqual(JSON.parse(appG.store.get('babyShush.session')).d, 10000, '关闭时应落盘会话时长');
advanceClock(60000);
const appH = loadApp();
await flush();
assert.strictEqual(appH.els.timer.textContent, '本次 00:00', '重新进入后本次计时归零');
assert.strictEqual(appH.store.has('babyShush.session'), false, '残留会话应被清理');
const hist1 = JSON.parse(appH.store.get('babyShush.history'));
assert.strictEqual(hist1.length, 1, '历史应有 1 条记录');
assert.strictEqual(hist1[0].d, 10000, '历史时长应为上一会话的 10 秒');

// ---------- 场景 I：历史记录面板（查看 / 关闭 / 清空） ----------
advanceClock(65000);
appH.tick();
assert.strictEqual(appH.els.timer.textContent, '本次 01:05', '新会话从零重新计时');
appH.els.historyBtn.click();
assert.strictEqual(appH.els.historyModal.hidden, false, '应打开历史面板');
assert.strictEqual(appH.els.historyTotal.textContent, '共 1 次 · 累计 10秒', '汇总行正确');
const liRow = appH.els.historyList.children[0];
assert.ok(liRow.children[0].textContent.includes('8月22日'), '记录应含日期');
assert.strictEqual(liRow.children[1].textContent, '10秒', '记录时长正确');
appH.els.historyClose.click();
assert.strictEqual(appH.els.historyModal.hidden, true, '应能关闭历史面板');
appH.els.historyBtn.click();
appH.els.historyClear.click();
assert.strictEqual(appH.els.historyList.children.length, 0, '清空后列表为空');
assert.ok(appH.els.historyList.innerHTML.includes('还没有哄睡记录'), '清空后应有空态提示');

console.log('✓ 场景A：进入页面自动播放（loop、本地录音音源、播放态 UI 正确）');
console.log('✓ 场景B：点按呼吸圆圈在 播放/暂停 间切换，文案与样式同步');
console.log('✓ 场景C：自动播放被浏览器拦截时提示「轻触开始」，轻触后正常播放');
console.log('✓ 场景D：锁屏/耳机播放暂停控件与元数据（Media Session）正确；音量交由设备硬件控制');
console.log('✓ 场景E：合成兜底 WAV 格式、长度与确定性校验通过');
console.log('✓ 场景F：录音加载失败时自动回退合成音源并续播，且回退只发生一次');
console.log('✓ 场景G：播放计时走表 / 暂停停表 / 恢复继续累加');
console.log('✓ 场景H：关闭应用时上次时长归档进历史，重新进入本次计时归零');
console.log('✓ 场景I：历史记录面板的查看、汇总、关闭与清空');

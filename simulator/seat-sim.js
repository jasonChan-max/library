/**
 * ============================================================================
 *  Smart Seat · 虚拟座位模拟器 (seat-sim.js)
 * ============================================================================
 *
 *  作用：在没有 ESP32-C3 硬件的情况下，用 N 个 WebSocket 客户端完整模拟
 *        「设备侧」行为，用于端到端验证：
 *          hello 注册 → sensor 占位 → button away_start → 服务端权威倒计时
 *          → 预超时告警 → 超时告警 → 设备断线/重连 → snapshot 重同步
 *
 *  前置：先在 server/ 目录执行 `npm install && npm start`，让 Hub 跑在 8080。
 *        本脚本会优先从 ../server/node_modules 复用 ws，无需二次安装。
 *
 *  用法：
 *    node simulator/seat-sim.js
 *    node simulator/seat-sim.js --count 8 --interval 2500
 *    node simulator/seat-sim.js --demo          # 快节奏演示：12s 暂离 + 5s 预预警 + 立即触发一次超时
 *    node simulator/seat-sim.js --chaos        # 随机断线重连，演练重连与快照补帧
 *    node simulator/seat-sim.js --all          # demo + chaos 全开
 *    node simulator/seat-sim.js --hub ws://192.168.1.10:8080/ws
 *
 *  参数：
 *    --hub        Hub WebSocket 地址，默认 ws://127.0.0.1:8080/ws
 *    --count      虚拟座位数，默认 12（对应 Hub 预置的 A01..A12）
 *    --interval   随机事件间隔 ms，默认 3000
 *    --demo       把暂离时长改为 0.2 分钟(12s)、预预警 5s，并立刻制造一个暂离
 *    --chaos      每 ~9s 随机断开并重的连一个设备
 *    --all        --demo + --chaos
 *
 *  协议：严格遵循 ../shared/protocol.js（唯一事实源）。
 *        模拟器只上报「事实」(sensor / button / ping)，绝不自行推导 status。
 * ============================================================================
 */

'use strict';

const path = require('path');
const protocol = require('../shared/protocol.js');

// --- ws 解析：优先复用 server/node_modules，避免重复安装 ---------------------
let WebSocket;
try {
  WebSocket = require('ws');
} catch (_) {
  try {
    WebSocket = require(path.join(__dirname, '..', 'server', 'node_modules', 'ws'));
  } catch (e) {
    console.error('[FATAL] 找不到 ws 模块。请先在 server/ 目录执行：npm install');
    process.exit(1);
  }
}

// --- CLI 参数 ---------------------------------------------------------------
const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  if (name === 'demo' || name === 'chaos' || name === 'all') return true;
  return argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}
const HUB = arg('hub', 'ws://127.0.0.1:8080/ws');
const COUNT = Math.max(1, Math.min(60, parseInt(arg('count', '12'), 10) || 12));
const INTERVAL = Math.max(300, parseInt(arg('interval', '3000'), 10) || 3000);
const DEMO = !!(arg('demo', false) || arg('all', false));
const CHAOS = !!(arg('chaos', false) || arg('all', false));
const HEARTBEAT_MS = 5000;

const ZONES = ['Zone A · 靠窗', 'Zone B · 中岛', 'Zone C · 安静区'];
const LOG = (tag, ...m) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${tag}`, ...m);

function seatIdOf(i) {
  const letter = String.fromCharCode(65 + Math.floor(i / 12));
  return `${letter}${String((i % 12) + 1).padStart(2, '0')}`;
}

/** 单个虚拟设备 */
class VirtualSeat {
  constructor(index, hubUrl) {
    this.index = index;
    this.seatId = seatIdOf(index);
    this.clientId = `SIM-${this.seatId}`;
    this.zone = ZONES[Math.floor(index / 4) % ZONES.length];
    this.hubUrl = hubUrl;
    this.ws = null;
    this.seq = 0;
    this.connected = false;
    this.forcedOffline = false;
    this.retry = 0;
    this.retryTimer = null;
    this.heartbeat = null;
    this.snapshotApplied = false;
    // 镜像服务端权威状态，仅用于「决定下一个合理事件」，不作为真值
    this.mirror = { status: protocol.STATUS.AVAILABLE, occupied: false, awayUntil: null, online: false };
    this.connect();
  }

  url() {
    const u = new URL(this.hubUrl);
    u.searchParams.set('role', protocol.ROLE.DEVICE);
    u.searchParams.set('id', this.clientId);
    return u.toString();
  }

  connect() {
    if (this.forcedOffline) return;
    try {
      this.ws = new WebSocket(this.url());
    } catch (e) {
      LOG(`[${this.seatId}] 构造连接失败`, e.message);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.connected = true;
      this.retry = 0;
      LOG(`[${this.seatId}] ✓ 已连接 Hub`);
      this.send({
        type: 'hello',
        role: protocol.ROLE.DEVICE,
        clientId: this.clientId,
        seatId: this.seatId,
        fw: 'sim-1.0.0',
        caps: { display: 'virtual', sensor: 'virtual', simulator: true, zone: this.zone },
      });
      this.heartbeat = setInterval(() => this.send({ type: 'ping', ts: Date.now() }), HEARTBEAT_MS);
    });

    this.ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      this.onMessage(msg);
    });

    this.ws.on('close', () => {
      this.connected = false;
      clearInterval(this.heartbeat);
      this.heartbeat = null;
      if (!this.forcedOffline) {
        LOG(`[${this.seatId}] ✕ 连接断开，准备重连`);
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (e) => {
      LOG(`[${this.seatId}] ! 连接错误`, e.message);
      try { this.ws.terminate(); } catch { /* noop */ }
    });
  }

  scheduleReconnect() {
    if (this.retryTimer) return;
    const backoff = Math.min(protocol.TIMING.BACKOFF_BASE_MS * (2 ** this.retry), protocol.TIMING.BACKOFF_MAX_MS);
    const wait = Math.round(backoff * (0.8 + Math.random() * 0.4));
    this.retry = Math.min(this.retry + 1, 6);
    LOG(`[${this.seatId}] ${wait}ms 后重连 (retry #${this.retry})`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, wait);
  }

  onMessage(msg) {
    switch (msg.type) {
      case 'snapshot': {
        this.snapshotApplied = true;
        const seat = (msg.seats || []).find((s) => s.seatId === this.seatId);
        if (seat) this.applySeat(seat);
        LOG(`[${this.seatId}] ⇄ 已接收快照重同步 (${msg.seats?.length || 0} 座位, 协议 v${msg.protocol})`);
        break;
      }
      case 'seat.update': {
        if (msg.seat && msg.seat.seatId === this.seatId) {
          const prev = this.mirror.status;
          this.applySeat(msg.seat);
          if (prev !== this.mirror.status) {
            LOG(`[${this.seatId}] 状态 ${prev} → ${this.mirror.status}${this.mirror.awayUntil ? ` (截止 ${new Date(this.mirror.awayUntil).toLocaleTimeString('zh-CN', { hour12: false })})` : ''}`);
          }
        }
        break;
      }
      case 'config.update':
        LOG(`[${this.seatId}] 配置更新: ${msg.config.awayDurationMin}min / 预预警 ${msg.config.alertLeadSec}s`);
        break;
      case 'alert':
        if (msg.alert && msg.alert.seatId === this.seatId) {
          LOG(`[${this.seatId}] 🚨 收到告警 [${msg.alert.severity}/${msg.alert.kind}] ${msg.alert.message}`);
        }
        break;
      case 'error':
        LOG(`[${this.seatId}] 服务端拒绝: ${msg.code} ${msg.message}`);
        break;
      case 'pong':
      default:
        break;
    }
  }

  applySeat(seat) {
    this.mirror.status = seat.status;
    this.mirror.occupied = !!seat.occupied;
    this.mirror.awayUntil = seat.awayUntil || null;
    this.mirror.online = !!seat.online;
  }

  send(obj) {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try { this.ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  /** 上报事实：占位传感器边沿 */
  sensor(occupied) {
    return this.send({ type: 'sensor', seatId: this.seatId, occupied: !!occupied, seq: ++this.seq });
  }

  /** 上报事实：物理按键事件 */
  button(action) {
    return this.send({ type: 'button', seatId: this.seatId, action, seq: ++this.seq, ts: Date.now() });
  }

  /** 依据当前镜像状态，产生一个「合理」的下一个事件 */
  randomEvent() {
    if (!this.connected || !this.snapshotApplied) return;
    const r = Math.random();
    const s = this.mirror.status;

    if (s === protocol.STATUS.AVAILABLE) {
      // 有人坐下
      if (r < 0.75) { this.sensor(true); LOG(`[${this.seatId}] → 有人坐下 (sensor=true)`); }
    } else if (s === protocol.STATUS.OCCUPIED) {
      if (r < 0.55) { this.button(protocol.ACTION.AWAY_START); LOG(`[${this.seatId}] → 按键·开始暂离`); }
      else if (r < 0.85) { this.sensor(false); LOG(`[${this.seatId}] → 起身离开 (sensor=false)`); }
    } else if (s === protocol.STATUS.AWAY) {
      if (r < 0.20) { this.button(protocol.ACTION.AWAY_CANCEL); LOG(`[${this.seatId}] → 按键·取消暂离`); }
      else if (r < 0.30) { this.button(protocol.ACTION.EXTEND); LOG(`[${this.seatId}] → 按键·续时 +5min`); }
      else if (r < 0.34) { this.button(protocol.ACTION.RELEASE); LOG(`[${this.seatId}] → 长按·释放座位`); }
      // 其余情况什么都不做，让服务端倒计时自然走到超时
    }
  }

  /** chaos：模拟设备断电 / WiFi 抖动 */
  dropAndRecover() {
    if (this.forcedOffline || !this.connected) return;
    LOG(`[${this.seatId}] ⚡ 模拟断线 (chaos)`);
    this.forcedOffline = true;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
    try { this.ws.close(); } catch { /* noop */ }
    setTimeout(() => {
      this.forcedOffline = false;
      LOG(`[${this.seatId}] ⚡ 模拟恢复上电，重新连接`);
      this.retry = 0;
      this.connect();
    }, 3000 + Math.random() * 3000);
  }

  shutdown() {
    clearInterval(this.heartbeat);
    clearTimeout(this.retryTimer);
    try { this.ws && this.ws.close(); } catch { /* noop */ }
  }
}

// --- 演示配置客户端 ---------------------------------------------------------
function applyDemoConfig() {
  return new Promise((resolve) => {
    const u = new URL(HUB);
    u.searchParams.set('role', protocol.ROLE.DASHBOARD);
    u.searchParams.set('id', 'SIM-CONFIG');
    const ws = new WebSocket(u.toString());
    const timer = setTimeout(() => { try { ws.terminate(); } catch {} resolve(false); }, 4000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', role: protocol.ROLE.DASHBOARD, clientId: 'SIM-CONFIG' }));
      ws.send(JSON.stringify({
        type: 'config.set',
        patch: { awayDurationMin: 0.2, alertLeadSec: 5, graceSec: 15 },
      }));
      LOG('[CONFIG] ⚙ 演示配置已下发：暂离 0.2min(12s) / 预预警 5s / grace 15s');
      setTimeout(() => { clearTimeout(timer); try { ws.close(); } catch {} resolve(true); }, 600);
    });
    ws.on('error', (e) => { LOG('[CONFIG] 下发失败', e.message); clearTimeout(timer); resolve(false); });
  });
}

// --- 主流程 -----------------------------------------------------------------
const seats = [];

function boot() {
  LOG('SIM', '════════════════════════════════════════════════════════');
  LOG('SIM', ' Smart Seat 虚拟座位模拟器');
  LOG('SIM', ` Hub       : ${HUB}`);
  LOG('SIM', ` 虚拟座位  : ${COUNT} 个  (${seatIdOf(0)} .. ${seatIdOf(COUNT - 1)})`);
  LOG('SIM', ` 事件间隔  : ${INTERVAL}ms`);
  LOG('SIM', ` 演示模式  : ${DEMO ? 'ON（12s 暂离，快速触发超时告警）' : 'OFF'}`);
  LOG('SIM', ` 断线演练  : ${CHAOS ? 'ON' : 'OFF'}`);
  LOG('SIM', '════════════════════════════════════════════════════════');

  for (let i = 0; i < COUNT; i++) seats.push(new VirtualSeat(i, HUB));

  // 初始占位：随机让 1/3 座位「有人」，制造初始 occupied 状态
  setTimeout(() => {
    seats.forEach((s) => { if (Math.random() < 0.34) s.sensor(true); });
    LOG('SIM', '已注入初始占位状态');
  }, 1200);

  // 随机事件循环
  setInterval(() => {
    const s = seats[Math.floor(Math.random() * seats.length)];
    s.randomEvent();
  }, INTERVAL);

  if (DEMO) {
    applyDemoConfig().then((ok) => {
      if (!ok) return;
      // 立刻制造一个「有人 → 暂离」的完整链路，12 秒后必然超时告警
      const target = seats[0];
      setTimeout(() => target.sensor(true), 400);
      setTimeout(() => target.button(protocol.ACTION.AWAY_START), 1200);
      LOG('SIM', `⚠ 已安排 ${target.seatId} 在 ~12s 后超时，请在后台观察红色横幅与音频告警`);
      // 之后再安排一批，保证持续有暂离卡片
      let k = 1;
      const timer = setInterval(() => {
        if (k >= seats.length) { clearInterval(timer); return; }
        const s = seats[k++];
        s.sensor(true);
        setTimeout(() => s.button(protocol.ACTION.AWAY_START), 500);
      }, 4500);
    });
  }

  if (CHAOS) {
    setInterval(() => {
      const s = seats[Math.floor(Math.random() * seats.length)];
      s.dropAndRecover();
    }, 9000);
  }
}

function shutdown() {
  LOG('SIM', '正在关闭所有虚拟设备…');
  seats.forEach((s) => s.shutdown());
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (e) => LOG('SIM', '未捕获异常', e.message));

boot();

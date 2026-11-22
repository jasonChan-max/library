/**
 * ============================================================================
 *  Smart Seat · 端到端冒烟测试 (smoke.js)
 * ============================================================================
 *
 *  一键运行：node tests/smoke.js
 *  前置：先在 server/ 执行 `npm install`（本脚本复用 server/node_modules/ws）。
 *
 *  本脚本会自动在独立端口(默认 8099)拉起 Hub，然后用「1 个虚拟设备 +
 *  1 个虚拟后台」走完整链路并断言：
 *    T1  snapshot 完整（12 座位 / 协议版本 / 默认配置 15min）
 *    T2  REST 配置读写（PUT /api/config → GET 回读一致）
 *    T3  sensor=true → status=occupied
 *    T4  button away_start → status=away 且 awayUntil 存在
 *    T5  预超时告警 pre_timeout 到达
 *    T6  超时告警 timeout 到达，且 status 自动回落 available
 *    T7  alert.ack → alert.cleared
 *    T8  设备断线重连 → 收到 snapshot，座位状态被保留（不被重置）
 *    T9  非法操作（无占位时 away_start）→ 收到 error 帧
 *
 *  为缩短测试时长，测试开始即把暂离时长改为 0.1min(6s)、预预警 2s。
 *  退出码：全部通过 0，任一失败 1。
 * ============================================================================
 */

'use strict';

const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const protocol = require('../shared/protocol.js');

let WebSocket;
try {
  WebSocket = require('ws');
} catch (_) {
  try {
    WebSocket = require(path.join(__dirname, '..', 'server', 'node_modules', 'ws'));
  } catch (e) {
    console.error('[FATAL] 找不到 ws 模块，请先在 server/ 执行 npm install');
    process.exit(1);
  }
}

const PORT = parseInt(process.env.SMOKE_PORT || '8099', 10);
const BASE = `http://127.0.0.1:${PORT}`;
const HUB = `ws://127.0.0.1:${PORT}/ws`;
const SEAT_ID = 'A01';

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✓ PASS' : '  ✗ FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** 带消息历史与等待能力的 WS 客户端 */
class Probe {
  constructor(role, id) {
    this.role = role;
    this.id = id;
    this.ws = null;
    this.history = [];
    this.waiters = [];
    this.seq = 0;
  }
  connect() {
    const u = new URL(HUB);
    u.searchParams.set('role', this.role);
    u.searchParams.set('id', this.id);
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(u.toString());
      const t = setTimeout(() => reject(new Error('connect timeout')), 5000);
      this.ws.on('open', () => {
        clearTimeout(t);
        this.ws.on('message', (raw) => {
          let msg;
          try { msg = JSON.parse(raw.toString()); } catch { return; }
          this.history.push(msg);
          this.waiters = this.waiters.filter((w) => {
            if (w.pred(msg)) { w.resolve(msg); return false; }
            return true;
          });
        });
        this.send({ type: 'hello', role: this.role, clientId: this.id, ...(this.role === 'device' ? { seatId: SEAT_ID, fw: 'smoke-1.0' } : {}) });
        resolve();
      });
      this.ws.on('error', (e) => { clearTimeout(t); reject(e); });
    });
  }
  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }
  waitFor(pred, timeoutMs = 8000, label = '') {
    const hit = this.history.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.reject !== reject);
        reject(new Error(`wait timeout: ${label}`));
      }, timeoutMs);
      this.waiters.push({
        pred,
        resolve: (m) => { clearTimeout(timer); resolve(m); },
        reject,
      });
    });
  }
  seatFromSnapshot() {
    const snap = [...this.history].reverse().find((m) => m.type === 'snapshot');
    return snap ? (snap.seats || []).find((s) => s.seatId === SEAT_ID) : null;
  }
  lastSeat() {
    return [...this.history].reverse().find((m) => m.type === 'seat.update' && m.seat && m.seat.seatId === SEAT_ID)?.seat || null;
  }
  close() { try { this.ws && this.ws.close(); } catch { /* noop */ } }
}

function rest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(BASE + urlPath, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
      timeout: 4000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf || '{}') }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('rest timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function waitHubReady(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await rest('GET', '/api/health');
      if (r.status === 200) return true;
    } catch { /* not ready */ }
    await sleep(250);
  }
  return false;
}

async function main() {
  console.log('\n════════════════════════════════════════════════════════');
  console.log(' Smart Seat · 端到端冒烟测试');
  console.log(` Hub: ${HUB}  |  ${now()}`);
  console.log('════════════════════════════════════════════════════════\n');

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d.toString(); });
  child.stderr.on('data', (d) => { serverLog += d.toString(); });

  const cleanup = () => { try { child.kill('SIGTERM'); } catch { /* noop */ } };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  try {
    if (!await waitHubReady()) {
      console.error('[FATAL] Hub 未能在 10s 内启动。服务端日志：\n' + serverLog);
      process.exitCode = 1;
      return;
    }
    console.log('  · Hub 已就绪\n');

    // ---- T1 / T2 -----------------------------------------------------------
    const dash = new Probe('dashboard', 'SMOKE-DASH');
    await dash.connect();
    const snap = await dash.waitFor((m) => m.type === 'snapshot', 5000, 'snapshot');
    check('T1 snapshot 含 12 座位 / 协议版本 / 默认 15min',
      Array.isArray(snap.seats) && snap.seats.length >= 12 &&
      !!snap.protocol && snap.config.awayDurationMin === 15,
      `seats=${snap.seats?.length}, protocol=v${snap.protocol}, away=${snap.config?.awayDurationMin}min`);

    const put = await rest('PUT', '/api/config', { patch: { awayDurationMin: 0.1, alertLeadSec: 2, graceSec: 5 } });
    const got = await rest('GET', '/api/config');
    const cfg = got.body.config || got.body;
    check('T2 REST 配置写入并可回读', put.status === 200 && Number(cfg.awayDurationMin) === 0.1,
      `PUT=${put.status}, awayDurationMin=${cfg.awayDurationMin}`);

    // ---- 设备接入 ----------------------------------------------------------
    const dev = new Probe('device', 'SMOKE-DEVICE');
    await dev.connect();
    await dev.waitFor((m) => m.type === 'snapshot', 5000, 'device snapshot');

    // ---- T3 sensor → occupied ---------------------------------------------
    dev.send({ type: 'sensor', seatId: SEAT_ID, occupied: true, seq: ++dev.seq });
    const occ = await dash.waitFor(
      (m) => m.type === 'seat.update' && m.seat?.seatId === SEAT_ID && m.seat.status === 'occupied',
      5000, 'occupied');
    check('T3 sensor=true 推导为 occupied', occ.seat.status === 'occupied' && occ.seat.occupied === true,
      `status=${occ.seat.status}, online=${occ.seat.online}`);

    // ---- T4 away_start -----------------------------------------------------
    dev.send({ type: 'button', seatId: SEAT_ID, action: 'away_start', seq: ++dev.seq, ts: Date.now() });
    const away = await dash.waitFor(
      (m) => m.type === 'seat.update' && m.seat?.seatId === SEAT_ID && m.seat.status === 'away',
      5000, 'away');
    const duration = away.seat.awayUntil - Date.now();
    check('T4 away_start 进入 away 且盖章 awayUntil',
      away.seat.status === 'away' && away.seat.awayUntil > Date.now() && duration < 20000,
      `剩余 ${Math.round(duration / 1000)}s, awayDurationMs=${away.seat.awayDurationMs}`);

    // ---- T5 预超时告警 -----------------------------------------------------
    try {
      const pre = await dash.waitFor(
        (m) => m.type === 'alert' && m.alert?.seatId === SEAT_ID && m.alert.kind === 'pre_timeout',
        9000, 'pre_timeout');
      check('T5 预超时告警 pre_timeout 到达', pre.alert.severity === 'warning',
        `${pre.alert.kind}/${pre.alert.severity} ${pre.alert.message}`);
    } catch (e) {
      check('T5 预超时告警 pre_timeout 到达', false, e.message);
    }

    // ---- T6 超时告警 + 自动释放 --------------------------------------------
    let timeoutOk = false, releasedOk = false, timeoutAlertId = null;
    try {
      const ta = await dash.waitFor(
        (m) => m.type === 'alert' && m.alert?.seatId === SEAT_ID && m.alert.kind === 'timeout',
        12000, 'timeout');
      timeoutOk = ta.alert.severity === 'critical';
      timeoutAlertId = ta.alert.alertId;
      const rel = await dash.waitFor(
        (m) => m.type === 'seat.update' && m.seat?.seatId === SEAT_ID && m.seat.status === 'available',
        5000, 'released');
      releasedOk = rel.seat.status === 'available' && !rel.seat.awayUntil;
    } catch (e) { /* handled below */ }
    check('T6a 超时告警 timeout/critical 到达', timeoutOk, timeoutAlertId ? `alertId=${timeoutAlertId}` : '未收到');
    check('T6b 超时后自动回落 available', releasedOk);

    // ---- T7 ack ------------------------------------------------------------
    if (timeoutAlertId) {
      dash.send({ type: 'alert.ack', alertId: timeoutAlertId });
      try {
        const cleared = await dash.waitFor(
          (m) => m.type === 'alert.cleared' && m.alertId === timeoutAlertId, 4000, 'alert.cleared');
        check('T7 alert.ack → alert.cleared', cleared.alertId === timeoutAlertId);
      } catch (e) { check('T7 alert.ack → alert.cleared', false, e.message); }
    } else {
      check('T7 alert.ack → alert.cleared', false, '无 alertId 可确认');
    }

    // ---- T8 断线重连保留状态 -----------------------------------------------
    dev.close();
    await sleep(700);
    const dev2 = new Probe('device', 'SMOKE-DEVICE-RECONNECT');
    await dev2.connect();
    try {
      const snap2 = await dev2.waitFor((m) => m.type === 'snapshot', 5000, 'reconnect snapshot');
      const seat = snap2.seats.find((s) => s.seatId === SEAT_ID);
      check('T8 重连后收到 snapshot 且座位状态被保留',
        !!seat && seat.status === 'available' && snap2.seats.length >= 12,
        `status=${seat?.status}, seats=${snap2.seats.length}`);
    } catch (e) { check('T8 重连后收到 snapshot 且座位状态被保留', false, e.message); }

    // ---- T9 非法操作 -------------------------------------------------------
    dev2.send({ type: 'button', seatId: SEAT_ID, action: 'away_start', seq: 999, ts: Date.now() });
    try {
      const err = await dev2.waitFor((m) => m.type === 'error', 3000, 'error');
      check('T9 无占位时 away_start 被拒绝', !!err.code, `${err.code}: ${err.message}`);
    } catch (e) { check('T9 无占位时 away_start 被拒绝', false, e.message); }

    // ---- T10 管理员手动覆盖（真 Hub + 纯后台演示路径）-----------------------
    // 关键区分：设备 button 从 available 仍被拒（T9），但 dashboard 的
    // admin.action (source=admin) 可代客登记暂离并强制 occupied=true。
    // 这条保证「无硬件 + 真 Hub」时后台也能完整演示，不必依赖 device 上报 sensor。
    dash.history = [];   // 清掉 T3~T8 的历史帧，只匹配本次覆盖产生的新帧
    dash.send({ type: 'admin.action', seatId: SEAT_ID, action: 'away_start' });
    try {
      const ov = await dash.waitFor(
        (m) => m.type === 'seat.update' && m.seat?.seatId === SEAT_ID && m.seat.status === 'away',
        5000, 'admin override away');
      check('T10 管理员覆盖：available 座位可直接登记暂离',
        ov.seat.status === 'away' && ov.seat.occupied === true &&
        ov.seat.awayUntil > Date.now() && ov.seat.lastEvent === 'admin.override:away_start',
        `status=${ov.seat.status}, occupied=${ov.seat.occupied}, lastEvent=${ov.seat.lastEvent}`);
      dash.send({ type: 'admin.action', seatId: SEAT_ID, action: 'release' });
    } catch (e) {
      check('T10 管理员覆盖：available 座位可直接登记暂离', false, e.message);
    }

    // ---- T11 音频门禁语义：config.update 必须把 soundEnabled 广播出去 -------
    // Hub 只做校验/持久化/广播，门禁在 ESP32 蜂鸣器与后台 Web Audio 各自执行；
    // 这里验证该字段确实随 config.update 抵达消费端（否则设备静音开关会失效）。
    dash.history = [];
    dash.send({ type: 'config.set', patch: { soundEnabled: false } });
    try {
      const cu = await dash.waitFor(
        (m) => m.type === 'config.update' && m.config && m.config.soundEnabled === false,
        5000, 'config.update soundEnabled=false');
      check('T11 soundEnabled 随 config.update 广播（门禁在消费端）',
        cu.config.soundEnabled === false && typeof cu.serverNow === 'number',
        `soundEnabled=${cu.config.soundEnabled}, serverNow=${typeof cu.serverNow}`);
    } catch (e) {
      check('T11 soundEnabled 随 config.update 广播（门禁在消费端）', false, e.message);
    }

    dash.close();
    dev2.close();
  } catch (e) {
    check('测试执行未抛异常', false, e.stack || e.message);
  } finally {
    // 关键：把配置还原成测试开始前的默认值，否则 config.json 残留 0.1min
    // 会让下一次运行的 T1（默认 15min）失败，破坏测试可重复性。
    try {
      await rest('PUT', '/api/config', { patch: { ...protocol.DEFAULT_CONFIG } });
    } catch (_) { /* Hub 已退出则忽略 */ }
    cleanup();
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log('\n────────────────────────────────────────────────────────');
  console.log(` 结果：${passed} 通过 / ${failed} 失败 / 共 ${results.length} 项`);
  console.log('────────────────────────────────────────────────────────\n');
  if (failed > 0) {
    console.log(' 服务端日志（末尾 2000 字符）：\n' + serverLog.slice(-2000));
    process.exitCode = 1;
  } else {
    process.exitCode = 0;
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

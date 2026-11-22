/**
 * ============================================================================
 *  Smart Seat · HUB 服务端（server/index.js）   CommonJS / Node.js 18+
 * ----------------------------------------------------------------------------
 *  本文件是「服务端权威状态机」的完整实现。协议事实源唯一：../shared/protocol.js
 *  所有消息类型、对象形状、常量、状态机规则均严格对齐该文件，未自造字段/状态。
 *  唯一向后兼容扩展：每条 S2C 帧额外附带 serverNow（epoch ms），供客户端做
 *  时钟偏移校准；多一个字段不破坏旧客户端解析。
 * ============================================================================
 *
 *  【一、快速开始】
 *    cd server
 *    npm install          # 仅安装 ws
 *    npm start            # 等价于 node index.js
 *    # 浏览器打开 http://localhost:8080/         （仪表盘，由 dashboard/ 提供）
 *    # 健康检查       http://localhost:8080/api/health
 *    # 自定义端口     PORT=9090 node index.js
 *    # 仅语法自检     npm run check   （node --check index.js，不监听端口）
 *
 *  【二、依赖安装】
 *    唯一第三方依赖：ws ^8.18.0（WebSocketServer）。
 *    其余全部 Node 内置：http / fs / path / os / url / crypto。
 *    若报 "Cannot find module 'ws'"，在 server/ 下执行 npm install 即可。
 *
 *  【三、REST 接口速查】（全部响应带 CORS 头，OPTIONS 预检返回 204）
 *    GET  /api/health
 *         -> { ok:true, protocol, serverNow, uptimeSec, clients, seats, alerts }
 *    GET  /api/snapshot
 *         -> 与 WS `snapshot` 帧完全同形：{ type:'snapshot', serverNow, protocol,
 *            config, seats:[Seat], alerts:[Alert] }
 *    GET  /api/seats
 *         -> { ok:true, serverNow, seats:[Seat] }
 *    GET  /api/config
 *         -> { ok:true, serverNow, config:{...} }
 *    PUT  /api/config
 *         body 可为 { "patch": { "awayDurationMin": 0.2 } } 或直接配置对象
 *         { "awayDurationMin": 0.2 }；成功 -> { ok:true, serverNow, config }
 *         校验失败 -> 400 { ok:false, error, details:[...] }
 *         取值范围：awayDurationMin 0.1~240（允许小数，便于演示）、
 *                   alertLeadSec 0~600、graceSec 0~600、
 *                   heartbeatMs 1000~120000、offlineAfterMs 1000~600000，
 *                   soundEnabled 必须为布尔值。
 *    POST /api/seats/:seatId/action
 *         body { action, value? }，action ∈ away_start|away_cancel|release|extend
 *         value 可选：数字或 { minutes:number } 或数字字符串，表示「自定义分钟数」
 *           · away_start: 覆盖本次暂离时长（默认取 config.awayDurationMin）
 *           · extend    : 覆盖本次延长量（默认 TIMING.EXTEND_MS = 5 分钟）
 *           · 其余动作忽略 value
 *         成功 -> 200 { ok:true, serverNow, seat }；非法迁移 -> 409 { ok:false, code, error }
 *    POST /api/alerts/:alertId/ack
 *         -> 200 { ok:true, alertId, serverNow }；不存在/已清除 -> 404
 *    GET  /            与 /index.html -> dashboard/index.html
 *    GET  /<任意路径>  -> dashboard/ 目录下的静态文件（带 path traversal 防护）
 *
 *  【四、WS 接口速查】
 *    连接：ws://<host>:8080/ws?role=<device|dashboard>&id=<clientId>
 *    C2S（客户端发）：hello / button / sensor / state / ping / config.set /
 *                     admin.action / alert.ack   （严格取 protocol.js 的 C2S）
 *    S2C（服务端发）：snapshot / seat.update / config.update / alert /
 *                     alert.cleared / pong / error（严格取 protocol.js 的 S2C）
 *    首帧必须是 hello；设备必须带 seatId（未带则用连接 id 兜底），未知 seatId 自动建座。
 *    config.set / admin.action / alert.ack 为 dashboard 专有，device 调用返回 error。
 *    所有 S2C 帧均含 serverNow；pong 另含回显 ts。
 *
 *  【五、状态机摘要】（Hub 唯一权威：设备只上报事实，状态由 Hub 推导并盖章时间）
 *    sensor=true  且无 away 会话 -> occupied
 *    sensor=false 且无 away 会话 -> available
 *    button away_start（仅 occupied 有效）-> away, awayStartedAt=now,
 *                 awayUntil=now + awayDurationMin*60000
 *    admin.action / REST away_start -> 管理员手动覆盖：允许从 available 触发，
 *                 强制 occupied=true，lastEvent="admin.override:away_start"（可审计）；
 *                 设备 button 分支不受影响，仍严格拒绝非 occupied 触发。
 *    soundEnabled -> Hub 仅做布尔校验 / 原子持久化 / config.update 广播，
 *                   **不在此处做音频门禁、不抑制 alert 帧**：门禁由 ESP32 蜂鸣器
 *                   (want = alertActive && cfgSoundEnabled) 与后台 Web Audio
 *                   (SoundEngine.canPlay) 各自本地执行，视觉告警恒不受影响。
 *                   请勿在 Hub 二次门禁，否则视觉告警会被误吞。
 *    away_cancel -> 回退到 sensor 决定的 occupied / available，清空 away 字段
 *    release     -> 强制 available，清空 away 字段
 *    extend      -> awayUntil += 5min（或 value 指定分钟）
 *    now >= awayUntil        -> available + timeout/critical 告警 + 设备蜂鸣
 *    剩余 <= alertLeadSec    -> pre_timeout/warning（每个 away 会话仅一次）
 *    away 期间 sensor=true 持续 >8s -> sensor_conflict/warning
 *    设备静默 > offlineAfterMs -> online=false + offline/warning（仅 seen=true 座位）
 *    重连 hello  -> 回 snapshot、online=true、清 offline 告警、业务状态原样保留
 *    断线 close  -> 绝不重置业务状态，仅 online=false；暂离倒计时继续由 Hub 推进
 *
 *  【六、排错】
 *    · 端口占用：日志提示 EADDRINUSE，用 PORT=xxxx 换端口。
 *    · 首页 404：dashboard/index.html 尚未生成，属正常；/api/* 与 /ws 不受影响。
 *    · 后台点「开始暂离」无反应 / 报 INVALID_TRANSITION：仅「设备 button」要求
 *      先 occupied；后台走 admin.action（source=admin）可管理员覆盖，从 available
 *      直接登记暂离并强制 occupied=true。若仍报错，确认该帧 type 是 admin.action
 *      且连接角色是 dashboard（device 调用会被 FORBIDDEN 拒绝）。
 *    · 设备连上但按 away_start 报 INVALID_TRANSITION：状态机要求先 occupied，
 *      需先上报 sensor{occupied:true} 才能进入暂离。
 *    · 预置座位不刷 offline 告警：seen=false 的座位永不告警，属刻意设计。
 *    · 配置改了没生效：确认 PUT 返回 200；config.json 为原子写，检查目录可写权限。
 *    · 客户端倒计时不一致：用 snapshot.serverNow 与本地 Date.now() 求时钟偏移，
 *      不要以本地时钟为准。
 * ============================================================================
 */
'use strict';

// ---------------------------------------------------------------------------
// 依赖：仅 ws 为第三方；其余全部 Node 内置
// ---------------------------------------------------------------------------
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const protocol = require('../shared/protocol.js');
const visitor = require('./visitor.js');

const {
  PROTOCOL_VERSION, WS_PATH, DEFAULT_PORT,
  STATUS, ROLE, ACTION, ALERT_KIND, SEVERITY, C2S, S2C,
  DEFAULT_CONFIG, TIMING,
} = protocol;

// ---------------------------------------------------------------------------
// 常量与路径
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || DEFAULT_PORT;
const HUB_HOST = process.env.HUB_HOST;
const SERVER_DIR = __dirname;
const DASHBOARD_DIR = path.resolve(SERVER_DIR, '../dashboard');
const CONFIG_PATH = path.join(SERVER_DIR, 'config.json');

const TICK_MS = TIMING.TICK_MS;                 // 250ms，来自协议，不自行改写
const EXTEND_MS = TIMING.EXTEND_MS;             // 5 分钟
const SENSOR_CONFLICT_MS = TIMING.SENSOR_CONFLICT_MS; // 8 秒
const HEARTBEAT_SWEEP_MS = 15000;              // WS 层 ping 扫描周期
const MAX_ALERTS = 100;                        // alerts Map 上限，保留最近 100 条
const MAX_BODY_BYTES = 64 * 1024;              // REST JSON body 上限 64KB
const GRACE_MS_PER_SEC = 1000;
const MIN_MS_PER_MIN = 60000;

// 简易 MIME 表：覆盖仪表盘常见静态资源
const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
});

// ---------------------------------------------------------------------------
// 全局状态容器
//   seats / alerts / clients 均为 Map；clients 以 ws 对象为 key，便于心跳遍历。
//   Seat 对象上另挂若干「服务端私有内部标记」（seen/preWarned/...），
//   这些标记绝不进入 publicSeat()，因此不会污染 protocol.js 定义的 Seat 形状。
// ---------------------------------------------------------------------------
let config = { ...DEFAULT_CONFIG };
const seats = new Map();     // seatId -> 完整 Seat（含内部标记）
const alerts = new Map();    // alertId -> Alert（只保留未清除告警，插入序即时间序）
const clients = new Map();   // ws -> { ws, role, clientId, seatId, lastPing, alive, ip }
let alertSeq = 0;            // ALT-0001 自增序列
let tickTimer = null;
let heartbeatTimer = null;

// ---------------------------------------------------------------------------
// 带时间戳的日志
// ---------------------------------------------------------------------------
function log(level, ...args) {
  const ts = new Date().toISOString();
  const tag = String(level).toUpperCase().padEnd(5, ' ');
  // eslint-disable-next-line no-console
  console.log(`[${ts}] [${tag}]`, ...args);
}

// ---------------------------------------------------------------------------
// HTTP 通用工具：CORS / JSON 响应 / 错误对象 / body 解析
// ---------------------------------------------------------------------------
function applyCors(res) {
  // 统一用 setHeader，后续 writeHead 传入的头部会与之合并，CORS 不会丢失。
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(req, res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj) + '\n', 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  // HEAD 只回头部，不发 body；Content-Length 仍按实际长度声明，符合语义。
  res.end(req.method === 'HEAD' ? undefined : body);
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // 不 destroy socket，否则无法回 413；只丢弃数据并打标记，等 end 再拒绝。
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return reject(httpError(413, `请求体超过 ${MAX_BODY_BYTES} 字节上限`));
      if (chunks.length === 0) return resolve({});
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(httpError(400, `JSON 解析失败: ${e.message}`));
      }
    });
    // Promise 天然只兑现一次，aborted / error 多次触发也无副作用。
    req.on('aborted', () => reject(httpError(400, '请求被客户端中断')));
    req.on('error', (e) => reject(httpError(400, `读取请求体失败: ${e.message}`)));
  });
}

// ---------------------------------------------------------------------------
// 静态托管
// ---------------------------------------------------------------------------
function serveStatic(req, res, pathname) {
  const rel = (pathname === '/' || pathname === '/index.html')
    ? 'index.html'
    : pathname.replace(/^\/+/, '');
  const root = path.resolve(DASHBOARD_DIR);
  const abs = path.resolve(root, rel);

  // 为什么这样做：path.resolve 会消解 ".." 以及解码后的 %2e%2e，
  // 再校验结果必须落在 dashboard 根目录内，从而杜绝目录穿越读任意文件。
  // 用 root + path.sep 作前缀可避免 "/dashboard-evil" 之类的兄弟目录绕过。
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return sendJson(req, res, 403, { ok: false, error: '禁止越界访问', path: rel });
  }

  fs.readFile(abs, (err, buf) => {
    if (err) {
      if (err.code === 'ENOENT' || err.code === 'EISDIR' || err.code === 'ENOTDIR') {
        return sendJson(req, res, 404, { ok: false, error: '静态文件不存在', path: rel });
      }
      return sendJson(req, res, 500, { ok: false, error: '读取静态文件失败', path: rel });
    }
    const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

// ---------------------------------------------------------------------------
// Seat / Alert 的「公开视图」与构造
//   为什么要有 publicSeat：内部去重标记（seen/preWarned/conflicted/...）是
//   服务端实现细节，若随 seat.update 广播出去就等于给协议加了字段，违反
//   "不得自行发明字段" 的约束。对外只输出 protocol.js 定义的 15 个字段。
// ---------------------------------------------------------------------------
function publicSeat(s) {
  return {
    seatId: s.seatId,
    label: s.label,
    zone: s.zone,
    status: s.status,
    occupied: s.occupied,
    online: s.online,
    awayUntil: s.awayUntil,
    awayStartedAt: s.awayStartedAt,
    awayDurationMs: s.awayDurationMs,
    lastSeen: s.lastSeen,
    fw: s.fw,
    ip: s.ip,
    rssi: s.rssi,
    lastEvent: s.lastEvent,
    alerting: s.alerting,
  };
}

function publicAlert(a) {
  return {
    alertId: a.alertId,
    seatId: a.seatId,
    kind: a.kind,
    severity: a.severity,
    message: a.message,
    createdAt: a.createdAt,
    acked: a.acked,
  };
}

function createSeat({ seatId, label, zone, seen }) {
  return {
    // ---- protocol.js 定义的字段 ----
    seatId,
    label,
    zone,
    status: STATUS.AVAILABLE,
    occupied: false,
    online: false,
    awayUntil: null,
    awayStartedAt: null,
    awayDurationMs: 0,
    lastSeen: 0,
    fw: null,
    ip: null,
    rssi: null,
    lastEvent: 'preset',
    alerting: false,
    // ---- 服务端私有内部标记（不广播）----
    seen: !!seen,                 // 是否至少成功连过一次真实设备
    lastSeq: -1,                  // button/sensor 共用去重游标
    preWarned: false,             // 本 away 会话是否已发 pre_timeout
    conflicted: false,            // 本 away 会话是否已发 sensor_conflict
    sensorTrueSince: null,        // away 期间 sensor 变 true 的起始时刻
    expiredAt: null,              // 超时时刻，用于 graceSec 清理红色态
    offlineAlerted: false,        // 本轮离线是否已告警，避免每 tick 刷屏
  };
}

function labelFromSeatId(id) {
  const m = /^([A-Za-z]+)[-_]?(\d+)$/.exec(String(id));
  if (m) return `${m[1].toUpperCase()}-${m[2].padStart(2, '0')}`;
  return String(id);
}

function allSeats() {
  return [...seats.values()].map(publicSeat);
}

function allAlerts() {
  return [...alerts.values()].map(publicAlert);
}

// ---------------------------------------------------------------------------
// 配置：校验 / 原子写 / 读取 / 更新
// ---------------------------------------------------------------------------
function validateConfigPatch(patch) {
  const src = (patch && typeof patch === 'object' && !Array.isArray(patch)) ? patch : {};
  const clean = {};
  const errors = [];

  function checkNumber(key, min, max) {
    if (!(key in src)) return;
    const v = src[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      errors.push(`${key} 必须是 ${min}~${max} 之间的有限数字`);
      return;
    }
    clean[key] = v;
  }

  // awayDurationMin 允许 0.1~240 的浮点数：0.1 分钟 = 6 秒，便于现场演示。
  checkNumber('awayDurationMin', 0.1, 240);
  checkNumber('alertLeadSec', 0, 600);
  checkNumber('graceSec', 0, 600);
  checkNumber('heartbeatMs', 1000, 120000);
  checkNumber('offlineAfterMs', 1000, 600000);

  if ('soundEnabled' in src) {
    if (typeof src.soundEnabled !== 'boolean') {
      errors.push('soundEnabled 必须为布尔值');
    } else {
      clean.soundEnabled = src.soundEnabled;
    }
  }

  return { clean, errors };
}

function persistConfig(cfg) {
  // 原子写：先写同进程专属 tmp，再 rename 覆盖，避免写一半被读到损坏 JSON。
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  try {
    fs.renameSync(tmp, CONFIG_PATH);
  } catch (e) {
    // 极少数 Windows 环境下 rename 无法覆盖已存在文件，退化为先删再命名。
    try { fs.unlinkSync(CONFIG_PATH); } catch (_) { /* 目标本就不存在 */ }
    fs.renameSync(tmp, CONFIG_PATH);
  }
}

function loadConfig() {
  let merged = { ...DEFAULT_CONFIG };
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const { clean, errors } = validateConfigPatch(parsed);
      if (errors.length) log('warn', 'config.json 含非法字段，已回落默认值:', errors.join('; '));
      // 与默认值合并：文件里缺的字段用默认补齐，非法字段被 clean 过滤掉。
      merged = { ...merged, ...clean };
    }
  } catch (e) {
    log('warn', `未能读取 config.json (${e.message})，使用默认配置并尝试重建`);
    try { persistConfig(merged); } catch (_) { log('warn', 'config.json 重建失败（目录只读？），仅在内存使用默认值'); }
  }
  return merged;
}

function updateConfig(patch) {
  const { clean, errors } = validateConfigPatch(patch);
  if (errors.length) return { ok: false, errors };
  config = { ...config, ...clean };
  try {
    persistConfig(config);
  } catch (e) {
    // 持久化失败不应阻断运行：内存配置已生效，仍要广播让客户端同步。
    log('error', `配置持久化失败: ${e.message}`);
  }
  broadcast({ type: 'config.update', config: { ...config } });
  log('info', '配置已更新并广播:', JSON.stringify(clean));
  return { ok: true };
}

function pickPatch(body) {
  // 兼容两种 PUT /api/config 体态：{patch:{...}} 与直接配置对象。
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  const p = body.patch;
  if (p && typeof p === 'object' && !Array.isArray(p)) return p;
  return body;
}

// ---------------------------------------------------------------------------
// 预置座位：无硬件时后台也有内容可看
//   A01..A12，每 4 个一个分区；seen=false 保证它们不会触发 offline 告警刷屏。
// ---------------------------------------------------------------------------
function presetSeats() {
  const zones = ['Zone A · 靠窗', 'Zone B · 中岛', 'Zone C · 安静区'];
  for (let i = 1; i <= 12; i += 1) {
    const n = String(i).padStart(2, '0');
    const seatId = `A${n}`;
    const label = `A-${n}`;
    const zone = zones[Math.floor((i - 1) / 4)];
    seats.set(seatId, createSeat({ seatId, label, zone, seen: false }));
  }
}

// ---------------------------------------------------------------------------
// 告警
// ---------------------------------------------------------------------------
function nextAlertId() {
  alertSeq += 1;
  return `ALT-${String(alertSeq).padStart(4, '0')}`;
}

function createAlert(seat, kind, severity, message) {
  const a = {
    alertId: nextAlertId(),
    seatId: seat.seatId,
    kind,
    severity,
    message,
    createdAt: Date.now(),
    acked: false,
  };
  alerts.set(a.alertId, a);

  // 上限裁剪：Map 保持插入顺序，反复删除最早一条即可保留最近 100 条；
  // 同时广播 alert.cleared，让 dashboard 同步移除被挤掉的卡片。
  while (alerts.size > MAX_ALERTS) {
    const oldestId = alerts.keys().next().value;
    alerts.delete(oldestId);
    broadcast({ type: 'alert.cleared', alertId: oldestId });
  }

  if (severity === SEVERITY.CRITICAL) seat.alerting = true;
  return a;
}

function clearAlertsWhere(predicate) {
  // 遍历中删除当前项是 Map 允许的操作。
  for (const [id, a] of alerts) {
    if (predicate(a)) {
      alerts.delete(id);
      broadcast({ type: 'alert.cleared', alertId: id });
    }
  }
}

function clearOfflineAlerts(seatId) {
  clearAlertsWhere((a) => a.seatId === seatId && a.kind === ALERT_KIND.OFFLINE);
}

function ackAlert(alertId) {
  const a = alerts.get(alertId);
  if (!a) return { ok: false, code: 'NOT_FOUND', message: `告警 ${alertId} 不存在或已被清除` };
  a.acked = true;
  alerts.delete(alertId);
  broadcast({ type: 'alert.cleared', alertId });

  // 按契约：确认告警后清除该座位的红色告警态，并立刻发 seat.update 让卡片复原。
  const seat = seats.get(a.seatId);
  if (seat) {
    seat.alerting = false;
    seat.expiredAt = null;
    broadcastSeatUpdate(seat);
  }
  log('info', `告警已确认 alertId=${alertId} seat=${a.seatId}`);
  return { ok: true, alertId };
}

function broadcastAlert(a) {
  const msg = { type: 'alert', alert: publicAlert(a) };
  // 为什么包含所属设备：timeout 告警需要设备本地蜂鸣（协议 STATUS MACHINE 要求），
  // dashboard 则负责展示卡片；其余 dashboard 同样能看到全部告警。
  broadcast(msg, (info) => info.role === ROLE.DASHBOARD ||
    (info.role === ROLE.DEVICE && info.seatId === a.seatId));
}

// ---------------------------------------------------------------------------
// WS 发送 / 广播
//   「每条 S2C 都带 serverNow」在此统一兜底：send/broadcast 若发现帧里没有
//   serverNow 就注入当前时刻。显式构造了 serverNow 的 snapshot 会原样保留。
// ---------------------------------------------------------------------------
function withServerNow(obj) {
  return ('serverNow' in obj) ? obj : Object.assign({ serverNow: Date.now() }, obj);
}

function send(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const text = JSON.stringify(withServerNow(obj));
  try {
    ws.send(text);
  } catch (e) {
    log('warn', `WS 发送失败: ${e.message}`);
  }
}

function broadcast(obj, filter) {
  // 只序列化一次，保证一次广播内所有客户端拿到同一个 serverNow。
  const text = JSON.stringify(withServerNow(obj));
  for (const [ws, info] of clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (filter && !filter(info, ws)) continue;
    try {
      ws.send(text);
    } catch (e) {
      log('warn', `广播失败 id=${info.clientId}: ${e.message}`);
    }
  }
}

function broadcastSeatUpdate(seat, excludeWs) {
  visitor.update(seat);
  // 权威座位变更：推给所有 dashboard，以及该座位所属的设备。
  broadcast({ type: 'seat.update', seat: publicSeat(seat) }, (info, ws) =>
    ws !== excludeWs &&
    (info.role === ROLE.DASHBOARD ||
      (info.role === ROLE.DEVICE && info.seatId === seat.seatId)));
}

function sendError(ws, code, message) {
  send(ws, { type: 'error', code, message });
}

function snapshotPayload() {
  return {
    type: 'snapshot',
    serverNow: Date.now(),
    protocol: PROTOCOL_VERSION,
    config: { ...config },
    seats: allSeats(),
    alerts: allAlerts(), // alerts Map 只保留未清除告警，符合协议 "未清除 alerts"
  };
}

// ---------------------------------------------------------------------------
// 状态机核心
// ---------------------------------------------------------------------------
function extractMinutes(value) {
  if (value === null || value === undefined) return null;
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'object' && !Array.isArray(value)) n = value.minutes;
  else if (typeof value === 'string' && value.trim() !== '') n = Number(value);
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > 240) return null;
  return n;
}

function clearAway(seat) {
  seat.awayUntil = null;
  seat.awayStartedAt = null;
  seat.awayDurationMs = 0;
  seat.preWarned = false;
  seat.conflicted = false;
  seat.sensorTrueSince = null;
}

function clearTimeoutAlerting(seat) {
  // 人为动作（release / away_cancel / 新的 away_start / ack）视作已确认超时：
  // 清掉红色态与残留的 timeout 告警卡片，避免 graceSec 之前一直红着。
  seat.expiredAt = null;
  seat.alerting = false;
  clearAlertsWhere((a) => a.seatId === seat.seatId && a.kind === ALERT_KIND.TIMEOUT);
}

function applyAction(seat, action, value, source) {
  const now = Date.now();
  const minutes = extractMinutes(value);

  switch (action) {
    case ACTION.AWAY_START: {
      // 设备物理按键 (source='button') 严格遵循物理语义：必须先有占位事实。
      // 管理后台 (source='admin') / REST (source='api') 是「管理员手动覆盖」通道：
      // 座位无人或设备离线时允许代客登记暂离，并强制标记 occupied=true 以便审计。
      // 这样既保住设备语义，也让 Admin Dashboard 在「无硬件 + 真 Hub」路径下可完整演示。
      const adminOverride = (source === 'admin' || source === 'api');
      if (seat.status !== STATUS.OCCUPIED && !adminOverride) {
        return { ok: false, code: 'INVALID_TRANSITION', message: `away_start 仅允许从 occupied 触发，当前 ${seat.status}` };
      }
      if (seat.status === STATUS.AWAY) {
        return { ok: false, code: 'INVALID_TRANSITION', message: 'away_start 不能重复触发，当前 away' };
      }
      const forced = seat.status !== STATUS.OCCUPIED;
      if (forced) {
        seat.occupied = true;
        log('info', `管理员覆盖 seat=${seat.seatId} 强制标记占用后开始暂离 (source=${source})`);
      }
      const durMin = minutes !== null ? minutes : config.awayDurationMin;
      seat.status = STATUS.AWAY;
      seat.awayStartedAt = now;
      seat.awayDurationMs = Math.round(durMin * MIN_MS_PER_MIN);
      seat.awayUntil = now + seat.awayDurationMs;
      // 新一轮 away 会话，重置本会话级去重标记。
      seat.preWarned = false;
      seat.conflicted = false;
      seat.sensorTrueSince = null;
      seat.lastEvent = forced ? 'admin.override:away_start' : `${source}:away_start`;
      break;
    }
    case ACTION.AWAY_CANCEL: {
      // 回退到「传感器事实」决定的状态，而不是硬编码 occupied。
      clearAway(seat);
      seat.status = seat.occupied ? STATUS.OCCUPIED : STATUS.AVAILABLE;
      seat.lastEvent = `${source}:away_cancel`;
      break;
    }
    case ACTION.RELEASE: {
      // 强制 available：即便传感器仍为 true，也以显式释放为准；
      // 后续若传感器再次上报事实，状态机仍会照常推导。
      clearAway(seat);
      seat.status = STATUS.AVAILABLE;
      seat.lastEvent = `${source}:release`;
      break;
    }
    case ACTION.EXTEND: {
      if (seat.status !== STATUS.AWAY || !seat.awayUntil) {
        return { ok: false, code: 'INVALID_TRANSITION', message: `extend 仅允许在 away 状态触发，当前 ${seat.status}` };
      }
      const addMs = minutes !== null ? Math.round(minutes * MIN_MS_PER_MIN) : EXTEND_MS;
      seat.awayUntil += addMs;
      seat.awayDurationMs += addMs;
      // 延长后重新允许预警：否则一次延到临近也不再提醒，属于逻辑漏洞。
      seat.preWarned = false;
      seat.lastEvent = `${source}:extend`;
      break;
    }
    default:
      return { ok: false, code: 'UNKNOWN_ACTION', message: `未知动作 ${action}` };
  }

  clearTimeoutAlerting(seat);
  broadcastSeatUpdate(seat);
  return { ok: true, seat };
}

function handleSensor(seat, occupied, source) {
  const now = Date.now();
  seat.occupied = !!occupied;
  seat.lastSeen = now;
  seat.lastEvent = `${source}:sensor:${seat.occupied ? 'true' : 'false'}`;

  if (!seat.awayUntil) {
    // 没有 away 会话时，传感器事实直接决定 status（协议状态机第 1、2 条）。
    seat.status = seat.occupied ? STATUS.OCCUPIED : STATUS.AVAILABLE;
  } else if (seat.occupied) {
    // away 期间有人就座不立刻打断暂离：只记录起始时刻，由 tick 判断是否持续 >8s。
    // 这样能过滤掉路过/误触造成的瞬时波动。
    if (seat.sensorTrueSince === null) seat.sensorTrueSince = now;
  } else {
    seat.sensorTrueSince = null;
  }
  broadcastSeatUpdate(seat);
}

// ---------------------------------------------------------------------------
// 连接辅助
// ---------------------------------------------------------------------------
function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  const ra = (req.socket && req.socket.remoteAddress) || null;
  return ra ? String(ra).replace(/^::ffff:/, '') : null;
}

function touchSeen(info) {
  // 任何来自设备的帧（甚至 WS 层 pong）都算活跃证据，刷新 lastSeen，
  // 这样只要设备还在发心跳，tick 就不会误判它离线。
  if (info.role !== ROLE.DEVICE || !info.seatId) return;
  const seat = seats.get(info.seatId);
  if (seat) seat.lastSeen = Date.now();
}

function resolveSeatId(info, msg) {
  if (msg.seatId !== null && msg.seatId !== undefined && String(msg.seatId).trim() !== '') {
    return String(msg.seatId);
  }
  return (info.role === ROLE.DEVICE) ? info.seatId : null;
}

function isDuplicate(seat, seq) {
  if (typeof seq !== 'number' || !Number.isFinite(seq)) return false; // 未带 seq 则不去重
  // 协议注释：seq 是「每设备单调递增的单一计数器」，故 button 与 sensor
  // 共用一个游标即可；重放/乱序的旧帧 seq <= lastSeq，直接丢弃。
  if (seq <= seat.lastSeq) return true;
  seat.lastSeq = seq;
  return false;
}

// ---------------------------------------------------------------------------
// WS 消息处理
// ---------------------------------------------------------------------------
function handleHello(ws, info, msg) {
  // URL 上的 role 是初值，hello 携带的 role/clientId 更权威，允许修正。
  if (msg.role === ROLE.DEVICE || msg.role === ROLE.DASHBOARD) info.role = msg.role;
  if (msg.clientId !== null && msg.clientId !== undefined && String(msg.clientId).trim() !== '') {
    info.clientId = String(msg.clientId);
  }

  if (info.role === ROLE.DASHBOARD) {
    log('info', `dashboard hello id=${info.clientId}`);
    send(ws, snapshotPayload());
    return;
  }

  const seatId = (msg.seatId !== null && msg.seatId !== undefined && String(msg.seatId).trim() !== '')
    ? String(msg.seatId)
    : info.clientId; // 设备未带 seatId 时用连接 id 兜底，兼容 id=A01 的接法

  let seat = seats.get(seatId);
  if (!seat) {
    seat = createSeat({ seatId, label: labelFromSeatId(seatId), zone: '自助接入', seen: true });
    seats.set(seatId, seat);
    log('info', `自动创建座位 ${seatId}（设备首次接入）`);
  } else {
    // 复用预置座位：只更新设备元数据并标记 seen，绝不重置 status / away 字段。
    seat.seen = true;
  }

  info.seatId = seatId;
  const now = Date.now();
  seat.online = true;
  seat.lastSeen = now;
  seat.fw = (msg.fw !== null && msg.fw !== undefined) ? String(msg.fw) : seat.fw;
  seat.ip = info.ip;
  if (msg.rssi !== null && msg.rssi !== undefined && Number.isFinite(Number(msg.rssi))) {
    seat.rssi = Number(msg.rssi);
  }
  seat.lastEvent = 'hello';
  seat.offlineAlerted = false; // 允许下一轮离线再次告警
  clearOfflineAlerts(seatId);

  if (msg.caps && typeof msg.caps === 'object') {
    log('info', `device hello seat=${seatId} id=${info.clientId} fw=${seat.fw || '-'} caps=${JSON.stringify(msg.caps)}`);
  } else {
    log('info', `device hello seat=${seatId} id=${info.clientId} fw=${seat.fw || '-'}`);
  }

  // 先让其它客户端看到 online=true；本连接随后收到完整 snapshot 做全量替换，
  // 因此把它从这次广播里排除，避免设备收到两条互相覆盖的帧。
  broadcastSeatUpdate(seat, ws);
  const snapshot = snapshotPayload();
  if (msg.caps?.compactSnapshot === true) {
    snapshot.seats = [publicSeat(seat)];
    snapshot.alerts = snapshot.alerts.filter((alert) =>
      alert.seatId === seatId && alert.kind === ALERT_KIND.TIMEOUT);
  }
  send(ws, snapshot);
}

function handleFactAction(ws, info, msg, source) {
  const seatId = resolveSeatId(info, msg);
  if (!seatId) return sendError(ws, 'NO_SEAT', '缺少 seatId');

  // 设备不能替别的座位上报事实，防止越权改写。
  if (info.role === ROLE.DEVICE && info.seatId && msg.seatId && msg.seatId !== info.seatId) {
    return sendError(ws, 'SEAT_MISMATCH', '设备不能代替其它座位上报');
  }
  const seat = seats.get(seatId);
  if (!seat) return sendError(ws, 'NO_SEAT', `座位 ${seatId} 不存在`);

  // 只有物理 button 帧带 seq 并需要去重；admin.action 是实时远程指令，不去重。
  if (source === 'button' && isDuplicate(seat, msg.seq)) {
    log('info', `丢弃离线重放事件 seat=${seatId} seq=${msg.seq}`);
    return;
  }
  if (!Object.values(ACTION).includes(msg.action)) {
    return sendError(ws, 'UNKNOWN_ACTION', `未知动作 ${msg.action}`);
  }
  const r = applyAction(seat, msg.action, msg.value, source);
  if (!r.ok) return sendError(ws, r.code, r.message); // 非法迁移回 error 帧
}

function handleSensorMsg(ws, info, msg) {
  const seatId = resolveSeatId(info, msg);
  if (!seatId) return sendError(ws, 'NO_SEAT', '缺少 seatId');
  if (info.role === ROLE.DEVICE && info.seatId && msg.seatId && msg.seatId !== info.seatId) {
    return sendError(ws, 'SEAT_MISMATCH', '设备不能代替其它座位上报');
  }
  const seat = seats.get(seatId);
  if (!seat) return sendError(ws, 'NO_SEAT', `座位 ${seatId} 不存在`);
  if (isDuplicate(seat, msg.seq)) {
    log('info', `丢弃离线重放传感器帧 seat=${seatId} seq=${msg.seq}`);
    return;
  }
  handleSensor(seat, !!msg.occupied, 'sensor');
}

function handleStateMsg(ws, info, msg) {
  // 可选显式状态请求（admin console / simulator）。时间仍由 Hub 盖章，
  // 不信任客户端给的任何时钟，这是权威模型的关键。
  const seatId = resolveSeatId(info, msg);
  if (!seatId) return sendError(ws, 'NO_SEAT', '缺少 seatId');
  const seat = seats.get(seatId);
  if (!seat) return sendError(ws, 'NO_SEAT', `座位 ${seatId} 不存在`);
  if (!Object.values(STATUS).includes(msg.status)) {
    return sendError(ws, 'BAD_STATUS', `非法状态 ${msg.status}`);
  }

  clearAway(seat);
  if (msg.status === STATUS.AWAY) {
    const now = Date.now();
    seat.awayStartedAt = now;
    seat.awayDurationMs = Math.round(config.awayDurationMin * MIN_MS_PER_MIN);
    seat.awayUntil = now + seat.awayDurationMs;
  }
  seat.status = msg.status;
  seat.lastEvent = `state:${msg.reason || msg.status}`;
  clearTimeoutAlerting(seat);
  broadcastSeatUpdate(seat);
}

function onMessage(ws, info, data) {
  let msg;
  try {
    msg = JSON.parse(data.toString('utf8'));
  } catch (_) {
    return sendError(ws, 'BAD_JSON', '无法解析 JSON 帧');
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') {
    return sendError(ws, 'BAD_FRAME', '帧必须是含 type 字段的 JSON 对象');
  }

  info.lastPing = Date.now();
  info.alive = true;
  touchSeen(info);

  // 用协议常量做白名单校验，保证每个 C2S 类型都有对应实现分支。
  if (!C2S.includes(msg.type)) {
    return sendError(ws, 'UNKNOWN_TYPE', `未知消息类型 ${msg.type}`);
  }

  switch (msg.type) {
    case 'hello':
      handleHello(ws, info, msg);
      break;
    case 'button':
      handleFactAction(ws, info, msg, 'button');
      break;
    case 'sensor':
      handleSensorMsg(ws, info, msg);
      break;
    case 'state':
      handleStateMsg(ws, info, msg);
      break;
    case 'ping':
      send(ws, { type: 'pong', ts: (msg.ts === undefined ? Date.now() : msg.ts) });
      break;
    case 'config.set': {
      if (info.role !== ROLE.DASHBOARD) return sendError(ws, 'FORBIDDEN', 'config.set 仅允许 dashboard');
      const r = updateConfig(msg.patch);
      if (!r.ok) return sendError(ws, 'BAD_CONFIG', `配置校验失败: ${r.errors.join('; ')}`);
      break;
    }
    case 'admin.action': {
      if (info.role !== ROLE.DASHBOARD) return sendError(ws, 'FORBIDDEN', 'admin.action 仅允许 dashboard');
      handleFactAction(ws, info, msg, 'admin');
      break;
    }
    case 'alert.ack': {
      if (info.role !== ROLE.DASHBOARD) return sendError(ws, 'FORBIDDEN', 'alert.ack 仅允许 dashboard');
      const r = ackAlert(msg.alertId);
      if (!r.ok) return sendError(ws, r.code, r.message);
      break;
    }
    default:
      // C2S 白名单已覆盖全部类型，此分支仅作防御，不会留空实现。
      sendError(ws, 'UNKNOWN_TYPE', `未处理的消息类型 ${msg.type}`);
  }
}

function onConnection(ws, req) {
  let parsed;
  try {
    parsed = new URL(req.url, 'http://localhost');
  } catch (_) {
    parsed = new URL(WS_PATH, 'http://localhost');
  }
  const urlRole = parsed.searchParams.get('role');
  const urlId = parsed.searchParams.get('id');
  const role = (urlRole === ROLE.DEVICE || urlRole === ROLE.DASHBOARD) ? urlRole : ROLE.DASHBOARD;
  // URL 未带 id 时用 crypto 生成短唯一 id，保证 clients 记录可区分。
  const clientId = (urlId && urlId.trim())
    ? urlId.trim()
    : `${role}-${crypto.randomBytes(3).toString('hex')}`;

  const info = {
    ws,
    role,
    clientId,
    seatId: null,
    lastPing: Date.now(),
    alive: true,
    ip: clientIp(req),
  };
  clients.set(ws, info);
  log('info', `WS 连接 role=${role} id=${clientId} ip=${info.ip} (在线 ${clients.size})`);

  ws.on('pong', () => {
    info.alive = true;
    info.lastPing = Date.now();
    touchSeen(info);
  });
  ws.on('message', (data) => onMessage(ws, info, data));
  ws.on('close', (code) => onClose(ws, info, code));
  ws.on('error', (e) => log('warn', `WS 错误 id=${clientId}: ${e.message}`));
}

function onClose(ws, info, code) {
  clients.delete(ws);
  log('info', `WS 断开 role=${info.role} id=${info.clientId} code=${code} (在线 ${clients.size})`);
  if (info.role !== ROLE.DEVICE || !info.seatId) return;
  const seat = seats.get(info.seatId);
  if (!seat) return;
  const replacement = [...clients.values()].some((client) =>
    client.role === ROLE.DEVICE && client.seatId === info.seatId &&
    client.ws.readyState === WebSocket.OPEN);
  if (replacement) return;
  // 关键：断线绝不重置座位状态，只翻转 online=false。
  // 暂离倒计时仍由 Hub 依据 awayUntil 继续推进（协议 RECONNECT CONTRACT）。
  if (seat.online) {
    seat.online = false;
    seat.lastEvent = 'disconnect';
    broadcastSeatUpdate(seat);
  }
}

// ---------------------------------------------------------------------------
// 计时引擎（每 250ms tick）
// ---------------------------------------------------------------------------
function onTimeout(seat, now) {
  // ① 超时：状态改 available、清空 away 字段、生成 timeout/critical 告警并广播，
  //    同时 alert 帧会送达所属设备用于蜂鸣。
  clearAway(seat);
  seat.status = STATUS.AVAILABLE;
  seat.lastEvent = 'timeout';
  seat.expiredAt = now;
  seat.alerting = true;
  broadcastSeatUpdate(seat);
  const a = createAlert(seat, ALERT_KIND.TIMEOUT, SEVERITY.CRITICAL, `${seat.label} 暂离超时，座位已释放`);
  broadcastAlert(a);
  log('info', `座位超时释放 seat=${seat.seatId} alert=${a.alertId}`);
}

function tick() {
  const now = Date.now();
  for (const seat of seats.values()) {
    // ① now >= awayUntil -> 超时释放
    if (seat.awayUntil && now >= seat.awayUntil) {
      onTimeout(seat, now);
      continue; // 本轮已清空 away，跳过后续与 away 相关的判断
    }

    // ② 临近超时预警：每个 away 会话只发一次（preWarned 内部标记去重）
    if (seat.awayUntil && !seat.preWarned) {
      if (seat.awayUntil - now <= config.alertLeadSec * GRACE_MS_PER_SEC) {
        seat.preWarned = true;
        const a = createAlert(seat, ALERT_KIND.PRE_TIMEOUT, SEVERITY.WARNING, `${seat.label} 暂离即将超时，请返回或续时`);
        broadcastAlert(a);
      }
    }

    // ③ away 期间 sensor=true 持续超过 8s -> 冲突告警（本会话只发一次）
    if (seat.awayUntil && seat.occupied && seat.sensorTrueSince !== null && !seat.conflicted) {
      if (now - seat.sensorTrueSince >= SENSOR_CONFLICT_MS) {
        seat.conflicted = true;
        const a = createAlert(seat, ALERT_KIND.SENSOR_CONFLICT, SEVERITY.WARNING, `${seat.label} 暂离期间检测到有人就座，请核对`);
        broadcastAlert(a);
      }
    }

    // ④ 设备静默超过 offlineAfterMs -> online=false + offline/warning
    //    仅对「至少成功连过一次」(seen=true) 的座位告警，避免 12 个预置座位刷屏；
    //    offlineAlerted 保证每轮离线只告警一次，hello 时重置。
    if (seat.seen && !seat.offlineAlerted && (now - seat.lastSeen) > config.offlineAfterMs) {
      if (seat.online) {
        seat.online = false;
        broadcastSeatUpdate(seat);
      }
      const a = createAlert(seat, ALERT_KIND.OFFLINE, SEVERITY.WARNING, `${seat.label} 设备静默超过 ${Math.round(config.offlineAfterMs / 1000)}s，已标记离线`);
      broadcastAlert(a);
      seat.offlineAlerted = true;
    }

    // ⑤ graceSec 之后清理卡片红色告警态与过期 timeout 告警
    if (seat.expiredAt !== null && (now - seat.expiredAt) >= config.graceSec * GRACE_MS_PER_SEC) {
      seat.expiredAt = null;
      if (seat.alerting) {
        seat.alerting = false;
        broadcastSeatUpdate(seat);
      }
      clearAlertsWhere((a) => a.seatId === seat.seatId && a.kind === ALERT_KIND.TIMEOUT);
    }
  }
}

// WS 层心跳：每轮 ping，连续两轮未收到 pong（约 30s）即判定僵死并 terminate。
function sweepHeartbeat() {
  for (const [ws, info] of clients) {
    if (info.alive === false) {
      log('warn', `僵死连接清理 id=${info.clientId} role=${info.role}`);
      try { ws.terminate(); } catch (_) { /* 已断开 */ }
      clients.delete(ws);
      continue;
    }
    info.alive = false;
    try { ws.ping(); } catch (_) { /* 已断开，等 close 事件收尾 */ }
  }
}

// ---------------------------------------------------------------------------
// REST 路由
// ---------------------------------------------------------------------------
async function handleApi(req, res, pathname) {
  const method = req.method;

  if (pathname === '/api/health' && method === 'GET') {
    return sendJson(req, res, 200, {
      ok: true,
      protocol: PROTOCOL_VERSION,
      serverNow: Date.now(),
      uptimeSec: Math.round(process.uptime()),
      clients: clients.size,
      seats: seats.size,
      alerts: alerts.size,
    });
  }

  if (pathname === '/api/snapshot' && method === 'GET') {
    return sendJson(req, res, 200, snapshotPayload());
  }

  if (pathname === '/api/seats' && method === 'GET') {
    return sendJson(req, res, 200, { ok: true, serverNow: Date.now(), seats: allSeats() });
  }

  if (pathname === '/api/config') {
    if (method === 'GET') {
      return sendJson(req, res, 200, { ok: true, serverNow: Date.now(), config: { ...config } });
    }
    if (method === 'PUT') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        return sendJson(req, res, e.status || 400, { ok: false, error: e.message, serverNow: Date.now() });
      }
      const r = updateConfig(pickPatch(body));
      if (!r.ok) {
        return sendJson(req, res, 400, { ok: false, error: '配置校验失败', details: r.errors, serverNow: Date.now() });
      }
      return sendJson(req, res, 200, { ok: true, serverNow: Date.now(), config: { ...config } });
    }
    return sendJson(req, res, 405, { ok: false, error: 'Method Not Allowed', serverNow: Date.now() });
  }

  let m = /^\/api\/seats\/([^/]+)\/action$/.exec(pathname);
  if (m) {
    if (method !== 'POST') return sendJson(req, res, 405, { ok: false, error: 'Method Not Allowed', serverNow: Date.now() });
    const seatId = m[1];
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendJson(req, res, e.status || 400, { ok: false, error: e.message, serverNow: Date.now() });
    }
    if (!Object.values(ACTION).includes(body.action)) {
      return sendJson(req, res, 400, { ok: false, error: `action 必须是 ${Object.values(ACTION).join(' | ')}`, serverNow: Date.now() });
    }
    const seat = seats.get(seatId);
    if (!seat) return sendJson(req, res, 404, { ok: false, error: `座位 ${seatId} 不存在`, serverNow: Date.now() });
    const r = applyAction(seat, body.action, body.value, 'api');
    if (!r.ok) {
      return sendJson(req, res, 409, { ok: false, code: r.code, error: r.message, serverNow: Date.now() });
    }
    return sendJson(req, res, 200, { ok: true, serverNow: Date.now(), seat: publicSeat(seat) });
  }

  m = /^\/api\/alerts\/([^/]+)\/ack$/.exec(pathname);
  if (m) {
    if (method !== 'POST') return sendJson(req, res, 405, { ok: false, error: 'Method Not Allowed', serverNow: Date.now() });
    const r = ackAlert(m[1]);
    if (!r.ok) {
      return sendJson(req, res, 404, { ok: false, code: r.code, error: r.message, serverNow: Date.now() });
    }
    return sendJson(req, res, 200, { ok: true, alertId: m[1], serverNow: Date.now() });
  }

  return sendJson(req, res, 404, { ok: false, error: '未找到该 API 路由', path: pathname, serverNow: Date.now() });
}

async function handleHttp(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  let parsed;
  try {
    parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (_) {
    return sendJson(req, res, 400, { ok: false, error: '非法请求 URL' });
  }
  let pathname;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch (_) {
    return sendJson(req, res, 400, { ok: false, error: '非法路径编码' });
  }

  if (visitor.handles(pathname)) return visitor.route(req, res, pathname, seats);
  if (pathname.startsWith('/api/')) return handleApi(req, res, pathname);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(req, res, 405, { ok: false, error: 'Method Not Allowed' });
  }
  return serveStatic(req, res, pathname);
}

// ---------------------------------------------------------------------------
// 启动横幅 / 优雅退出 / 全局兜底
// ---------------------------------------------------------------------------
function lanIps() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) {
      // Node 18+ family 为 'IPv4'；兼容旧写法数字 4。
      if ((ni.family === 'IPv4' || ni.family === 4) && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

function printBanner() {
  const art = [
    '  +==============================================================+',
    '  |                                                              |',
    '  |   SSS  M   M   AAA   RRR  TTT      SSS  EEEEE   AAA   TTT     |',
    '  |  S     MM MM  A   A  R  R  T      S     E      A   A  T      |',
    '  |   SSS  M M M  AAAAA  RRR   T       SSS  EEE    AAAAA  T       |',
    '  |      S M   M  A   A  R R   T          S E      A   A  T       |',
    '  |   SSS  M   M  A   A  R  R  T       SSS  EEEEE  A   A  T       |',
    '  |                                                              |',
    '  |      S M A R T   S E A T   -   H U B                          |',
    '  |      Authoritative State Machine / WS / REST / Static          |',
    '  +==============================================================+',
  ];
  // eslint-disable-next-line no-console
  console.log('\n' + art.join('\n') + '\n');
  log('info', `协议 PROTOCOL_VERSION=${PROTOCOL_VERSION} | S2C=${S2C.join(',')} | 运行时 ${process.version}`);
  log('info', `Hub 绑定 ${HUB_HOST || '所有接口'}:${PORT} | 管理员入口 / | 访客入口 /visit`);
  log('info', `WebSocket: ws://0.0.0.0:${PORT}${WS_PATH}?role=device|dashboard&id=<clientId>`);
  const ips = lanIps();
  if (!HUB_HOST && ips.length) {
    log('info', `局域网 IP: ${ips.map((ip) => `http://${ip}:${PORT}/`).join('   ')}`);
  } else if (!HUB_HOST) {
    log('warn', '未检测到非回环 IPv4 地址，仅可通过 localhost 访问');
  }
  log('info', `预置座位 ${seats.size} 个 | 告警上限 ${MAX_ALERTS} 条 | tick ${TICK_MS}ms | 心跳扫描 ${HEARTBEAT_SWEEP_MS}ms`);
}

function shutdown(signal) {
  log('info', `收到 ${signal}，开始优雅退出`);
  if (tickTimer) clearInterval(tickTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  visitor.close();
  for (const [ws] of clients) {
    try { ws.close(1001, 'server shutdown'); } catch (_) { /* 已断开 */ }
  }
  try {
    wss.close(() => {
      try { server.close(); } catch (_) { /* 已关闭 */ }
    });
  } catch (_) { /* wss 已关闭 */ }
  // 客户端不配合 close 时的兜底：最迟 1.5s 关掉 HTTP 并退出。
  setTimeout(() => {
    try { server.close(); } catch (_) { /* 已关闭 */ }
    log('info', 'HTTP / WS 已关闭，进程退出');
    process.exit(0);
  }, 1500).unref();
}

// ---------------------------------------------------------------------------
// 初始化（顺序即启动流程）
// ---------------------------------------------------------------------------
config = loadConfig();
presetSeats();

const server = http.createServer((req, res) => {
  Promise.resolve(handleHttp(req, res)).catch((e) => {
    log('error', 'HTTP 处理异常', (e && (e.stack || e.message)) || String(e));
    if (!res.headersSent) {
      sendJson(req, res, (e && e.status) || 500, { ok: false, error: '服务器内部错误', serverNow: Date.now() });
    }
  });
});

const wss = new WebSocketServer({ server, path: WS_PATH });
wss.on('connection', onConnection);
wss.on('error', (e) => log('error', `WebSocketServer 错误: ${e.message}`));

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    log('error', `端口 ${PORT} 已被占用，请设置 PORT 环境变量或更换端口`);
  } else {
    log('error', `HTTP 服务器错误: ${e && e.message}`);
  }
});

tickTimer = setInterval(tick, TICK_MS);
heartbeatTimer = setInterval(sweepHeartbeat, HEARTBEAT_SWEEP_MS);

server.listen(PORT, HUB_HOST, () => {
  printBanner();
  visitor.start(seats, log);
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// 只记录不退出：避免单条坏帧 / 未处理的 Promise 让整个 Hub 崩掉。
process.on('uncaughtException', (err) => {
  log('error', 'uncaughtException', (err && (err.stack || err.message)) || String(err));
});
process.on('unhandledRejection', (reason) => {
  log('error', 'unhandledRejection', (reason && (reason.stack || reason.message)) || String(reason));
});

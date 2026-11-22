/**
 * ============================================================================
 *  Smart Seat · Temporary Leave Management System
 *  SHARED PROTOCOL CONTRACT  v1.0.0   —  SINGLE SOURCE OF TRUTH
 * ============================================================================
 *
 *  Transport : JSON text frames over WebSocket. UTF-8. One message per frame.
 *  Endpoint  : ws://<host>:8080/ws?role=<device|dashboard>&id=<clientId>
 *              (wss:// + reverse proxy in production)
 *              USB: same JSON over UTF-8 serial lines at 115200 baud;
 *              server/usb-bridge.ps1 forwards those lines to /ws.
 *
 *  Topology
 *  --------
 *      [ESP32-C3 x N]  --WS(device)-->  [ Node.js Hub ]  <--WS(dashboard)--  [Admin UI]
 *                                          |  ^
 *                                          |  +-- REST /api/*  (admin + health)
 *                                          +-- static /  (dashboard/index.html)
 *                                          +-- /visit + /api/public/events (read-only SSE)
 *
 *  AUTHORITY MODEL
 *  ---------------
 *  The Hub is the single authority for seat status and for time.
 *  - Devices report *facts* (button presses, occupancy sensor edges, heartbeats).
 *  - The Hub derives the canonical `status`, stamps `awayUntil` (epoch ms) and
 *    broadcasts `seat.update` to every dashboard and to the owning device.
 *  - Clients NEVER tick their own clock as truth: they compute
 *        remainingMs = seat.awayUntil - (Date.now() + clockOffset)
 *    where clockOffset = snapshot.serverNow - Date.now() captured at snapshot.
 *    This keeps every screen in lockstep and survives reconnect / tab throttling.
 *  - Devices keep a *local fallback* countdown (millis based) only while offline,
 *    and overwrite it from the next snapshot / seat.update.
 *
 *  ---------------------------------------------------------------------------
 *  CLIENT -> SERVER  (C2S)
 *  ---------------------------------------------------------------------------
 *  hello          { type, role, clientId, seatId?, fw?, caps? }
 *                 First frame after connect. Server replies with `snapshot`.
 *                 Devices MUST include seatId (e.g. "A01"). Dashboards may omit.
 *                 With caps.compactSnapshot=true, a device receives only its
 *                 own seat and its unacknowledged timeout alerts in snapshots.
 *  button         { type, seatId, action, seq, ts }
 *                 Physical button event, already debounced on device.
 *                 action: away_start | away_cancel | release | extend
 *                 seq: monotonic per-device counter, used for dedupe/replay.
 *  sensor         { type, seatId, occupied:boolean, seq }
 *                 Occupancy edge (FSR / IR break-beam / pressure pad).
 *  state          { type, seatId, status, reason? }
 *                 Optional explicit state request (admin console / simulator).
 *  ping           { type, ts }
 *                 Heartbeat. Server answers `pong`.
 *  config.set     { type, patch:{ awayDurationMin?, alertLeadSec?, graceSec?, soundEnabled? } }
 *                 Dashboard only. Persisted + broadcast as `config.update`.
 *  admin.action   { type, seatId, action, value? }
 *                 Dashboard only. Same actions as `button`, remote triggered.
 *  alert.ack      { type, alertId }
 *                 Dashboard only. Broadcast as `alert.cleared`.
 *
 *  ---------------------------------------------------------------------------
 *  SERVER -> CLIENT  (S2C)
 *  ---------------------------------------------------------------------------
 *  snapshot       { type, serverNow, protocol, config, seats:[Seat], alerts:[Alert] }
 *                 Full resync. Sent on every (re)connect. Replaces client state.
 *  seat.update    { type, seat:Seat }
 *                 One authoritative seat changed. Sent to all dashboards + owner.
 *  config.update  { type, config, serverNow }
 *  alert          { type, alert:Alert }
 *  alert.cleared  { type, alertId }
 *  pong           { type, ts, serverNow }
 *  error          { type, code, message }
 *
 *  ---------------------------------------------------------------------------
 *  OBJECT SHAPES
 *  ---------------------------------------------------------------------------
 *  Seat {
 *    seatId:        "A01"
 *    label:         "A-01"
 *    zone:          "Zone A · Window"        (display label, free text)
 *    status:        "available" | "occupied" | "away"     <-- ONLY 3 states
 *    occupied:      false                    raw sensor value
 *    online:        true                     device connectivity flag
 *    awayUntil:     1730000000000 | null     epoch ms, authoritative
 *    awayStartedAt: 1730000000000 | null
 *    awayDurationMs: 900000                  duration used for THIS away session
 *    lastSeen:      1730000000000
 *    fw:            "1.0.0" | null
 *    ip:            "192.168.1.42" | null
 *    rssi:          -54 | null
 *    lastEvent:     "button:away_start"
 *    alerting:      false                    true while an unacked critical alert exists
 *  }
 *
 *  Alert {
 *    alertId:   "ALT-0007"
 *    seatId:    "A01"
 *    kind:      "timeout" | "pre_timeout" | "offline" | "sensor_conflict"
 *    severity:  "critical" | "warning" | "info"
 *    message:   "A-01 暂离超时，座位已释放"
 *    createdAt: 1730000000000
 *    acked:     false
 *  }
 *
 *  Config {
 *    awayDurationMin: 15        // default 15 minutes, admin configurable (float ok, e.g. 0.2 for demo)
 *    alertLeadSec:    60        // pre-timeout warning lead time
 *    graceSec:        30        // seconds after timeout the card keeps a red "just expired" glow
 *    heartbeatMs:     5000
 *    offlineAfterMs:  15000
 *    soundEnabled:    true
 *  }
 *
 *  soundEnabled 语义（全局「音频」门禁，不是全局「告警」开关）：
 *    - Hub 只做布尔类型校验、原子持久化，并随 config.update 广播；Hub 不做音频门禁，
 *      也不因该值为 false 而抑制 alert 帧 —— 视觉告警必须永远可用。
 *    - 门禁由各消费端本地执行：ESP32 蜂鸣器 (want = alertActive && cfgSoundEnabled)、
 *      后台 Web Audio (SoundEngine.canPlay)。OLED 红闪 / 后台红色横幅与卡片脉冲不受影响。
 *    - 与「本机浏览器静音偏好」是两级独立控制，互不广播、互不覆盖。
 *
 *  ---------------------------------------------------------------------------
 *  STATUS MACHINE  (server authoritative)
 *  ---------------------------------------------------------------------------
 *   sensor occupied=true  & no away session           -> occupied
 *   sensor occupied=false & no away session           -> available
 *   button away_start (device, only from occupied)    -> away,
 *        awayStartedAt = now, awayUntil = now + awayDurationMin*60000
 *   admin away_start (`admin.action` / REST, source=admin|api) -> 管理员手动覆盖：
 *        允许从 available/occupied 触发；当前非 occupied 时强制置 occupied=true，
 *        lastEvent 记为 "admin.override:away_start" 以便审计。设备 button 不受影响，
 *        仍严格拒绝非 occupied 触发（保留物理语义）。用途：无硬件时纯后台演示、
 *        传感器故障或用户忘记按键时的代客登记。
 *   button away_cancel                               -> occupied if sensor else available
 *   button release / admin release                    -> available  (clears away)
 *   button extend / admin extend                      -> awayUntil += 5*60000
 *   now >= awayUntil                                  -> available + alert(timeout/critical)
 *   awayUntil - now <= alertLeadSec (once per session)-> alert(pre_timeout/warning)
 *   during away, sensor goes true for > 8s            -> alert(sensor_conflict/warning)
 *   device silent > offlineAfterMs                    -> online=false + alert(offline/warning)
 *        NOTE: an away countdown KEEPS RUNNING while the device is offline.
 *   device reconnects (hello)                         -> snapshot, online=true,
 *                                                      offline alert cleared, state preserved
 *
 *  ---------------------------------------------------------------------------
 *  RECONNECT CONTRACT
 *  ---------------------------------------------------------------------------
 *  - Exponential backoff with jitter: 1s, 2s, 4s, 8s, 16s, max 30s.
 *  - Device buffers up to 16 outbound events while offline, replays in seq order.
 *  - Dashboard clears local state on disconnect and fully replaces on `snapshot`.
 *  - Server NEVER resets seat state on socket close; it only flips `online`.
 *  - Heartbeat: client ping every heartbeatMs; if no pong within 2.5x, force reconnect.
 *
 *  NOTE for firmware: ESP32-C3 is C++ and cannot import this file. The constants
 *  above are mirrored (with a comment pointing here) at the top of the .ino.
 *  Keep both in sync when bumping PROTOCOL_VERSION.
 * ============================================================================
 */

'use strict';

const PROTOCOL_VERSION = '1.0.0';
const WS_PATH = '/ws';
const DEFAULT_PORT = 8080;

const STATUS = Object.freeze({
  AVAILABLE: 'available',
  OCCUPIED: 'occupied',
  AWAY: 'away',
});

const ROLE = Object.freeze({ DEVICE: 'device', DASHBOARD: 'dashboard' });

const ACTION = Object.freeze({
  AWAY_START: 'away_start',
  AWAY_CANCEL: 'away_cancel',
  RELEASE: 'release',
  EXTEND: 'extend',
});

const ALERT_KIND = Object.freeze({
  TIMEOUT: 'timeout',
  PRE_TIMEOUT: 'pre_timeout',
  OFFLINE: 'offline',
  SENSOR_CONFLICT: 'sensor_conflict',
});

const SEVERITY = Object.freeze({ CRITICAL: 'critical', WARNING: 'warning', INFO: 'info' });

const C2S = Object.freeze([
  'hello', 'button', 'sensor', 'state', 'ping',
  'config.set', 'admin.action', 'alert.ack',
]);

const S2C = Object.freeze([
  'snapshot', 'seat.update', 'config.update', 'alert', 'alert.cleared', 'pong', 'error',
]);

const DEFAULT_CONFIG = Object.freeze({
  awayDurationMin: 15,
  alertLeadSec: 60,
  graceSec: 30,
  heartbeatMs: 5000,
  offlineAfterMs: 15000,
  soundEnabled: true,
});

const TIMING = Object.freeze({
  TICK_MS: 250,
  EXTEND_MS: 5 * 60 * 1000,
  SENSOR_CONFLICT_MS: 8000,
  BACKOFF_BASE_MS: 1000,
  BACKOFF_MAX_MS: 30000,
  OFFLINE_QUEUE_MAX: 16,
});

/** Remaining ms for an away seat, computed from an authoritative epoch + clock offset. */
function remainingMs(awayUntil, clockOffset = 0, now = Date.now()) {
  if (!awayUntil) return 0;
  return Math.max(0, awayUntil - (now + clockOffset));
}

function clockOffsetFrom(serverNow, sampledAt = Date.now()) {
  return serverNow - sampledAt;
}

function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

module.exports = {
  PROTOCOL_VERSION, WS_PATH, DEFAULT_PORT,
  STATUS, ROLE, ACTION, ALERT_KIND, SEVERITY, C2S, S2C,
  DEFAULT_CONFIG, TIMING,
  remainingMs, clockOffsetFrom, formatCountdown,
};

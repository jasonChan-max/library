'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const WebSocket = require('ws');

const hubPort = process.env.VISITOR_TEST_HUB_PORT || '8102';
const visitorPort = process.env.VISITOR_TEST_PORT || '8103';
const hub = `http://127.0.0.1:${hubPort}`;
const visitor = `http://127.0.0.1:${visitorPort}`;

async function connectStream(base, signal) {
  const response = await fetch(base + '/api/public/events', { signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return async (name) => {
    for (;;) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary < 0) {
        const { done, value } = await reader.read();
        assert.equal(done, false, '访客事件流提前断开');
        buffer += decoder.decode(value, { stream: true });
        continue;
      }
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const [type, data] = frame.split('\n');
      if (type === `event: ${name}`) return JSON.parse(data.slice('data: '.length));
    }
  };
}

async function main() {
  const controller = new AbortController();
  const { signal } = controller;
  const deadline = setTimeout(() => controller.abort(new Error('访客测试超时')), 10000);
  const server = spawn(process.execPath, [path.join(__dirname, '../server/index.js')], {
    env: { ...process.env, PORT: hubPort, PUBLIC_PORT: visitorPort, PUBLIC_HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  let device;
  try {
    const page = await (async () => {
      while (!signal.aborted) {
        try { return await fetch(visitor, { signal }); } catch (_) { await delay(50); }
      }
      throw signal.reason;
    })();
    assert.equal(page.status, 200);
    assert.match(await page.text(), /自习室座位/);
    assert.equal((await fetch(hub + '/visit', { signal })).status, 200);
    assert.equal((await fetch(visitor + '/api/snapshot', { signal })).status, 404);
    assert.equal((await fetch(visitor + '/index.html', { signal })).status, 404);
    assert.equal((await fetch(visitor + '/api/public/seats', { method: 'POST', signal })).status, 405);
    const wsRejection = new WebSocket(`ws://127.0.0.1:${visitorPort}/ws?role=dashboard`, { handshakeTimeout: 2000 });
    const [error] = await once(wsRejection, 'error', { signal });
    assert.match(error.message, /404/);

    const clients = await Promise.all([connectStream(hub, signal), connectStream(visitor, signal)]);
    const snapshots = await Promise.all(clients.map((next) => next('snapshot')));
    assert.ok(snapshots.every(({ seats }) => seats.length === 12 && seats.every((seat) => seat.status === 'unknown')));

    device = new WebSocket(`ws://127.0.0.1:${hubPort}/ws?role=device&id=SEAT_A01`);
    await once(device, 'open', { signal });
    const send = (frame) => device.send(JSON.stringify({ seatId: 'A01', ...frame }));
    const checkBoth = async (status) => {
      const events = await Promise.all(clients.map((next) => next('seat')));
      for (const { seat } of events) {
        assert.deepEqual(seat, { seatId: 'A01', label: 'A-01', zone: 'Zone A · 靠窗', status });
      }
    };

    const deviceSnapshot = once(device, 'message', { signal });
    send({ type: 'hello', role: 'device', fw: 'smoke', caps: { compactSnapshot: true } });
    const [frame] = await deviceSnapshot;
    assert.deepEqual(JSON.parse(frame).seats.map(({ seatId }) => seatId), ['A01']);
    await checkBoth('available');
    send({ type: 'sensor', occupied: true, seq: 1 });
    await checkBoth('occupied');
    send({ type: 'button', action: 'away_start', seq: 2 });
    await checkBoth('away');
    send({ type: 'button', action: 'away_cancel', seq: 3 });
    await checkBoth('occupied');
    send({ type: 'button', action: 'release', seq: 4 });
    await checkBoth('available');
    device.close();
    await checkBoth('unknown');

    const snapshot = await fetch(visitor + '/api/public/seats', { signal }).then((res) => res.json());
    assert.equal(snapshot.seats[0].status, 'unknown');
    console.log('PASS 双访客同步、设备往返、座位离线、公开字段及访客端口隔离');
  } finally {
    clearTimeout(deadline);
    controller.abort();
    device?.terminate();
    server.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

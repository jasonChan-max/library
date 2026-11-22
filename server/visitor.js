'use strict';

const http = require('node:http');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const files = new Map([
  ['/visit', ['index.html', 'text/html']],
  ['/visit/', ['index.html', 'text/html']],
  ['/visit/site.css', ['site.css', 'text/css']],
  ['/visit/site.js', ['site.js', 'text/javascript']],
]);
const snapshotPath = '/api/public/seats';
const streamPath = '/api/public/events';
const streams = new Set();
let listener;
let heartbeat;

function handles(pathname) {
  return files.has(pathname) || pathname === snapshotPath || pathname === streamPath;
}

function seatView(seat) {
  return {
    seatId: seat.seatId,
    label: seat.label,
    zone: seat.zone,
    status: seat.online ? seat.status : 'unknown',
  };
}

function snapshot(seats) {
  return { serverNow: Date.now(), seats: Array.from(seats.values(), seatView) };
}

function event(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function broadcast(frame) {
  for (const stream of streams) {
    // A slow client can reconnect and receive a fresh snapshot.
    if (!stream.write(frame)) {
      streams.delete(stream);
      stream.destroy();
    }
  }
}

function update(seat) {
  if (streams.size > 0) {
    broadcast(event('seat', { serverNow: Date.now(), seat: seatView(seat) }));
  }
}

function route(req, res, pathname, seats) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!handles(pathname)) return res.writeHead(404).end();
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.writeHead(405, { Allow: 'GET, HEAD' }).end();
  }

  if (pathname === streamPath) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    });
    if (req.method === 'HEAD') return res.end();
    streams.add(res);
    res.on('close', () => streams.delete(res));
    res.write(event('snapshot', snapshot(seats)));
    return;
  }

  if (pathname === snapshotPath) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(req.method === 'HEAD' ? undefined : JSON.stringify(snapshot(seats)));
  }

  const [file, mime] = files.get(pathname);
  res.setHeader('Content-Type', `${mime}; charset=utf-8`);
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  return res.end(req.method === 'HEAD' ? undefined : readFileSync(path.join(__dirname, '../visitor', file)));
}

function start(seats, log) {
  heartbeat = setInterval(() => {
    if (streams.size > 0) broadcast(event('heartbeat', { serverNow: Date.now() }));
  }, 10000);
  heartbeat.unref();

  const port = Number(process.env.PUBLIC_PORT);
  if (!process.env.PUBLIC_PORT) return;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    log('error', 'PUBLIC_PORT 必须是 1–65535 的整数');
    return;
  }
  const host = process.env.PUBLIC_HOST || '127.0.0.1';
  listener = http.createServer((req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      route(req, res, pathname === '/' ? '/visit' : pathname, seats);
    } catch (_) {
      if (res.headersSent) return res.destroy();
      res.writeHead(500).end();
    }
  });
  listener.on('error', (error) => log('error', `访客监听失败: ${error.message}`));
  listener.listen(port, host, () => log('info', `独立访客入口 http://${host}:${port}/`));
}

function close() {
  clearInterval(heartbeat);
  for (const stream of streams) stream.end();
  streams.clear();
  if (listener?.listening) listener.close();
}

module.exports = { handles, route, update, start, close };

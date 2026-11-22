/**
 * ============================================================================
 *  Smart Seat · 浏览器端冒烟测试 (browser-smoke.js)
 * ============================================================================
 *
 *  一键运行：node tests/browser-smoke.js
 *  依赖：本机 Chrome 或 Edge（自动探测）；Node.js 18+（需全局 fetch/WebSocket，
 *        Node 22 已内置；低版本会回退到 ws）。无需 puppeteer / 无需安装依赖。
 *
 *  原理：以 --headless=new 启动浏览器并通过 Chrome DevTools Protocol 打开
 *        dashboard/index.html（file://，无 Hub → 自动进入演示模式），然后：
 *          T1 演示模式自动激活、12 张座位卡片渲染、KPI 有值、时钟在走
 *          T2 网格 / 列表视图切换
 *          T3 搜索 / 状态筛选 / 排序
 *          T4 配置滑块 → 保存并广播；全局蜂鸣器复选框存在且可切换
 *          T5 告警测试 → 横幅 / toast 出现，全部确认后横幅消失
 *          T6 座位操作（occupied → 开始暂离 → 卡片变为 st-away）
 *          T7 全程无 Runtime.exceptionThrown / console.error / Log.error
 *
 *  退出码：全部通过 0；运行时异常 3；脚本失败 4。
 *  环境变量：CHROME_PATH 可覆盖浏览器可执行文件位置。
 * ============================================================================
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

// Node 18/20 没有全局 WebSocket，回退到项目已安装的 ws
const WebSocketImpl = (typeof WebSocket !== 'undefined')
  ? WebSocket
  : require(path.join(__dirname, '..', 'server', 'node_modules', 'ws'));

const DASH = path.resolve(__dirname, '..', 'dashboard', 'index.html');
const pageUrl = pathToFileURL(DASH).href;

function findBrowser() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return null;
}

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓ PASS' : '✗ FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function main() {
  console.log('\n════════════════════════════════════════════════════════');
  console.log(' Smart Seat · 浏览器端冒烟测试 (CDP / file:// 演示模式)');
  console.log(` 页面: ${pageUrl}`);
  console.log('════════════════════════════════════════════════════════\n');

  if (!fs.existsSync(DASH)) throw new Error('找不到 dashboard/index.html');
  const browser = findBrowser();
  if (!browser) throw new Error('未找到 Chrome / Edge，可设置 CHROME_PATH 环境变量');
  console.log('  · 浏览器:', browser);

  const userDir = path.join(os.tmpdir(), 'smartseat-cdp-' + Date.now());
  const proc = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-background-networking', '--remote-debugging-port=0',
    '--user-data-dir=' + userDir, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  const runtimeErrors = [];

  const cleanup = () => { try { proc.kill(); } catch (_) { /* noop */ } };
  process.on('exit', cleanup);

  try {
    let browserWs = null;
    for (let i = 0; i < 80 && !browserWs; i++) {
      const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) browserWs = m[1];
      else await sleep(150);
    }
    if (!browserWs) throw new Error('Chrome DevTools 未就绪: ' + stderr.slice(-600));
    const port = browserWs.match(/:(\d+)\//)[1];
    const list = await fetch('http://127.0.0.1:' + port + '/json/list').then((r) => r.json());
    const page = list.find((t) => t.type === 'page');
    if (!page) throw new Error('未找到 page target');

    const ws = new WebSocketImpl(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let seq = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
        return;
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        runtimeErrors.push('EXCEPTION: ' + ((d.exception && d.exception.description) || d.text));
      } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        runtimeErrors.push('LOG: ' + m.params.entry.text);
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        runtimeErrors.push('CONSOLE: ' + m.params.args.map((a) => a.value || a.description).join(' '));
      }
    };
    const cmd = (method, params) => new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
    const evaluate = async (expr) => {
      const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('EVAL: ' + JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };
    const evalJson = async (expr) => JSON.parse(await evaluate('JSON.stringify((function(){' + expr + '})())'));

    await cmd('Runtime.enable');
    await cmd('Log.enable');
    await cmd('Page.enable');
    await cmd('Page.navigate', { url: pageUrl });
    await sleep(5200); // 3s 自动演示模式 + 若干轮 200ms tick + 随机事件

    // ---- T1 ----------------------------------------------------------------
    const t1 = await evalJson(`
      return {
        cards: document.querySelectorAll('.seat-card').length,
        conn: document.getElementById('connText').textContent,
        demo: !document.getElementById('demoBanner').classList.contains('hidden'),
        total: document.querySelector('[data-num="total"]').textContent,
        away: document.querySelector('[data-num="away"]').textContent,
        clock: document.getElementById('clock').textContent,
        countdown: (document.querySelector('[data-countdown]')||{}).textContent,
        overlayHidden: document.getElementById('reconnectOverlay').classList.contains('hidden'),
        globalSound: !!document.getElementById('globalSound')
      };
    `);
    check('T1 演示模式自动激活 + 12 张卡片 + KPI/时钟/倒计时',
      t1.demo && t1.cards === 12 && Number(t1.total) === 12 && /^\d{2}:\d{2}:\d{2}$/.test(t1.clock) && t1.overlayHidden,
      `cards=${t1.cards}, total=${t1.total}, away=${t1.away}, clock=${t1.clock}, conn=${t1.conn}`);
    check('T1b 全局蜂鸣器复选框已解耦并存在', t1.globalSound === true);

    // ---- T2 ----------------------------------------------------------------
    const t2 = await evalJson(`
      document.getElementById('viewList').click();
      var rows = document.querySelectorAll('#listBody tr').length;
      var listShown = !document.getElementById('listView').classList.contains('hidden');
      document.getElementById('viewGrid').click();
      return { rows: rows, listShown: listShown, gridBack: !document.getElementById('seatGrid').classList.contains('hidden') };
    `);
    check('T2 网格 / 列表视图切换', t2.listShown && t2.rows === 12 && t2.gridBack, `rows=${t2.rows}`);

    // ---- T3 ----------------------------------------------------------------
    const t3 = await evalJson(`
      var inp=document.getElementById('searchInput');
      inp.value='A0'; inp.dispatchEvent(new Event('input',{bubbles:true}));
      var filtered=document.querySelectorAll('.seat-card').length;
      inp.value=''; inp.dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelector('[data-filter="away"]').click();
      var awayOnly=document.querySelectorAll('.seat-card').length;
      document.querySelector('[data-filter="all"]').click();
      var sel=document.getElementById('sortSelect'); sel.value='remaining'; sel.dispatchEvent(new Event('change',{bubbles:true}));
      return { filtered:filtered, awayOnly:awayOnly, restored:document.querySelectorAll('.seat-card').length };
    `);
    // 'A0' 只命中 A01..A09 共 9 张（A10/A11/A12 不含子串 "A0"），故期望 9。
    check('T3 搜索 / 状态筛选 / 排序', t3.filtered === 9 && t3.awayOnly >= 1 && t3.restored === 12,
      `search=${t3.filtered}, awayOnly=${t3.awayOnly}, restored=${t3.restored}`);

    // ---- T4 ----------------------------------------------------------------
    const t4 = await evalJson(`
      var sl=document.getElementById('awaySlider'); sl.value='0.1'; sl.dispatchEvent(new Event('input',{bubbles:true}));
      var dirty=!document.getElementById('dirtyBadge').classList.contains('hidden');
      document.getElementById('saveConfig').click();
      var saved=document.getElementById('dirtyBadge').classList.contains('hidden');
      var gs=document.getElementById('globalSound'); var before=gs.checked; gs.checked=!before; gs.dispatchEvent(new Event('change',{bubbles:true}));
      return { dirty:dirty, saved:saved, soundToggled:gs.checked!==before, dur:document.getElementById('awayDuration').value };
    `);
    check('T4 配置滑块 / 保存 / 全局蜂鸣器切换',
      t4.dirty && t4.saved && t4.soundToggled && Number(t4.dur) === 0.1,
      `dirtyBefore=${t4.dirty}, clearedAfterSave=${t4.saved}, awayDurationMin=${t4.dur}`);

    // ---- T5 ----------------------------------------------------------------
    const t5 = await evalJson(`
      document.getElementById('alertTest').click();
      var shown=!document.getElementById('alertBanner').classList.contains('hidden');
      var banner=document.getElementById('bannerText').textContent;
      var toasts=document.querySelectorAll('.toast').length;
      document.getElementById('bannerAckAll').click();
      var hidden=document.getElementById('alertBanner').classList.contains('hidden');
      return { shown:shown, banner:banner, toasts:toasts, hidden:hidden };
    `);
    check('T5 告警横幅 / toast / 全部确认', t5.shown && t5.toasts >= 1 && t5.hidden,
      `toasts=${t5.toasts}, banner="${t5.banner}"`);

    // ---- T6 ----------------------------------------------------------------
    const t6 = await evalJson(`
      var cards=[].slice.call(document.querySelectorAll('.seat-card'));
      var c=cards.find(function(x){ var b=x.querySelector('[data-act="away_start"]'); return b && !b.disabled; });
      if(!c) return {clicked:false};
      var id=c.getAttribute('data-seat');
      c.querySelector('[data-act="away_start"]').click();
      var after=document.querySelector('[data-seat="'+id+'"]');
      return {clicked:true, seatId:id, isAway: after? after.classList.contains('st-away'):false};
    `);
    check('T6 座位操作 occupied → 开始暂离', t6.clicked && t6.isAway,
      t6.clicked ? `seat=${t6.seatId}, isAway=${t6.isAway}` : '未找到可操作的占用座位');

    // ---- T6b ---------------------------------------------------------------
    // 管理员手动覆盖：先强制释放成 available，再点「开始暂离」，
    // 验证演示模式与真 Hub 的 admin 覆盖规则一致（不再被 occupied 前置卡住）。
    const t6b = await evalJson(`
      var card=document.querySelector('.seat-card');
      var id=card.getAttribute('data-seat');
      var rel=card.querySelector('[data-act="release"]');
      if(rel && !rel.disabled) rel.click();
      var fresh=document.querySelector('[data-seat="'+id+'"]');
      var wasAvailable=fresh? fresh.classList.contains('st-available'):false;
      var btn=fresh? fresh.querySelector('[data-act="away_start"]'):null;
      var enabled=!!btn && !btn.disabled;
      if(enabled) btn.click();
      var after=document.querySelector('[data-seat="'+id+'"]');
      return { seatId:id, wasAvailable:wasAvailable, enabled:enabled,
               isAway: after? after.classList.contains('st-away'):false };
    `);
    check('T6b 管理员覆盖：available 座位可直接登记暂离',
      t6b.wasAvailable && t6b.enabled && t6b.isAway,
      `seat=${t6b.seatId}, available=${t6b.wasAvailable}, btnEnabled=${t6b.enabled}, isAway=${t6b.isAway}`);

    await sleep(600);
    // ---- T7 ----------------------------------------------------------------
    // file:// 直开且本机没有 Hub 时，浏览器必然记录 WS 连接被拒绝 —— 这正是
    // 「3 秒自动进入演示模式」的触发条件，属于预期噪声，不算产品运行时异常。
    const benign = (s) => /WebSocket connection to .* failed:.*ERR_CONNECTION_REFUSED/.test(s);
    const realErrors = runtimeErrors.filter((s) => !benign(s));
    const ignored = runtimeErrors.length - realErrors.length;
    check('T7 全程无真实运行时异常 / console.error', realErrors.length === 0,
      realErrors.length ? realErrors.join(' || ').slice(0, 400)
        : `NONE（已忽略 ${ignored} 条无 Hub 时的预期 WS 连接拒绝日志）`);

    ws.close();
  } finally {
    cleanup();
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log('\n────────────────────────────────────────────────────────');
  console.log(` 结果：${passed} 通过 / ${failed} 失败 / 共 ${results.length} 项`);
  console.log('────────────────────────────────────────────────────────\n');
  if (failed > 0) process.exitCode = results.some((r) => r.name.startsWith('T7') && !r.ok) ? 3 : 4;
}

main().catch((e) => { console.error('  SMOKE FAILED:', e.message); process.exitCode = 4; });

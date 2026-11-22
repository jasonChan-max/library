'use strict';

const labels = { available: '空闲', occupied: '使用中', away: '暂离', unknown: '待确认' };
const seats = new Map();
const connection = document.querySelector('#connection');
const updated = document.querySelector('#updated');
const zoneSelect = document.querySelector('#zone');
const onlyAvailable = document.querySelector('#only-available');
const zoneList = document.querySelector('#zones');
const empty = document.querySelector('#empty');
const time = new Intl.DateTimeFormat('zh-CN', { timeStyle: 'medium', hourCycle: 'h23' });
const order = new Intl.Collator('zh-CN', { numeric: true });
let live = false;
let hasSnapshot = false;
let lastSeen = 0;
let lastUpdate = 0;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function render() {
  const groups = new Map();
  const totals = { available: 0, occupied: 0, away: 0, unknown: 0 };
  for (const seat of seats.values()) {
    const status = live && Object.hasOwn(labels, seat.status) ? seat.status : 'unknown';
    totals[status]++;
    if (!groups.has(seat.zone)) groups.set(seat.zone, []);
    groups.get(seat.zone).push({ ...seat, status });
  }

  for (const [status, total] of Object.entries(totals)) {
    document.getElementById(status).textContent = live || (hasSnapshot && status === 'unknown') ? total : '—';
  }
  const selectedZone = zoneSelect.value;
  const zones = [...groups.keys()].sort(order.compare);
  zoneSelect.replaceChildren(new Option('全部区域', ''), ...zones.map((zone) => new Option(zone, zone)));
  if (groups.has(selectedZone)) zoneSelect.value = selectedZone;

  const sections = [];
  for (const zone of zones) {
    if (zoneSelect.value && zone !== zoneSelect.value) continue;
    const group = groups.get(zone).sort((a, b) => order.compare(a.label, b.label));
    const available = group.filter((seat) => seat.status === 'available');
    const visible = onlyAvailable.checked ? available : group;
    if (visible.length === 0) continue;

    const section = element('section', '', 'zone');
    const heading = element('div', '', 'zone-head');
    heading.append(element('h3', zone), element('p', live ? `${available.length} 个空闲` : '状态待确认'));
    const items = element('ul', '', 'seats');
    for (const seat of visible) {
      const item = element('li', '', 'seat');
      item.dataset.state = seat.status;
      item.append(element('strong', seat.label), element('span', labels[seat.status], 'seat-status'));
      items.append(item);
    }
    section.append(heading, items);
    sections.push(section);
  }
  zoneList.replaceChildren(...sections);
  empty.hidden = sections.length > 0;
  if (!empty.hidden) {
    empty.textContent = live
      ? (onlyAvailable.checked ? '所选区域暂时没有空闲座位。' : '暂无座位数据。')
      : '暂时无法确认座位状态，请稍后再查看。';
  }
}

function showConnection(connected) {
  live = connected;
  connection.dataset.live = connected;
  connection.textContent = connected ? '实时更新' : '连接中断，正在重连';
  updated.textContent = lastUpdate ? `最近同步 ${time.format(lastUpdate)}` : '';
}

function markStale() {
  showConnection(false);
  render();
}

zoneSelect.addEventListener('change', render);
onlyAvailable.addEventListener('change', render);

let source;
function connect() {
  lastSeen = Date.now();
  source = new EventSource('/api/public/events');
  source.addEventListener('snapshot', (event) => {
    const data = JSON.parse(event.data);
    seats.clear();
    for (const seat of data.seats) seats.set(seat.seatId, seat);
    hasSnapshot = true;
    lastSeen = Date.now();
    lastUpdate = data.serverNow;
    showConnection(true);
    render();
  });
  source.addEventListener('seat', (event) => {
    const data = JSON.parse(event.data);
    seats.set(data.seat.seatId, data.seat);
    lastSeen = Date.now();
    lastUpdate = data.serverNow;
    showConnection(true);
    render();
  });
  source.addEventListener('heartbeat', () => { lastSeen = Date.now(); });
  source.onerror = markStale;
}

connect();
setInterval(() => {
  if (Date.now() - lastSeen < 25000) return;
  markStale();
  source.close();
  connect();
}, 5000);

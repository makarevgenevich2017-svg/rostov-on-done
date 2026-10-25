const $ = id => document.getElementById(id);
const rub = n => new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 0}).format(n) + ' ₽';
const state = {company: null, page: 1, charts: {}, slide: 0, days: 30};
const MIN_DAYS = 30, MAX_DAYS = 365;
const dayWord = n => { const m = n % 100, d = n % 10; return (m > 10 && m < 15) ? 'дней' : d === 1 ? 'день' : (d > 1 && d < 5) ? 'дня' : 'дней'; };
window.currentSlide = 0;
const PALETTE = ['#d6143a','#ff9a1f','#0fa968','#2f80ed','#e0559c','#f5c400','#8b5cf6','#2cc5b8','#ff6b4a'];
const BURGUNDY = 'rgba(214,20,58,1)', AMBER = 'rgba(255,140,0,1)';
if (window.Chart) {
  Chart.defaults.font.family = '"Manrope", system-ui, sans-serif';
  Chart.defaults.color = '#7a6569';
  Chart.defaults.borderColor = '#efe2e2';
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmtDay = d => new Intl.DateTimeFormat('ru-RU', {day: 'numeric', month: 'long'}).format(new Date(d + 'T00:00:00'));
const fmtShort = d => d.slice(8, 10) + '.' + d.slice(5, 7);
const fmtPct = p => p > 0.99 ? 'более 99%' : p < 0.01 ? 'менее 1%' : Math.round(p * 100) + '%';

const SLIDES = [...document.querySelectorAll('#track > .slide')];
const ANIM_MS = 380;
function go(i){
  const prev = state.slide;
  state.slide = i; window.currentSlide = i;
  document.querySelectorAll('[data-nav]').forEach(b => b.classList.toggle('active', +b.dataset.nav === i));
  if (i === prev) return;

  // всё лишнее сразу прячем: промежуточные экраны не мелькают
  SLIDES.forEach((sl, k) => {
    if (k !== i && k !== prev) { sl.getAnimations().forEach(a => a.cancel()); sl.classList.remove('on'); }
  });
  const inc = SLIDES[i], out = SLIDES[prev];
  inc.getAnimations().forEach(a => a.cancel());
  out.getAnimations().forEach(a => a.cancel());
  inc.classList.add('on');

  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { out.classList.remove('on'); return; }
  const dir = i > prev ? 1 : -1, ease = 'cubic-bezier(.2,.7,.2,1)';
  inc.animate([{transform: `translateX(${dir * 70}px)`, opacity: 0}, {transform: 'none', opacity: 1}],
    {duration: ANIM_MS, easing: ease});
  const leave = out.animate([{transform: 'none', opacity: 1}, {transform: `translateX(${-dir * 70}px)`, opacity: 0}],
    {duration: ANIM_MS, easing: ease, fill: 'forwards'});
  leave.onfinish = () => { if (state.slide !== prev) out.classList.remove('on'); leave.cancel(); };
}
document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => go(+b.dataset.go));

async function api(url, opts){
  const r = await fetch(url, opts);
  let j = {};
  try { j = await r.json(); } catch (e) {}
  if (r.status === 401) { location.href = '/login'; throw new Error('Нужно войти в систему'); }
  if (!r.ok) throw new Error(j.error || 'Ошибка запроса');
  return j;
}

// верхнее меню: «История» и «Статистика» открываются, когда выбрана компания
function unlockNav(){
  document.querySelectorAll('[data-nav]').forEach(b => { b.disabled = false; b.title = ''; });
}
document.querySelectorAll('[data-nav]').forEach(b => b.onclick = () => {
  const i = +b.dataset.nav;
  if (i === 2) $('go-history').click();
  else if (i === 3) $('go-stats').click();
  else go(i);
});

$('logout').onclick = async () => {
  try { await fetch('/api/auth/logout', {method: 'POST'}); } catch (e) {}
  location.href = '/login';
};

// загрузка файла
$('pick').onclick = () => $('file').click();
$('file').onchange = async () => {
  const file = $('file').files[0];
  if (!file) return;
  const msg = $('upload-msg');
  msg.className = 'hint'; msg.textContent = 'Обрабатываем файл…';
  $('pick').disabled = true;

  const fd = new FormData(); fd.append('file', file);
  try {
    const j = await api('/api/upload', {method: 'POST', body: fd});
    $('company').innerHTML = j.companies.map(c => `<option>${c}</option>`).join('');
    state.company = $('company').value;
    $('file-info').textContent =
      `${j.operations.toLocaleString('ru-RU')} операций, ${j.date_from} — ${j.date_to}. ` + j.notes.join(' ');
    msg.textContent = '';
    unlockNav();
    loadOverview();
    go(1);
  } catch (e) {
    msg.className = 'hint err';
    msg.textContent = e instanceof TypeError
      ? 'Нет связи с сервером. Проверьте, что он запущен и страница открыта по адресу http://127.0.0.1:5000'
      : e.message;
  } finally {
    $('pick').disabled = false; $('file').value = '';
  }
};
$('company').onchange = e => { state.company = e.target.value; loadOverview(); };

// данные уже лежат в базе с прошлого раза
function openData(j){
  $('company').innerHTML = j.companies.map(c => `<option>${c}</option>`).join('');
  state.company = $('company').value;
  $('file-info').textContent =
    `${j.operations.toLocaleString('ru-RU')} операций, ${j.date_from} — ${j.date_to}.`;
  unlockNav();
  loadOverview();
  go(1);
}
// экран выбора: короткая сводка по выбранной компании прямо на карточках
let ovToken = 0;
const RISK_CHIP = {low: ['low', 'Разрыв маловероятен'], medium: ['medium', 'Есть заметный риск разрыва'], high: ['high', 'Высокий риск разрыва']};
function sparkSvg(v){
  const n = v.length, lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
  const pts = v.map((y, i) => [n > 1 ? i / (n - 1) * 300 : 150, 7 + (1 - (y - lo) / span) * 46]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  return `<defs><linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#d6143a" stop-opacity=".28"/><stop offset="1" stop-color="#d6143a" stop-opacity="0"/></linearGradient></defs>
    <path d="${line} L300 64 L0 64 Z" fill="url(#spark-fill)"/>
    <path d="${line}" fill="none" stroke="#d6143a" stroke-width="2.2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
}
async function loadOverview(){
  const my = ++ovToken, enc = encodeURIComponent(state.company);
  const clear = () => { ['mn-recent', 'mn-hist-foot', 'mn-trio', 'mn-stat-foot'].forEach(id => $(id).innerHTML = ''); $('mn-spark').innerHTML = ''; };
  try {
    const [o, f] = await Promise.all([
      api('/api/overview?company=' + enc),
      api('/api/forecast?company=' + enc + '&days=30').catch(() => null)]);
    if (my !== ovToken) return;
    $('mn-recent').innerHTML = o.recent.map(r => `<span class="rc-row"><span class="rc-date">${r.date}</span>
      <span class="rc-who">${esc(r.who)}</span><span class="rc-sum">−${rub(r.amount)}</span></span>`).join('');
    $('mn-hist-foot').innerHTML = `<b>${o.out_count.toLocaleString('ru-RU')}</b> ${o.out_count % 10 === 1 && o.out_count % 100 !== 11 ? 'списание' : 'списаний'} на <b>${rub(o.outcome)}</b>`;
    $('mn-spark').innerHTML = sparkSvg(o.spark);
    $('mn-trio').innerHTML = [['Поступления', o.income, 'in'], ['Списания', o.outcome, 'out'], ['Остаток', o.balance, '']]
      .map(([a, b, c]) => `<span class="kv ${c}"><small>${a}</small><b>${rub(b)}</b></span>`).join('');
    const chip = f && RISK_CHIP[f.level];
    $('mn-stat-foot').innerHTML = chip
      ? `<span class="chip ${chip[0]}">Прогноз на 30 дней: ${chip[1].toLowerCase()}</span>` : '';
  } catch (e) { if (my === ovToken) clear(); }
}

fetch('/api/state').then(r => r.json()).then(j => {
  if (!j.has_data) return;
  $('saved').hidden = false;
  $('saved').onclick = () => openData(j);
}).catch(() => {});

// история списаний
async function loadHistory(){
  const p = new URLSearchParams({
    company: state.company, page: state.page,
    q: $('q').value, category: $('cat').value
  });
  const j = await api('/api/history?' + p);
  state.page = j.page;
  document.querySelector('#s-history h2').textContent = 'История списаний, ' + state.company;

  const cat = $('cat'), cur = cat.value;
  cat.innerHTML = '<option value="">Все категории</option>' +
    j.categories.map(c => `<option>${c}</option>`).join('');
  cat.value = cur;

  $('h-sum').textContent = `${j.total.toLocaleString('ru-RU')} операций на ${rub(j.sum)}`;
  $('h-body').innerHTML = j.rows.length ? j.rows.map(r => `
    <tr><td>${r.date}</td><td>${esc(r.name) || '—'}</td><td><span class="tag">${r.category}</span></td>
    <td class="purpose">${esc(r.purpose) || '—'}</td><td>${r.inn || '—'}</td>
    <td class="num">−${rub(r.amount)}</td></tr>`).join('')
    : '<tr><td colspan="6">Ничего не найдено</td></tr>';
  $('page-info').textContent = `Страница ${j.page} из ${j.pages}`;
  $('prev').disabled = j.page <= 1;
  $('next').disabled = j.page >= j.pages;
}

$('go-history').onclick = () => {
  state.page = 1; $('q').value = ''; $('cat').value = '';
  loadHistory().then(() => go(2)).catch(e => alert(e.message));
};
$('prev').onclick = () => { state.page--; loadHistory(); };
$('next').onclick = () => { state.page++; loadHistory(); };
$('cat').onchange = () => { state.page = 1; loadHistory(); };
let t; $('q').oninput = () => { clearTimeout(t); t = setTimeout(() => { state.page = 1; loadHistory(); }, 300); };

// графики
function draw(id, config){
  if (state.charts[id]) state.charts[id].destroy();
  state.charts[id] = new Chart($(id), config);
}
function drop(id){
  if (state.charts[id]) { state.charts[id].destroy(); delete state.charts[id]; }
}
const money = {callbacks: {label: c => ` ${c.dataset.label || c.label}: ${rub(c.parsed.y ?? c.parsed)}`}};
const axisY = {ticks: {callback: v => new Intl.NumberFormat('ru-RU', {notation: 'compact'}).format(v)}};
const hideHidden = {labels: {filter: i => !i.text.startsWith('_')}};
const hideTip = {filter: i => !i.dataset.label.startsWith('_') && i.dataset.label !== 'Ноль',
  callbacks: {label: c => ` ${c.dataset.label}: ${rub(c.parsed.y)}`}};

const pctFmt = v => new Intl.NumberFormat('ru-RU', {maximumFractionDigits: v < 10 ? 1 : 0}).format(v) + '%';
// ---------- объёмные «бублики» ----------
// Кольцо нарисовано на canvas как наклонный цилиндр с полостью: верхняя грань, внешняя стенка спереди
// и внутренняя стенка сзади. Свет падает слева сверху, под кольцом лежит мягкая тень.
const TILT = .5, HOLE = .56, LIFT = 12;
const rgb = hex => { const n = parseInt(hex.slice(1), 16); return [n >> 16, n >> 8 & 255, n & 255]; };
function shade(hex, k){
  let [r, g, b] = rgb(hex);
  if (k < 1) { r *= k; g *= k; b *= k; }
  else { const t = k - 1; r += (255 - r) * t; g += (255 - g) * t; b += (255 - b) * t; }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}
// куски дуги [a0, a1], которые лежат на передней (sin > 0) или задней половине эллипса
function halves(a0, a1, front){
  const out = [];
  for (let k = Math.floor(a0 / Math.PI) - 1; k <= Math.ceil(a1 / Math.PI) + 1; k++) {
    if ((k % 2 === 0) !== front) continue;
    const s = Math.max(a0, k * Math.PI), e = Math.min(a1, (k + 1) * Math.PI);
    if (e - s > 1e-4) out.push([s, e]);
  }
  return out;
}

class Donut3D {
  constructor(host, d){
    this.host = host; this.labels = d.labels; this.values = d.values.map(Number);
    this.hidden = new Set(); this.hover = -1;
    this.pop = this.values.map(() => 0);
    this.shown = this.values.slice();
    this.grow = 0; this.t0 = performance.now(); this.raf = 0; this.w = 0; this.h = 0;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) this.grow = 1;

    host.innerHTML = '';
    this.stage = document.createElement('div'); this.stage.className = 'd3-stage';
    this.canvas = document.createElement('canvas'); this.stage.appendChild(this.canvas);
    this.tip = document.createElement('div'); this.tip.className = 'd3-tip'; this.tip.hidden = true;
    this.stage.appendChild(this.tip);
    this.legend = document.createElement('ul'); this.legend.className = 'd3-legend';
    host.append(this.stage, this.legend);
    this.ctx = this.canvas.getContext('2d');

    this.legend.innerHTML = this.labels.map((l, i) =>
      `<li data-i="${i}" tabindex="0" role="button" aria-pressed="true"><i style="background:${this.color(i)}"></i>
        <span>${esc(l)}</span><b></b></li>`).join('');
    this.legend.querySelectorAll('li').forEach(li => {
      const i = +li.dataset.i;
      li.onmouseenter = () => this.setHover(i);
      li.onmouseleave = () => this.setHover(-1);
      const toggle = () => this.toggle(i);
      li.onclick = toggle;
      li.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
    });
    this.canvas.onmousemove = e => this.onMove(e);
    this.canvas.onmouseleave = () => this.setHover(-1);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.stage);
    this.resize();
    this.updateLegend();
    this.kick();
  }
  color(i){ return PALETTE[i % PALETTE.length]; }
  total(){ return this.shown.reduce((a, b) => a + b, 0); }
  fullTotal(){ return this.values.reduce((a, b, i) => a + (this.hidden.has(i) ? 0 : b), 0); }

  resize(){
    const r = this.stage.getBoundingClientRect();
    const w = Math.round(r.width), h = Math.round(r.height);
    if (!w || !h || (w === this.w && h === this.h)) return;
    const dpr = window.devicePixelRatio || 1;
    this.w = w; this.h = h;
    this.canvas.width = w * dpr; this.canvas.height = h * dpr;
    this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
    this.dpr = dpr;
    this.R = Math.max(Math.min(w / 2 - LIFT - 6, (h - 26) / (2 * TILT + .17)), 40);
    this.D = this.R * .15;
    this.cx = w / 2;
    this.cy = (h - (2 * TILT * this.R + this.D)) / 2 + TILT * this.R - 3;
    this.draw();
  }
  toggle(i){
    this.hidden.has(i) ? this.hidden.delete(i) : this.hidden.add(i);
    if (this.hover === i && this.hidden.has(i)) this.hover = -1;
    this.updateLegend(); this.kick();
  }
  setHover(i){
    if (i === this.hover) return;
    this.hover = i; this.updateLegend();
    if (i < 0) this.tip.hidden = true;
    this.canvas.style.cursor = i >= 0 ? 'pointer' : '';
    this.kick();
  }
  updateLegend(){
    const full = this.fullTotal();
    this.legend.querySelectorAll('li').forEach(li => {
      const i = +li.dataset.i, off = this.hidden.has(i);
      li.classList.toggle('off', off);
      li.classList.toggle('hot', i === this.hover);
      li.setAttribute('aria-pressed', !off);
      li.querySelector('b').textContent = off || !full ? '—' : pctFmt(this.values[i] / full * 100);
    });
  }

  // геометрия секторов с учётом скрытых и вступительной анимации
  sectors(){
    const tot = this.total(); if (!tot) return [];
    const sweep = Math.PI * 2 * (1 - Math.pow(1 - this.grow, 3));
    let a = -Math.PI / 2;
    return this.shown.map((v, i) => {
      const da = v / tot * sweep, s = {i, a0: a, a1: a + da, mid: a + da / 2};
      a += da; return s;
    }).filter(s => s.a1 - s.a0 > 1e-4);
  }
  off(s){
    const p = this.pop[s.i];
    return {x: Math.cos(s.mid) * LIFT * p, y: Math.sin(s.mid) * LIFT * TILT * p - 8 * p};
  }

  onMove(e){
    const r = this.canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const i = this.hit(x, y);
    this.setHover(i);
    if (i >= 0) {
      const full = this.fullTotal();
      this.tip.textContent = `${this.labels[i]}: ${rub(this.values[i])} (${pctFmt(this.values[i] / full * 100)})`;
      this.tip.hidden = false;
      const tw = this.tip.offsetWidth;
      this.tip.style.left = Math.min(Math.max(x + 14, 4), Math.max(this.w - tw - 4, 4)) + 'px';
      this.tip.style.top = Math.max(y - 38, 2) + 'px';
    }
  }
  hit(x, y){
    const R = this.R, secs = this.sectors();
    // от верхних секторов к нижним: приподнятый сектор перекрывает соседей
    const order = secs.slice().sort((p, q) => (this.pop[p.i] - this.pop[q.i]) || 0).reverse();
    for (const s of order) {
      const o = this.off(s);
      for (const dy of [0, this.D * .5, this.D]) {            // верхняя грань и внешняя стенка
        const u = (x - this.cx - o.x) / R, v = (y - dy - this.cy - o.y) / (R * TILT);
        const rr = Math.hypot(u, v);
        if (rr > 1 || rr < HOLE) continue;
        if (dy && v < 0) continue;                              // стенка видна только спереди
        let a = Math.atan2(v, u); while (a < -Math.PI / 2) a += Math.PI * 2;
        let k = a; if (k < s.a0) k += Math.PI * 2;
        if (k >= s.a0 && k <= s.a1) return s.i;
      }
    }
    return -1;
  }

  kick(){ if (!this.raf) this.raf = requestAnimationFrame(() => this.tick()); }
  tick(){
    this.raf = 0;
    let busy = false;
    if (this.grow < 1) { this.grow = Math.min((performance.now() - this.t0) / 900, 1); busy = this.grow < 1; }
    this.pop.forEach((p, i) => {
      const t = i === this.hover ? 1 : 0, n = p + (t - p) * .22;
      this.pop[i] = Math.abs(n - t) < .01 ? t : n; if (this.pop[i] !== t) busy = true;
    });
    this.shown.forEach((v, i) => {
      const t = this.hidden.has(i) ? 0 : this.values[i], n = v + (t - v) * .2;
      this.shown[i] = Math.abs(n - t) < Math.max(t, this.values[i]) * .002 ? t : n; if (this.shown[i] !== t) busy = true;
    });
    this.draw();
    if (busy) this.kick();
  }

  draw(){
    if (!this.w) return;
    const c = this.ctx, {R, D, cx, cy} = this, ri = R * HOLE;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    const secs = this.sectors();
    if (!secs.length) return;

    // тень на «столе»
    c.save();
    c.translate(cx, cy + D * .8); c.scale(1, TILT);
    const g = c.createRadialGradient(0, 0, 0, 0, 0, R * 1.16);
    g.addColorStop(0, 'rgba(90,10,30,0)'); g.addColorStop(HOLE * .75 / 1.16, 'rgba(90,10,30,0)');
    g.addColorStop(.8, 'rgba(90,10,30,.2)'); g.addColorStop(1, 'rgba(90,10,30,0)');
    c.fillStyle = g; c.beginPath(); c.arc(0, 0, R * 1.16, 0, Math.PI * 2); c.fill();
    c.restore();

    const hot = secs.slice().sort((p, q) => this.pop[p.i] - this.pop[q.i]);   // приподнятые рисуем позже
    const ell = (x, y, rad, a, b, ccw) => c.ellipse(x, y, rad, rad * TILT, 0, a, b, ccw);

    // 1. внутренняя стенка сзади (видна сквозь отверстие)
    for (const s of hot) {
      const o = this.off(s), col = this.color(s.i);
      const gr = c.createLinearGradient(cx - ri, 0, cx + ri, 0);
      gr.addColorStop(0, shade(col, .58)); gr.addColorStop(1, shade(col, .84));
      for (const [a, b] of halves(s.a0, s.a1, false)) {
        c.beginPath();
        ell(cx + o.x, cy + o.y, ri, a, b, false);
        ell(cx + o.x, cy + o.y + D, ri, b, a, true);
        c.closePath(); c.fillStyle = gr; c.fill();
      }
    }
    // 2. внешняя стенка спереди
    for (const s of hot) {
      const o = this.off(s), col = this.color(s.i);
      const gr = c.createLinearGradient(cx - R, 0, cx + R, 0);
      gr.addColorStop(0, shade(col, .95)); gr.addColorStop(.45, shade(col, .8)); gr.addColorStop(1, shade(col, .5));
      for (const [a, b] of halves(s.a0, s.a1, true)) {
        c.beginPath();
        ell(cx + o.x, cy + o.y, R, a, b, false);
        ell(cx + o.x, cy + o.y + D, R, b, a, true);
        c.closePath(); c.fillStyle = gr; c.fill();
        c.strokeStyle = 'rgba(255,255,255,.28)'; c.lineWidth = 1; c.stroke();
      }
    }
    // 3. верхняя грань
    for (const s of hot) {
      const o = this.off(s), col = this.color(s.i);
      const gr = c.createLinearGradient(0, cy - R * TILT, 0, cy + R * TILT);
      gr.addColorStop(0, shade(col, 1.22)); gr.addColorStop(.55, shade(col, 1.02)); gr.addColorStop(1, shade(col, .9));
      c.beginPath();
      ell(cx + o.x, cy + o.y, R, s.a0, s.a1, false);
      ell(cx + o.x, cy + o.y, ri, s.a1, s.a0, true);
      c.closePath(); c.fillStyle = gr; c.fill();
      c.strokeStyle = 'rgba(255,255,255,.92)'; c.lineWidth = 1.6; c.lineJoin = 'round'; c.stroke();
    }
    // 4. проценты на верхней грани
    const full = this.total();
    c.font = '800 12px Manrope, system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    for (const s of hot) {
      const share = this.shown[s.i] / full * 100;
      if (share < 5 || this.grow < 1) continue;
      const o = this.off(s), rm = R * (1 + HOLE) / 2, txt = pctFmt(share);
      const x = cx + o.x + Math.cos(s.mid) * rm, y = cy + o.y + Math.sin(s.mid) * rm * TILT;
      c.lineWidth = 3; c.lineJoin = 'round'; c.strokeStyle = 'rgba(40,0,10,.35)'; c.strokeText(txt, x, y);
      c.fillStyle = '#fff'; c.fillText(txt, x, y);
    }
  }
  destroy(){ this.ro.disconnect(); cancelAnimationFrame(this.raf); this.host.innerHTML = ''; }
}

function donut(id, d){
  if (state.charts[id]) { state.charts[id].destroy(); delete state.charts[id]; }
  const host = $(id);
  if (!d.values.length || !d.values.some(v => v > 0)) { host.innerHTML = '<p class="hint">Данных пока нет.</p>'; return; }
  state.charts[id] = new Donut3D(host, d);
}

// обычная статистика
async function loadStats(){
  const j = await api('/api/stats?company=' + encodeURIComponent(state.company));
  document.querySelector('#s-stats h2').textContent = 'Полная статистика, ' + state.company;
  const k = j.kpi;
  $('kpis').innerHTML = [
    ['Поступления', rub(k.income)], ['Списания', rub(k.outcome)],
    ['Остаток на конец периода', rub(k.balance)], ['Операций', k.operations.toLocaleString('ru-RU')]
  ].map(([a, b]) => `<div class="kpi"><small>${a}</small><div>${b}</div></div>`).join('');

  draw('ch-monthly', {type: 'bar',
    data: {labels: j.monthly.labels, datasets: [
      {label: 'Поступления', data: j.monthly.income, backgroundColor: '#0fa968', borderRadius: 4},
      {label: 'Списания', data: j.monthly.outcome, backgroundColor: '#d6143a', borderRadius: 4}]},
    options: {plugins: {tooltip: money}, scales: {y: axisY}}});

  donut('ch-out', j.outcome_cat);
  donut('ch-in', j.income_cat);

  const top = j.income_top || [];
  $('top-payers').innerHTML = top.length ? top.map(t => `<div class="payer">
      <div class="payer-top"><span title="${esc(t.name)}">${esc(t.name)}</span><span>${rub(t.sum)}</span></div>
      <div class="payer-bar"><i style="width:${Math.max(t.share, 2).toFixed(1)}%"></i></div>
      <small>${pctFmt(t.share)} всех поступлений · операций: ${t.count.toLocaleString('ru-RU')}</small></div>`).join('')
    : '<p class="hint">Поступлений пока нет.</p>';
  const lead = top[0];
  $('top-note').textContent = !lead ? '' : lead.share >= 50
    ? `На «${lead.name}» приходится больше половины выручки: если этот клиент задержит оплату, денег может не хватить.`
    : `Всего плательщиков: ${j.income_clients}. Чем больше доля одного клиента, тем сильнее вы от него зависите.`;

  draw('ch-balance', {type: 'line',
    data: {labels: j.balance.labels, datasets: [{label: 'Остаток', data: j.balance.values,
      borderColor: '#d6143a', backgroundColor: 'rgba(214,20,58,.12)', fill: true, pointRadius: 0, tension: .2}]},
    options: {plugins: {legend: {display: false}, tooltip: money},
      scales: {y: axisY, x: {ticks: {maxTicksLimit: 8}}}}});
}

// прогноз
function riskText(j, withAdvice){
  const r = j.risk;
  const n = j.days.length;
  if (j.level === 'low') {
    return {title: `Кассовый разрыв в ближайшие ${n} ${dayWord(n)} маловероятен`,
      body: `<p>Вероятность нехватки денег: ${fmtPct(r.probability)}.</p>
             <p>Самый низкий ожидаемый остаток — ${rub(j.lowest.value)} (${fmtDay(j.lowest.date)}).</p>`};
  }
  const bold = s => `<b style="display:inline;font-size:inherit">${s}</b>`;
  return {
    title: j.level === 'high' ? 'Высокий риск: денег может не хватить' : 'Есть заметный риск нехватки денег',
    body: `<p>Вероятность разрыва: ${bold(fmtPct(r.probability))}.</p>
      <p>Скорее всего это случится ${bold(fmtDay(r.date))}`
      + (r.date_early && r.date_early !== r.date ? ` (в плохом случае уже ${fmtDay(r.date_early)})` : '') + `.</p>
      <p>Не хватит около ${bold(rub(r.shortfall))}, в неблагоприятном случае до ${rub(r.shortfall_worst)}.</p>`
      + (withAdvice ? '<p>Конкретные меры и их эффект — в блоке «Что делать» ниже.</p>' : '')
  };
}

function bandDatasets(days, color, name, prefix){
  return [
    {label: `_${prefix}lo`, data: days.map(d => d.p10), borderWidth: 0, pointRadius: 0, fill: false},
    {label: `_${prefix}hi`, data: days.map(d => d.p90), borderWidth: 0, pointRadius: 0,
      backgroundColor: color.replace('1)', '.14)'), fill: '-1'},
  ];
}

async function runForecast(){
  const msg = $('f-msg'), box = $('verdict');
  msg.className = 'hint'; msg.textContent = 'Считаем прогноз…';
  try {
    const j = await api('/api/forecast?company=' + encodeURIComponent(state.company) + '&days=' + state.days);
    msg.textContent = '';

    const ov = $('overdue');
    if (j.overdue.length) {
      ov.innerHTML = `<b>Не пришли в срок: ${j.overdue.length}</b><ul>` + j.overdue.map(o =>
        `<li>Ждали ${fmtDay(o.expected)} (опаздывает на ${o.days_late} дн.): ${esc(o.title)}, ${rub(o.amount)}
         (${o.direction === 'Поступление' ? 'поступление' : 'платёж'}, источник: ${esc(o.source)})</li>`).join('')
        + '</ul><p>Прогноз и риск разрыва уже пересчитаны с учётом этих задержек.</p>';
      ov.hidden = false;
    } else ov.hidden = true;

    const rt = riskText(j, true);
    box.className = 'verdict ' + j.level;
    box.innerHTML = `<b>${rt.title}</b>${rt.body}`;
    box.hidden = false;

    draw('ch-forecast', {type: 'line',
      data: {labels: j.days.map(d => fmtShort(d.date)), datasets: [
        ...bandDatasets(j.days, BURGUNDY, '', 'b'),
        {label: 'Ожидаемый остаток', data: j.days.map(d => d.p50), borderColor: '#d6143a', borderWidth: 3, pointRadius: 0, fill: false},
        {label: 'Ноль', data: j.days.map(() => 0), borderColor: '#7a6569', borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0, fill: false}]},
      options: {interaction: {mode: 'index', intersect: false},
        plugins: {legend: hideHidden, tooltip: hideTip},
        scales: {y: axisY, x: {ticks: {maxTicksLimit: 10}}}}});

    $('f-upcoming').innerHTML = j.upcoming.length ? j.upcoming.map(u => {
      const inn = u.direction === 'Поступление';
      return `<tr><td>${fmtDay(u.date)}</td><td>${esc(u.title)}</td><td class="src">${esc(u.source)}</td>
        <td class="num"><span style="color:${inn ? '#0fa968' : '#e8261a'}">${inn ? '+' : '−'}${rub(u.amount)}</span></td></tr>`;
    }).join('') : '<tr><td colspan="4">Известных платежей на выбранный период не найдено</td></tr>';

    $('f-notes').innerHTML = j.notes.map(n => `<li>${esc(n)}</li>`).join('');
  } catch (e) {
    msg.className = 'hint err'; msg.textContent = e.message;
    box.hidden = true; $('overdue').hidden = true; drop('ch-forecast');
  }
}

// что делать: меры проверены той же симуляцией + запас прочности
async function loadAdvice(){
  const head = $('adv-head'), note = $('adv-note');
  try {
    const j = await api('/api/advice?company=' + encodeURIComponent(state.company) + '&days=' + state.days);
    note.textContent = '';
    const levers = $('adv-levers'), stress = $('adv-stress');
    if (j.safe) {
      head.className = 'verdict low';
      head.innerHTML = `<b>Сейчас всё в безопасной зоне</b><p>Вероятность разрыва: ${fmtPct(j.probability)}. Ниже — насколько ситуация может ухудшиться, прежде чем появится риск.</p>`;
      levers.hidden = true;
      const t = j.tolerance, tiles = [];
      const lim = (v, step) => v === 0 ? `уже при небольшом ухудшении (${step}) риск станет заметным` : null;
      tiles.push(`<div class="verdict ${t.revenue_drop >= 20 ? 'low' : 'medium'}"><small>Падение выручки</small><b>${t.revenue_drop ? 'до ' + t.revenue_drop + '%' : 'почти нет запаса'}</b>
        <p>${t.revenue_drop ? `Даже если выручка просядет на ${t.revenue_drop}%, риск останется в пределах нормы.` : 'При падении выручки на 10% риск разрыва уже выйдет за безопасный порог.'}</p></div>`);
      if (t.client_delay !== undefined) {
        const nm = j.big_client ? esc(String(j.big_client.name)) : 'крупного клиента';
        tiles.push(`<div class="verdict ${t.client_delay >= 14 ? 'low' : 'medium'}"><small>Задержка оплаты от ${nm}</small><b>${t.client_delay ? 'до ' + t.client_delay + ' ' + dayWord(t.client_delay) : 'почти нет запаса'}</b>
          <p>${t.client_delay ? `Если самый крупный клиент заплатит на ${t.client_delay} ${dayWord(t.client_delay)} позже, денег всё равно хватит.` : 'Даже недельная задержка крупного клиента выведет риск за безопасный порог.'}</p></div>`);
      }
      stress.innerHTML = tiles.join(''); stress.hidden = false;
      note.textContent = 'Безопасной считаем зону, где разрыв возможен не чаще чем в 1 случае из 10.';
    } else {
      const cls = j.probability >= 0.4 ? 'high' : 'medium';
      head.className = 'verdict ' + cls;
      head.innerHTML = `<b>Риск выше нормы: ${fmtPct(j.probability)}</b>
        <p>Чтобы снизить вероятность разрыва до безопасных ${fmtPct(j.target)}, нужен резерв около <b style="display:inline;font-size:inherit">${rub(j.reserve)}</b> — либо меры из таблицы.</p>`;
      $('adv-body').innerHTML = j.levers.map(l => `<tr><td><b>${esc(l.title)}</b><br><span class="src">${esc(l.detail)}</span></td>
        <td class="num">${fmtPct(j.probability)}</td><td class="num"><b>${fmtPct(l.prob_after)}</b></td>
        <td>${l.enough ? '✔ да' : 'не хватит одной меры'}</td></tr>`).join('');
      levers.hidden = false; stress.hidden = true;
      note.textContent = 'Эффект каждой меры посчитан повторной симуляцией с теми же случайными числами, поэтому разница — это именно действие меры.';
    }
    head.hidden = false;
  } catch (e) {
    head.hidden = true; $('adv-levers').hidden = true; $('adv-stress').hidden = true;
    note.textContent = e.message;
  }
}

// данные для прогноза: ручной ввод, файлы, список
async function loadPlan(){
  const j = await api('/api/plan?company=' + encodeURIComponent(state.company));
  if (!$('p-source').options.length) {
    $('p-source').innerHTML = j.sources.map(s => `<option>${s}</option>`).join('');
  }
  $('p-body').innerHTML = j.items.length ? j.items.map(i => {
    const inn = i.direction === 'Поступление';
    return `<tr><td>${fmtDay(i.date)}</td><td>${esc(i.title)}</td><td>${esc(i.kind)}</td>
      <td class="src">${esc(i.source)}</td>
      <td class="num"><span style="color:${inn ? '#0fa968' : '#e8261a'}">${inn ? '+' : '−'}${rub(i.amount)}</span></td>
      <td><button class="btn small" data-del="${i.id}">Убрать</button></td></tr>`;
  }).join('') : '<tr><td colspan="6">Пока ничего не добавлено</td></tr>';
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    await api('/api/plan/' + b.dataset.del, {method: 'DELETE'});
    refreshAll();
  });
}

$('m-add').onclick = async () => {
  const m = $('p-msg');
  try {
    await api('/api/plan/add', {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({company_id: state.company, date: $('m-date').value, amount: $('m-amount').value,
        direction: $('m-dir').value, description: $('m-desc').value})});
    $('m-amount').value = ''; $('m-desc').value = '';
    m.className = 'hint'; m.textContent = 'Событие добавлено, прогноз пересчитан.';
    refreshAll();
  } catch (e) { m.className = 'hint err'; m.textContent = e.message; }
};

$('p-pick').onclick = () => $('p-file').click();
$('p-file').onchange = async () => {
  const f = $('p-file').files[0];
  if (!f) return;
  const m = $('p-msg'); m.className = 'hint'; m.textContent = 'Загружаем…';
  const fd = new FormData(); fd.append('file', f); fd.append('source', $('p-source').value);
  try {
    const j = await api('/api/plan/upload', {method: 'POST', body: fd});
    m.textContent = `Добавлено событий: ${j.added} (источник: ${j.source}). Прогноз пересчитан.`;
    refreshAll();
  } catch (e) { m.className = 'hint err'; m.textContent = e.message; }
  finally { $('p-file').value = ''; }
};

// сценарии «что если»
async function runScenario(){
  const msg = $('sc-msg'); msg.textContent = '';
  const p = new URLSearchParams({company: state.company, days: state.days, client_delay: $('sc-delay').value,
    revenue_drop: $('sc-drop').value, cost_growth: $('sc-growth').value,
    extra: $('sc-extra').value || 0, extra_day: $('sc-extra-day').value || 1});
  const set = ['sc-delay', 'sc-drop', 'sc-growth', 'sc-extra'].some(id => +$(id).value > 0);
  if (!set) { msg.textContent = 'Выберите хотя бы одно неблагоприятное событие.'; $('sc-result').hidden = true; return; }
  try {
    const j = await api('/api/scenario?' + p);
    const b = riskText(j.base, false), s = riskText(j.scenario, false);
    $('sc-cards').innerHTML =
      `<div class="verdict ${j.base.level}"><small>Сейчас</small><b>${b.title}</b>${b.body}</div>
       <div class="verdict ${j.scenario.level}"><small>Если это случится</small><b>${s.title}</b>${s.body}</div>`;

    draw('ch-scenario', {type: 'line',
      data: {labels: j.base.days.map(d => fmtShort(d.date)), datasets: [
        ...bandDatasets(j.base.days, BURGUNDY, '', 'b'),
        ...bandDatasets(j.scenario.days, AMBER, '', 's'),
        {label: 'Сейчас', data: j.base.days.map(d => d.p50), borderColor: '#d6143a', borderWidth: 3, pointRadius: 0, fill: false},
        {label: 'Если это случится', data: j.scenario.days.map(d => d.p50), borderColor: '#ff8c00', borderWidth: 3, pointRadius: 0, fill: false},
        {label: 'Ноль', data: j.base.days.map(() => 0), borderColor: '#7a6569', borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0, fill: false}]},
      options: {interaction: {mode: 'index', intersect: false},
        plugins: {legend: hideHidden, tooltip: hideTip},
        scales: {y: axisY, x: {ticks: {maxTicksLimit: 10}}}}});

    const bc = j.base.big_client;
    $('sc-note').textContent = (+$('sc-delay').value > 0 && bc)
      ? `Крупный клиент по вашей истории: ${bc.name}.` : '';
    $('sc-result').hidden = false;
  } catch (e) { msg.textContent = e.message; $('sc-result').hidden = true; }
}
$('sc-run').onclick = runScenario;

// план-факт
async function loadPlanFact(){
  const text = $('pf-text');
  try {
    const j = await api('/api/planfact?company=' + encodeURIComponent(state.company));
    const days = j.days;
    text.textContent = `Прогноз, построенный на ${fmtDay(j.cutoff)}, сравнили с тем, что произошло на самом деле. `
      + `Факт попал в ожидаемый диапазон в ${j.inside} из ${j.total} дней.`;
    draw('ch-planfact', {type: 'line',
      data: {labels: days.map(d => fmtShort(d.date)), datasets: [
        ...bandDatasets(days, BURGUNDY, '', 'b'),
        {label: 'План', data: days.map(d => d.p50), borderColor: '#d6143a', borderWidth: 2, pointRadius: 0, fill: false},
        {label: 'Факт', data: days.map(d => d.fact), borderColor: '#2b1519', borderWidth: 3, pointRadius: 0, fill: false},
        {label: 'Отклонение', data: days.map(d => d.outside ? d.fact : null), showLine: false,
          pointRadius: 6, pointBackgroundColor: '#ff8c00', borderColor: '#ff8c00', fill: false}]},
      options: {interaction: {mode: 'index', intersect: false},
        plugins: {legend: hideHidden, tooltip: hideTip},
        scales: {y: axisY, x: {ticks: {maxTicksLimit: 10}}}}});

    const cell = (v, bad) => `<td class="num ${bad ? 'bad' : ''}">${rub(v)}</td>`;
    $('pf-weeks').innerHTML = j.weeks.map(w => `<tr><td>${fmtShort(w.from)} — ${fmtShort(w.to)}</td>
      ${cell(w.plan_in, false)}${cell(w.fact_in, w.flag_in)}${cell(w.plan_out, false)}${cell(w.fact_out, w.flag_out)}</tr>`).join('');
  } catch (e) {
    text.textContent = e.message;
    drop('ch-planfact'); $('pf-weeks').innerHTML = '';
  }
}

function syncPeriodUI(){
  $('f-title').textContent = `Прогноз на ${state.days} ${dayWord(state.days)}`;
  document.querySelectorAll('#period-seg .seg-btn').forEach(b => b.classList.toggle('active', +b.dataset.days === state.days));
  $('period-custom').value = state.days;
  $('sc-extra-day').max = state.days;
}
function setPeriod(n){
  n = Math.round(+n);
  if (!Number.isFinite(n)) n = MIN_DAYS;
  const clamped = Math.min(Math.max(n, MIN_DAYS), MAX_DAYS);
  $('f-msg').className = 'hint';
  state.days = clamped;
  syncPeriodUI();
  const ex = $('sc-extra-day'); if (+ex.value > clamped) ex.value = clamped;
  return refreshAll().then(() => {
    if (clamped !== n) { $('f-msg').className = 'hint'; $('f-msg').textContent = `Срок можно выбрать от ${MIN_DAYS} до ${MAX_DAYS} дней, поставили ${clamped}.`; }
  });
}
document.querySelectorAll('#period-seg .seg-btn').forEach(b => b.onclick = () => setPeriod(b.dataset.days));
$('period-apply').onclick = () => setPeriod($('period-custom').value);
$('period-custom').onkeydown = e => { if (e.key === 'Enter') setPeriod($('period-custom').value); };

function refreshAll(){
  if (!$('sc-result').hidden) runScenario();
  return Promise.all([runForecast(), loadAdvice(), loadPlan(), loadPlanFact()]);
}

$('go-stats').onclick = () => {
  $('sc-result').hidden = true; $('sc-msg').textContent = ''; $('p-msg').textContent = '';
  syncPeriodUI();
  Promise.all([loadStats(), refreshAll()]).then(() => go(3)).catch(e => alert(e.message));
};



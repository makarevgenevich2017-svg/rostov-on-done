/**
 * Полный браузерный порт Python-бэкенда (app.py, forecast.py, pipeline.py,
 * step2_categorize.py, step3_regularity.py, plan_events.py, db.py) для GitHub Pages.
 */
(function () {
  const IN = 'Поступление', OUT = 'Списание';
  const LOOKBACK_DAYS = 180, OVERDUE_DAYS = 3, PLAN_MATCH = 0.10, SAFE_PROB = 0.10;
  const SKIP_CATEGORIES = new Set(['Перевод собственных средств']);
  const COST_CATEGORIES = new Set(['Аренда', 'Закупки/Поставщики']);
  const QUARTER_MONTHS = new Set([1, 4, 7, 10]);
  const SOURCES = ['Банк', '1С', 'ЭДО', 'Онлайн-касса', 'Маркетплейс', 'Другое'];

  const TEMPLATE_OPS_CSV =
    "company_id;operation_date;amount;direction;payment_purpose;counterparty_inn;balance_eod\n" +
    "C001;2026-09-01;250000;Поступление;Оплата по счету № 101 за услуги;7701234567;1250000\n" +
    "C001;2026-09-03;85000;Списание;Оплата по договору аренды помещения за сентябрь;7709876543;1165000\n" +
    "C001;2026-09-05;120000;Списание;Выплата заработной платы за август;;1045000\n" +
    "C001;2026-09-10;60000;Списание;Оплата за товар по счету поставщика № 55;5001112223;985000\n" +
    "C001;2026-09-15;180000;Поступление;Поступление по картам (эквайринг);;1165000\n" +
    "C001;2026-09-28;40000;Списание;Единый налоговый платеж;7727406020;1125000\n";

  const TEMPLATE_PLAN_CSV =
    "company_id;type;direction;amount;issue_date;due_date;payment_term_days;description;probability;parts;interval_days;prepay_percent;deferral_days\n" +
    "C001;счет;Поступление;150000;2026-09-25;2026-10-05;;Оплата счета № 123;80;;;;\n" +
    "C001;счет;Списание;45000;2026-09-28;;14;Счет поставщика за запчасти;100;;;;\n" +
    "C001;налог;Списание;256000;;2026-10-28;;Единый налоговый платеж;100;;;;\n" +
    "C001;договор;Поступление;900000;;2026-10-10;;Договор с ООО Ромашка;85;3;30;30;14\n" +
    "C001;кредит;Списание;120000;;2026-10-15;;Платеж по кредиту (график банка);100;;;;\n";

  // Настройка кнопок скачивания шаблонов для статического хостинга
// Настройка кнопок скачивания шаблонов для статического хостинга
  window.addEventListener('DOMContentLoaded', () => {
    const tPlan = document.getElementById('plan-template-link');
    if (tPlan) {
      const blob = new Blob(['\ufeff' + TEMPLATE_PLAN_CSV], { type: 'text/csv;charset=utf-8' });
      tPlan.href = URL.createObjectURL(blob);
    }
  });

  // --- Утилиты дат (UTC полночь) ---
  const MS_DAY = 86400000;
  function parseDate(s) {
    if (!s) return NaN;
    s = String(s).trim();
    if (!s || s === 'nan' || s === 'NaT') return NaN;
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
    m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
    if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
    const d = new Date(s);
    return isNaN(d) ? NaN : Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  }
  function fmtISO(ms) {
    const d = new Date(ms);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  function fmtRU(ms) {
    const d = new Date(ms);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${day}.${m}.${y}`;
  }
  function fmtShortRU(ms) {
    return fmtRU(ms).slice(0, 5);
  }
  function fmtYM(ms) {
    return fmtISO(ms).slice(0, 7);
  }
  function weekdayPy(ms) {
    // В Python Monday=0 .. Sunday=6
    const jsDay = new Date(ms).getUTCDay();
    return (jsDay + 6) % 7;
  }
  function diffDays(a, b) {
    return Math.round((a - b) / MS_DAY);
  }

  // --- Хранилище IndexedDB (замена SQLite) ---
  const DB_NAME = 'proekt_rostov_db_v1';
  let MEM_OPS = null;
  let MEM_PLAN = [];

  function openIDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbGet(key) {
    try {
      const db = await openIDB();
      return await new Promise((res, rej) => {
        const tx = db.transaction('kv', 'readonly').objectStore('kv').get(key);
        tx.onsuccess = () => res(tx.result);
        tx.onerror = () => rej(tx.error);
      });
    } catch (e) { return null; }
  }
  async function idbSet(key, val) {
    try {
      const db = await openIDB();
      return await new Promise((res, rej) => {
        const tx = db.transaction('kv', 'readwrite').objectStore('kv').put(val, key);
        tx.onsuccess = () => res();
        tx.onerror = () => rej(tx.error);
      });
    } catch (e) {}
  }

  const initReady = (async () => {
    const savedOps = await idbGet('ops');
    const savedPlan = await idbGet('plan');
    if (savedOps && Array.isArray(savedOps) && savedOps.length) MEM_OPS = savedOps;
    if (savedPlan && Array.isArray(savedPlan)) MEM_PLAN = savedPlan;
  })();

  // --- CSV Парсер (автоопределение ; , \t) ---
  function parseCSV(text) {
    text = text.replace(/^\ufeff/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const firstLine = text.split('\n')[0] || '';
    const sep = firstLine.includes(';') ? ';' : firstLine.includes('\t') ? '\t' : ',';
    const lines = [];
    let cur = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else {
        if (c === '"') inQuotes = true;
        else if (c === sep) { cur.push(field.trim()); field = ''; }
        else if (c === '\n') {
          cur.push(field.trim()); field = '';
          if (cur.some(x => x !== '')) lines.push(cur);
          cur = [];
        } else field += c;
      }
    }
    if (field || cur.length) {
      cur.push(field.trim());
      if (cur.some(x => x !== '')) lines.push(cur);
    }
    if (!lines.length) return { headers: [], rows: [] };
    const headers = lines[0].map(h => h.trim());
    const rows = lines.slice(1).map(r => {
      const obj = {};
      headers.forEach((h, idx) => obj[h] = r[idx] !== undefined ? r[idx] : '');
      return obj;
    });
    return { headers, rows };
  }

  function parseNum(v, def = null) {
    if (v === null || v === undefined) return def;
    const s = String(v).replace(/\u00a0/g, '').replace(/\s+/g, '').replace(',', '.').trim();
    if (!s || s === 'nan') return def;
    const n = Number(s);
    return Number.isFinite(n) ? n : def;
  }

  // --- step2_categorize.py ---
  const RULES = [
    ['Перевод собственных средств', /перевод собственных|собственных средств/i, null],
    ['Налоги', /(?:^|[^а-яёa-z0-9_])енп(?:$|[^а-яёa-z0-9_])|единый налоговый|налог|ндфл|страховые взнос|взносы на|(?:^|[^а-яёa-z0-9_])усн(?:$|[^а-яёa-z0-9_])|штраф|(?:^|[^а-яёa-z0-9_])пени(?:$|[^а-яёa-z0-9_])/i, OUT],
    ['Зарплата', /зарплат|заработн|аванс|отпускн|больничн|оплата труда/i, OUT],
    ['Аренда', /аренд|помещени|недвижим/i, OUT],
    ['Кредиты/Лизинг', /кредит|лизинг|займ|процент|гашение|основной долг/i, null],
    ['Выручка (Эквайринг)', /эквайринг|поступление по картам|(?:^|[^а-яёa-z0-9_])сбп(?:$|[^а-яёa-z0-9_])/i, IN],
    ['Выручка (Безнал)', /оплата по счету|оплата по договору|оплата по упд|поступление|оплата за товар|за услуги/i, IN],
    ['Банковские комиссии', /комисси|ведение счета|обслуживание счета/i, OUT],
    ['Закупки/Поставщики', /поставк|поставщик|закупк|товар|материал|сырье|запчаст|ремонт|оплата по |оплата за |услуг/i, OUT],
  ];

  function categorizeOperations(rows) {
    for (const r of rows) {
      const p = String(r.payment_purpose || '').toLowerCase();
      let cat = 'Не определено';
      for (const [cName, regex, dir] of RULES) {
        if (dir && r.direction !== dir) continue;
        if (regex.test(p)) { cat = cName; break; }
      }
      if (cat === 'Не определено') {
        cat = r.direction === IN ? 'Выручка (Прочее)' : 'Прочие расходы';
      }
      r.category = cat;
    }
    return rows;
  }

  // --- Математика и статистика ---
  function median(arr) {
    if (!arr.length) return 0;
    const s = Float64Array.from(arr).sort();
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }
  function sampleStd(arr) {
    if (arr.length < 2) return 0;
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    const v = arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1);
    return Math.sqrt(v);
  }
  function percentile(sortedArr, p) {
    if (!sortedArr.length) return 0;
    const pos = (sortedArr.length - 1) * (p / 100);
    const base = Math.floor(pos), rest = pos - base;
    return sortedArr[base + 1] !== undefined
      ? sortedArr[base] + rest * (sortedArr[base + 1] - sortedArr[base])
      : sortedArr[base];
  }

  // --- step3_regularity.py ---
  function detectRegularPayments(ops) {
    const groups = new Map();
    for (const r of ops) {
      const inn = String(r.counterparty_inn || '').trim();
      if (!inn) continue;
      const key = `${r.company_id}|||${inn}|||${r.direction}|||${r.category}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const events = [];
    for (const [key, grp] of groups.entries()) {
      if (grp.length < 3) continue;
      grp.sort((a, b) => a.operation_date - b.operation_date);
      const diffs = [];
      for (let i = 1; i < grp.length; i++) {
        diffs.push(diffDays(grp[i].operation_date, grp[i - 1].operation_date));
      }
      if (!diffs.length) continue;
      const medDiff = median(diffs);
      if ((medDiff >= 25 && medDiff <= 35) || (medDiff >= 12 && medDiff <= 16)) {
        if (sampleStd(diffs) < 5) {
          const [company_id, counterparty_inn, direction, category] = key.split('|||');
          const lastOp = grp[grp.length - 1];
          events.push({
            company_id, counterparty_inn, direction, category,
            median_amount: median(grp.map(x => x.amount)),
            interval_days: medDiff,
            last_date: lastOp.operation_date,
            predicted_next_date: lastOp.operation_date + Math.round(medDiff) * MS_DAY,
            source: 'detected_regular'
          });
        }
      }
    }
    return events;
  }

  // --- pipeline.py ---
  function runPipeline(csvText) {
    const notes = [];
    const { headers, rows } = parseCSV(csvText);
    const req = ['company_id', 'operation_date', 'amount', 'direction', 'payment_purpose', 'counterparty_inn'];
    const missing = req.filter(c => !headers.includes(c));
    if (missing.length) {
      throw new Error('В файле не хватает колонок: ' + missing.sort().join(', '));
    }

    const seen = new Set();
    let clean = [];
    for (let idx = 0; idx < rows.length; idx++) {
      const r = rows[idx];
      const dt = parseDate(r.operation_date);
      const amt = parseNum(r.amount);
      if (isNaN(dt) || amt === null) continue;
      const item = {
        company_id: String(r.company_id).trim(),
        operation_date: dt,
        amount: amt,
        direction: String(r.direction).trim(),
        payment_purpose: String(r.payment_purpose || ''),
        counterparty_inn: String(r.counterparty_inn || '').trim(),
        counterparty_name: r.counterparty_name ? String(r.counterparty_name).trim() : '',
        operation_id: r.operation_id !== undefined ? r.operation_id : idx,
        balance_eod: r.balance_eod !== undefined && r.balance_eod !== '' ? parseNum(r.balance_eod) : null
      };
      const sig = `${item.company_id}|${item.operation_date}|${item.amount}|${item.direction}|${item.payment_purpose}|${item.counterparty_inn}|${item.balance_eod}`;
      if (!seen.has(sig)) {
        seen.add(sig);
        clean.push(item);
      }
    }

    clean.sort((a, b) => {
      if (a.company_id !== b.company_id) return a.company_id.localeCompare(b.company_id);
      if (a.operation_date !== b.operation_date) return a.operation_date - b.operation_date;
      return String(a.operation_id).localeCompare(String(b.operation_id));
    });

    const hasBalance = headers.includes('balance_eod') && clean.every(x => x.balance_eod !== null);
    if (!hasBalance) {
      const sums = {};
      for (const r of clean) {
        sums[r.company_id] = (sums[r.company_id] || 0) + (r.direction === IN ? r.amount : -r.amount);
        r.balance_eod = sums[r.company_id];
      }
      notes.push('В файле нет колонки balance_eod, остаток посчитан от нуля и может отличаться от реального.');
    }

    categorizeOperations(clean);
    return { ops: clean, notes };
  }

  // --- plan_events.py ---
  function detectKind(text) {
    const t = String(text || '').toLowerCase();
    for (const [k, name] of [['налог', 'налог'], ['договор', 'договор'], ['кредит', 'кредит'], ['зарплат', 'зарплата'], ['поруч', 'платёжное поручение']]) {
      if (t.includes(k)) return name;
    }
    return 'счёт';
  }
  function parseProb(v) {
    const p = parseNum(v, null);
    if (p === null) return null;
    return p > 1 ? p / 100 : p;
  }
  function parsePlanFile(csvText, source) {
    const { headers, rows } = parseCSV(csvText);
    const missing = ['amount', 'direction'].filter(c => !headers.includes(c));
    if (missing.length) throw new Error('В файле не хватает колонок: ' + missing.join(', '));
    if (!headers.includes('due_date') && !(headers.includes('issue_date') && headers.includes('payment_term_days'))) {
      throw new Error('Нужна колонка due_date (срок оплаты) или пара issue_date + payment_term_days');
    }
    const out = [];
    rows.forEach((r, idx) => {
      const n = idx + 2;
      try {
        const direction = String(r.direction || '').trim();
        if (direction !== IN && direction !== OUT) throw new Error('direction должен быть «Поступление» или «Списание»');
        const amount = parseNum(r.amount);
        if (amount === null || amount <= 0) throw new Error('не указана сумма');
        let due = parseDate(r.due_date);
        if (isNaN(due)) {
          const issue = parseDate(r.issue_date);
          const term = parseNum(r.payment_term_days, 0);
          if (isNaN(issue)) throw new Error('не указан срок оплаты');
          due = issue + Math.round(term) * MS_DAY;
        }
        const kind = detectKind(r.type);
        const company = r.company_id && String(r.company_id).trim() ? String(r.company_id).trim() : null;
        const desc = r.description ? String(r.description).trim() : '';
        const prob = parseProb(r.probability);
        const base = { company_id: company, direction, probability: prob, source };

        if (kind === 'договор') {
          const parts = Math.max(Math.round(parseNum(r.parts, 1)), 1);
          const interval = Math.round(parseNum(r.interval_days, 30));
          const prepay = (parseNum(r.prepay_percent, 0) || 0) / 100;
          const deferral = Math.round(parseNum(r.deferral_days, 0));
          const title = desc || 'Договор';
          if (prepay > 0) {
            out.push({ ...base, id: Date.now() + Math.random(), kind, date: due, amount: amount * prepay, description: `${title}: предоплата` });
          }
          const rest = amount * (1 - prepay);
          const first = due + deferral * MS_DAY;
          for (let i = 0; i < parts; i++) {
            out.push({ ...base, id: Date.now() + Math.random(), kind, date: first + interval * i * MS_DAY, amount: rest / parts, description: `${title}: платёж ${i + 1} из ${parts}` });
          }
        } else {
          out.push({ ...base, id: Date.now() + Math.random(), kind, date: due, amount, description: desc || (kind.charAt(0).toUpperCase() + kind.slice(1)) });
        }
      } catch (e) {
        throw new Error(`Строка ${n}: ${e.message}`);
      }
    });
    return out;
  }

  // --- Детерминированный ГСЧ (Mulberry32 + Box-Muller) для совпадения seed в forecast.py ---
  function createRNG(seed = 7) {
    let s = seed >>> 0;
    function random() {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    function normal(mean = 0, sd = 1) {
      const u1 = Math.max(random(), 1e-12);
      const u2 = random();
      return mean + sd * Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    }
    function integers(low, high) {
      return low + Math.floor(random() * (high - low));
    }
    return { random, normal, integers };
  }

  function taxDates(startMs, endMs) {
    const out = [];
    const dStart = new Date(startMs), dEnd = new Date(endMs);
    let y = dStart.getUTCFullYear(), m = dStart.getUTCMonth() - 1;
    const endY = dEnd.getUTCFullYear(), endM = dEnd.getUTCMonth() + 1;
    while (y < endY || (y === endY && m <= endM)) {
      let d = Date.UTC(y, m, 28);
      const wd = weekdayPy(d);
      if (wd === 5) d += 2 * MS_DAY;
      else if (wd === 6) d += 1 * MS_DAY;
      if (d >= startMs && d <= endMs) out.push(d);
      m++;
      if (m > 11) { m = 0; y++; }
    }
    return out;
  }

  function wasPaid(comp, r) {
    const lo = r.date - 10 * MS_DAY;
    return comp.some(op => op.direction === r.direction && op.operation_date >= lo && Math.abs(op.amount - r.amount) <= PLAN_MATCH * r.amount);
  }

  // --- forecast.py: simulate() ---
  function simulate(compAll, planAll, asOf, days = 30, nSims = 1000, seed = 7, scenario = null) {
    const sc = Object.assign({
      client_delay: 0, revenue_drop: 0.0, cost_growth: 0.0,
      extra_expense: 0.0, extra_day: 1, cost_delay: 0
    }, scenario || {});
    const rng = createRNG(seed);

    const comp = compAll.filter(r => r.operation_date <= asOf);
    const cid = String(comp[0].company_id);
    const startBalance = Number(comp[comp.length - 1].balance_eod);
    const start = asOf + MS_DAY;
    const dates = Array.from({ length: days }, (_, i) => start + i * MS_DAY);
    const end = dates[dates.length - 1];

    const names = {};
    for (const r of comp) {
      if (r.counterparty_name && r.counterparty_inn) names[r.counterparty_inn] = r.counterparty_name;
    }

    const minOpDate = comp[0].operation_date;
    const lookbackStart = Math.max(minOpDate, asOf - LOOKBACK_DAYS * MS_DAY);
    const historyDays = diffDays(asOf, lookbackStart) + 1;

    // Самый крупный клиент
    let bigInn = null, bigName = null;
    const bigTotals = new Map();
    for (const r of comp) {
      if (r.operation_date >= lookbackStart && r.direction === IN && !SKIP_CATEGORIES.has(r.category) && r.counterparty_inn) {
        bigTotals.set(r.counterparty_inn, (bigTotals.get(r.counterparty_inn) || 0) + r.amount);
      }
    }
    let maxBig = -1;
    for (const [inn, sum] of bigTotals.entries()) {
      if (sum > maxBig) { maxBig = sum; bigInn = inn; }
    }
    if (bigInn) bigName = names[bigInn] || bigInn;

    const inM = new Float64Array(nSims * days);
    const outM = new Float64Array(nSims * days);
    const inX = new Float64Array(nSims * days);
    const outX = new Float64Array(nSims * days);
    const upcoming = [], overdue = [], notes = [];

    function add(flow, baseDay, amounts, sd = 0.0, prob = 1.0, lateOnly = false, mult = 1.0) {
      const lenA = amounts.length;
      for (let s = 0; s < nSims; s++) {
        let jit = sd > 0 ? rng.normal(0, sd) : 0;
        if (lateOnly) jit = Math.abs(jit);
        const d = Math.max(Math.round(baseDay + jit), 0);
        const amt = lenA > 1 ? amounts[rng.integers(0, lenA)] : amounts[0];
        const r = rng.random();
        if (d < days && r < prob) {
          flow[s * days + d] += amt * mult;
        }
      }
    }

    function noteUpcoming(day, title, amount, direction, kind, source) {
      if (day >= 0 && day < days) {
        upcoming.push({
          date: fmtISO(dates[day]), title,
          amount: Number(amount), direction, kind, source
        });
      }
    }

    // Регулярные платежи
    const usedKeys = new Set();
    let used = 0, stale = 0;
    const reg = detectRegularPayments(comp).filter(r => r.category !== 'Налоги' && !SKIP_CATEGORIES.has(r.category));
    for (const r of reg) {
      const interval = Math.max(Math.round(r.interval_days), 1);
      const grp = comp.filter(x => x.counterparty_inn === r.counterparty_inn && x.direction === r.direction && x.category === r.category);
      if (!grp.length) continue;
      const last = grp[grp.length - 1].operation_date;
      if (diffDays(start, last) > 2.5 * interval) {
        stale++;
        continue;
      }
      const amounts = grp.slice(-12).map(x => x.amount);
      const med = median(amounts);
      const isIn = r.direction === IN;
      const flow = isIn ? inM : outM;
      const mult = (!isIn && COST_CATEGORIES.has(r.category)) ? (1 + sc.cost_growth) : 1.0;
      let shift = 0;
      if (isIn && r.counterparty_inn === bigInn) shift = Math.trunc(sc.client_delay);
      else if (!isIn && COST_CATEGORIES.has(r.category)) shift = Math.trunc(sc.cost_delay);
      const title = `${r.category}: ${names[r.counterparty_inn] || r.counterparty_inn}`;
      const sd = isIn ? 2.0 : 1.0;
      const prob = isIn ? 0.9 : 1.0;

      let exp = last + interval * MS_DAY;
      if (exp < start) {
        const late = diffDays(asOf, exp);
        const flagged = late > OVERDUE_DAYS;
        if (flagged) {
          overdue.push({
            expected: fmtISO(exp), title, amount: med,
            direction: r.direction, days_late: late, source: 'История операций'
          });
        }
        add(flow, shift, amounts, isIn ? 4.0 : 0.0, isIn ? (flagged ? 0.6 : prob) : 1.0, true, mult);
        noteUpcoming(shift, flagged ? `${title} (с опозданием)` : title, med * mult, r.direction, 'regular', 'История операций');
        exp += interval * MS_DAY;
      }
      while (exp < start) exp += interval * MS_DAY;

      let d = diffDays(exp, start);
      while (d < days) {
        add(flow, d + shift, amounts, sd, prob, false, mult);
        noteUpcoming(d + shift, title, med * mult, r.direction, 'regular', 'История операций');
        d += interval;
      }
      usedKeys.add(`${r.counterparty_inn}|${r.direction}|${r.category}`);
      used++;
    }

    // Плановые события
    const ext = (planAll || []).filter(p =>
      (!p.company_id || String(p.company_id) === cid) &&
      p.date >= (asOf - 60 * MS_DAY) && p.date <= end
    );
    const taxPlanDates = [];
    let paid = 0, nPlan = 0;
    for (const r of ext) {
      const isIn = r.direction === IN;
      if (r.kind === 'налог') taxPlanDates.push(r.date);
      let d = 0;
      if (r.date < start) {
        if (wasPaid(comp, r)) { paid++; continue; }
        const late = diffDays(asOf, r.date);
        d = 0;
        if (late > OVERDUE_DAYS) {
          overdue.push({
            expected: fmtISO(r.date), title: r.description,
            amount: Number(r.amount), direction: r.direction,
            days_late: late, source: r.source
          });
        }
      } else {
        d = diffDays(r.date, start);
      }
      let prob = (r.probability !== null && r.probability !== undefined && !isNaN(r.probability))
        ? Number(r.probability) : (isIn ? 0.8 : 1.0);
      if (r.date < start && isIn) prob = Math.min(prob, 0.6);
      add(isIn ? inX : outX, d, [Number(r.amount)], isIn ? 3.0 : 0.0, prob, isIn, 1.0);
      noteUpcoming(d, r.description, r.amount, r.direction, r.kind, r.source);
      nPlan++;
    }

    // Налоговый календарь
    const taxOps = comp.filter(x => x.category === 'Налоги');
    const monthlyMap = new Map();
    for (const x of taxOps) {
      const ym = fmtYM(x.operation_date);
      monthlyMap.set(ym, (monthlyMap.get(ym) || 0) + x.amount);
    }
    let mKeys = Array.from(monthlyMap.keys()).sort();
    const asOfYM = fmtYM(asOf);
    if (mKeys.length > 1) mKeys = mKeys.filter(k => k !== asOfYM);
    mKeys = mKeys.slice(-12);
    const allVals = mKeys.map(k => monthlyMap.get(k));
    const qVals = mKeys.filter(k => QUARTER_MONTHS.has(Number(k.slice(5, 7)))).map(k => monthlyMap.get(k));

    if (allVals.length) {
      for (const dTax of taxDates(start, end)) {
        if (taxPlanDates.some(x => Math.abs(diffDays(dTax, x)) <= 5)) continue;
        const mNum = new Date(dTax).getUTCMonth() + 1;
        const quarter = QUARTER_MONTHS.has(mNum);
        const vals = (quarter && qVals.length) ? qVals : allVals;
        const d = diffDays(dTax, start);
        add(outX, d, vals);
        const title = quarter
          ? 'ЕНП до 28-го (в т.ч. квартальные: НДС, аванс по УСН)'
          : 'ЕНП до 28-го (налоги и взносы)';
        noteUpcoming(d, title, median(vals), OUT, 'налог', 'Налоговый календарь');
      }
      notes.push('Налоги: по календарю (ЕНП до 28-го), сумма по прошлым месяцам.');
    } else if (!taxPlanDates.length) {
      notes.push('Налоги не учтены: в истории нет налоговых платежей. Добавьте предстоящие налоги вручную или файлом.');
    }

    // Внеплановый расход из сценария
    const extraD = Math.min(Math.max(Math.trunc(sc.extra_day) - 1, 0), days - 1);
    add(outX, extraD, [Number(sc.extra_expense)]);
    if (sc.extra_expense > 0) {
      noteUpcoming(extraD, 'Внеплановый расход (сценарий)', sc.extra_expense, OUT, 'extra', 'Сценарий');
    }

    // Остальные нерегулярные операции (бутстрэп по будням/выходным)
    const lb = comp.filter(x =>
      x.operation_date >= lookbackStart &&
      !SKIP_CATEGORIES.has(x.category) && x.category !== 'Налоги' &&
      !usedKeys.has(`${x.counterparty_inn || ''}|${x.direction}|${x.category}`)
    );
    const idxLen = historyDays;
    const isWeekend = new Uint8Array(idxLen);
    const pools = {
      in_big: new Float64Array(idxLen),
      in_oth: new Float64Array(idxLen),
      out_cost: new Float64Array(idxLen),
      out_oth: new Float64Array(idxLen)
    };
    const weekdayPool = [], weekendPool = [];
    for (let i = 0; i < idxLen; i++) {
      const dt = lookbackStart + i * MS_DAY;
      const wk = weekdayPy(dt) >= 5 ? 1 : 0;
      isWeekend[i] = wk;
      if (wk) weekendPool.push(i); else weekdayPool.push(i);
    }
    for (const r of lb) {
      const pos = diffDays(r.operation_date, lookbackStart);
      if (pos < 0 || pos >= idxLen) continue;
      if (r.direction === IN) {
        if (bigInn && r.counterparty_inn === bigInn) pools.in_big[pos] += r.amount;
        else pools.in_oth[pos] += r.amount;
      } else if (r.direction === OUT) {
        if (COST_CATEGORIES.has(r.category)) pools.out_cost[pos] += r.amount;
        else pools.out_oth[pos] += r.amount;
      }
    }

    const irr = {
      in_big: new Float64Array(nSims * days),
      in_oth: new Float64Array(nSims * days),
      out_cost: new Float64Array(nSims * days),
      out_oth: new Float64Array(nSims * days)
    };

    for (let d = 0; d < days; d++) {
      const wk = weekdayPy(dates[d]) >= 5 ? 1 : 0;
      const pool = wk ? (weekendPool.length ? weekendPool : weekdayPool) : (weekdayPool.length ? weekdayPool : weekendPool);
      for (let s = 0; s < nSims; s++) {
        const pick = pool[rng.integers(0, pool.length)];
        const cell = s * days + d;
        irr.in_big[cell] = pools.in_big[pick];
        irr.in_oth[cell] = pools.in_oth[pick];
        irr.out_cost[cell] = pools.out_cost[pick];
        irr.out_oth[cell] = pools.out_oth[pick];
      }
    }

    function shifted(arr, k) {
      k = Math.trunc(k);
      if (k === 0) return arr;
      const out = new Float64Array(nSims * days);
      for (let s = 0; s < nSims; s++) {
        const rowOff = s * days;
        if (k > 0 && k < days) {
          for (let d = k; d < days; d++) out[rowOff + d] = arr[rowOff + d - k];
        } else if (k < 0 && -k < days) {
          const nk = -k;
          for (let d = 0; d < days - nk; d++) out[rowOff + d] = arr[rowOff + d + nk];
          for (let d = days - nk; d < days; d++) out[rowOff + d] = arr[rowOff + d];
        }
      }
      return out;
    }

    irr.in_big = shifted(irr.in_big, sc.client_delay);
    irr.out_cost = shifted(irr.out_cost, sc.cost_delay);

    const inflow = new Float64Array(nSims * days);
    const outflow = new Float64Array(nSims * days);
    const bal = new Float64Array(nSims * days);

    for (let s = 0; s < nSims; s++) {
      let curBal = startBalance;
      const rowOff = s * days;
      for (let d = 0; d < days; d++) {
        const i = rowOff + d;
        const totInM = (inM[i] + irr.in_oth[i] + irr.in_big[i]) * (1 - sc.revenue_drop);
        const totOutM = outM[i] + irr.out_oth[i] + irr.out_cost[i] * (1 + sc.cost_growth);
        const inf = totInM + inX[i];
        const outf = totOutM + outX[i];
        inflow[i] = inf;
        outflow[i] = outf;
        curBal += inf - outf;
        bal[i] = curBal;
      }
    }

    if (historyDays < 60) {
      notes.push(`Истории мало (${historyDays} дн.), прогноз может быть неточным.`);
    }
    notes.unshift(`Регулярных платежей и поступлений учтено: ${used}` + (stale ? ` (ещё ${stale} давно не повторялись и не учтены).` : '.'));
    notes.unshift(`Прогноз построен по операциям за последние ${Math.min(historyDays, LOOKBACK_DAYS)} дней.`);
    if (nPlan || paid) {
      notes.push(`Плановых событий учтено: ${nPlan}` + (paid ? `, уже оплачено по выписке: ${paid}.` : '.'));
    }
    notes.push('Переводы собственных средств не учитываются.');

    return {
      dates, inflow, outflow, bal, nSims, days,
      start_balance: startBalance, as_of: asOf,
      upcoming, overdue, notes,
      big_client: bigInn ? { name: bigName, inn: bigInn } : null
    };
  }

  function summarize(sim) {
    const { bal, dates, nSims, days } = sim;
    const p10 = new Float64Array(days);
    const p50 = new Float64Array(days);
    const p90 = new Float64Array(days);
    const pGapDay = new Float64Array(days);
    const col = new Float64Array(nSims);

    for (let d = 0; d < days; d++) {
      let gCount = 0;
      for (let s = 0; s < nSims; s++) {
        const v = bal[s * days + d];
        col[s] = v;
        if (v < 0) gCount++;
      }
      col.sort();
      p10[d] = percentile(col, 10);
      p50[d] = percentile(col, 50);
      p90[d] = percentile(col, 90);
      pGapDay[d] = gCount / nSims;
    }

    const firstGapDays = [];
    const deficits = [];
    for (let s = 0; s < nSims; s++) {
      let minB = Infinity, firstIdx = -1;
      const off = s * days;
      for (let d = 0; d < days; d++) {
        const v = bal[off + d];
        if (v < minB) minB = v;
        if (v < 0 && firstIdx === -1) firstIdx = d;
      }
      if (minB < 0) {
        firstGapDays.push(firstIdx);
        deficits.push(-minB);
      }
    }

    const prob = deficits.length / nSims;
    const risk = { probability: prob, date: null, date_early: null, shortfall: null, shortfall_worst: null };
    if (deficits.length > 0) {
      firstGapDays.sort((a, b) => a - b);
      deficits.sort((a, b) => a - b);
      risk.date = fmtISO(dates[Math.trunc(percentile(firstGapDays, 50))]);
      risk.date_early = fmtISO(dates[Math.trunc(percentile(firstGapDays, 10))]);
      risk.shortfall = percentile(deficits, 50);
      risk.shortfall_worst = percentile(deficits, 90);
    }

    const level = prob < 0.10 ? 'low' : prob < 0.40 ? 'medium' : 'high';
    let iMin = 0;
    for (let d = 1; d < days; d++) if (p50[d] < p50[iMin]) iMin = d;

    const upcoming = sim.upcoming.slice().sort((a, b) => a.date.localeCompare(b.date) || (b.amount - a.amount));
    const overdue = sim.overdue.slice().sort((a, b) => a.expected.localeCompare(b.expected));

    return {
      start_date: fmtISO(sim.as_of),
      start_balance: sim.start_balance,
      days: dates.map((dt, i) => ({
        date: fmtISO(dt), p10: p10[i], p50: p50[i], p90: p90[i], p_gap: pGapDay[i]
      })),
      risk, level,
      lowest: { date: fmtISO(dates[iMin]), value: p50[iMin] },
      upcoming: upcoming.slice(0, Math.max(15, Math.floor(days / 3))),
      overdue,
      big_client: sim.big_client,
      notes: sim.notes
    };
  }

  function gapProb(sim) {
    const { bal, nSims, days } = sim;
    let g = 0;
    for (let s = 0; s < nSims; s++) {
      const off = s * days;
      for (let d = 0; d < days; d++) {
        if (bal[off + d] < 0) { g++; break; }
      }
    }
    return g / nSims;
  }

  function companyOps(cid) {
    if (!MEM_OPS) return [];
    return MEM_OPS.filter(r => String(r.company_id) === String(cid))
      .sort((a, b) => a.operation_date - b.operation_date);
  }

  function forecastCompany(cid, days = 30, scenario = null) {
    const comp = companyOps(cid);
    if (!comp.length) return null;
    const sim = simulate(comp, MEM_PLAN, comp[comp.length - 1].operation_date, days, 1000, 7, scenario);
    return summarize(sim);
  }

  function adviceCompany(cid, days = 30) {
    const comp = companyOps(cid);
    if (!comp.length) return null;
    const asOf = comp[comp.length - 1].operation_date;
    const run = (sc = null) => simulate(comp, MEM_PLAN, asOf, days, 1000, 7, sc);

    const base = run();
    const prob = gapProb(base);
    const big = base.big_client;
    const out = { probability: prob, target: SAFE_PROB, safe: prob <= SAFE_PROB + 1e-9, big_client: big };

    if (out.safe) {
      const limit = (key, steps, scale = 1.0) => {
        let best = 0;
        for (const v of steps) {
          if (gapProb(run({ [key]: v * scale })) > SAFE_PROB + 1e-9) break;
          best = v;
        }
        return best;
      };
      out.tolerance = { revenue_drop: limit('revenue_drop', [10, 20, 30, 40, 50], 0.01) };
      if (big) {
        out.tolerance.client_delay = limit('client_delay', [7, 14, 21, 28].filter(d => d < days));
      }
      return out;
    }

    const deficits = new Float64Array(base.nSims);
    for (let s = 0; s < base.nSims; s++) {
      let minB = Infinity;
      const off = s * base.days;
      for (let d = 0; d < base.days; d++) if (base.bal[off + d] < minB) minB = base.bal[off + d];
      deficits[s] = -minB;
    }
    deficits.sort();
    out.reserve = Math.max(percentile(deficits, 100 * (1 - SAFE_PROB)), 0);

    const candidates = [];
    if (big) {
      candidates.push([`Ускорить оплату от клиента «${big.name}» на 7 дней`, 'Выставить счёт раньше или договориться о предоплате', { client_delay: -7 }]);
    }
    candidates.push(
      ['Получить отсрочку у поставщиков и арендодателя на 7 дней', 'Сдвигает закупки и аренду; налоги и зарплата остаются в срок', { cost_delay: 7 }],
      ['Сократить закупки и аренду на 10%', 'Пересмотреть условия договоров, найти более дешёвых поставщиков', { cost_growth: -0.10 }],
      ['Увеличить выручку на 10%', 'Рост продаж или повышение цен; считается от поступлений по истории', { revenue_drop: -0.10 }]
    );
    out.levers = candidates.map(([title, detail, sc]) => {
      const after = gapProb(run(sc));
      return { title, detail, prob_after: after, enough: after <= SAFE_PROB + 1e-9 };
    }).sort((a, b) => a.prob_after - b.prob_after);

    return out;
  }

  function planFactCompany(cid, windowDays = 28) {
    const comp = companyOps(cid);
    if (!comp.length) return null;
    const last = comp[comp.length - 1].operation_date;
    if (diffDays(last, comp[0].operation_date) < 120) {
      return { error: 'Для плана-факта нужно минимум 4 месяца истории.' };
    }
    const cutoff = last - windowDays * MS_DAY;
    const sim = simulate(comp, MEM_PLAN, cutoff, windowDays, 500, 7);
    const { dates, nSims } = sim;

    const fIn = new Float64Array(windowDays);
    const fOut = new Float64Array(windowDays);
    for (const r of comp) {
      if (r.operation_date > cutoff && !SKIP_CATEGORIES.has(r.category)) {
        const idx = diffDays(r.operation_date, dates[0]);
        if (idx >= 0 && idx < windowDays) {
          if (r.direction === IN) fIn[idx] += r.amount;
          else if (r.direction === OUT) fOut[idx] += r.amount;
        }
      }
    }

    const factBal = new Float64Array(windowDays);
    let cur = sim.start_balance;
    for (let i = 0; i < windowDays; i++) {
      cur += fIn[i] - fOut[i];
      factBal[i] = cur;
    }

    const p10 = new Float64Array(windowDays);
    const p50 = new Float64Array(windowDays);
    const p90 = new Float64Array(windowDays);
    const outside = new Array(windowDays);
    const col = new Float64Array(nSims);
    let insideCount = 0;

    for (let d = 0; d < windowDays; d++) {
      for (let s = 0; s < nSims; s++) col[s] = sim.bal[s * windowDays + d];
      col.sort();
      p10[d] = percentile(col, 10);
      p50[d] = percentile(col, 50);
      p90[d] = percentile(col, 90);
      const isOut = factBal[d] < p10[d] || factBal[d] > p90[d];
      outside[d] = isOut;
      if (!isOut) insideCount++;
    }

    const weeks = [];
    for (let w = 0; w < Math.floor(windowDays / 7); w++) {
      const startIdx = 7 * w, endIdx = startIdx + 7;
      const row = { from: fmtISO(dates[startIdx]), to: fmtISO(dates[endIdx - 1]) };
      for (const [name, simsArr, factArr] of [['in', sim.inflow, fIn], ['out', sim.outflow, fOut]]) {
        const wSims = new Float64Array(nSims);
        for (let s = 0; s < nSims; s++) {
          let sum = 0;
          for (let d = startIdx; d < endIdx; d++) sum += simsArr[s * windowDays + d];
          wSims[s] = sum;
        }
        wSims.sort();
        const lo = percentile(wSims, 10), mid = percentile(wSims, 50), hi = percentile(wSims, 90);
        let fv = 0;
        for (let d = startIdx; d < endIdx; d++) fv += factArr[d];
        row[`plan_${name}`] = mid;
        row[`fact_${name}`] = fv;
        row[`flag_${name}`] = (fv < lo || fv > hi);
      }
      weeks.push(row);
    }

    return {
      cutoff: fmtISO(cutoff),
      days: dates.map((dt, i) => ({
        date: fmtISO(dt), p10: p10[i], p50: p50[i], p90: p90[i], fact: factBal[i], outside: outside[i]
      })),
      weeks,
      inside: insideCount,
      total: windowDays
    };
  }

  // --- Перехватчик fetch для всех маршрутов /api/* ---
  const origFetch = window.fetch.bind(window);

  function jsonResp(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
      status,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  window.fetch = async function (input, opts = {}) {
    await initReady;
    const rawUrl = typeof input === 'string' ? input : input.url;
    const u = new URL(rawUrl, location.origin);
    const path = u.pathname;
    const q = u.searchParams;
    const method = (opts.method || 'GET').toUpperCase();

    if (!path.startsWith('/api/')) {
      return origFetch(input, opts);
    }

    try {
      if (path === '/api/auth/logout') {
        if (confirm('Очистить сохранённые в браузере данные операций и плана?')) {
          MEM_OPS = null;
          MEM_PLAN = [];
          await idbSet('ops', null);
          await idbSet('plan', []);
          location.reload();
        }
        return jsonResp({ ok: true });
      }

      if (path === '/api/state') {
        if (!MEM_OPS || !MEM_OPS.length) return jsonResp({ has_data: false });
        const companies = Array.from(new Set(MEM_OPS.map(r => String(r.company_id)))).sort();
        const dates = MEM_OPS.map(r => r.operation_date);
        return jsonResp({
          has_data: true,
          companies,
          operations: MEM_OPS.length,
          date_from: fmtRU(Math.min(...dates)),
          date_to: fmtRU(Math.max(...dates))
        });
      }

      if (path === '/api/upload' && method === 'POST') {
        const fd = opts.body;
        const file = fd.get('file');
        if (!file || !file.name.toLowerCase().endsWith('.csv')) {
          return jsonResp({ error: 'Загрузите файл в формате .csv' }, 400);
        }
        const text = await file.text();
        const { ops, notes } = runPipeline(text);
        MEM_OPS = ops;
        await idbSet('ops', MEM_OPS);
        const companies = Array.from(new Set(ops.map(r => String(r.company_id)))).sort();
        const dates = ops.map(r => r.operation_date);
        return jsonResp({
          companies, notes,
          operations: ops.length,
          date_from: fmtRU(Math.min(...dates)),
          date_to: fmtRU(Math.max(...dates))
        });
      }

      if (path === '/api/overview') {
        if (!MEM_OPS) return jsonResp({ error: 'Сначала загрузите файл' }, 400);
        const df = companyOps(q.get('company'));
        if (!df.length) return jsonResp({ error: 'Нет данных по этой компании' }, 404);
        let income = 0, outcome = 0, outCount = 0;
        const byDateBal = new Map();
        const outRows = [];
        for (const r of df) {
          if (r.direction === IN) income += r.amount;
          else if (r.direction === OUT) { outcome += r.amount; outCount++; outRows.push(r); }
          byDateBal.set(r.operation_date, r.balance_eod);
        }
        const balArr = Array.from(byDateBal.values());
        const step = Math.max(Math.floor(balArr.length / 60), 1);
        const spark = [];
        for (let i = 0; i < balArr.length; i += step) spark.push(Number(balArr[i]));
        const lastBal = Number(balArr[balArr.length - 1]);
        if (spark[spark.length - 1] !== lastBal) spark.push(lastBal);

        const recent = outRows.slice(-4).reverse().map(r => ({
          date: fmtShortRU(r.operation_date),
          who: (r.counterparty_name || '').trim() || (r.payment_purpose || '').trim() || 'Без названия',
          category: r.category,
          amount: Number(r.amount)
        }));

        return jsonResp({
          income, outcome, balance: lastBal, out_count: outCount, spark,
          date_from: fmtRU(df[0].operation_date),
          date_to: fmtRU(df[df.length - 1].operation_date),
          recent
        });
      }

      if (path === '/api/history') {
        if (!MEM_OPS) return jsonResp({ error: 'Сначала загрузите файл' }, 400);
        const allOut = companyOps(q.get('company')).filter(r => r.direction === OUT);
        const categories = Array.from(new Set(allOut.map(r => r.category))).sort();
        let df = allOut;
        const cat = q.get('category');
        if (cat) df = df.filter(r => r.category === cat);
        const search = (q.get('q') || '').trim().toLowerCase();
        if (search) {
          df = df.filter(r =>
            String(r.payment_purpose || '').toLowerCase().includes(search) ||
            String(r.counterparty_inn || '').toLowerCase().includes(search) ||
            String(r.counterparty_name || '').toLowerCase().includes(search)
          );
        }
        df = df.slice().sort((a, b) => b.operation_date - a.operation_date);
        const sum = df.reduce((a, b) => a + b.amount, 0);
        const perPage = 25;
        const total = df.length;
        const pages = Math.max(Math.ceil(total / perPage), 1);
        const page = Math.min(Math.max(parseInt(q.get('page') || '1', 10), 1), pages);
        const chunk = df.slice((page - 1) * perPage, page * perPage);
        const rows = chunk.map(r => ({
          date: fmtRU(r.operation_date),
          inn: r.counterparty_inn || '',
          name: r.counterparty_name || '',
          category: r.category,
          purpose: r.payment_purpose,
          amount: Number(r.amount)
        }));
        return jsonResp({ rows, total, page, pages, sum, categories });
      }

      if (path === '/api/stats') {
        if (!MEM_OPS) return jsonResp({ error: 'Сначала загрузите файл' }, 400);
        const df = companyOps(q.get('company'));
        if (!df.length) return jsonResp({ error: 'Нет данных по этой компании' }, 404);
        const inc = df.filter(r => r.direction === IN);
        const out = df.filter(r => r.direction === OUT);

        const mMap = new Map();
        for (const r of df) {
          const m = fmtYM(r.operation_date);
          if (!mMap.has(m)) mMap.set(m, { in: 0, out: 0 });
          if (r.direction === IN) mMap.get(m).in += r.amount;
          else if (r.direction === OUT) mMap.get(m).out += r.amount;
        }
        const mLabels = Array.from(mMap.keys()).sort();
        const byDateBal = new Map();
        for (const r of df) byDateBal.set(fmtISO(r.operation_date), Number(r.balance_eod));

        const byCat = arr => {
          const map = new Map();
          for (const r of arr) map.set(r.category, (map.get(r.category) || 0) + r.amount);
          const entries = Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
          return { labels: entries.map(e => e[0]), values: entries.map(e => e[1]) };
        };

        const payerMap = new Map();
        const innSet = new Set();
        for (const r of inc) {
          if (r.counterparty_inn) innSet.add(r.counterparty_inn);
          const key = (r.counterparty_name || '').trim() || (r.counterparty_inn || '').trim() || 'Без названия';
          if (!payerMap.has(key)) payerMap.set(key, { sum: 0, count: 0 });
          const rec = payerMap.get(key);
          rec.sum += r.amount;
          rec.count += 1;
        }
        const totInc = inc.reduce((a, b) => a + b.amount, 0) || 1.0;
        const incomeTop = Array.from(payerMap.entries())
          .sort((a, b) => b[1].sum - a[1].sum)
          .slice(0, 5)
          .map(([name, r]) => ({ name, sum: r.sum, count: r.count, share: (r.sum / totInc) * 100 }));

        const balValues = Array.from(byDateBal.values());
        return jsonResp({
          income_top: incomeTop,
          income_clients: innSet.size,
          kpi: {
            income: inc.reduce((a, b) => a + b.amount, 0),
            outcome: out.reduce((a, b) => a + b.amount, 0),
            balance: balValues[balValues.length - 1],
            operations: df.length
          },
          monthly: {
            labels: mLabels,
            income: mLabels.map(k => mMap.get(k).in),
            outcome: mLabels.map(k => mMap.get(k).out)
          },
          balance: {
            labels: Array.from(byDateBal.keys()),
            values: balValues
          },
          income_cat: byCat(inc),
          outcome_cat: byCat(out)
        });
      }

      if (path === '/api/plan' && method === 'GET') {
        const cid = String(q.get('company') || '');
        const items = MEM_PLAN
          .filter(r => !r.company_id || String(r.company_id) === cid)
          .sort((a, b) => a.date - b.date)
          .map(r => ({
            id: r.id, date: fmtISO(r.date), title: r.description,
            kind: r.kind, direction: r.direction, amount: Number(r.amount),
            source: r.source, probability: r.probability
          }));
        return jsonResp({ sources: SOURCES, items });
      }

      if (path === '/api/plan/add' && method === 'POST') {
        if (!MEM_OPS) return jsonResp({ error: 'Сначала загрузите файл с операциями' }, 400);
        const data = JSON.parse(opts.body || '{}');
        if (data.direction !== IN && data.direction !== OUT) {
          return jsonResp({ error: 'Выберите, это поступление или списание' }, 400);
        }
        const amount = parseNum(data.amount);
        if (!amount || amount <= 0) return jsonResp({ error: 'Введите сумму больше нуля' }, 400);
        const dt = parseDate(data.date);
        if (isNaN(dt)) return jsonResp({ error: 'Укажите дату' }, 400);
        MEM_PLAN.push({
          id: Date.now() + Math.floor(Math.random() * 1000),
          company_id: data.company_id ? String(data.company_id) : null,
          kind: 'другое',
          direction: data.direction,
          date: dt,
          amount,
          description: (data.description || '').trim() || 'Планируемое событие',
          probability: parseProb(data.probability),
          source: 'Ручной ввод'
        });
        await idbSet('plan', MEM_PLAN);
        return jsonResp({ added: 1 });
      }

      if (path === '/api/plan/upload' && method === 'POST') {
        if (!MEM_OPS) return jsonResp({ error: 'Сначала загрузите файл с операциями' }, 400);
        const fd = opts.body;
        const file = fd.get('file');
        const source = fd.get('source') || 'Другое';
        if (!file || !file.name.toLowerCase().endsWith('.csv')) {
          return jsonResp({ error: 'Загрузите файл в формате .csv' }, 400);
        }
        const text = await file.text();
        const rows = parsePlanFile(text, source);
        MEM_PLAN.push(...rows);
        await idbSet('plan', MEM_PLAN);
        return jsonResp({ added: rows.length, source });
      }

      if (path.startsWith('/api/plan/') && method === 'DELETE') {
        const id = Number(path.split('/').pop());
        MEM_PLAN = MEM_PLAN.filter(x => Number(x.id) !== id);
        await idbSet('plan', MEM_PLAN);
        return jsonResp({ ok: true });
      }

      const days = Math.min(Math.max(parseInt(q.get('days') || '30', 10) || 30, 30), 365);

      if (path === '/api/forecast') {
        if (!MEM_OPS) return jsonResp({ error: 'Сначала загрузите файл' }, 400);
        const res = forecastCompany(q.get('company'), days);
        if (!res) return jsonResp({ error: 'Нет данных по этой компании' }, 404);
        return jsonResp(res);
      }

      if (path === '/api/scenario') {
        if (!MEM_OPS) return jsonResp({ error: 'Сначала загрузите файл' }, 400);
        const cid = q.get('company');
        const sc = {
          client_delay: Math.max(parseInt(q.get('client_delay') || '0', 10) || 0, 0),
          revenue_drop: Math.min(Math.max(parseFloat(q.get('revenue_drop') || '0') || 0, 0), 90) / 100,
          cost_growth: Math.max(parseFloat(q.get('cost_growth') || '0') || 0, 0) / 100,
          extra_expense: Math.max(parseFloat(q.get('extra') || '0') || 0, 0),
          extra_day: Math.max(parseInt(q.get('extra_day') || '1', 10) || 1, 1)
        };
        const base = forecastCompany(cid, days);
        if (!base) return jsonResp({ error: 'Нет данных по этой компании' }, 404);
        return jsonResp({ base, scenario: forecastCompany(cid, days, sc) });
      }

      if (path === '/api/advice') {
        if (!MEM_OPS) return jsonResp({ error: 'Сначала загрузите файл' }, 400);
        const res = adviceCompany(q.get('company'), days);
        if (!res) return jsonResp({ error: 'Нет данных по этой компании' }, 404);
        return jsonResp(res);
      }

      if (path === '/api/planfact') {
        if (!MEM_OPS) return jsonResp({ error: 'Сначала загрузите файл' }, 400);
        const res = planFactCompany(q.get('company'));
        if (!res) return jsonResp({ error: 'Нет данных по этой компании' }, 404);
        if (res.error) return jsonResp({ error: res.error }, 400);
        return jsonResp(res);
      }

      return jsonResp({ error: 'Неизвестный маршрут: ' + path }, 404);
    } catch (e) {
      return jsonResp({ error: e.message || String(e) }, 400);
    }
  };
})();

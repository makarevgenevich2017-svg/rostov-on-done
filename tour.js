// Обучающий тур: затемняет сайт, подсвечивает нужное место и объясняет, что это.
// Внизу при первом входе показывается предложение пройти обзор.
(function () {
  const $ = id => document.getElementById(id);
  const user = document.body.dataset.user || 'guest';
  const KEY = 'tour_seen_' + user;

  const seen = () => { try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; } };
  const markSeen = () => { try { localStorage.setItem(KEY, '1'); } catch (e) {} };

  // slide — номер экрана, cap — ограничить высоту подсветки (для больших блоков)
  const STEPS = [
    {slide: 0, sel: '#nav', title: 'Меню разделов',
     text: 'Здесь можно перейти в любой раздел. «История» и «Статистика» откроются, когда вы загрузите данные. Подсвеченный пункт — где вы сейчас.'},
    {slide: 0, sel: '#pick', title: 'Шаг 1. Загрузите данные',
     text: 'Нажмите кнопку и выберите CSV-файл с операциями из банка или 1С. Обработка занимает несколько секунд.'},
    {slide: 0, sel: '#template', title: 'Не знаете, как оформить файл?',
     text: 'Нажмите «Загрузить шаблон» — скачается готовый CSV-файл с нужными колонками и примерами строк. Замените примеры своими операциями и загрузите файл кнопкой слева.'},
    {slide: 0, sel: '#saved', title: 'Данные уже загружались?',
     text: 'Прошлая загрузка сохраняется в базе. Нажмите эту кнопку, чтобы открыть её без повторной загрузки.'},
    {slide: 1, sel: '#company', title: 'Шаг 2. Выберите компанию',
     text: 'Если в файле несколько компаний, выберите нужную в этом списке. Все разделы покажут данные именно по ней.'},
    {slide: 1, sel: '#go-history', title: 'История списаний',
     text: 'Таблица всех расходов. Её можно искать по словам и ИНН и фильтровать по категориям: аренда, налоги, зарплата и так далее.'},
    {slide: 1, sel: '#go-stats', title: 'Полная статистика и прогноз',
     text: 'Графики прихода и расхода, остаток на счёте и главное — прогноз на 30, 90, 180 дней или свой срок: хватит ли денег и когда может возникнуть кассовый разрыв.'},
    {slide: 2, sel: '#h-toolbar', title: 'Поиск и фильтры',
     text: 'Введите слово из назначения платежа, название контрагента или ИНН. Список ниже сразу отфильтруется. Справа — сколько операций нашлось и на какую сумму.'},
    {slide: 2, sel: '#s-history .table-box', cap: 300, title: 'Таблица расходов',
     text: 'Новые операции сверху. Если записей много, листайте страницы кнопками под таблицей.'},
    {slide: 3, sel: '#forecast', cap: 330, title: 'Прогноз и период',
     text: 'Сверху выберите период: 30, 90, 180 дней или свой срок. Цветной блок сразу говорит, насколько вероятна нехватка денег. Ниже — график ожидаемого остатка и список ближайших платежей.'},
    {slide: 3, sel: '#advice', cap: 300, title: 'Что делать и насколько вы устойчивы',
     text: 'Если риск разрыва выше нормы, здесь список мер: ускорить оплату клиента, получить отсрочку у поставщиков, сократить затраты. Для каждой показано, насколько она снижает вероятность разрыва. Если всё спокойно — видно, насколько может упасть выручка или задержаться клиент, пока риск не станет заметным.'},
    {slide: 3, sel: '#sources', cap: 300, title: 'Данные для прогноза',
     text: 'Знаете, что клиент скоро заплатит или предстоит крупный платёж? Добавьте событие вручную или загрузите файл — прогноз пересчитается.'},
    {slide: 3, sel: '#scenarios', cap: 300, title: 'А если что-то пойдёт не так?',
     text: 'Выберите неприятное событие — например, задержку оплаты от клиента — и нажмите «Показать сценарий». Увидите, как изменится риск.'},
    {slide: 3, sel: '#planfact', cap: 280, title: 'План и факт',
     text: 'Проверка точности: прогноз, сделанный месяц назад, сравнивается с тем, что произошло на самом деле.'},
    {slide: 3, sel: '#kpis', title: 'Главные цифры',
     text: 'Поступления, списания, остаток и число операций за весь период. Ниже — диаграммы по месяцам и категориям.'},
    {slide: 3, sel: '#help-btn', title: 'Готово!',
     text: 'Это всё. Чтобы пройти обзор ещё раз, нажмите «Как пользоваться сайтом?» слева вверху в любой момент.'},
  ];

  let steps = [], idx = 0, active = false, token = 0;

  const visible = el => el && el.offsetParent !== null || (el && getComputedStyle(el).position === 'fixed');

  function setDim(on) {
    // на время тура не даём прокручивать слайды колёсиком под затемнением
    document.documentElement.style.overscrollBehavior = on ? 'contain' : '';
  }

  function place(step, el) {
    const hole = $('tour-hole'), card = $('tour-card');
    const pad = 8, vw = innerWidth, vh = innerHeight;
    const r = el.getBoundingClientRect();
    let top = r.top - pad, height = r.height + pad * 2;
    if (step.cap && height > step.cap) height = step.cap;
    const left = Math.max(r.left - pad, 6);
    const width = Math.min(r.width + pad * 2, vw - left - 6);
    Object.assign(hole.style, {top: top + 'px', left: left + 'px', width: width + 'px', height: height + 'px'});

    const cw = card.offsetWidth, ch = card.offsetHeight, gap = 16;
    const bottom = top + height;
    let ct, cl;
    if (vh - bottom >= ch + gap + 8) { ct = bottom + gap; cl = left; }           // под блоком
    else if (top >= ch + gap + 8) { ct = top - ch - gap; cl = left; }            // над блоком
    else { ct = vh - ch - 20; cl = (vw - cw) / 2; }                                 // поверх, у нижнего края
    cl = Math.min(Math.max(cl, 12), vw - cw - 12);
    ct = Math.min(Math.max(ct, 12), vh - ch - 12);
    card.style.top = ct + 'px';
    card.style.left = cl + 'px';
  }

  async function render() {
    const my = ++token;
    const step = steps[idx];
    const el = document.querySelector(step.sel);

    if (window.go && window.currentSlide !== step.slide) {
      window.go(step.slide);
      await new Promise(r => setTimeout(r, 420));
      if (my !== token) return;
    }
    // слайды со скроллом: приводим нужный блок в поле зрения
    const sl = el.closest('.slide.scroll');
    if (sl) sl.scrollTo({top: sl.scrollTop + el.getBoundingClientRect().top - sl.getBoundingClientRect().top - 16, behavior: 'instant'});
    await new Promise(r => setTimeout(r, 60));
    if (my !== token) return;

    $('tour-count').textContent = `Шаг ${idx + 1} из ${steps.length}`;
    $('tour-title').textContent = step.title;
    $('tour-text').textContent = step.text;
    $('tour-prev').disabled = idx === 0;
    $('tour-next').textContent = idx === steps.length - 1 ? 'Готово ✓' : 'Далее →';
    place(step, el);
    $('tour-next').focus({preventScroll: true});
  }

  function start() {
    // шаги, чьих элементов нет (например, кнопка сохранённых данных или ссылки на базу), пропускаем
    steps = STEPS.filter(s => { const el = document.querySelector(s.sel); return el && el.offsetParent !== null && el.getBoundingClientRect().height > 30; });
    if (!steps.length) return;
    $('tour-offer').hidden = true;
    markSeen();
    idx = 0; active = true;
    $('tour').hidden = false;
    setDim(true);
    render();
  }

  function stop() {
    active = false; token++;
    $('tour').hidden = true;
    setDim(false);
    document.querySelectorAll('.slide.scroll').forEach(sl => sl.scrollTo({top: 0, behavior: 'instant'}));
    if (window.go) window.go(0);
  }

  $('tour-next').onclick = () => { if (idx >= steps.length - 1) stop(); else { idx++; render(); } };
  $('tour-prev').onclick = () => { if (idx > 0) { idx--; render(); } };
  $('tour-close').onclick = stop;
  $('tour-start').onclick = start;
  $('tour-skip').onclick = () => { $('tour-offer').hidden = true; markSeen(); };
  $('help-btn').onclick = () => { $('tour-offer').hidden = true; start(); };

  addEventListener('keydown', e => {
    if (active) {
      if (e.key === 'Escape') stop();
      else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); $('tour-next').click(); }
      else if (e.key === 'ArrowLeft') $('tour-prev').click();
    } else if (!$('tour-offer').hidden && e.key === 'Escape') $('tour-skip').click();
  });
  addEventListener('resize', () => { if (active) render(); });

  // первое посещение: затемняем сайт и предлагаем обзор внизу
  if (!seen()) setTimeout(() => { $('tour-offer').hidden = false; $('tour-start').focus(); }, 500);
})();

/**
 * 22_Budget.gs — что считается тратой месяца.
 *
 * Траты приходят двумя путями: человек записывает их сам (лист «Расходы» —
 * наличные, чеки, ссылки из SMS) и они же приезжают из выписок (лист
 * «Операции»). Складывать листы напрямую нельзя: одна покупка попадает в оба.
 *
 * Поэтому бюджет собирается на лету — без третьего листа и без копий. Из
 * «Операций» берётся только то, что действительно потрачено и ещё не учтено
 * ручной записью.
 */

/**
 * Строки выписок, которые считаются тратой.
 *
 * options: {from, to} — границы периода по дате покупки.
 *
 * Почему по дате покупки, а не списания: деньги ушли из семьи, когда её член
 * расплатился на кассе. Карта спишет их 10 сентября, но трата — августовская,
 * иначе месяцы перемешаются и «сколько мы потратили в августе» потеряет смысл.
 */
function operationExpenses_(options) {
  options = options || {};

  var sheet = ensureSheet_(SHEET_OPERATIONS, OPERATION_COLUMNS);
  var last = sheet.getLastRow();
  if (last < 2) return [];

  var cards = readCards_();
  var rows = sheet.getRange(2, 1, last - 1, OPERATION_COLUMNS.length).getValues();
  var result = [];

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];

    if (String(row[14]).trim()) continue;          // «не трата»
    var kind = String(row[13] || '');
    if (kind === 'поступление' || kind === 'к сведению') continue;

    // Связь с ручной записью: покупку уже посчитали как запись человека,
    // в ней есть категория и комментарий. Пометка «отдельно» означает
    // обратное — человек сказал, что это разные траты
    var link = String(row[16] || '').trim();
    if (link && link !== 'отдельно') continue;

    var date = row[0] instanceof Date ? row[0] : parseCellDate_(row[0]);
    if (!date) continue;
    if (options.from && date < options.from) continue;
    if (options.to && date > options.to) continue;

    var amount = Number(row[2]) || 0;
    if (!amount) continue;

    var card = String(row[8] || '');
    var known = cards[card];

    result.push({
      row: i + 2,
      fromOperations: true,
      created: date,
      date: date,
      chargeDate: row[1] || '',
      amount: amount,
      currency: String(row[3] || 'ILS'),
      baseAmount: Number(row[4]) || amount,
      category: String(row[11] || '') || FALLBACK_CATEGORY,
      subcategory: String(row[12] || ''),
      description: withRussianHint_(String(row[10] || '')) || 'Покупка по карте',
      store: String(row[10] || ''),
      items: '',
      // Автора берём из реестра карт: в выписке его нет, а вопрос «кто это
      // потратил» возникает первым
      author: String(row[9] || '') || (known ? known.owner : ''),
      sourceType: card ? String(row[7] || 'выписка') + ' · ' + card : String(row[7] || 'выписка'),
      rawText: String(row[18] || ''),
      categorySource: 'выписка',
      fileLink: '',
      kind: 'расход',
      id: String(row[19] || '')
    });
  }

  return result;
}

/**
 * Все траты периода: записанные руками и пришедшие из выписок.
 */
function budgetExpenses_(options) {
  var manual = readExpenses_(options || {});
  return manual.concat(operationExpenses_(options));
}

/**
 * Сколько трат из выписок ещё не разложено по категориям.
 * Нужно для подсказки: без категорий отчёт по месяцу выглядит бессмысленно.
 */
function uncategorizedOperationsCount_() {
  return operationExpenses_({}).filter(function (item) {
    return !item.category || item.category === FALLBACK_CATEGORY;
  }).length;
}

/**
 * Сколько и когда спишется с карт — то, что уже известно из выписок.
 *
 * Карта живёт не по календарю: покупки августа Cal снимет 2 сентября, Isracard
 * — 15-го, а автокредит идёт своим чередом до 2029 года. Отсюда вопрос, на
 * который таблица не отвечала: сколько денег понадобится на счёте и к какому
 * числу.
 *
 * Считается по факту из «Операций» — по датам списания, которые проставил сам
 * эмитент. Плюс к ним будущие платежи по рассрочкам: их график известен из
 * примечания («תשלום 30 מתוך 60» — тридцатый из шестидесяти), и не показать их
 * значило бы каждый месяц удивляться полутора тысячам за машину.
 *
 * options.days — горизонт списка в днях (по умолчанию 45). Всё, что дальше,
 * сворачивается в строку «дальше по рассрочкам».
 */
function upcomingCharges_(options) {
  options = options || {};
  var horizon = options.days || 45;

  var now = options.now || new Date();
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var edge = new Date(today.getFullYear(), today.getMonth(), today.getDate() + horizon);

  var sheet = ensureSheet_(SHEET_OPERATIONS, OPERATION_COLUMNS);
  var last = sheet.getLastRow();
  if (last < 2) return { groups: [], later: null, asOf: lastImportAt_() };

  var cards = readCards_();
  var rows = sheet.getRange(2, 1, last - 1, OPERATION_COLUMNS.length).getValues();
  var buckets = {};
  var later = { count: 0, monthly: 0, until: null };

  function bucket(date, card, amount) {
    var key = formatDate_(date) + '|' + card;
    if (!buckets[key]) {
      var known = cards[card];
      buckets[key] = {
        date: date,
        card: card,
        title: known ? known.title : '',
        issuer: known ? known.issuer : '',
        owner: known ? known.owner : '',
        amount: 0,
        count: 0,
        forecast: 0
      };
    }
    buckets[key].amount += amount;
    buckets[key].count++;
    return buckets[key];
  }

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (String(row[14]).trim()) continue;                       // «не трата»
    var kind = String(row[13] || '');
    if (kind === 'поступление' || kind === 'к сведению') continue;

    var charge = isDateValue_(row[1]) ? row[1] : parseCellDate_(row[1]);
    if (!charge) continue;

    var amount = Number(row[2]) || 0;
    if (!amount) continue;

    var card = String(row[8] || '');

    // Уже списанное показывать незачем — вопрос про «сколько ещё уйдёт»
    if (charge >= today && charge <= edge) bucket(charge, card, amount);

    if (kind !== 'рассрочка') continue;

    // «תשלום 30 מתוך 60»: тридцать платежей позади, тридцать впереди. Без
    // номера платежа (так выглядит финансирование будущей покупки у Max)
    // график неизвестен — тогда показываем только ближайшее списание
    var schedule = String(row[18] || '').match(/(\d+)\s*מתוך\s*(\d+)/);
    if (!schedule) continue;

    var left = Number(schedule[2]) - Number(schedule[1]);
    for (var k = 1; k <= left; k++) {
      var next = new Date(charge.getFullYear(), charge.getMonth() + k, charge.getDate());
      if (next < today) continue;
      if (next <= edge) {
        bucket(next, card, amount).forecast += amount;
      } else {
        later.count++;
        later.monthly += amount;
        if (!later.until || next > later.until) later.until = next;
      }
    }
  }

  var groups = Object.keys(buckets).map(function (key) { return buckets[key]; });
  groups.sort(function (a, b) { return a.date - b.date || (a.card > b.card ? 1 : -1); });

  // Платёж одной рассрочки повторяется каждый месяц, поэтому «в месяц» — это
  // сумма одного круга, а не всех оставшихся платежей сразу
  if (later.count) {
    var months = monthsBetween_(today, later.until) || 1;
    later.monthly = Math.round((later.monthly / months) * 100) / 100;
  }

  return {
    groups: groups,
    later: later.count ? later : null,
    asOf: lastImportAt_()
  };
}

/**
 * Сколько месяцев между датами — для пересчёта «сколько это в месяц».
 */
function monthsBetween_(from, to) {
  if (!from || !to) return 0;
  return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
}

/**
 * Когда последний раз разбирали выписку. Показывается рядом с предстоящими
 * списаниями: сумма честна ровно настолько, насколько свежие выгрузки.
 */
function lastImportAt_() {
  var journal = ensureSheet_(SHEET_IMPORTS, IMPORT_COLUMNS);
  var last = journal.getLastRow();
  if (last < 2) return null;
  var value = journal.getRange(last, 1, 1, 1).getValues()[0][0];
  return isDateValue_(value) ? value : null;
}

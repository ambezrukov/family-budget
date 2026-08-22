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

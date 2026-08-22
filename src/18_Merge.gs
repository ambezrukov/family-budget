/**
 * 18_Merge.gs — склейка строк выписки с записями, внесёнными руками.
 *
 * Одна покупка попадает в систему дважды: человек записал её ботом сразу, а
 * через несколько дней та же трата приехала в выписке. Это не ошибка — это
 * два взгляда на одну операцию. Задача — связать их, чтобы в отчёте трата
 * осталась одна, а комментарий и категория, проставленные руками, не
 * потерялись.
 *
 * Решение принимает человек: суммы и даты совпадают слишком часто, чтобы
 * склеивать молча.
 */

var MERGE_DAYS_ = 3;        // выписка отстаёт от покупки на день-два
var MERGE_ASK_LIMIT_ = 5;   // больше пяти вопросов подряд — уже допрос

/**
 * Ищет пары «строка выписки ↔ ручная запись».
 */
function findMergeCandidates_() {
  var sheet = ensureSheet_(SHEET_OPERATIONS, OPERATION_COLUMNS);
  var last = sheet.getLastRow();
  if (last < 2) return [];

  var operations = sheet.getRange(2, 1, last - 1, OPERATION_COLUMNS.length).getValues()
    .map(function (row, position) {
      return {
        row: position + 2,
        date: row[0],
        amount: Number(row[2]) || 0,
        currency: row[3] || 'ILS',
        source: row[7],
        merchant: String(row[10] || ''),
        notTrackable: String(row[14] || ''),
        merged: String(row[16] || ''),
        id: String(row[19] || '')
      };
    })
    .filter(function (op) { return !op.notTrackable && !op.merged && op.amount > 0; });

  if (!operations.length) return [];

  // Ручные записи: те, что человек внёс сам. Строки, пришедшие из выписок,
  // в «Расходах» не появляются, так что сравнивать не с чем не будет
  var manual = readExpenses_({}).filter(function (item) {
    return item.sourceType !== 'выписка';
  });
  if (!manual.length) return [];

  var pairs = [];
  var taken = {};

  operations.forEach(function (op) {
    if (pairs.length >= MERGE_ASK_LIMIT_) return;
    if (!op.date) return;

    for (var i = 0; i < manual.length; i++) {
      var record = manual[i];
      if (taken[record.id]) continue;
      if (record.currency !== op.currency) continue;
      if (Math.abs(Number(record.amount) - op.amount) > 0.011) continue;

      var days = Math.abs(record.date - op.date) / (24 * 60 * 60 * 1000);
      if (days > MERGE_DAYS_) continue;

      taken[record.id] = true;
      pairs.push({ operation: op, record: record });
      break;
    }
  });

  return pairs;
}

/**
 * Спрашивает про найденные пары. Вопрос один на пару — с кнопками.
 */
function offerMergeCandidates_(chatId) {
  var pairs = findMergeCandidates_();
  if (!pairs.length) return;

  tgSend_(chatId, pairs.length === 1
    ? 'Нашёл трату, похожую на уже записанную. Это одно и то же?'
    : 'Нашёл ' + pairs.length + ' трат, похожих на уже записанные. Посмотрите:');

  pairs.forEach(function (pair) {
    var op = pair.operation;
    var record = pair.record;

    var text = [
      '<b>' + formatMoney_(op.amount, op.currency) + '</b>',
      'Выписка (' + escapeHtml_(String(op.source)) + '): ' +
        formatDate_(op.date) + ' · ' + escapeHtml_(op.merchant || 'без названия'),
      'Ваша запись: ' + formatDate_(record.date) + ' · ' +
        escapeHtml_(record.description || record.store || record.category)
    ].join('\n');

    tgSend_(chatId, text, [[
      { text: 'Одно и то же', callback_data: 'mg:' + op.id + ':' + record.id },
      { text: 'Разные траты', callback_data: 'mgn:' + op.id }
    ]]);
  });
}

/**
 * Связывает строку выписки с ручной записью.
 */
function mergeOperationWithRecord_(operationId, recordId) {
  var sheet = ensureSheet_(SHEET_OPERATIONS, OPERATION_COLUMNS);
  var last = sheet.getLastRow();
  if (last < 2) return false;

  var ids = sheet.getRange(2, 20, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(operationId)) {
      sheet.getRange(i + 2, 17).setValue(recordId);
      logEvent_('Строка выписки склеена с записью', { операция: operationId, запись: recordId });
      return true;
    }
  }
  return false;
}

/**
 * Помечает, что пара не подходит: иначе бот спросит о ней снова после
 * следующего импорта.
 */
function keepOperationSeparate_(operationId) {
  var sheet = ensureSheet_(SHEET_OPERATIONS, OPERATION_COLUMNS);
  var last = sheet.getLastRow();
  if (last < 2) return false;

  var ids = sheet.getRange(2, 20, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(operationId)) {
      sheet.getRange(i + 2, 17).setValue('отдельно');
      return true;
    }
  }
  return false;
}

/**
 * Удаляет строки выписок, которые старше даты начала учёта.
 *
 * Нужно, когда отсечка задана задним числом или, как 22.08.2026, не сработала
 * из-за формата даты: лишние строки уже в таблице, а руками выбирать их среди
 * сотни неудобно.
 */
function dropOperationsBefore_(date) {
  if (!date) return 0;

  var sheet = ensureSheet_(SHEET_OPERATIONS, OPERATION_COLUMNS);
  var last = sheet.getLastRow();
  if (last < 2) return 0;

  var dates = sheet.getRange(2, 1, last - 1, 1).getValues();
  var doomed = [];
  for (var i = 0; i < dates.length; i++) {
    var value = dates[i][0];
    if (value && Object.prototype.toString.call(value) === '[object Date]' && value < date) {
      doomed.push(i + 2);
    }
  }

  // Удаляем снизу вверх, иначе номера строк съезжают по ходу дела
  for (var d = doomed.length - 1; d >= 0; d--) sheet.deleteRow(doomed[d]);

  if (doomed.length) {
    logEvent_('Удалены строки раньше начала учёта', { строк: doomed.length, дата: formatDate_(date) });
  }
  return doomed.length;
}

/**
 * Сколько строк в «Операциях» старше даты.
 */
function countOperationsBefore_(date) {
  if (!date) return 0;
  var sheet = ensureSheet_(SHEET_OPERATIONS, OPERATION_COLUMNS);
  var last = sheet.getLastRow();
  if (last < 2) return 0;

  return sheet.getRange(2, 1, last - 1, 1).getValues().filter(function (row) {
    return row[0] && Object.prototype.toString.call(row[0]) === '[object Date]' && row[0] < date;
  }).length;
}

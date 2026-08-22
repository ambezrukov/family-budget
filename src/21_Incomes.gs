/**
 * 21_Incomes.gs — поступления из банковской выписки.
 *
 * Почему они не заносятся в «Доходы» сами: приход денег на счёт и доход —
 * не одно и то же. Зарплата — доход. Возврат долга, перевод с собственного
 * вклада, деньги, которые жена перекинула мужу, отмена платежа магазином —
 * приход есть, дохода нет. Ошибка здесь тише и вреднее, чем в расходах:
 * бюджет покажет, что семья зарабатывает больше, чем на самом деле.
 *
 * Поэтому решение принимает человек — одним нажатием, по каждой строке.
 */

var INCOME_ASK_LIMIT_ = 6;

/**
 * Поступления, о которых бот ещё не спрашивал.
 */
function pendingIncomeOperations_() {
  var sheet = ensureSheet_(SHEET_OPERATIONS, OPERATION_COLUMNS);
  var last = sheet.getLastRow();
  if (last < 2) return [];

  return sheet.getRange(2, 1, last - 1, OPERATION_COLUMNS.length).getValues()
    .map(function (row, position) {
      return {
        row: position + 2,
        date: row[0],
        amount: Number(row[2]) || 0,
        currency: row[3] || 'ILS',
        source: row[7],
        merchant: String(row[10] || ''),
        kind: String(row[13] || ''),
        decision: String(row[16] || ''),
        note: String(row[18] || ''),
        id: String(row[19] || '')
      };
    })
    .filter(function (op) {
      return op.kind === 'поступление' && !op.decision && op.amount > 0;
    });
}

/**
 * Спрашивает про каждое поступление: доход это или перекладывание денег.
 */
function offerIncomeCandidates_(chatId) {
  var pending = pendingIncomeOperations_();
  if (!pending.length) return;

  var shown = pending.slice(0, INCOME_ASK_LIMIT_);
  tgSend_(chatId, shown.length === 1
    ? 'На счёт пришли деньги. Это доход или перевод?'
    : 'На счёт пришли деньги — ' + pending.length + ' поступлений. ' +
      'Отметьте, что из этого доход:');

  shown.forEach(function (op) {
    var guess = resolveIncomeCategory_('', op.merchant + ' ' + op.note);
    var text = [
      '<b>' + formatMoney_(op.amount, op.currency) + '</b> · ' + formatDate_(op.date),
      escapeHtml_(op.merchant || 'без названия'),
      op.note ? escapeHtml_(shorten_(op.note, 120)) : ''
    ].filter(function (line) { return line; }).join('\n');

    // «החזר חוב», «החזר כספים» — возврат долга или средств. Деньги пришли,
    // но заработаны не были, поэтому такую кнопку показываем первой
    var looksLikeRefund = /החזר|возврат|долг/i.test(op.merchant + ' ' + op.note);
    var incomeButton = { text: '💰 Доход · ' + guess.category, callback_data: 'inc:' + op.id };
    var transferButton = { text: '↔️ Перевод', callback_data: 'ninc:' + op.id };

    tgSend_(chatId, text, [looksLikeRefund
      ? [transferButton, incomeButton]
      : [incomeButton, transferButton]]);
  });

  if (pending.length > shown.length) {
    tgSend_(chatId, 'Остальные ' + (pending.length - shown.length) +
      ' покажу после следующего импорта — чтобы не заваливать чат.');
  }
}

/**
 * Заносит поступление в лист «Доходы» и связывает его со строкой выписки.
 */
function incomeFromOperation_(operationId) {
  var operation = findOperationById_(operationId);
  if (!operation) return null;

  var category = resolveIncomeCategory_('', operation.merchant + ' ' + operation.note);
  var record = appendExpense_({
    date: operation.date,
    amount: operation.amount,
    currency: operation.currency,
    kind: 'доход',
    category: category.category,
    subcategory: category.subcategory,
    description: operation.merchant || 'Поступление на счёт',
    store: '',
    author: '',
    sourceType: 'выписка',
    rawText: operation.note,
    categorySource: category.source
  });

  markOperationDecision_(operationId, record && record.id ? record.id : 'доход');
  logEvent_('Поступление занесено в доходы', {
    сумма: operation.amount, источник: operation.merchant, категория: category.category
  });

  return { record: record, category: category.category, operation: operation };
}

/**
 * Отмечает, что поступление доходом не является.
 */
function markOperationNotIncome_(operationId) {
  markOperationDecision_(operationId, 'перевод');
  return true;
}

/**
 * Общее: проставить решение в колонку связи и не спрашивать повторно.
 */
function markOperationDecision_(operationId, value) {
  var sheet = ensureSheet_(SHEET_OPERATIONS, OPERATION_COLUMNS);
  var last = sheet.getLastRow();
  if (last < 2) return false;

  var ids = sheet.getRange(2, 20, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(operationId)) {
      sheet.getRange(i + 2, 17).setValue(value);
      return true;
    }
  }
  return false;
}

/**
 * Строка выписки по её идентификатору.
 */
function findOperationById_(operationId) {
  var sheet = ensureSheet_(SHEET_OPERATIONS, OPERATION_COLUMNS);
  var last = sheet.getLastRow();
  if (last < 2) return null;

  var rows = sheet.getRange(2, 1, last - 1, OPERATION_COLUMNS.length).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][19]) === String(operationId)) {
      return {
        row: i + 2,
        date: rows[i][0],
        amount: Number(rows[i][2]) || 0,
        currency: rows[i][3] || 'ILS',
        source: rows[i][7],
        merchant: String(rows[i][10] || ''),
        kind: String(rows[i][13] || ''),
        note: String(rows[i][18] || ''),
        id: String(rows[i][19] || '')
      };
    }
  }
  return null;
}

/**
 * Команда /postupleniya: показать поступления, о которых бот ещё не спрашивал.
 */
function handlePendingIncomes_(message) {
  var chatId = message.chat.id;
  var pending = pendingIncomeOperations_();
  if (!pending.length) {
    tgSend_(chatId, 'Все поступления разобраны — новых вопросов нет.');
    return;
  }
  offerIncomeCandidates_(chatId);
}

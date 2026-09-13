/**
 * 25_Repair.gs — разбор завалов в листе «Операции».
 *
 * Нужен из-за двух ошибок сопоставления, проживших в боте с 22.08 по
 * 13.09.2026. Обе задваивали траты, и обе тихо: отчёт сходился сам с собой,
 * расхождение видно только при сверке с выпиской.
 *
 * Первая: покупку, которая ещё не проведена, карточная компания называет
 * иначе, чем проведённую («Carrefour רמת אלון חיפה» → «CARREFOUR רמת אלון ח»),
 * а сопоставление требовало точного совпадения названия. Вторая: Max
 * пересчитывает проценты по автокредиту между выгрузками, и платёж с новой
 * суммой выглядел новым платежом.
 *
 * Сам разбор чинит уже записанное; чтобы не повторялось, поправлены
 * waitingKey_ и installmentKey_ в 16_Import.gs.
 */

/**
 * Похожа ли пара строк на одну и ту же покупку: источник, карта и сумма
 * совпадают, дни рядом. Названия магазина нарочно не сравниваем — именно
 * на них разбор и спотыкался.
 */
function sameOperation_(waitRow, doneRow) {
  if (String(waitRow[7]) !== String(doneRow[7])) return false;
  if (String(waitRow[8]).replace(/\D/g, '') !== String(doneRow[8]).replace(/\D/g, '')) return false;
  if (Math.abs((Number(waitRow[2]) || 0) - (Number(doneRow[2]) || 0)) > 0.005) return false;

  var a = waitRow[0];
  var b = doneRow[0];
  if (Object.prototype.toString.call(a) !== '[object Date]') return false;
  if (Object.prototype.toString.call(b) !== '[object Date]') return false;
  // Карточные компании проводят покупку в тот же день или через несколько:
  // «Steam 17.98» ушёл в выписку 22.08, а вернулся проведённым 23.08
  return Math.abs(a.getTime() - b.getTime()) <= 4 * 24 * 60 * 60 * 1000;
}

/**
 * Ищет задвоенные строки. Возвращает {drop: [{row, why, text}], kept: n}.
 * Ничего не меняет — чтобы список можно было показать до удаления.
 */
function findDuplicateOperations_() {
  var sheet = ensureSheet_(SHEET_OPERATIONS, OPERATION_COLUMNS);
  var last = sheet.getLastRow();
  var found = { drop: [], locked: [], settle: [] };
  if (last < 2) return found;

  var rows = sheet.getRange(2, 1, last - 1, OPERATION_COLUMNS.length).getValues();
  var line = function (i) { return 2 + i; };
  var label = function (row) {
    var day = Object.prototype.toString.call(row[0]) === '[object Date]' ? formatDate_(row[0]) : String(row[0]);
    return day + ' · ' + (Number(row[2]) || 0).toFixed(2) + ' ₪ · ' + String(row[10] || '');
  };

  // 1. Ожидающая строка, у которой уже есть проведённая пара
  var taken = {};
  rows.forEach(function (waitRow, i) {
    if (String(waitRow[13]) !== 'ждёт списания') return;

    for (var j = 0; j < rows.length; j++) {
      if (j === i || taken[j]) continue;
      var doneRow = rows[j];
      if (String(doneRow[13]) === 'ждёт списания') continue;
      if (String(doneRow[14]).trim()) continue; // «не трата» — другая сущность
      if (!sameOperation_(waitRow, doneRow)) continue;

      // Обе строки склеены с одной и той же записью в «Расходах»: бот
      // принял их за две стороны одной покупки — и был прав, это она и
      // есть. Лишнюю убираем как обычный дубль, запись при этом цела
      if (String(waitRow[16]).trim() &&
          String(waitRow[16]).trim() === String(doneRow[16]).trim()) {
        taken[j] = true;
        found.drop.push({
          row: line(i),
          why: 'дубль строки ' + line(j) + ', склейка та же',
          text: label(waitRow)
        });
        return;
      }

      // Бот успевает склеить с чеком как раз ожидающую строку — она в
      // таблице раньше. Тогда убирать надо не её, а проведённую копию:
      // иначе пропадёт разобранная человеком запись. Саму строку при этом
      // дописываем по проведённой — вид, дату списания и ключ
      if (String(waitRow[16]).trim() && !String(doneRow[16]).trim()) {
        taken[j] = true;
        found.drop.push({
          row: line(j),
          why: 'дубль строки ' + line(i) + ', там склейка с чеком',
          text: label(doneRow)
        });
        found.settle.push({ row: line(i), from: line(j) });
        return;
      }

      // Обе связаны с чеком — руками надёжнее, чем угадывать
      if (String(waitRow[16]).trim()) {
        found.locked.push({ row: line(i), text: label(waitRow) });
        return;
      }
      taken[j] = true;
      found.drop.push({ row: line(i), why: 'дубль строки ' + line(j), text: label(waitRow) });
      return;
    }
  });

  // 2. Платёж по рассрочке, записанный дважды с разными суммами
  var seenInstallment = {};
  rows.forEach(function (row, i) {
    if (String(row[13]) !== 'рассрочка') return;
    var key = installmentKey_(row[7], row[8], row[0], row[10], row[18]);
    // Примечание у старых строк могло получить хвост «· null» — он приходил
    // из выгрузки Max буквальным текстом, и без него ключ тот же
    key = key.replace(/\s*·\s*null$/i, '');
    if (!seenInstallment[key]) { seenInstallment[key] = line(i); return; }

    // Остаётся строка из более свежей выгрузки — она и есть последняя оценка
    // процентов: Max пересчитал 403.18 ₪ в 396.46 ₪, и верна вторая цифра.
    // Свежая запись лежит в листе ниже, поэтому её номер и больше
    var keep = Math.max(seenInstallment[key], line(i));
    var drop = Math.min(seenInstallment[key], line(i));
    seenInstallment[key] = keep;
    if (String(rows[drop - 2][16]).trim()) {
      found.locked.push({ row: drop, text: label(rows[drop - 2]) });
      return;
    }
    found.drop.push({ row: drop, why: 'платёж уже учтён строкой ' + keep, text: label(rows[drop - 2]) });
  });

  found.drop.sort(function (a, b) { return a.row - b.row; });
  return found;
}

/**
 * Удаляет найденные дубли. Идём снизу вверх: иначе номера строк поедут.
 */
function repairOperations(chatId) {
  var found = findDuplicateOperations_();
  var sheet = ensureSheet_(SHEET_OPERATIONS, OPERATION_COLUMNS);
  var sum = 0;

  // Сначала дописываем уцелевшие строки по их проведённым копиям — пока
  // копии на месте и номера строк не поехали от удаления
  found.settle.forEach(function (item) {
    var done = sheet.getRange(item.from, 1, 1, OPERATION_COLUMNS.length).getValues()[0];
    sheet.getRange(item.row, 2).setValue(done[1] || '');
    sheet.getRange(item.row, 14).setValue(done[13]);
    sheet.getRange(item.row, 16).setValue(done[15]);
  });

  found.drop.slice().sort(function (a, b) { return b.row - a.row; }).forEach(function (item) {
    var row = sheet.getRange(item.row, 1, 1, OPERATION_COLUMNS.length).getValues()[0];
    sum += Number(row[2]) || 0;
    sheet.deleteRow(item.row);
  });

  logEvent_('Разбор задвоенных операций', {
    удалено: found.drop.length, сумма: sum, дописано: found.settle.length
  });

  if (chatId) {
    var lines = ['<b>Разбор задвоенных операций</b>'];
    if (!found.drop.length) {
      lines.push('Задвоенных строк не нашёл.');
    } else {
      lines.push('Удалено строк: <b>' + found.drop.length + '</b> на ' + sum.toFixed(2) + ' ₪');
      if (found.settle.length) {
        lines.push('Из них со склейкой сохранена ваша строка: ' + found.settle.length);
      }
      found.drop.slice(0, 20).forEach(function (item) {
        lines.push('• ' + escapeHtml_(item.text) + ' — ' + escapeHtml_(item.why));
      });
    }
    if (found.locked.length) {
      lines.push('');
      lines.push('Оставил как есть (строка связана с чеком) — посмотрите сами:');
      found.locked.forEach(function (item) {
        lines.push('• строка ' + item.row + ': ' + escapeHtml_(item.text));
      });
    }
    tgSend_(chatId, lines.join('\n'));
  }

  return {
    removed: found.drop.length, amount: sum,
    locked: found.locked.length, settled: found.settle.length
  };
}

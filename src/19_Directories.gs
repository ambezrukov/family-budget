/**
 * 19_Directories.gs — заполнение справочников «Карты» и «Источники» прямо
 * из чата.
 *
 * Зачем это команда, а не строчки в коде: номера карт, имена владельцев и
 * адреса кабинетов — личные данные семьи, а код бота лежит в открытом
 * репозитории. Через чат они попадают сразу в таблицу, минуя исходники.
 *
 * Формат сообщения — по строке на запись, поля через вертикальную черту:
 *
 *   /spravochnik карты
 *   9926 | ויזה שופרסל | Cal | Мария | продукты и рестораны | 2 | активна
 */

var DIRECTORY_TARGETS_ = {
  'карты': { sheet: 'Карты', columns: 'CARD' },
  'источники': { sheet: 'Источники', columns: 'SOURCE' }
};

function directorySpec_(word) {
  var key = String(word || '').toLowerCase().trim();
  if (!DIRECTORY_TARGETS_[key]) return null;
  var target = DIRECTORY_TARGETS_[key];
  return {
    name: target.sheet,
    sheetName: target.columns === 'CARD' ? SHEET_CARDS : SHEET_SOURCES,
    columns: target.columns === 'CARD' ? CARD_COLUMNS : SOURCE_COLUMNS
  };
}

/**
 * Разбирает строки сообщения в строки таблицы.
 */
function parseDirectoryRows_(text, columns) {
  return String(text || '').split('\n')
    .slice(1) // первая строка — сама команда
    .map(function (line) { return line.trim(); })
    .filter(function (line) { return line && line.indexOf('|') !== -1; })
    .map(function (line) {
      var cells = line.split('|').map(function (cell) { return cell.trim(); });
      // Недостающие поля дополняем пустыми: короткая строка не должна
      // сдвигать столбцы у соседних записей
      while (cells.length < columns.length) cells.push('');
      return cells.slice(0, columns.length);
    });
}

/**
 * Команда /spravochnik: заменяет содержимое справочника присланными строками.
 */
function handleDirectoryUpload_(message, text) {
  var chatId = message.chat.id;
  var firstLine = String(text || '').split('\n')[0] || '';
  var word = firstLine.replace(/^\/\S+\s*/, '').trim();
  var spec = directorySpec_(word);

  if (!spec) {
    tgSend_(chatId, 'Какой справочник заполняем? Напишите <code>/spravochnik карты</code> ' +
      'или <code>/spravochnik источники</code>, а следующими строками — сами записи, ' +
      'поля через <code>|</code>.');
    return;
  }

  var rows = parseDirectoryRows_(text, spec.columns);
  if (!rows.length) {
    tgSend_(chatId, 'В сообщении нет строк справочника. Каждая запись — своей строкой, ' +
      'поля через <code>|</code>.');
    return;
  }

  var sheet = ensureSheet_(spec.sheetName, spec.columns);
  var last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, spec.columns.length).clearContent();
  sheet.getRange(2, 1, rows.length, spec.columns.length).setValues(rows);

  logEvent_('Справочник обновлён из чата', { лист: spec.name, записей: rows.length });
  tgSend_(chatId, 'Справочник «' + spec.name + '» обновлён: записей — <b>' + rows.length + '</b>.');
}

/**
 * Команда /uchet: с какой даты подтягивать строки выписок.
 *
 * Настройка живёт в таблице, но лезть туда ради одной даты неудобно, а без
 * неё импорт затянет всю историю карты — включая месяцы, когда бюджет ещё
 * не вели.
 */
function handleAccountingStart_(message, text) {
  var chatId = message.chat.id;
  var argument = String(text || '').replace(/^\/\S+\s*/, '').trim();

  if (!argument) {
    var current = String(setting_('Учёт с', '')).trim();
    tgSend_(chatId, current
      ? 'Строки выписок беру начиная с <b>' + escapeHtml_(current) + '</b>.\n' +
        'Поменять: <code>/uchet 15.08.2026</code>'
      : 'Дата начала учёта не задана — беру всё, что есть в выписке.\n' +
        'Задать: <code>/uchet 15.08.2026</code>');
    return;
  }

  if (/^(сброс|все|всё|clear)$/i.test(argument)) {
    updateSetting_('Учёт с', '');
    tgSend_(chatId, 'Хорошо, теперь беру все строки выписки, без отсечки по дате.');
    return;
  }

  var date = parseStatementDate_(argument);
  if (!date) {
    tgSend_(chatId, 'Не понял дату. Напишите так: <code>/uchet 15.08.2026</code>');
    return;
  }

  updateSetting_('Учёт с', formatDate_(date));
  logEvent_('Задана дата начала учёта', { дата: formatDate_(date) });
  tgSend_(chatId, 'Готово. Строки выписок раньше <b>' + formatDate_(date) + '</b> ' +
    'импортироваться не будут.');
}

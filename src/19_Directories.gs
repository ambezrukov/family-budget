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

/**
 * Команда /model: посмотреть и сменить модель Gemini прямо из чата.
 *
 * Зачем: лимиты бесплатного уровня Google считает по каждой модели отдельно.
 * Когда дневная квота одной кончилась, соседняя ещё свободна — и переключение
 * должно быть делом одной строчки, а не похода в редактор скрипта.
 */
function handleModelCommand_(message, text) {
  var chatId = message.chat.id;
  var argument = String(text || '').replace(/^\/\S+\s*/, '').trim();

  if (!argument) {
    tgSend_(chatId, [
      'Сейчас работают:',
      '• чеки и голос — <b>' + escapeHtml_(modelForMedia_()) + '</b>',
      '• разбор текста — <b>' + escapeHtml_(modelForText_()) + '</b>',
      '',
      'Лимиты Google считает по каждой модели отдельно, так что при',
      '«превышена квота» помогает переход на соседнюю:',
      '<code>/model медиа gemini-2.5-flash</code>',
      '<code>/model текст gemini-2.5-flash-lite</code>',
      '',
      '<code>/model список</code> — что доступно вашему ключу',
      '<code>/model авто</code> — подобрать рабочие самостоятельно'
    ].join('\n'));
    return;
  }

  if (/^(список|list)$/i.test(argument)) {
    tgSend_(chatId, escapeHtml_(listGeminiModels()));
    return;
  }

  if (/^(авто|auto)$/i.test(argument)) {
    tgSend_(chatId, 'Перебираю модели, это займёт с полминуты…');
    tgSend_(chatId, escapeHtml_(autoSelectModels()));
    return;
  }

  var parts = argument.split(/\s+/);
  var role = parts[0].toLowerCase();
  var model = parts.slice(1).join(' ').trim();

  var setting = /^(медиа|media|чеки|голос)$/.test(role) ? 'Модель для медиа'
    : (/^(текст|text)$/.test(role) ? 'Модель для текста' : '');

  if (!setting || !model) {
    tgSend_(chatId, 'Напишите, что меняем и на что: ' +
      '<code>/model медиа gemini-2.5-flash</code>');
    return;
  }

  updateSetting_(setting, model);
  logEvent_('Модель сменена из чата', { настройка: setting, модель: model });
  tgSend_(chatId, setting + ' теперь <b>' + escapeHtml_(model) + '</b>.\n' +
    'Если модель окажется нерабочей, бот сам перейдёт к запасной, ' +
    'а <code>/model авто</code> подберёт рабочую пару.');
}

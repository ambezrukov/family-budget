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
  'источники': { sheet: 'Источники', columns: 'SOURCE' },
  'доходы': { sheet: 'Категории доходов', columns: 'CATEGORY' },
  'расходы': { sheet: 'Категории', columns: 'CATEGORY' }
};

function directorySpec_(word) {
  var key = String(word || '').toLowerCase().trim();
  if (!DIRECTORY_TARGETS_[key]) return null;
  var target = DIRECTORY_TARGETS_[key];
  var sheets = {
    CARD: { name: SHEET_CARDS, columns: CARD_COLUMNS },
    SOURCE: { name: SHEET_SOURCES, columns: SOURCE_COLUMNS },
    CATEGORY: { name: target.sheet, columns: CATEGORY_COLUMNS }
  };

  return {
    name: target.sheet,
    sheetName: sheets[target.columns].name,
    columns: sheets[target.columns].columns
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
  var word = firstLine.replace(/^\/\S+\s*/, '')
    .replace(/\s(добавить|дополнить)\s*$/i, '').trim();
  var spec = directorySpec_(word);

  if (!spec) {
    tgSend_(chatId, 'Какой справочник заполняем? Бывают <code>карты</code>, ' +
      '<code>источники</code>, <code>доходы</code> и <code>расходы</code>. ' +
      'Пишите так: <code>/spravochnik доходы</code>, а следующими строками — ' +
      'сами записи, поля через <code>|</code>. Присланный список заменяет ' +
      'справочник целиком.');
    return;
  }

  // «добавить» дописывает строки к справочнику вместо замены целиком: список
  // категорий длинный, и пересылать его ради одной новой строки неудобно
  var appendMode = /\s(добавить|дополнить)\s*$/i.test(firstLine);
  var rows = parseDirectoryRows_(text, spec.columns);
  if (!rows.length) {
    tgSend_(chatId, 'В сообщении нет строк справочника. Каждая запись — своей строкой, ' +
      'поля через <code>|</code>.');
    return;
  }

  var sheet = ensureSheet_(spec.sheetName, spec.columns);
  var last = sheet.getLastRow();

  if (!appendMode) {
    if (last > 1) sheet.getRange(2, 1, last - 1, spec.columns.length).clearContent();
    sheet.getRange(2, 1, rows.length, spec.columns.length).setValues(rows);
  } else {
    var existing = last > 1
      ? sheet.getRange(2, 1, last - 1, spec.columns.length).getValues()
      : [];

    rows.forEach(function (row) {
      // Строка с тем же названием заменяется, новая — дописывается: так одной
      // командой можно и завести категорию, и поправить соседнюю
      var found = -1;
      for (var i = 0; i < existing.length; i++) {
        if (String(existing[i][0]).trim() === row[0] &&
            String(existing[i][1]).trim() === row[1]) { found = i; break; }
      }
      if (found === -1) {
        sheet.appendRow(row);
        existing.push(row);
      } else {
        sheet.getRange(found + 2, 1, 1, spec.columns.length).setValues([row]);
      }
    });
  }

  // Ключевые слова, которые бот когда-то дописал сам, не должны перебивать
  // ручную правку
  var cleaned = 0;
  if (spec.columns === CATEGORY_COLUMNS) {
    cleaned = dropConflictingKeywords_(sheet, spec.columns, rows);
  }

  // Справочники категорий кэшируются: без сброса бот продолжил бы раскладывать
  // траты по старому списку до перезапуска
  CATEGORIES_CACHE_ = null;
  INCOME_CATEGORIES_CACHE_ = null;

  logEvent_('Справочник обновлён из чата', { лист: spec.name, записей: rows.length });
  var note = cleaned ? '\nУбрал ' + cleaned + ' конфликтующих ключевых слов из других категорий.' : '';
  tgSend_(chatId, (appendMode
    ? 'Справочник «' + spec.name + '» дополнен: строк — <b>' + rows.length + '</b>.'
    : 'Справочник «' + spec.name + '» обновлён: записей — <b>' + rows.length + '</b>.') + note);
}

/**
 * Убирает ключевые слова из других строк справочника.
 *
 * Зачем. Разобрав магазин, бот дописывает его полное название в ключевые
 * слова той категории, куда его отнёс. Если решение было неверным, человек
 * правит справочник — но автодобавленное название длиннее, а выигрывает
 * самое длинное совпадение, и правка не действует. Поэтому при ручной правке
 * конфликтующие ключи из чужих строк вычищаются.
 */
function dropConflictingKeywords_(sheet, columns, rows) {
  var last = sheet.getLastRow();
  if (last < 2) return 0;

  var table = sheet.getRange(2, 1, last - 1, columns.length).getValues();
  var removed = 0;

  rows.forEach(function (row) {
    var ours = String(row[2] || '').toLowerCase().split(',')
      .map(function (word) { return word.trim(); })
      .filter(function (word) { return word.length > 2; });
    if (!ours.length) return;

    table.forEach(function (existing, index) {
      // Свою же строку не трогаем
      if (String(existing[0]).trim() === row[0] && String(existing[1]).trim() === row[1]) return;

      var keywords = String(existing[2] || '').split(',')
        .map(function (word) { return word.trim(); })
        .filter(function (word) { return word; });

      var kept = keywords.filter(function (word) {
        var lower = word.toLowerCase();
        return !ours.some(function (our) {
          // Чужой ключ мешает, если он и есть наш или содержит его целиком:
          // «יופיי סבטלנה זינגר» перебивает «זינגר»
          return lower === our || lower.indexOf(our) !== -1;
        });
      });

      if (kept.length === keywords.length) return;
      removed += keywords.length - kept.length;
      sheet.getRange(index + 2, 3).setValue(kept.join(', '));
      existing[2] = kept.join(', ');
    });
  });

  if (removed) logEvent_('Убраны конфликтующие ключевые слова', { слов: removed });
  return removed;
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

  var older = countOperationsBefore_(date);
  if (!older) {
    tgSend_(chatId, 'Готово. Строки выписок раньше <b>' + formatDate_(date) + '</b> ' +
      'импортироваться не будут.');
    return;
  }

  // Строки могли попасть раньше — например, когда отсечка ещё не работала.
  // Удалять молча нельзя: вдруг они там нужны
  tgSend_(chatId, 'Готово, отсечка стоит на <b>' + formatDate_(date) + '</b>.\n\n' +
    'В листе «Операции» уже лежит строк раньше этой даты: <b>' + older + '</b>. Убрать их?',
    [[
      { text: 'Убрать ' + older, callback_data: 'dropold' },
      { text: 'Оставить', callback_data: 'keepold' }
    ]]);
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
      'Вмешиваться обычно не нужно: лимиты Google считает по каждой модели',
      'отдельно, и когда у одной кончается дневной запас, бот сам переходит',
      'к следующей — от новых к старым. Наутро, когда лимит обновится,',
      'он так же сам возвращается обратно.',
      '',
      'Если всё-таки хочется вручную:',
      '<code>/model медиа gemini-2.5-flash</code> — задать модель для чеков',
      '<code>/model список</code> — что доступно вашему ключу',
      '<code>/model авто</code> — перебрать и выбрать рабочую пару'
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

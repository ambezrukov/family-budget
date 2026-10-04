/**
 * 26_Corrections.gs — правки отдельных строк файлом.
 *
 * Кнопки бота решают по одному вопросу за раз, а после сверки выписок правок
 * набирается десятки: категория не та, снятие наличных посчитано тратой,
 * перевод склеен не с той записью. Править их руками в таблице долго и легко
 * промахнуться строкой.
 *
 * Поэтому правки собираются в файл «правки ….csv» в той же папке, что и
 * выписки, а команда /pravki применяет их и отчитывается по каждой строке.
 * Строка файла — одна правка:
 *
 *   ID,Действие,Значение,Пояснение
 *   261004213631-ace3abfd81,связь,260930170729-c4871608dc,Лиля — занятия Майи
 *   261004213603-0378409cab,категория,Дети / Кружки и секции,скалодром
 *   סופרפארם,слово,Здоровье и аптека / Аптека,чтобы не уезжало в продукты
 *
 * ID — строки листа «Операции» или записи «Расходов»/«Доходов». Для действия
 * «слово» вместо ID пишется само ключевое слово.
 *
 * Действия:
 *   категория  — «Категория / Подкатегория»; строка выписки помечается
 *                «вручную», и /kategorii заново её уже не перекладывает
 *   не трата   — «да» или «нет»
 *   связь      — ID записи, «перевод», «отдельно» или пусто: с чем склеена
 *                строка выписки
 *   удалить    — запись «Расходов» или «Доходов» (мягко, как кнопкой)
 *   слово      — дописать ключевое слово в справочник категорий и убрать его
 *                из чужих строк
 *
 * «/pravki проверить» только проверяет файл и ничего не меняет.
 */

var CORRECTIONS_PREFIX_ = 'правки';
var CORRECTIONS_REPORT_LIMIT_ = 25;

/**
 * Файл с правками, а не выписка: по имени.
 */
function isCorrectionsFile_(fileName) {
  var name = String(fileName || '').toLowerCase().trim();
  return name.indexOf(CORRECTIONS_PREFIX_) === 0 && /\.csv$/.test(name);
}

/**
 * Строки файла → [{line, id, action, value, comment}].
 * Шапка и пустые строки пропускаются.
 */
function parseCorrections_(rows) {
  var result = [];
  (rows || []).forEach(function (row, index) {
    var id = String(row[0] == null ? '' : row[0]).trim();
    var action = String(row[1] == null ? '' : row[1]).trim().toLowerCase();
    if (!id && !action) return;
    if (index === 0 && id.toLowerCase() === 'id') return;
    result.push({
      line: index + 1,
      id: id,
      action: action,
      value: String(row[2] == null ? '' : row[2]).trim(),
      comment: String(row[3] == null ? '' : row[3]).trim()
    });
  });
  return result;
}

/**
 * «Категория / Подкатегория» → {category, subcategory}.
 */
function splitCategoryPair_(value) {
  var parts = String(value || '').split('/');
  return {
    category: String(parts[0] || '').trim(),
    subcategory: parts.slice(1).join('/').trim()
  };
}

/**
 * Применяет правки. dryRun — только проверить.
 * Возвращает {applied, failed: [{line, text}], done: [text]}.
 */
function applyCorrections_(corrections, dryRun) {
  var sheet = ensureSheet_(SHEET_OPERATIONS, OPERATION_COLUMNS);
  var last = sheet.getLastRow();
  var rows = last >= 2 ? sheet.getRange(2, 1, last - 1, OPERATION_COLUMNS.length).getValues() : [];

  var byId = {};
  rows.forEach(function (row, position) {
    var id = String(row[19] || '').trim();
    if (id) byId[id] = { row: position + 2, values: row };
  });

  // Шапка новой колонки: лист, заведённый до её появления, сам её не получит
  if (!dryRun && last >= 1 && !String(sheet.getRange(1, 21).getValues()[0][0] || '').trim()) {
    sheet.getRange(1, 21).setValue(OPERATION_COLUMNS[20]);
  }

  var expenseNames = categoryNames_();
  var incomeNames = incomeCategoryNames_();
  var result = { applied: 0, failed: [], done: [] };

  var fail = function (item, text) { result.failed.push({ line: item.line, text: text }); };
  var ok = function (item, text) {
    result.applied++;
    result.done.push(text + (item.comment ? ' — ' + item.comment : ''));
  };
  var label = function (operation) {
    var v = operation.values;
    return formatDate_(v[0]) + ' · ' + formatMoney_(Number(v[2]) || 0, v[3] || 'ILS') + ' · ' +
      withRussianHint_(String(v[10] || ''));
  };

  corrections.forEach(function (item) {
    var operation = byId[item.id];

    switch (item.action) {
      case 'категория': {
        var pair = splitCategoryPair_(item.value);
        if (!pair.category) { fail(item, 'не указана категория'); return; }

        if (operation) {
          if (expenseNames.indexOf(pair.category) === -1) {
            fail(item, 'нет такой категории расходов: «' + pair.category + '»');
            return;
          }
          if (!dryRun) {
            if (pair.subcategory) addCategoryIfMissing_(pair.category, pair.subcategory);
            sheet.getRange(operation.row, 12, 1, 2).setValues([[pair.category, pair.subcategory]]);
            sheet.getRange(operation.row, 21).setValue('вручную');
          }
          ok(item, label(operation) + ' → ' + item.value);
          return;
        }

        var record = locateRecord_(item.id);
        if (!record) { fail(item, 'строка не найдена: ' + item.id); return; }
        var names = record.sheetName === SHEET_INCOMES ? incomeNames : expenseNames;
        if (names.indexOf(pair.category) === -1) {
          fail(item, 'нет такой категории в листе «' + record.sheetName + '»: «' + pair.category + '»');
          return;
        }
        if (!dryRun) updateExpenseCategory_(item.id, pair.category, pair.subcategory);
        ok(item, record.sheetName + ', запись ' + item.id + ' → ' + item.value);
        return;
      }

      case 'не трата': {
        if (!operation) { fail(item, 'строка выписки не найдена: ' + item.id); return; }
        var flag = /^(да|yes|1)$/i.test(item.value) ? 'да' : '';
        if (!flag && !/^(нет|no|0|)$/i.test(item.value)) {
          fail(item, 'для «не трата» пишется «да» или «нет»');
          return;
        }
        if (!dryRun) sheet.getRange(operation.row, 15).setValue(flag);
        ok(item, label(operation) + (flag ? ' → не трата' : ' → снова трата'));
        return;
      }

      case 'связь': {
        if (!operation) { fail(item, 'строка выписки не найдена: ' + item.id); return; }
        var link = item.value;
        if (link && link !== 'перевод' && link !== 'отдельно' && !locateRecord_(link)) {
          fail(item, 'запись для склейки не найдена: ' + link);
          return;
        }
        if (!dryRun) sheet.getRange(operation.row, 17).setValue(link);
        ok(item, label(operation) + ' → ' + (link ? 'связь: ' + link : 'связь снята'));
        return;
      }

      case 'удалить': {
        var target = locateRecord_(item.id);
        if (!target) { fail(item, 'запись не найдена: ' + item.id); return; }
        if (!dryRun) markExpenseDeleted_(item.id);
        ok(item, target.sheetName + ', запись ' + item.id + ' удалена');
        return;
      }

      case 'слово': {
        var keyword = item.id.toLowerCase();
        var where = splitCategoryPair_(item.value);
        if (keyword.length < 3) { fail(item, 'слово короче трёх букв: «' + item.id + '»'); return; }
        if (expenseNames.indexOf(where.category) === -1) {
          fail(item, 'нет такой категории расходов: «' + where.category + '»');
          return;
        }
        if (!dryRun) {
          addCategoryIfMissing_(where.category, where.subcategory);
          rememberStoreCategory_(keyword, where.category, where.subcategory);
          var dictionary = ensureSheet_(SHEET_CATEGORIES, CATEGORY_COLUMNS);
          dropConflictingKeywords_(dictionary, CATEGORY_COLUMNS,
            [[where.category, where.subcategory, keyword]]);
          CATEGORIES_CACHE_ = null;
        }
        ok(item, 'в справочнике: «' + item.id + '» → ' + item.value);
        return;
      }

      default:
        fail(item, 'непонятное действие «' + item.action + '»');
    }
  });

  if (!dryRun && result.applied) {
    logEvent_('Применены правки', { применено: result.applied, ошибок: result.failed.length });
  }
  return result;
}

/**
 * Команда /pravki: применить свежие файлы правок из папки выписок.
 */
function handleCorrectionsCommand_(message, text) {
  var chatId = message.chat.id;
  var dryRun = /\s(проверить|проверка|check)\s*$/i.test(String(text || ''));

  var folder = statementsFolder_();
  if (folder.error) {
    tgSend_(chatId, 'Папку с выписками не нашёл: ' + escapeHtml_(folder.error) + '.');
    return;
  }

  var done = importedFileKeys_();
  var fresh = [];
  var files = folder.folder.getFiles();
  while (files.hasNext()) {
    var file = files.next();
    if (!isCorrectionsFile_(file.getName())) continue;
    var key = 'pravki:' + file.getId() + ':' + file.getLastUpdated().getTime();
    if (done[key]) continue;
    fresh.push({ file: file, key: key });
  }

  if (!fresh.length) {
    tgSend_(chatId, 'Новых файлов правок в папке «' + escapeHtml_(folder.name) + '» нет. ' +
      'Имя файла должно начинаться со слова «правки» и заканчиваться на .csv.');
    return;
  }

  fresh.forEach(function (item) {
    var name = item.file.getName();
    var corrections = parseCorrections_(rowsFromCsv_(item.file.getBlob()));
    var result = applyCorrections_(corrections, dryRun);

    if (!dryRun) {
      ensureSheet_(SHEET_IMPORTS, IMPORT_COLUMNS).appendRow([
        new Date(), name, 'Правки', '', corrections.length, result.applied, 0,
        result.failed.length, item.key
      ]);
    }

    tgSend_(chatId, correctionsReportText_(name, corrections.length, result, dryRun));
  });
}

/**
 * Отчёт по одному файлу правок.
 */
function correctionsReportText_(name, total, result, dryRun) {
  var lines = [
    '<b>' + escapeHtml_(name) + '</b>' + (dryRun ? ' · проверка, ничего не менял' : ''),
    (dryRun ? 'Можно применить: ' : 'Применено: ') + '<b>' + result.applied + '</b> из ' + total
  ];

  if (result.failed.length) {
    lines.push('');
    lines.push('Не получилось — ' + result.failed.length + ':');
    result.failed.slice(0, CORRECTIONS_REPORT_LIMIT_).forEach(function (f) {
      lines.push('• строка ' + f.line + ': ' + escapeHtml_(f.text));
    });
  }

  if (result.done.length) {
    lines.push('');
    result.done.slice(0, CORRECTIONS_REPORT_LIMIT_).forEach(function (text) {
      lines.push('• ' + escapeHtml_(text));
    });
    if (result.done.length > CORRECTIONS_REPORT_LIMIT_) {
      lines.push('…и ещё ' + (result.done.length - CORRECTIONS_REPORT_LIMIT_));
    }
  }

  if (!dryRun && result.failed.length) {
    lines.push('');
    lines.push('<i>Исправьте эти строки и положите файл под новым именем — ' +
      'применённые правки повторять безопасно.</i>');
  }
  return lines.join('\n');
}

/**
 * 01_Sheets.gs — работа с Google-таблицей: создание листов, запись и чтение
 * расходов, справочник категорий, лог.
 *
 * Все обращения к таблице собраны здесь, чтобы остальной код не знал ни про
 * номера столбцов, ни про формат хранения.
 */

// ---------------------------------------------------------------------------
// Структура листа «Расходы». Порядок столбцов = порядок в массиве.
// ---------------------------------------------------------------------------

var EXPENSE_COLUMNS = [
  'Создано',            // 1  — дата и время создания записи
  'Дата расхода',       // 2
  'Сумма',              // 3
  'Валюта',             // 4
  'Сумма в базовой',    // 5  — пересчёт в шекели
  'Категория',          // 6
  'Подкатегория',       // 7
  'Описание',           // 8
  'Магазин',            // 9
  'Позиции чека',       // 10
  'Автор',              // 11
  'Способ ввода',       // 12 — текст / голос / фото
  'Исходный текст',     // 13 — сообщение или расшифровка голоса
  'Источник категории', // 14 — словарь / модель / вручную
  'Ссылка на файл',     // 15
  'Удалено',            // 16 — «да» или пусто
  'ID'                  // 17 — служебный ключ для кнопок «Изменить»/«Удалить»
];

var COL_CREATED = 1;
var COL_DATE = 2;
var COL_AMOUNT = 3;
var COL_CURRENCY = 4;
var COL_BASE_AMOUNT = 5;
var COL_CATEGORY = 6;
var COL_SUBCATEGORY = 7;
var COL_DESCRIPTION = 8;
var COL_STORE = 9;
var COL_ITEMS = 10;
var COL_AUTHOR = 11;
var COL_SOURCE_TYPE = 12;
var COL_RAW_TEXT = 13;
var COL_CATEGORY_SOURCE = 14;
var COL_FILE_LINK = 15;
var COL_DELETED = 16;
var COL_ID = 17;

var CATEGORY_COLUMNS = ['Категория', 'Подкатегория', 'Ключевые слова'];
var TRANSLATION_COLUMNS = ['Оригинал', 'Перевод', 'Что это', 'Впервые встретилось'];
var SETTINGS_COLUMNS = ['Параметр', 'Значение', 'Пояснение'];
var LOG_COLUMNS = ['Время', 'Событие', 'Подробности'];

// ---------------------------------------------------------------------------
// Доступ к таблице
// ---------------------------------------------------------------------------

var SPREADSHEET_CACHE_ = null;

/**
 * Таблица берётся по идентификатору из свойств скрипта; если свойство не задано,
 * пробуем таблицу, к которой привязан скрипт.
 */
function getSpreadsheet_() {
  if (SPREADSHEET_CACHE_) return SPREADSHEET_CACHE_;
  var id = scriptProp_(PROP_SPREADSHEET_ID);
  if (id) {
    SPREADSHEET_CACHE_ = SpreadsheetApp.openById(id);
  } else {
    SPREADSHEET_CACHE_ = SpreadsheetApp.getActiveSpreadsheet();
  }
  if (!SPREADSHEET_CACHE_) {
    throw new Error('Не задано свойство скрипта ' + PROP_SPREADSHEET_ID + ' и скрипт не привязан к таблице');
  }
  return SPREADSHEET_CACHE_;
}

/**
 * Возвращает лист, создавая его при необходимости и проставляя шапку.
 */
function ensureSheet_(name, columns) {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, columns.length).setValues([columns]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function expensesSheet_() {
  return ensureSheet_(SHEET_EXPENSES, EXPENSE_COLUMNS);
}

// ---------------------------------------------------------------------------
// Запись расхода
// ---------------------------------------------------------------------------

/**
 * Пишет запись в таблицу.
 *
 * record: {
 *   date: Date, amount: number, currency: string,
 *   category, subcategory, description, store, items,
 *   author, sourceType, rawText, categorySource, fileLink
 * }
 * sheetName — необязательный: по умолчанию «Расходы», но структура листов
 * одинаковая, поэтому та же функция запишет и в «Доходы».
 * Возвращает объект с добавленным id.
 */
function appendExpense_(record, sheetName) {
  // Лист выбирается по виду операции: доход — в «Доходы», всё остальное
  // (включая возврат, он же отрицательная трата) — в «Расходы»
  var target = sheetName || (record.kind === 'доход' ? SHEET_INCOMES : SHEET_EXPENSES);
  var sheet = ensureSheet_(target, EXPENSE_COLUMNS);
  var id = newRecordId_();
  var currency = String(record.currency || baseCurrency_()).toUpperCase();
  var amount = Number(record.amount) || 0;

  var row = [];
  row[COL_CREATED - 1] = new Date();
  row[COL_DATE - 1] = record.date || new Date();
  row[COL_AMOUNT - 1] = amount;
  row[COL_CURRENCY - 1] = currency;
  row[COL_BASE_AMOUNT - 1] = toBaseAmount_(amount, currency);
  row[COL_CATEGORY - 1] = record.category || 'Без категории';
  row[COL_SUBCATEGORY - 1] = record.subcategory || '';
  row[COL_DESCRIPTION - 1] = record.description || '';
  row[COL_STORE - 1] = record.store || '';
  row[COL_ITEMS - 1] = record.items || '';
  row[COL_AUTHOR - 1] = record.author || '';
  row[COL_SOURCE_TYPE - 1] = record.sourceType || 'текст';
  row[COL_RAW_TEXT - 1] = record.rawText || '';
  row[COL_CATEGORY_SOURCE - 1] = record.categorySource || '';
  row[COL_FILE_LINK - 1] = record.fileLink || '';
  row[COL_DELETED - 1] = '';
  row[COL_ID - 1] = id;

  sheet.appendRow(row);

  record.id = id;
  record.baseAmount = row[COL_BASE_AMOUNT - 1];
  record.currency = currency;
  record.amount = amount;
  return record;
}

/**
 * Короткий уникальный идентификатор записи.
 * Нужен, чтобы кнопки «Изменить категорию» и «Удалить» находили свою строку
 * даже если строки в таблице двигали руками. Укладывается в лимит
 * callback_data (64 байта).
 */
function newRecordId_() {
  // Метка времени оставлена ради читаемости: по идентификатору видно, когда
  // запись сделана. А вот хвост берём из UUID, а не из случайного числа:
  // траты из одного сообщения пишутся в одну и ту же секунду, и трёх цифр
  // мало — при совпадении кнопки «Удалить» и «Изменить категорию» попадали
  // бы в чужую строку.
  var stamp = Utilities.formatDate(new Date(), tz_(), 'yyMMddHHmmss');
  var tail = String(Utilities.getUuid()).replace(/-/g, '').substring(0, 10);
  return stamp + '-' + tail;
}

/**
 * Находит номер строки по идентификатору записи. 0 — не найдено.
 */
function findRowById_(id, sheetName) {
  var sheet = sheetName ? ensureSheet_(sheetName, EXPENSE_COLUMNS) : expensesSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var ids = sheet.getRange(2, COL_ID, last - 1, 1).getValues();
  for (var i = ids.length - 1; i >= 0; i--) { // с конца: свежие записи ищутся быстрее
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return 0;
}

/**
 * Ищет запись по идентификатору сразу в обоих листах.
 *
 * Кнопки под сообщением несут только идентификатор: класть туда ещё и лист
 * негде — телеграм отводит на всю кнопку 64 байта. Да и лист у записи может
 * смениться, если её перенесли из расходов в доходы.
 *
 * Возвращает {sheetName, sheet, row} или null.
 */
function locateRecord_(id) {
  var sheetNames = [SHEET_EXPENSES, SHEET_INCOMES];
  for (var i = 0; i < sheetNames.length; i++) {
    var row = findRowById_(id, sheetNames[i]);
    if (row) {
      return {
        sheetName: sheetNames[i],
        sheet: ensureSheet_(sheetNames[i], EXPENSE_COLUMNS),
        row: row
      };
    }
  }
  return null;
}

/**
 * Читает одну запись по идентификатору. null — не найдена.
 */
function readExpenseById_(id) {
  var found = locateRecord_(id);
  if (!found) return null;
  var values = found.sheet.getRange(found.row, 1, 1, EXPENSE_COLUMNS.length).getValues()[0];
  return {
    row: found.row,
    sheetName: found.sheetName,
    kind: found.sheetName === SHEET_INCOMES ? 'доход' : 'расход',
    items: String(values[COL_ITEMS - 1] || ''),
    author: String(values[COL_AUTHOR - 1] || ''),
    sourceType: String(values[COL_SOURCE_TYPE - 1] || ''),
    rawText: String(values[COL_RAW_TEXT - 1] || ''),
    fileLink: String(values[COL_FILE_LINK - 1] || ''),
    date: values[COL_DATE - 1],
    amount: Number(values[COL_AMOUNT - 1]) || 0,
    currency: String(values[COL_CURRENCY - 1] || ''),
    category: String(values[COL_CATEGORY - 1] || ''),
    subcategory: String(values[COL_SUBCATEGORY - 1] || ''),
    description: String(values[COL_DESCRIPTION - 1] || ''),
    store: String(values[COL_STORE - 1] || ''),
    id: String(values[COL_ID - 1] || '')
  };
}

/**
 * Помечает запись удалённой (физически строка остаётся).
 */
function markExpenseDeleted_(id) {
  var found = locateRecord_(id);
  if (!found) return false;
  found.sheet.getRange(found.row, COL_DELETED).setValue('да');
  return true;
}

/**
 * Меняет категорию записи и помечает источник как «вручную».
 */
function updateExpenseCategory_(id, category, subcategory) {
  var found = locateRecord_(id);
  if (!found) return false;
  found.sheet.getRange(found.row, COL_CATEGORY).setValue(category);
  found.sheet.getRange(found.row, COL_SUBCATEGORY).setValue(subcategory || '');
  found.sheet.getRange(found.row, COL_CATEGORY_SOURCE).setValue('вручную');
  return true;
}

/**
 * Переименовывает автора в уже записанных строках.
 *
 * Нужно при смене имени: записи, сделанные до того, подписаны прежним именем —
 * телеграмным или предыдущим настроенным. Без этого в отчётах и мини-приложении
 * один человек выглядит двумя.
 *
 * Возвращает число исправленных строк.
 */
function renameAuthorInExpenses_(oldNames, newName) {
  var wanted = (oldNames || []).map(function (name) {
    return String(name || '').trim().toLowerCase();
  }).filter(function (name) { return name && name !== String(newName).trim().toLowerCase(); });

  if (!wanted.length) return 0;

  var changed = 0;

  // Доходы правим тоже: иначе человек, переименовавшись, останется в отчёте
  // по доходам под старым именем
  [SHEET_EXPENSES, SHEET_INCOMES].forEach(function (sheetName) {
    var sheet = ensureSheet_(sheetName, EXPENSE_COLUMNS);
    var last = sheet.getLastRow();
    if (last < 2) return;

    var range = sheet.getRange(2, COL_AUTHOR, last - 1, 1);
    var values = range.getValues();
    var touched = 0;

    for (var i = 0; i < values.length; i++) {
      var current = String(values[i][0] || '').trim();
      if (current && wanted.indexOf(current.toLowerCase()) !== -1) {
        values[i][0] = newName;
        touched++;
      }
    }

    if (touched) {
      range.setValues(values);
      changed += touched;
    }
  });

  return changed;
}

/**
 * Все имена авторов, встречающиеся в записях, с числом записей у каждого.
 *
 * Нужно, чтобы показать человеку, под какими именами он успел записаться:
 * пока имя не задано, записи подписываются именем из телеграма, и один
 * человек в отчётах выглядит двумя-тремя.
 */
function authorCounts_() {
  var counts = {};

  [SHEET_EXPENSES, SHEET_INCOMES].forEach(function (sheetName) {
    var sheet = ensureSheet_(sheetName, EXPENSE_COLUMNS);
    var last = sheet.getLastRow();
    if (last < 2) return;

    var values = sheet.getRange(2, 1, last - 1, EXPENSE_COLUMNS.length).getValues();
    values.forEach(function (row) {
      if (String(row[COL_DELETED - 1]).trim() !== '') return; // удалённые не в счёт
      var name = String(row[COL_AUTHOR - 1] || '').trim();
      if (!name) return;
      counts[name] = (counts[name] || 0) + 1;
    });
  });

  return Object.keys(counts)
    .map(function (name) { return { name: name, count: counts[name] }; })
    .sort(function (a, b) { return b.count - a.count; });
}

// ---------------------------------------------------------------------------
// Чтение расходов
// ---------------------------------------------------------------------------

/**
 * Читает все неудалённые расходы как массив объектов.
 * options: {from: Date, to: Date} — фильтр по дате расхода (границы включительно).
 */
function readExpenses_(options) {
  options = options || {};
  var sheet = options.sheetName
    ? ensureSheet_(options.sheetName, EXPENSE_COLUMNS)
    : expensesSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var values = sheet.getRange(2, 1, last - 1, EXPENSE_COLUMNS.length).getValues();
  var result = [];

  for (var i = 0; i < values.length; i++) {
    var r = values[i];
    if (String(r[COL_DELETED - 1]).trim() !== '') continue; // удалённые игнорируем везде
    var date = r[COL_DATE - 1] instanceof Date ? r[COL_DATE - 1] : parseCellDate_(r[COL_DATE - 1]);
    if (!date) continue;
    if (options.from && date < options.from) continue;
    if (options.to && date > options.to) continue;

    result.push({
      row: i + 2,
      created: r[COL_CREATED - 1],
      date: date,
      amount: Number(r[COL_AMOUNT - 1]) || 0,
      currency: String(r[COL_CURRENCY - 1] || ''),
      baseAmount: Number(r[COL_BASE_AMOUNT - 1]) || 0,
      category: String(r[COL_CATEGORY - 1] || ''),
      subcategory: String(r[COL_SUBCATEGORY - 1] || ''),
      description: String(r[COL_DESCRIPTION - 1] || ''),
      store: String(r[COL_STORE - 1] || ''),
      items: String(r[COL_ITEMS - 1] || ''),
      author: String(r[COL_AUTHOR - 1] || ''),
      sourceType: String(r[COL_SOURCE_TYPE - 1] || ''),
      rawText: String(r[COL_RAW_TEXT - 1] || ''),
      categorySource: String(r[COL_CATEGORY_SOURCE - 1] || ''),
      fileLink: String(r[COL_FILE_LINK - 1] || ''),
      id: String(r[COL_ID - 1] || '')
    });
  }
  return result;
}

/**
 * Дата из ячейки: в норме это объект Date, но если столбец отформатирован как
 * текст — разбираем «дд.мм.гггг».
 */
function parseCellDate_(value) {
  if (value instanceof Date) return value;
  var s = String(value || '').trim();
  if (!s) return null;
  var m = s.match(/^(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{2,4})/);
  if (m) {
    var year = parseInt(m[3], 10);
    if (year < 100) year += 2000;
    return new Date(year, parseInt(m[2], 10) - 1, parseInt(m[1], 10));
  }
  var parsed = new Date(s);
  return isNaN(parsed.getTime()) ? null : parsed;
}

// ---------------------------------------------------------------------------
// Справочник категорий
// ---------------------------------------------------------------------------

var CATEGORIES_CACHE_ = null;

/**
 * Читает лист «Категории» → [{category, subcategory, keywords: [...]}].
 */
function readCategories_() {
  if (CATEGORIES_CACHE_) return CATEGORIES_CACHE_;
  CATEGORIES_CACHE_ = readCategorySheet_(SHEET_CATEGORIES);
  return CATEGORIES_CACHE_;
}

var INCOME_CATEGORIES_CACHE_ = null;

/**
 * Справочник доходов — отдельный лист. Слова там свои: «зарплата» в списке
 * расходных категорий не нужна, а «продукты» — в доходных.
 */
function readIncomeCategories_() {
  if (INCOME_CATEGORIES_CACHE_) return INCOME_CATEGORIES_CACHE_;

  var list = readCategorySheet_(SHEET_INCOME_CATEGORIES);

  // В таблице, заведённой до появления доходов, лист создастся пустым.
  // Заполняем его сам собой: иначе первый же доход упадёт в «Прочие»,
  // а человек будет гадать, почему справочник не работает.
  if (!list.length) {
    try {
      var sheet = ensureSheet_(SHEET_INCOME_CATEGORIES, CATEGORY_COLUMNS);
      var rows = starterIncomeCategories_();
      sheet.getRange(2, 1, rows.length, 3).setValues(rows);
      logEvent_('Создан справочник доходов', { категорий: rows.length });
      list = readCategorySheet_(SHEET_INCOME_CATEGORIES);
    } catch (err) {
      logEvent_('Не удалось создать справочник доходов', String(err));
    }
  }

  INCOME_CATEGORIES_CACHE_ = list;
  return list;
}

function incomeCategoryNames_() {
  var seen = {};
  var names = [];
  readIncomeCategories_().forEach(function (item) {
    if (!seen[item.category]) {
      seen[item.category] = true;
      names.push(item.category);
    }
  });
  return names;
}

/**
 * Общее чтение справочника категорий с любого листа.
 */
function readCategorySheet_(sheetName) {
  var sheet = ensureSheet_(sheetName, CATEGORY_COLUMNS);
  var last = sheet.getLastRow();
  var list = [];
  if (last >= 2) {
    var values = sheet.getRange(2, 1, last - 1, 3).getValues();
    for (var i = 0; i < values.length; i++) {
      var category = String(values[i][0] || '').trim();
      if (!category) continue;
      list.push({
        category: category,
        subcategory: String(values[i][1] || '').trim(),
        keywords: String(values[i][2] || '')
          .split(/[,;]+/)
          .map(function (s) { return s.trim().toLowerCase(); })
          .filter(function (s) { return s.length > 1; })
      });
    }
  }
  return list;
}

/**
 * Записи листа «Доходы»: структура та же, отличается только лист.
 */
function readIncomes_(options) {
  var params = {};
  Object.keys(options || {}).forEach(function (key) { params[key] = options[key]; });
  params.sheetName = SHEET_INCOMES;
  return readExpenses_(params);
}

/**
 * Список уникальных названий категорий — его передаём модели.
 */
function categoryNames_() {
  var seen = {};
  var names = [];
  readCategories_().forEach(function (item) {
    if (!seen[item.category]) {
      seen[item.category] = true;
      names.push(item.category);
    }
  });
  return names;
}

/**
 * Подкатегории конкретной категории.
 */
function subcategoriesOf_(category) {
  var result = [];
  readCategories_().forEach(function (item) {
    if (item.category === category && item.subcategory && result.indexOf(item.subcategory) === -1) {
      result.push(item.subcategory);
    }
  });
  return result;
}

/**
 * Добавляет новую категорию в справочник (когда модель предложила свою).
 */
function addCategoryIfMissing_(category, subcategory) {
  category = String(category || '').trim();
  if (!category) return;
  var exists = readCategories_().some(function (item) {
    return item.category === category && item.subcategory === String(subcategory || '').trim();
  });
  if (exists) return;
  var sheet = ensureSheet_(SHEET_CATEGORIES, CATEGORY_COLUMNS);
  sheet.appendRow([category, subcategory || '', '']);
  CATEGORIES_CACHE_ = null;
}

// ---------------------------------------------------------------------------
// Словарь переводов
// ---------------------------------------------------------------------------

var TRANSLATIONS_CACHE_ = null;

/**
 * Читает лист «Переводы» в объект {нормализованный оригинал: перевод}.
 *
 * Словарь нужен ради постоянства: без него модель переводит «שופרסל» то как
 * «Шуферсаль», то как «Шуфersal», и в таблице заводятся два разных магазина.
 * Первый перевод запоминается и дальше используется всегда.
 */
function readTranslations_() {
  if (TRANSLATIONS_CACHE_) return TRANSLATIONS_CACHE_;

  var sheet = ensureSheet_(SHEET_TRANSLATIONS, TRANSLATION_COLUMNS);
  var map = {};
  var last = sheet.getLastRow();

  if (last >= 2) {
    var values = sheet.getRange(2, 1, last - 1, 2).getValues();
    values.forEach(function (row) {
      var original = normalizeForDictionary_(row[0]);
      var translation = String(row[1] || '').trim();
      if (original && translation) map[original] = translation;
    });
  }

  TRANSLATIONS_CACHE_ = map;
  return map;
}

/**
 * Ключ словаря: без регистра, без лишних пробелов и кавычек.
 * «ШУФЕРСАЛЬ  ДИЛ» и «шуферсаль дил» — одно и то же название.
 */
function normalizeForDictionary_(text) {
  return String(text || '')
    .replace(/["'«»]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Возвращает сохранённый перевод или пустую строку.
 */
function knownTranslation_(original) {
  var key = normalizeForDictionary_(original);
  if (!key) return '';
  return readTranslations_()[key] || '';
}

/**
 * Запоминает перевод. Существующие записи не перезаписываются — иначе
 * постоянство, ради которого словарь и заведён, потеряется.
 */
function rememberTranslation_(original, translation, kind) {
  var key = normalizeForDictionary_(original);
  var value = String(translation || '').trim();
  if (!key || !value) return;
  if (readTranslations_()[key]) return;

  var sheet = ensureSheet_(SHEET_TRANSLATIONS, TRANSLATION_COLUMNS);
  sheet.appendRow([String(original).trim(), value, kind || '', new Date()]);
  readTranslations_()[key] = value; // чтобы в этом же запуске подхватилось
}

/**
 * Меняет значение на листе «Настройки». Строка ищется по названию параметра
 * в первом столбце; если её нет — добавляется.
 */
function updateSetting_(key, value) {
  var sheet = ensureSheet_(SHEET_SETTINGS, SETTINGS_COLUMNS);
  var last = sheet.getLastRow();

  if (last >= 2) {
    var names = sheet.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < names.length; i++) {
      if (String(names[i][0]).trim() === key) {
        sheet.getRange(i + 2, 2).setValue(value);
        SETTINGS_CACHE_ = null;
        return;
      }
    }
  }

  sheet.appendRow([key, value, '']);
  SETTINGS_CACHE_ = null;
}

// ---------------------------------------------------------------------------
// Лог
// ---------------------------------------------------------------------------

/**
 * Пишет строку в лист «Лог». Никогда не бросает исключение: лог не должен
 * ронять обработку сообщения.
 */
function logEvent_(event, details) {
  try {
    var sheet = ensureSheet_(SHEET_LOG, LOG_COLUMNS);
    var text = typeof details === 'string' ? details : JSON.stringify(details);
    if (text && text.length > 45000) text = text.substring(0, 45000) + '…';
    sheet.appendRow([new Date(), String(event), text || '']);
  } catch (err) {
    console.error('Не удалось записать в лог: ' + err);
  }
}

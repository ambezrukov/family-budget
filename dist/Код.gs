/**
 * Бот учёта семейных расходов — весь код одним файлом.
 *
 * Собран автоматически из папки src/ (node tools/build.js).
 * Править удобнее там, по отдельным файлам, а сюда — только пересобирать.
 *
 * Порядок частей:
 *   00_Config
 *   01_Sheets
 *   02_Telegram
 *   03_Gemini
 *   04_TextParser
 *   05_Categorizer
 *   06_Reports
 *   07_State
 *   08_Handlers
 *   09_Main
 *   10_Setup
 *   11_Polling
 *   12_Links
 *   13_MiniApp
 *   14_Updates
 *   15_Changes
 *   16_Import
 *   17_ImportFiles
 *   18_Merge
 *   19_Directories
 *   20_Xlsx
 */

// ===========================================================================
// 00_Config
// ===========================================================================

/**
 * 00_Config.gs — константы, доступ к секретам и к листу «Настройки».
 *
 * Секреты (токен бота, ключ Gemini, идентификатор таблицы) в коде НЕ хранятся:
 * они лежат в свойствах скрипта (Файл → Настройки проекта → Свойства скрипта).
 */

// ---------------------------------------------------------------------------
// Версия кода
// ---------------------------------------------------------------------------

/**
 * Версия бота. Единственный источник правды: отсюда её берёт сборщик и кладёт
 * в dist/version.json, а чужие установки сверяются с этим файлом на GitHub,
 * чтобы понять, что вышло обновление.
 *
 * Поднимать при каждой заметной правке, вместе с записью в CHANGELOG.md.
 */
var BOT_VERSION = '1.8.2';

// Откуда берутся обновления. Свой форк подставляется свойством скрипта
// UPDATE_SOURCE — тогда бот следит за ним, а не за исходным проектом.
var UPDATE_SOURCE_DEFAULT = 'https://raw.githubusercontent.com/ambezrukov/family-budget/master/';

// ---------------------------------------------------------------------------
// Имена листов
// ---------------------------------------------------------------------------

var SHEET_EXPENSES = 'Расходы';
var SHEET_INCOMES = 'Доходы'; // задел на будущее, создаётся, но ботом не заполняется
var SHEET_CATEGORIES = 'Категории';
var SHEET_INCOME_CATEGORIES = 'Категории доходов'; // у доходов свой справочник
var SHEET_SETTINGS = 'Настройки';
var SHEET_LOG = 'Лог';
var SHEET_TRANSLATIONS = 'Переводы';
var SHEET_OPERATIONS = 'Операции';   // строки из выписок банка и карточных компаний
var SHEET_IMPORTS = 'Импорт';        // журнал разобранных файлов
var SHEET_CARDS = 'Карты';           // реестр карт: по 4 цифрам узнаём владельца
var SHEET_SOURCES = 'Источники';     // откуда и что скачивать — для страницы импорта

// ---------------------------------------------------------------------------
// Ключи свойств скрипта
// ---------------------------------------------------------------------------

var PROP_BOT_TOKEN = 'TELEGRAM_TOKEN';
var PROP_GEMINI_KEY = 'GEMINI_API_KEY';
var PROP_SPREADSHEET_ID = 'SPREADSHEET_ID';
var PROP_WEBHOOK_SECRET = 'WEBHOOK_SECRET'; // необязательный

// ---------------------------------------------------------------------------
// Модели Gemini (бесплатный уровень). При желании переопределяются в «Настройках».
// ---------------------------------------------------------------------------

var GEMINI_MODEL_MULTIMODAL = 'gemini-2.5-flash'; // голос и фотографии чеков
var GEMINI_MODEL_TEXT = 'gemini-2.5-flash-lite'; // категоризация текста — дешевле

// Ограничения, за которые не выходим (см. требования по бесплатным лимитам)
var MAX_VOICE_SECONDS = 60; // голосовые длиннее минуты не обрабатываем
var MAX_FILE_BYTES = 18 * 1024 * 1024; // Telegram отдаёт ботам файлы до 20 МБ

/**
 * Значения по умолчанию для листа «Настройки».
 * Ключ → [значение, пояснение для человека].
 */
function defaultSettings_() {
  return [
    ['Базовая валюта', 'ILS', 'Валюта, в которой считается итог. Меняется вместе с курсами ниже.'],
    ['Курс ILS', '1', 'Сколько базовой валюты в одной единице. Для базовой валюты всегда 1.'],
    ['Курс USD', '3.7', 'Сколько шекелей в одном долларе.'],
    ['Курс EUR', '4.0', 'Сколько шекелей в одном евро.'],
    ['Курс RUB', '0.042', 'Сколько шекелей в одном рубле.'],
    ['Разрешённые телеграм-айди', '', 'Через запятую. Можно с именем: «66902800=Толя, 673335047=Маша» — это имя пойдёт в столбец «Автор». Пусто = бот никого не пускает.'],
    ['Чат месячного отчёта', '', 'Куда слать отчёт 1-го числа. Можно несколько адресатов через запятую — каждый получит свой экземпляр.'],
    ['Кто обновляет бота', '', 'Телеграм-айди того, у кого есть доступ к редактору кода. Ему приходят сообщения о новых версиях. Пусто = первый из разрешённых.'],
    ['Модель для медиа', GEMINI_MODEL_MULTIMODAL, 'Модель Gemini для голоса и чеков.'],
    ['Модель для текста', GEMINI_MODEL_TEXT, 'Модель Gemini для категоризации текста.'],
    ['Учёт с', '', 'Дата, раньше которой строки выписок не импортируются: до неё бюджет не вели. Формат ДД.ММ.ГГГГ, пусто = брать всё.'],
    ['Папка выписок', 'Выписки', 'Название папки на Google Диске рядом с таблицей, откуда бот забирает файлы по команде /импорт.']
  ];
}

// ---------------------------------------------------------------------------
// Секреты
// ---------------------------------------------------------------------------

function scriptProp_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

function getBotToken_() {
  var token = scriptProp_(PROP_BOT_TOKEN);
  if (!token) throw new Error('Не задано свойство скрипта ' + PROP_BOT_TOKEN);
  return token;
}

function getGeminiKey_() {
  return scriptProp_(PROP_GEMINI_KEY); // пусто — работаем без модели, на одном словаре
}

// ---------------------------------------------------------------------------
// Настройки из таблицы (с кэшем на время одного запуска)
// ---------------------------------------------------------------------------

var SETTINGS_CACHE_ = null;

/**
 * Читает лист «Настройки» в объект {ключ: значение}.
 */
function getSettings_() {
  if (SETTINGS_CACHE_) return SETTINGS_CACHE_;
  var map = {};
  try {
    var sheet = getSpreadsheet_().getSheetByName(SHEET_SETTINGS);
    if (sheet) {
      var values = sheet.getDataRange().getValues();
      for (var i = 1; i < values.length; i++) {
        var key = String(values[i][0]).trim();
        if (key) map[key] = values[i][1];
      }
    }
  } catch (err) {
    // Настройки могут быть недоступны при самой первой инициализации — это не фатально
  }
  SETTINGS_CACHE_ = map;
  return map;
}

function setting_(key, fallback) {
  var value = getSettings_()[key];
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return value;
}

function baseCurrency_() {
  return String(setting_('Базовая валюта', 'ILS')).toUpperCase();
}

function modelForMedia_() {
  return String(setting_('Модель для медиа', GEMINI_MODEL_MULTIMODAL));
}

function modelForText_() {
  return String(setting_('Модель для текста', GEMINI_MODEL_TEXT));
}

/**
 * Разбирает настройку «Разрешённые телеграм-айди».
 *
 * Формат допускает имя после знака равенства: «66902800=Толя, 673335047=Маша».
 * Имя подставляется в столбец «Автор» вместо того, что стоит в телеграме, —
 * так в таблице и отчётах видно «Толя», а не «Анатолий Безруков».
 * Без имени — просто «66902800» — берётся имя из телеграма.
 */
function allowedUsers_() {
  var raw = String(setting_('Разрешённые телеграм-айди', ''));
  var result = [];

  raw.split(/[,;\n]+/).forEach(function (chunk) {
    var part = chunk.trim();
    if (!part) return;

    var eq = part.indexOf('=');
    var id = (eq === -1 ? part : part.substring(0, eq)).trim();
    var name = eq === -1 ? '' : part.substring(eq + 1).trim();

    if (id) result.push({ id: id, name: name });
  });

  return result;
}

/**
 * Белый список телеграм-айди. Пустой список означает «никого не пускаем»:
 * так бот, найденный посторонним по имени, ничего не запишет в семейную таблицу.
 */
function allowedUserIds_() {
  return allowedUsers_().map(function (user) { return user.id; });
}

/**
 * Имя, заданное в настройках для этого айди. Пусто — имя не задано.
 */
function userNameById_(userId) {
  var found = null;
  allowedUsers_().forEach(function (user) {
    if (user.id === String(userId)) found = user.name;
  });
  return found || '';
}

/**
 * Задаёт человеку имя для таблицы и отчётов, не трогая остальных.
 *
 * Список разрешённых хранится одной строкой («66902800=Толя, 673335047=Маша»),
 * поэтому её приходится пересобирать целиком.
 */
function setUserName_(userId, name) {
  var id = String(userId);
  var users = allowedUsers_();
  var found = false;

  var line = users.map(function (user) {
    if (user.id !== id) return user.name ? user.id + '=' + user.name : user.id;
    found = true;
    return name ? id + '=' + name : id;
  });

  if (!found) line.push(name ? id + '=' + name : id);

  updateSetting_('Разрешённые телеграм-айди', line.join(', '));
  SETTINGS_CACHE_ = null; // дальше по ходу этого же запуска нужно уже новое имя
  return true;
}

function isAllowedUser_(userId) {
  var list = allowedUserIds_();
  return list.indexOf(String(userId)) !== -1;
}

/**
 * Куда слать месячный отчёт. Можно указать несколько адресатов через запятую —
 * тогда каждый получит свой экземпляр отчёта (например, муж и жена по отдельности).
 */
function reportChatIds_() {
  var raw = String(setting_('Чат месячного отчёта', ''));
  return raw
    .split(/[,;\s]+/)
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s !== ''; });
}

/**
 * Курсы на крайний случай: когда в таблице ни числа, ни ответа от Google.
 * Значения приблизительные — они нужны, чтобы рублёвая трата не записалась
 * один к одному, а не чтобы считать точно.
 */
function fallbackRates_() {
  return { ILS: 1, USD: 3.7, EUR: 4.0, RUB: 0.042 };
}

/**
 * Курс валюты к базовой.
 *
 * Значение берётся с листа «Настройки». Там может стоять как число, так и
 * формула GOOGLEFINANCE — бот читает уже посчитанный результат, ему всё равно.
 *
 * Три рубежа, потому что курс из интернета иногда не приходит:
 *   1) значение из таблицы;
 *   2) последний удачный курс (запоминается здесь же);
 *   3) приблизительный курс из кода.
 * Единицу для неизвестной валюты не подставляем: это молча испортило бы сумму.
 */
function currencyRate_(currency) {
  var code = String(currency).toUpperCase();
  if (code === baseCurrency_()) return 1;

  var value = setting_('Курс ' + code, null);
  var rate = parseFloat(String(value).replace(',', '.'));

  if (rate && !isNaN(rate) && rate > 0) {
    rememberRate_(code, rate);
    return rate;
  }

  // В ячейке ошибка формулы (#N/A) или пусто — берём последний удачный курс
  var remembered = parseFloat(scriptProp_('RATE_' + code));
  if (remembered && !isNaN(remembered) && remembered > 0) {
    logEvent_('Курс не получен, взят последний известный', { валюта: code, курс: remembered });
    return remembered;
  }

  var fallback = fallbackRates_()[code];
  if (fallback) {
    logEvent_('Курс не получен, взят приблизительный', { валюта: code, курс: fallback });
    return fallback;
  }

  logEvent_('Неизвестная валюта', { валюта: code, значение: String(value) });
  return 1;
}

/**
 * Запоминает удачный курс — чтобы было чем воспользоваться, если в следующий
 * раз Google не ответит.
 */
function rememberRate_(code, rate) {
  try {
    PropertiesService.getScriptProperties().setProperty('RATE_' + code, String(rate));
  } catch (err) {
    // Не смогли запомнить — не беда, на запись расхода это не влияет
  }
}

/**
 * Пересчёт суммы в базовую валюту.
 */
function toBaseAmount_(amount, currency) {
  var rate = currencyRate_(currency);
  return Math.round(amount * rate * 100) / 100;
}

// ---------------------------------------------------------------------------
// Часовой пояс и формат дат
// ---------------------------------------------------------------------------

function tz_() {
  return Session.getScriptTimeZone() || 'Asia/Jerusalem';
}

function formatDate_(date) {
  return Utilities.formatDate(date, tz_(), 'dd.MM.yyyy');
}

function formatDateTime_(date) {
  return Utilities.formatDate(date, tz_(), 'dd.MM.yyyy HH:mm');
}


// ===========================================================================
// 01_Sheets
// ===========================================================================

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
  'Способ ввода',       // 12 — текст / голос / фото / файл / ссылка
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

// Лист «Операции» — строки выписок. Здесь деньги как их видит банк или
// карточная компания: без позиций чека и без наших комментариев. Чек и ручная
// запись такую строку дополняют, а не заводят вторую.
var OPERATION_COLUMNS = [
  'Дата операции',      // 1  — когда куплено
  'Дата списания',      // 2  — когда ушло со счёта (у кредиток отличается)
  'Сумма',              // 3  — в валюте списания
  'Валюта',             // 4
  'Сумма в базовой',    // 5
  'Исходная сумма',     // 6  — для покупок за границей
  'Исходная валюта',    // 7
  'Источник',           // 8  — банк / Isracard / Max / Cal
  'Карта',              // 9  — 4 цифры, у банковских строк пусто
  'Владелец',           // 10
  'Магазин',            // 11
  'Категория',          // 12
  'Подкатегория',       // 13
  'Тип операции',       // 14 — покупка / рассрочка / списание по карте / перевод
  'Не трата',           // 15 — «да» у общих списаний и переводов между своими
  'Ключ',               // 16 — по нему отсеиваем повторный импорт
  'Запись в расходах',  // 17 — id склеенной записи листа «Расходы»
  'Файл',               // 18 — имя выписки, из которой строка пришла
  'Заметки',            // 19 — что было в примечании выписки
  'ID'                  // 20
];

var IMPORT_COLUMNS = [
  'Когда', 'Файл', 'Источник', 'Период', 'Строк в файле',
  'Новых', 'Повторов', 'Пропущено по дате', 'Ключ файла'
];

// Реестр карт: по четырём цифрам из выписки узнаём, чья это карта и что за
// ней стоит. Заодно из него строится страница «что и откуда скачивать».
var CARD_COLUMNS = [
  'Карта', 'Название', 'Эмитент', 'Владелец', 'Для чего', 'День списания', 'Статус'
];

var SOURCE_COLUMNS = [
  'Источник', 'Кабинет', 'Карты', 'Что скачивать', 'Формат', 'Как часто', 'Порядок'
];

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


// ===========================================================================
// 02_Telegram
// ===========================================================================

/**
 * 02_Telegram.gs — тонкий слой над Telegram Bot API.
 * Здесь только транспорт: отправка сообщений, кнопки, скачивание файлов.
 */

function tgApiUrl_(method) {
  return 'https://api.telegram.org/bot' + getBotToken_() + '/' + method;
}

/**
 * Вызов метода Bot API. Ошибки не бросаем наружу — телеграм может ответить
 * отказом (например, чат заблокирован), но обработку сообщения это ронять
 * не должно: расход уже записан.
 */
function tgCall_(method, payload) {
  try {
    var response = UrlFetchApp.fetch(tgApiUrl_(method), {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload || {}),
      muteHttpExceptions: true
    });
    var text = response.getContentText();
    var data = JSON.parse(text);
    if (!data.ok) {
      logEvent_('Ошибка Telegram API', { method: method, response: text });
    }
    return data;
  } catch (err) {
    logEvent_('Сбой запроса к Telegram', { method: method, error: String(err) });
    return { ok: false };
  }
}

/**
 * Отправка текста. Разметка HTML, лишние теги в тексте экранируем заранее.
 */
function tgSend_(chatId, text, keyboard) {
  var payload = {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
  return tgCall_('sendMessage', payload);
}

function tgEditText_(chatId, messageId, text, keyboard) {
  var payload = {
    chat_id: chatId,
    message_id: messageId,
    text: text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
  return tgCall_('editMessageText', payload);
}

function tgEditKeyboard_(chatId, messageId, keyboard) {
  return tgCall_('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: keyboard || [] }
  });
}

/**
 * Ответ на нажатие инлайн-кнопки: убирает «часики» на кнопке.
 */
function tgAnswerCallback_(callbackId, text) {
  return tgCall_('answerCallbackQuery', {
    callback_query_id: callbackId,
    text: text || '',
    show_alert: false
  });
}

/**
 * Отправка файла. Нужна, чтобы прислать новый код бота прямо в чат:
 * человеку остаётся открыть его и вставить в редактор.
 */
function tgSendDocument_(chatId, blob, caption) {
  try {
    var response = UrlFetchApp.fetch(tgApiUrl_('sendDocument'), {
      method: 'post',
      payload: {
        chat_id: String(chatId),
        caption: String(caption || '').substring(0, 1000),
        parse_mode: 'HTML',
        document: blob
      },
      muteHttpExceptions: true
    });

    var data = JSON.parse(response.getContentText());
    if (!data.ok) logEvent_('Файл не отправился', { response: response.getContentText().substring(0, 500) });
    return data;
  } catch (err) {
    logEvent_('Сбой отправки файла', String(err));
    return { ok: false };
  }
}

function tgSendChatAction_(chatId, action) {
  return tgCall_('sendChatAction', { chat_id: chatId, action: action || 'typing' });
}

// ---------------------------------------------------------------------------
// Файлы
// ---------------------------------------------------------------------------

/**
 * Путь к файлу на серверах телеграма (метод getFile).
 */
function tgGetFilePath_(fileId) {
  var data = tgCall_('getFile', { file_id: fileId });
  if (!data.ok || !data.result || !data.result.file_path) return null;
  return data.result.file_path;
}

/**
 * Скачивает файл телеграма и возвращает {bytes, mimeType, url, sizeBytes}.
 * Возвращает null, если скачать не удалось или файл слишком велик.
 */
function tgDownloadFile_(fileId) {
  var path = tgGetFilePath_(fileId);
  if (!path) return null;
  var url = 'https://api.telegram.org/file/bot' + getBotToken_() + '/' + path;
  try {
    var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) {
      logEvent_('Не удалось скачать файл', { fileId: fileId, code: response.getResponseCode() });
      return null;
    }
    var blob = response.getBlob();
    var bytes = blob.getBytes();
    if (bytes.length > MAX_FILE_BYTES) {
      logEvent_('Файл слишком большой', { fileId: fileId, size: bytes.length });
      return null;
    }
    return {
      blob: blob,
      base64: Utilities.base64Encode(bytes),
      mimeType: guessMimeType_(path, blob.getContentType()),
      path: path,
      sizeBytes: bytes.length
    };
  } catch (err) {
    logEvent_('Сбой скачивания файла', { fileId: fileId, error: String(err) });
    return null;
  }
}

/**
 * Телеграм не всегда отдаёт вменяемый content-type, поэтому смотрим ещё
 * и на расширение.
 */
function guessMimeType_(path, fallback) {
  var lower = String(path).toLowerCase();
  if (/\.ogg$/.test(lower) || /\.oga$/.test(lower)) return 'audio/ogg';
  if (/\.mp3$/.test(lower)) return 'audio/mp3';
  if (/\.m4a$/.test(lower)) return 'audio/mp4';
  if (/\.wav$/.test(lower)) return 'audio/wav';
  if (/\.jpg$/.test(lower) || /\.jpeg$/.test(lower)) return 'image/jpeg';
  if (/\.png$/.test(lower)) return 'image/png';
  if (/\.webp$/.test(lower)) return 'image/webp';
  if (/\.heic$/.test(lower)) return 'image/heic';
  if (/\.pdf$/.test(lower)) return 'application/pdf';
  return fallback || 'application/octet-stream';
}

/**
 * Ссылка на файл для таблицы. Прямой URL телеграма содержит токен бота, поэтому
 * в таблицу его писать нельзя — сохраняем file_id, по которому файл всегда
 * можно достать повторно.
 */
function fileReference_(fileId) {
  return fileId ? 'tg:' + fileId : '';
}

// ---------------------------------------------------------------------------
// Установка вебхука (запускается вручную из редактора)
// ---------------------------------------------------------------------------

/**
 * Ставит вебхук.
 *
 * Адрес берётся из свойства WEBHOOK_URL — это адрес посредника, а не самого
 * Apps Script: на прямой адрес телеграм ходить не умеет, потому что Apps Script
 * отвечает перенаправлением. Если WEBHOOK_URL не задан, пробуем WEBAPP_URL.
 *
 * Секретное слово из WEBHOOK_SECRET передаём телеграму: он будет присылать его
 * заголовком в каждом запросе, а посредник — проверять. Так на адрес посредника
 * не пройдёт чужой запрос.
 */
function setWebhook(webhookUrl) {
  var url = webhookUrl || scriptProp_('WEBHOOK_URL') || scriptProp_('WEBAPP_URL');
  if (!url) {
    throw new Error('Не задан адрес вебхука. Пропишите свойство скрипта WEBHOOK_URL ' +
      '(адрес посредника) или передайте адрес параметром.');
  }

  var payload = {
    url: url,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: false // накопившиеся сообщения нужны
  };

  var secret = scriptProp_(PROP_WEBHOOK_SECRET);
  if (secret) payload.secret_token = secret;

  var result = tgCall_('setWebhook', payload);
  console.log(JSON.stringify(result));
  return result;
}

function deleteWebhook() {
  var result = tgCall_('deleteWebhook', { drop_pending_updates: true });
  console.log(JSON.stringify(result));
  return result;
}

function getWebhookInfo() {
  var result = tgCall_('getWebhookInfo', {});
  console.log(JSON.stringify(result));
  return result;
}

/**
 * Прописывает боту список команд — они появятся в меню телеграма.
 */
function setBotCommands() {
  var result = tgCall_('setMyCommands', {
    commands: [
      { command: 'mesyac', description: 'Расходы за текущий месяц по категориям' },
      { command: 'poslednie', description: 'Последние 10 записей' },
      { command: 'segodnya', description: 'Сумма за сегодня' },
      { command: 'dohody', description: 'Доходы за месяц и остаток' },
      { command: 'otchet', description: 'Отчёт за прошлый месяц' },
      { command: 'spravka', description: 'Как вводить расходы' },
      { command: 'imya', description: 'Как подписывать меня в таблице' },
      { command: 'avtory', description: 'Свести имена авторов' },
      { command: 'whoami', description: 'Показать мой телеграм-айди' }
    ]
  });
  console.log(JSON.stringify(result));
  return result;
}


// ===========================================================================
// 03_Gemini
// ===========================================================================

/**
 * 03_Gemini.gs — обращения к Gemini API.
 *
 * Ключевая идея: у модели всегда просим строгий JSON (responseMimeType +
 * responseSchema), поэтому ответ не приходится разбирать регулярками.
 * Любой сбой модели не должен терять запись — вызывающий код обязан
 * предусмотреть работу без модели.
 */

var GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';

// Последний запрос сорвался из-за перегрузки Google (503 «high demand» или
// 429 «лимит»), а не потому что модель чего-то не поняла. Разница важна для
// ответа человеку: в первом случае помогает просто повторить через минуту.
var GEMINI_BUSY_ = false;

// Сколько всего времени отводим на один разбор со всеми повторами и сменой
// моделей. Скрипту Google даёт шесть минут на запуск, и часть их нужна на
// запись расхода с ответом — поэтому берём меньше половины.
var GEMINI_TIME_BUDGET_MS = 150000;

/**
 * Низкоуровневый вызов модели.
 *
 * options: {
 *   model: строка,
 *   systemInstruction: строка,
 *   parts: массив частей запроса ([{text: ...}, {inline_data: {...}}]),
 *   schema: схема ответа (OpenAPI-подобная),
 *   temperature: число
 * }
 * Возвращает разобранный объект или null.
 */
function geminiJson_(options) {
  var key = getGeminiKey_();
  if (!key) {
    logEvent_('Gemini не настроен', 'Свойство ' + PROP_GEMINI_KEY + ' пустое, работаем без модели');
    return null;
  }

  var body = {
    contents: [{ role: 'user', parts: options.parts }],
    generationConfig: {
      temperature: options.temperature === undefined ? 0 : options.temperature,
      responseMimeType: 'application/json'
    }
  };
  if (options.schema) body.generationConfig.responseSchema = options.schema;
  if (options.systemInstruction) {
    body.systemInstruction = { parts: [{ text: options.systemInstruction }] };
  }

  var started = new Date().getTime();
  var url = GEMINI_ENDPOINT + encodeURIComponent(options.model) + ':generateContent?key=' + encodeURIComponent(key);
  var raw = geminiFetchWithRetry_(url, body, options.attempts, started);

  // Перегружена бывает не «вся Gemini», а конкретная модель — причём
  // соседняя версия того же поколения обычно занята заодно с ней. Поэтому
  // спускаемся по списку доступных моделей, пока кто-нибудь не ответит.
  if (!raw && GEMINI_BUSY_ && !options.noFallback) {
    var spares = spareModels_(options.model);
    for (var i = 0; i < spares.length && !raw; i++) {
      if (new Date().getTime() - started > GEMINI_TIME_BUDGET_MS) {
        logEvent_('Перебор моделей остановлен по времени', { осталось: spares.slice(i).join(', ') });
        break;
      }
      logEvent_('Модель перегружена, пробуем запасную', { было: options.model, стало: spares[i] });
      raw = geminiFetchWithRetry_(
        GEMINI_ENDPOINT + encodeURIComponent(spares[i]) + ':generateContent?key=' + encodeURIComponent(key),
        body, 2, started);
    }
  }

  if (!raw) return null;

  var text = geminiExtractText_(raw);
  if (!text) {
    logEvent_('Пустой ответ модели', JSON.stringify(raw).substring(0, 4000));
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    // Иногда модель оборачивает JSON в ```json ... ``` — пробуем вытащить
    var match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (err2) { /* ниже запишем в лог */ }
    }
    logEvent_('Невалидный JSON от модели', text.substring(0, 4000));
    return null;
  }
}

/**
 * Очередь моделей на случай, когда основная занята.
 *
 * Сначала вторая настроенная (она под рукой и точно рабочая), затем — модели
 * прошлых поколений из каталога ключа: 22.08.2026 всё семейство 3.x стояло
 * в очереди целиком, а спрос на 2.x давно спал.
 */
function spareModels_(model) {
  var queue = [modelForMedia_(), modelForText_(), GEMINI_MODEL_MULTIMODAL, GEMINI_MODEL_TEXT];

  var ranked = rankModels_(availableGeminiModels_(), 'media');
  var older = ranked.filter(function (name) {
    return queue.indexOf(name) === -1 && name !== model;
  });
  // Список отсортирован от новых к старым, а нужен обратный порядок:
  // старое поколение реже перегружено, чем то, куда все только перешли
  queue = queue.concat(older.reverse());

  var seen = {};
  return queue.filter(function (name) {
    if (!name || name === model || seen[name]) return false;
    seen[name] = true;
    return true;
  }).slice(0, 4);
}

/**
 * Запрос с повторами: бесплатный уровень легко упирается в лимит (429),
 * а сервис иногда отдаёт 503 «сейчас много желающих». Паузы растянуты
 * до полуминуты суммарно: 22.08.2026 чек не прочитался только потому, что
 * трёх попыток за четыре секунды не хватило переждать всплеск спроса.
 */
function geminiFetchWithRetry_(url, body, attempts, startedAt) {
  var delays = [0, 1500, 4000, 8000, 15000].slice(0, attempts || 5);
  var started = startedAt || new Date().getTime();
  var busy = false;
  for (var attempt = 0; attempt < delays.length; attempt++) {
    // Сам запрос в часы пик висит по полминуты, поэтому следим не за числом
    // попыток, а за общим временем: человек ждёт ответа в чате
    if (attempt && new Date().getTime() - started > GEMINI_TIME_BUDGET_MS) {
      logEvent_('Повторы прекращены по времени', { попыток: attempt });
      break;
    }
    if (delays[attempt]) Utilities.sleep(delays[attempt]);
    try {
      var response = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(body),
        muteHttpExceptions: true
      });
      var code = response.getResponseCode();
      var text = response.getContentText();

      if (code === 200) {
        GEMINI_BUSY_ = false;
        return JSON.parse(text);
      }

      if (code === 429 || code >= 500) {
        busy = true;
        logEvent_('Gemini временная ошибка', { code: code, attempt: attempt + 1, body: text.substring(0, 1000) });
        continue; // имеет смысл повторить
      }

      if (code === 404) {
        // Google периодически снимает старые модели с публикации
        logEvent_('Модель Gemini недоступна',
          'Запустите функцию autoSelectModels — она подберёт рабочую модель из тех, ' +
          'что доступны вашему ключу. Ответ Google: ' + text.substring(0, 1000));
        return null;
      }

      logEvent_('Gemini отказал', { code: code, body: text.substring(0, 2000) });
      GEMINI_BUSY_ = false;
      return null; // 400/403 повторять бессмысленно
    } catch (err) {
      busy = true; // обрыв связи тоже лечится повтором
      logEvent_('Сбой запроса к Gemini', String(err));
    }
  }
  GEMINI_BUSY_ = busy;
  return null;
}

/**
 * Достаёт текст из ответа Gemini.
 */
function geminiExtractText_(raw) {
  try {
    var parts = raw.candidates[0].content.parts;
    var text = '';
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].text) text += parts[i].text;
    }
    return text.trim();
  } catch (err) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Какие модели доступны
// ---------------------------------------------------------------------------

/**
 * Спрашивает у Google список моделей, доступных вашему ключу.
 * Возвращает массив имён вида «gemini-2.5-flash» (без приставки «models/»).
 *
 * Нужно потому, что Google периодически снимает старые модели: имя, зашитое
 * в код полгода назад, однажды перестаёт работать с ошибкой 404.
 */
function availableGeminiModels_() {
  var key = getGeminiKey_();
  if (!key) return [];

  try {
    var response = UrlFetchApp.fetch(
      GEMINI_ENDPOINT.replace(/models\/$/, 'models') + '?pageSize=200&key=' + encodeURIComponent(key),
      { muteHttpExceptions: true }
    );
    if (response.getResponseCode() !== 200) {
      logEvent_('Не удалось получить список моделей', response.getContentText().substring(0, 1000));
      return [];
    }

    var data = JSON.parse(response.getContentText());
    return (data.models || [])
      .filter(function (model) {
        var methods = model.supportedGenerationMethods || [];
        return methods.indexOf('generateContent') !== -1;
      })
      .map(function (model) { return String(model.name).replace(/^models\//, ''); });
  } catch (err) {
    logEvent_('Сбой запроса списка моделей', String(err));
    return [];
  }
}

/**
 * Ранжирует доступные модели по пригодности для нашей задачи.
 *
 * kind: 'media' — для голоса и чеков (нужна модель поумнее),
 *       'text'  — для разбора текста (сгодится самая дешёвая).
 *
 * Возвращает отсортированный список кандидатов: имя — только предположение,
 * поэтому вызывающий код пробует их по очереди, пока какая-то не ответит.
 */
function rankModels_(models, kind) {
  var candidates = models.filter(function (name) {
    var lower = name.toLowerCase();
    if (lower.indexOf('gemini') !== 0) return false;

    // Узкоспециальные модели: генерация картинок и видео, речь, эмбеддинги,
    // разбор видео, модерация. Для разбора текста и чеков они не годятся,
    // хотя в имени у них тоже бывает «flash».
    if (/embedding|aqa|imagen|veo|tts|image|audio|live|native|robotics|video|understanding|guard|safety|rerank|translate|computer-use/.test(lower)) {
      return false;
    }

    // eap — программа раннего доступа: такие модели часто отвечают отказом
    if (/(^|-)eap(-|$)/.test(lower)) return false;

    return true;
  });
  if (!candidates.length) return [];

  function version(name) {
    var m = name.match(/gemini-(\d+)(?:\.(\d+))?/);
    if (!m) return 0;
    return parseInt(m[1], 10) * 100 + (m[2] ? parseInt(m[2], 10) : 0);
  }

  function score(name) {
    var lower = name.toLowerCase();
    var points = version(lower) * 100;

    if (kind === 'text') {
      // Для текста дешёвая lite-модель предпочтительнее
      if (lower.indexOf('lite') !== -1) points += 40;
      else if (lower.indexOf('flash') !== -1) points += 20;
    } else {
      // Для медиа lite слабовата, а pro избыточен по лимитам
      if (lower.indexOf('flash') !== -1 && lower.indexOf('lite') === -1) points += 40;
      else if (lower.indexOf('pro') !== -1) points += 20;
      else if (lower.indexOf('flash') !== -1) points += 10;
    }

    // Стабильные версии надёжнее превью и экспериментов
    if (!/preview|exp|thinking/.test(lower)) points += 15;
    // Имя с датой внутри — это снимок конкретной версии, он живёт недолго
    if (/\d{3,}/.test(lower.replace(/gemini-\d+(\.\d+)?/, ''))) points -= 5;

    return points;
  }

  candidates.sort(function (a, b) { return score(b) - score(a); });
  return candidates;
}

/**
 * Пробует модель самым простым запросом: отвечает ли она вообще и умеет ли
 * возвращать строгий JSON. Это надёжнее любых догадок по названию — Google
 * выкладывает модели, недоступные конкретному ключу, и узкоспециальные,
 * которые на обычный запрос отвечают отказом.
 */
function probeModel_(model) {
  var answer = geminiJson_({
    model: model,
    systemInstruction: 'Отвечай только строгим JSON по заданной схеме.',
    parts: [{ text: 'Это проверка связи. Верни JSON {"ok": true}.' }],
    schema: {
      type: 'OBJECT',
      properties: { ok: { type: 'BOOLEAN' } },
      required: ['ok']
    },
    attempts: 1, // на переборе повторы не нужны: не ответила — берём следующую
    noFallback: true // и подмена моделью-дублёром здесь только запутала бы подбор
  });
  return !!(answer && answer.ok === true);
}

/**
 * Перебирает кандидатов по убыванию пригодности и возвращает первого,
 * кто реально ответил. Больше limit моделей не трогаем, чтобы не жечь
 * дневной лимит запросов на переборе.
 */
function firstWorkingModel_(candidates, limit) {
  var tried = [];
  var max = Math.min(candidates.length, limit || 6);

  for (var i = 0; i < max; i++) {
    if (probeModel_(candidates[i])) {
      return { model: candidates[i], tried: tried };
    }
    tried.push(candidates[i]);
  }
  return { model: '', tried: tried };
}

// ---------------------------------------------------------------------------
// Схемы ответов
// ---------------------------------------------------------------------------

/**
 * Схема разбора сообщения о расходах.
 *
 * В одном сообщении может быть несколько трат («250 продукты и 80 бензин»),
 * поэтому модель всегда возвращает список — даже если трата одна.
 * withTranscript = true добавляет расшифровку речи (для голосовых).
 */
function schemaExpenseList_(withTranscript) {
  var properties = {
    isExpense: { type: 'BOOLEAN', description: 'true, если сообщение вообще про деньги: траты, доходы, возвраты, переводы' },
    expenses: {
      type: 'ARRAY',
      description: 'Каждая отдельная трата из сообщения',
      items: {
        type: 'OBJECT',
        properties: {
          amount: { type: 'NUMBER', description: 'Сумма траты, 0 если не названа' },
          currency: { type: 'STRING', description: 'Код валюты: ILS, USD, EUR, RUB' },
          date: { type: 'STRING', description: 'Дата в формате ГГГГ-ММ-ДД, пустая строка если не названа' },
          description: { type: 'STRING', description: 'Краткое описание траты по-русски' },
          store: { type: 'STRING', description: 'Магазин или заведение, если названо' },
          category: { type: 'STRING', description: 'Категория из переданного списка' },
          subcategory: { type: 'STRING', description: 'Подкатегория, если уместна' },
          kind: {
            type: 'STRING',
            description: 'Вид операции: «расход», «доход», «возврат» или «перевод»'
          }
        },
        required: ['amount', 'currency', 'description', 'category', 'kind']
      }
    },
    comment: { type: 'STRING', description: 'Чего не хватает для записи, если чего-то не хватает' }
  };

  if (withTranscript) {
    properties.transcript = { type: 'STRING', description: 'Дословная расшифровка речи' };
  }

  return {
    type: 'OBJECT',
    properties: properties,
    required: withTranscript ? ['transcript', 'isExpense', 'expenses'] : ['isExpense', 'expenses']
  };
}

/**
 * Общая часть промпта для текста и голоса: как разбирать траты.
 */
function expenseParsingRules_() {
  var categories = categoryNames_();
  var incomeCategories = incomeCategoryNames_();
  var today = formatDate_(new Date());

  return [
    'Правила разбора:',
    '- У каждой операции определи вид (поле kind):',
    '  • «доход» — деньги пришли в семью: зарплата, аванс, премия, гонорар, ' +
      'пособие, пенсия, проценты, подарок деньгами, выручка от продажи вещи. ' +
      'Сумма, записанная со знаком плюс («+12000»), — ВСЕГДА доход, без исключений.',
    '  • «возврат» — вернули деньги за уже купленное: отменённый заказ, сдача ' +
      'товара в магазин, компенсация за брак. Это не доход, а отмена траты.',
    '  • «перевод» — деньги переложили внутри семьи, не потратив: снял наличные ' +
      'в банкомате, положил на свою карту, перевёл жене или мужу, обменял валюту. ' +
      'Перевод постороннему человеку («перевёл Диме за ремонт») — это обычный расход, ' +
      'а не перевод.',
    '  • «расход» — всё остальное, это самый частый случай.',
    '- Для дохода категорию бери из ДРУГОГО списка — доходного: ' +
      incomeCategories.join(', ') + '. Если ничего не подходит — «Прочие доходы».',
    '- Для возврата категорию бери из расходного списка: ту, куда попала бы сама покупка.',
    '- У перевода категория не нужна, оставь её пустой.',
    '- В одном сообщении может быть НЕСКОЛЬКО трат: «250 продукты, 80 бензин и 45 аптека» — ' +
      'это три отдельные траты, верни три элемента списка. Одна трата — список из одного элемента.',
    '- Не дроби одну трату на части: «обед на двоих 180» — это одна трата, а не две.',
    '- Валюта по умолчанию — ILS (шекель). «Шек», «шекелей», «₪» → ILS; ' +
      '«руб», «рублей», «₽» → RUB; «доллар», «$» → USD; «евро», «€» → EUR.',
    '- Сегодня ' + today + '. «Вчера», «позавчера», названное число месяца переводи в дату ' +
      'формата ГГГГ-ММ-ДД. Дата, названная в начале сообщения, относится ко всем тратам ' +
      'сообщения, если для конкретной траты не названа своя. Не названа вовсе — оставь date пустым.',
    '- Если для какой-то траты сумма НЕ названа — поставь amount = 0 и напиши в comment, ' +
      'чего именно не хватает. Не выдумывай суммы.',
    '- Категорию расхода выбери из списка: ' + categories.join(', ') + '. ' +
      'Если ничего не подходит — верни «Без категории».',
    '- description — короткое описание по-русски, без суммы и даты: «продукты в Рами Леви», «бензин».',
    '- Если сообщение вообще не про деньги (приветствие, вопрос, случайный текст) — ' +
      'поставь isExpense = false и верни пустой список.'
  ].join('\n');
}

/**
 * Разбор обычного текстового сообщения.
 */
function geminiParseText_(text) {
  return geminiJson_({
    model: modelForText_(),
    systemInstruction: 'Ты помощник семейного учёта расходов. Отвечай только строгим JSON по заданной схеме.',
    parts: [{
      text: 'Разбери сообщение о расходах семьи, живущей в Израиле.\n\n' +
        'Сообщение: «' + text + '»\n\n' + expenseParsingRules_()
    }],
    schema: schemaExpenseList_(false)
  });
}

/**
 * Схема разбора чеков.
 *
 * На фотографии может оказаться несколько чеков сразу — например, положили
 * рядом два и сняли одним кадром. Поэтому модель всегда возвращает список.
 */
function schemaReceiptList_() {
  return {
    type: 'OBJECT',
    properties: {
      receipts: {
        type: 'ARRAY',
        description: 'Каждый отдельный чек, найденный на изображении',
        items: {
          type: 'OBJECT',
          properties: {
            total: { type: 'NUMBER', description: 'Итоговая сумма чека, 0 если не читается' },
            currency: { type: 'STRING', description: 'Код валюты: ILS, USD, EUR, RUB' },
            datetime: { type: 'STRING', description: 'Дата и время покупки в формате ГГГГ-ММ-ДД ЧЧ:ММ, пустая строка если не читается' },
            store: { type: 'STRING', description: 'Название магазина как написано на чеке, на языке оригинала' },
            storeRu: { type: 'STRING', description: 'То же название по-русски; пустая строка, если оригинал уже русский' },
            category: { type: 'STRING', description: 'Категория из переданного списка' },
            subcategory: { type: 'STRING', description: 'Подкатегория, если уместна' },
            items: {
              type: 'ARRAY',
              description: 'Позиции чека',
              items: {
                type: 'OBJECT',
                properties: {
                  name: { type: 'STRING', description: 'Название позиции по-русски' },
                  original: { type: 'STRING', description: 'Название позиции как на чеке; пусто, если оригинал русский' },
                  price: { type: 'NUMBER' }
                },
                required: ['name']
              }
            },
            tips: { type: 'NUMBER', description: 'Чаевые или сервисный сбор, если выделены отдельно, иначе 0' },
            readable: { type: 'BOOLEAN', description: 'true, если чек прочитан уверенно' },
            note: { type: 'STRING', description: 'Что помешало разобрать, если readable = false' }
          },
          required: ['total', 'currency', 'store', 'category', 'readable']
        }
      }
    },
    required: ['receipts']
  };
}

/**
 * Схема выбора категории.
 */
function schemaCategory_() {
  return {
    type: 'OBJECT',
    properties: {
      category: { type: 'STRING', description: 'Название категории' },
      subcategory: { type: 'STRING', description: 'Подкатегория или пустая строка' },
      isNew: { type: 'BOOLEAN', description: 'true, если категории нет в переданном списке' }
    },
    required: ['category', 'isNew']
  };
}

// ---------------------------------------------------------------------------
// Прикладные вызовы
// ---------------------------------------------------------------------------

/**
 * Голосовое сообщение: одним запросом просим и расшифровку, и разбор.
 * Отдельный сервис распознавания речи не нужен — это экономит и лимиты, и время.
 */
function geminiParseVoice_(base64Audio, mimeType) {
  var prompt =
    'Это голосовое сообщение о расходах в семейном бюджете.\n' +
    'Речь может быть на русском, на иврите или смешанной — учитывай оба языка, ' +
    'включая ивритские названия магазинов и сетей.\n\n' +
    'Сделай две вещи одновременно:\n' +
    '1) Дословно расшифруй сказанное в поле transcript (на языке оригинала).\n' +
    '2) Разбери названные траты по полям.\n\n' +
    expenseParsingRules_();

  return geminiJson_({
    model: modelForMedia_(),
    systemInstruction: 'Ты помощник семейного учёта расходов. Отвечай только строгим JSON по заданной схеме.',
    parts: [
      { text: prompt },
      { inline_data: { mime_type: mimeType || 'audio/ogg', data: base64Audio } }
    ],
    schema: schemaExpenseList_(true)
  });
}

/**
 * Фотография чека.
 */
function geminiParseReceipt_(base64Image, mimeType, caption) {
  var categories = categoryNames_();
  var today = formatDate_(new Date());

  var prompt =
    'На изображении — кассовый чек или счёт. Извлеки данные о покупке.\n\n' +
    'Сначала посмотри, сколько на изображении чеков. Их может быть несколько: ' +
    'люди кладут рядом два-три чека и снимают одним кадром. Верни КАЖДЫЙ чек ' +
    'отдельным элементом списка receipts, со своими суммой, магазином и датой. ' +
    'Признаки разных чеков: своя строка итога у каждого, разные магазины, ' +
    'разные даты, видимые края бумаги между ними. Один длинный чек на части ' +
    'не дроби — у него одна строка итога.\n\n' +
    'Правила для каждого чека:\n' +
    '- Итоговую сумму бери ИМЕННО из строки итога чека («ИТОГО», «СУММА К ОПЛАТЕ», ' +
    '«סה"כ», «לתשלום», «TOTAL»). Не складывай позиции самостоятельно.\n' +
    '- Если отдельной строкой видны чаевые или сервисный сбор — включи их в total ' +
    'и продублируй сумму в поле tips.\n' +
    '- Чеки бывают на иврите (справа налево, дата в формате ДД/ММ/ГГГГ), ' +
    'а также на русском и английском.\n' +
    '- Дату бери с чека, а не сегодняшнюю. Сегодня ' + today + '. ' +
    'Если дата не читается — оставь datetime пустым.\n' +
    '- Валюта: ₪ / ש"ח / NIS → ILS; ₽ → RUB; $ → USD; € → EUR. По умолчанию ILS.\n' +
    '- Позиции перечисли по-русски: в поле name — перевод, в поле original — ' +
    'как написано на чеке. Если позиция уже по-русски, original оставь пустым. ' +
    'Переводи по смыслу товара: «חלב 3%» → «молоко 3%», «לחם אחיד» → «хлеб».\n' +
    '- Название магазина в поле store оставь как на чеке, а в storeRu дай ' +
    'привычное русское написание: «שופרסל» → «Шуферсаль», «רמי לוי» → «Рами Леви». ' +
    'Если название и так по-русски, storeRu оставь пустым.\n' +
    '- Если позиции не читаются — верни пустой список.\n' +
    '- Категорию выбери из списка: ' + categories.join(', ') + '. ' +
    'Если ничего не подходит — «Без категории».\n' +
    '- Если сумма итога не читается — поставь total = 0, readable = false ' +
    'и объясни в note, что именно не удалось разобрать.';

  if (caption) {
    prompt += '\n\nПользователь приложил подпись к фото: «' + caption + '». ' +
      'Считай её уточнением: она важнее того, что распознано с чека, ' +
      'для выбора категории и описания.';
  }

  return geminiJson_({
    model: modelForMedia_(),
    systemInstruction: 'Ты помощник семейного учёта расходов. Отвечай только строгим JSON по заданной схеме.',
    parts: [
      { text: prompt },
      { inline_data: { mime_type: mimeType || 'image/jpeg', data: base64Image } }
    ],
    schema: schemaReceiptList_()
  });
}

/**
 * Чек, открытый по ссылке обычной веб-страницей.
 *
 * Отличается от фотографии только тем, что чек приходит текстом, а не
 * картинкой: разбирать модели легче, но мусора вокруг больше — меню сайта,
 * кнопки, реклама. Поэтому первым делом просим отделить чек от обвязки.
 */
function geminiParseReceiptText_(pageText, comment, sourceUrl) {
  var categories = categoryNames_();
  var today = formatDate_(new Date());

  var prompt =
    'Ниже — текст страницы с чеком, открытой по ссылке из SMS. ' +
    'Разметка со страницы снята, поэтому рядом с чеком попадаются пункты меню, ' +
    'кнопки и реклама — их игнорируй, бери только сам чек.\n\n' +
    'Если чека на странице нет (открылась реклама, ошибка, страница входа) — ' +
    'верни пустой список receipts.\n\n' +
    'Правила:\n' +
    '- Итоговую сумму бери из строки итога. Если строк несколько, нужна ' +
    'фактически уплаченная («לתשלום», «סה"כ שולם», «ИТОГО», «TOTAL»), а не ' +
    'сумма до скидки, не НДС («מע"מ») и не сэкономленное («חסכת»). ' +
    'Не складывай позиции самостоятельно.\n' +
    '- Иврит пишется справа налево, поэтому в тексте страницы подпись часто ' +
    'стоит ПОСЛЕ своего числа, а не перед ним, и подписи легко разъезжаются ' +
    'с числами. Проверяй себя счётом: итог обычно равен сумме позиций. Если ' +
    'одно из чисел рядом с итогом совпало с суммой позиций — это и есть итог, ' +
    'даже если подпись рядом говорит иное.\n' +
    '- Чеки бывают на иврите (дата в формате ДД/ММ/ГГГГ), русском и английском.\n' +
    '- Дату бери с чека, а не сегодняшнюю. Сегодня ' + today + '. ' +
    'Если даты нет — оставь datetime пустым.\n' +
    '- Валюта: ₪ / ש"ח / NIS → ILS; ₽ → RUB; $ → USD; € → EUR. По умолчанию ILS.\n' +
    '- Позиции перечисли по-русски: в поле name — перевод, в original — как ' +
    'на чеке. Если позиция уже по-русски, original оставь пустым.\n' +
    '- Название магазина в store оставь как на чеке, в storeRu дай привычное ' +
    'русское написание.\n' +
    '- Категорию выбери из списка: ' + categories.join(', ') + '. ' +
    'Если ничего не подходит — «Без категории».\n' +
    '- Если итог найти не удалось — total = 0, readable = false и объясни в note.\n\n' +
    (sourceUrl ? 'Адрес страницы: ' + sourceUrl + '\n\n' : '') +
    (comment ? 'Пользователь приписал к ссылке: «' + comment + '». ' +
      'Считай это уточнением для категории и описания.\n\n' : '') +
    'Текст страницы:\n' + pageText;

  return geminiJson_({
    model: modelForMedia_(),
    systemInstruction: 'Ты помощник семейного учёта расходов. Отвечай только строгим JSON по заданной схеме.',
    parts: [{ text: prompt }],
    schema: schemaReceiptList_()
  });
}

/**
 * Перевод и категория для чека, пришедшего готовыми данными.
 *
 * Суммы и дата у такого чека уже точные, поэтому модели их не показываем как
 * предмет работы: её дело — русские названия позиций, русское имя магазина
 * и категория.
 */
function geminiEnrichReceipt_(receipt) {
  var originals = (receipt.items || []).map(function (item) {
    return String(item.original || '').trim();
  }).filter(function (name) { return name; });

  var store = String(receipt.store || '').trim();
  if (!originals.length && !store) return null;

  var categories = categoryNames_();
  var prompt =
    'Чек из израильского магазина уже разобран — суммы и дата известны. ' +
    'Нужны только русские названия и категория.\n\n' +
    (store ? 'Магазин: «' + store + '»\n' : '') +
    'Позиции чека:\n' + originals.map(function (name, index) {
      return (index + 1) + '. ' + name;
    }).join('\n') + '\n\n' +
    'Сделай три вещи:\n' +
    '1) Для каждой позиции верни пару original (ровно как в списке выше, ' +
    'без изменений) и name — перевод на русский по смыслу товара: ' +
    '«חלב 3%» → «молоко 3%», «לחם אחיד» → «хлеб». Названия на иврите часто ' +
    'обрезаны кассой — переводи по узнаваемой части, не выдумывай лишнего.\n' +
    '2) В storeRu дай привычное русское написание магазина: ' +
    '«שופרסל» → «Шуферсаль», «Carrefour» → «Карфур». Если название уже ' +
    'по-русски, оставь пустым.\n' +
    '3) Выбери категорию всей покупки из списка: ' + categories.join(', ') + '. ' +
    'Если ничего не подходит — «Без категории».';

  return geminiJson_({
    model: modelForText_(),
    systemInstruction: 'Ты помощник семейного учёта расходов. Отвечай только строгим JSON по заданной схеме.',
    parts: [{ text: prompt }],
    schema: schemaReceiptTranslation_()
  });
}

/**
 * Схема перевода позиций готового чека.
 */
function schemaReceiptTranslation_() {
  return {
    type: 'OBJECT',
    properties: {
      storeRu: { type: 'STRING', description: 'Русское написание названия магазина; пусто, если оригинал русский' },
      category: { type: 'STRING', description: 'Категория покупки из переданного списка' },
      subcategory: { type: 'STRING', description: 'Подкатегория, если уместна' },
      items: {
        type: 'ARRAY',
        description: 'По одному элементу на каждую позицию чека',
        items: {
          type: 'OBJECT',
          properties: {
            original: { type: 'STRING', description: 'Название позиции ровно как в переданном списке' },
            name: { type: 'STRING', description: 'Перевод названия на русский' }
          },
          required: ['original', 'name']
        }
      }
    },
    required: ['category', 'items']
  };
}

/**
 * Категоризация текстового описания, когда словарь не сработал.
 */
function geminiPickCategory_(description, store) {
  var categories = categoryNames_();
  var prompt =
    'Определи категорию расхода в семейном бюджете (семья живёт в Израиле).\n\n' +
    'Описание расхода: «' + description + '»' +
    (store ? '\nМагазин или заведение: «' + store + '»' : '') + '\n\n' +
    'Существующие категории: ' + categories.join(', ') + '.\n\n' +
    'Выбери одну из существующих категорий. Новую категорию предлагай только если ' +
    'расход явно не укладывается ни в одну из них; тогда поставь isNew = true и ' +
    'дай короткое название в одно-два слова.';

  return geminiJson_({
    model: modelForText_(),
    systemInstruction: 'Ты помощник семейного учёта расходов. Отвечай только строгим JSON по заданной схеме.',
    parts: [{ text: prompt }],
    schema: schemaCategory_()
  });
}


// ===========================================================================
// 04_TextParser
// ===========================================================================

/**
 * 04_TextParser.gs — разбор свободного текста вида
 * «360 шек отправка машины», «45 продукты», «вчера 1200 гараж», «12.05 200 руб такси».
 *
 * Модель здесь не используется: текст разбирается локально, это быстро,
 * бесплатно и предсказуемо. Модель подключается позже, только для категории.
 *
 * Важно про регулярные выражения: в JavaScript \b и \w работают только с
 * латиницей, поэтому для русских слов границы задаются явно — через
 * «[а-яё]*» и отрицательные проверки, а не через \b.
 */

var RU_LETTER_ = 'а-яёА-ЯЁ';

// ---------------------------------------------------------------------------
// Валюты
// ---------------------------------------------------------------------------

/**
 * Написания валют. Длинные варианты стоят раньше коротких, чтобы «шекелей»
 * не обрезалось до «шек» и хвост слова не попадал в описание.
 */
function currencyPatterns_() {
  return [
    { code: 'ILS', re: /(?:₪|ש"ח|шекел[а-яё]*|шкл(?![а-яё])|шек(?![а-яё])|shekel[a-z]*|\bnis\b|\bils\b)/i },
    { code: 'RUB', re: /(?:₽|рубл[а-яё]*|руб(?![а-яё])|\brub\b)/i },
    { code: 'USD', re: /(?:\$|доллар[а-яё]*|долл(?![а-яё])|бакс[а-яё]*|\busd\b)/i },
    { code: 'EUR', re: /(?:€|евро(?![а-яё])|\beur\b)/i }
  ];
}

/**
 * Ищет валюту в тексте. Возвращает {code, matched} или null.
 */
function detectCurrency_(text) {
  var patterns = currencyPatterns_();
  for (var i = 0; i < patterns.length; i++) {
    var m = text.match(patterns[i].re);
    if (m) return { code: patterns[i].code, matched: m[0] };
  }
  return null;
}

/**
 * Приводит код валюты, пришедший от модели или от пользователя, к нашему виду.
 */
function normalizeCurrency_(value) {
  var s = String(value || '').trim();
  if (!s) return baseCurrency_();
  var upper = s.toUpperCase();
  if (['ILS', 'USD', 'EUR', 'RUB'].indexOf(upper) !== -1) return upper;
  var found = detectCurrency_(s);
  return found ? found.code : baseCurrency_();
}

// ---------------------------------------------------------------------------
// Даты
// ---------------------------------------------------------------------------

/**
 * Корни названий месяцев в родительном падеже: «12 мая», «5 января».
 */
var MONTH_ROOTS_ = [
  'январ', 'феврал', 'март', 'апрел', 'ма[йя]', 'июн',
  'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'
];

function startOfDay_(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function daysAgo_(days) {
  var d = startOfDay_(new Date());
  d.setDate(d.getDate() - days);
  return d;
}

/**
 * Ищет дату в тексте. Возвращает {date, matched} или null.
 */
function detectDate_(text) {
  var lower = text.toLowerCase();

  // 1. Относительные дни. «Позавчера» проверяем раньше «вчера»,
  //    иначе внутри него нашлось бы «вчера».
  var relative = [
    { re: /позавчера/, days: 2 },
    { re: /вчера/, days: 1 },
    { re: /сегодня/, days: 0 }
  ];
  for (var i = 0; i < relative.length; i++) {
    var m = lower.match(relative[i].re);
    if (m) return { date: daysAgo_(relative[i].days), matched: m[0] };
  }

  // 2. «12 мая», «5 января 2026»
  for (var mo = 0; mo < MONTH_ROOTS_.length; mo++) {
    var re = new RegExp('(^|[^\\d])(\\d{1,2})\\s+' + MONTH_ROOTS_[mo] + '[а-яё]*(?:\\s+(\\d{4}))?', 'i');
    var match = lower.match(re);
    if (match) {
      var day = parseInt(match[2], 10);
      if (day >= 1 && day <= 31) {
        var year = match[3] ? parseInt(match[3], 10) : guessYear_(mo, day);
        return {
          date: new Date(year, mo, day),
          matched: match[0].substring(match[1].length) // без символа-разделителя слева
        };
      }
    }
  }

  // 3. «12.05», «12.05.2026», «12/05/26»
  var numeric = lower.match(/\b(\d{1,2})[.\/\-](\d{1,2})(?:[.\/\-](\d{2,4}))?\b/);
  if (numeric) {
    var d = parseInt(numeric[1], 10);
    var mth = parseInt(numeric[2], 10);
    if (d >= 1 && d <= 31 && mth >= 1 && mth <= 12) {
      var y;
      if (numeric[3]) {
        y = parseInt(numeric[3], 10);
        if (y < 100) y += 2000;
      } else {
        y = guessYear_(mth - 1, d);
      }
      return { date: new Date(y, mth - 1, d), matched: numeric[0] };
    }
  }

  return null;
}

/**
 * Год для даты без года: текущий, а если такая дата ещё не наступила —
 * прошлый (декабрьские траты, записанные в январе).
 */
function guessYear_(monthIndex, day) {
  var now = new Date();
  var candidate = new Date(now.getFullYear(), monthIndex, day);
  if (candidate > startOfDay_(now)) return now.getFullYear() - 1;
  return now.getFullYear();
}

/**
 * Разбирает дату, пришедшую от модели в формате ГГГГ-ММ-ДД (возможно, с временем).
 */
function parseIsoDate_(value) {
  var s = String(value || '').trim();
  if (!s) return null;
  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  var date = new Date(
    parseInt(m[1], 10),
    parseInt(m[2], 10) - 1,
    parseInt(m[3], 10),
    m[4] ? parseInt(m[4], 10) : 0,
    m[5] ? parseInt(m[5], 10) : 0
  );
  if (isNaN(date.getTime())) return null;
  // Отсекаем явную чушь: чек не может быть из 1970 года или из далёкого будущего
  var year = date.getFullYear();
  var nowYear = new Date().getFullYear();
  if (year < nowYear - 5 || year > nowYear + 1) return null;
  return date;
}

// ---------------------------------------------------------------------------
// Суммы
// ---------------------------------------------------------------------------

/**
 * Ищет сумму в тексте. Возвращает {amount, matched} или null.
 * Понимает «1 200,50», «1200.5», «1200», в том числе с неразрывным пробелом
 * в разделителе тысяч (так вставляет iOS).
 */
function detectAmount_(text) {
  // Плюс перед числом допустим: им помечают доход («+12000 зарплата»)
  var re = /(?:^|[\s(«"'\-–—+₪$€₽])((?:\d{1,3}(?:[\s ]\d{3})+|\d+)(?:[.,]\d{1,2})?)(?![\d.,])/;
  var m = text.match(re);
  if (!m) return null;
  var raw = m[1];
  var normalized = raw.replace(/[\s ]/g, '').replace(',', '.');
  var amount = parseFloat(normalized);
  if (isNaN(amount) || amount <= 0) return null;
  return { amount: Math.round(amount * 100) / 100, matched: raw };
}

// ---------------------------------------------------------------------------
// Основной разбор
// ---------------------------------------------------------------------------

/**
 * Слова, по которым доход узнаётся без модели.
 *
 * Список нарочно короткий и однозначный. «Получил» и «пришло» сюда не входят:
 * «получил заказ, отдал 500» — это расход, а ошибка тут дорогая, она искажает
 * бюджет дважды (придуманный доход плюс потерянный расход).
 */
var INCOME_WORDS_ = /(зарплат|аванс|премия|премию|гонорар|дивиденд|стипенди|пособи|пенси|кэшбэк|кешбэк|подработк)/i;

/**
 * Слова возврата денег: это не доход, а отмена прежней траты.
 */
var REFUND_WORDS_ = /(вернул[аи]?\s|вернули|возврат|компенсировал|отменил[аи]? заказ|refund)/i;

/**
 * Перекладывание денег между своими счетами — не доход и не расход.
 * «Перевёл Диме» сюда не относится: чужому человеку это обычная трата,
 * поэтому получателя проверяем отдельно, уже в модели.
 */
var TRANSFER_WORDS_ = /(снял[аи]?\s|снятие налич|в банкомат|перевёл себе|перевел себе|положил на карт|пополнил счёт|пополнил счет|обменял валют)/i;

/**
 * Определяет вид операции по тексту: «расход», «доход» или «возврат».
 *
 * Плюс перед суммой — правило железное и модели не доверяется: «+12000» это
 * всегда доход, что бы ни было написано рядом.
 */
function detectOperationKind_(text) {
  var s = String(text || '');

  if (/(^|[\s(])\+\s*\d/.test(s)) return 'доход';
  if (REFUND_WORDS_.test(s)) return 'возврат';
  if (TRANSFER_WORDS_.test(s)) return 'перевод';
  if (INCOME_WORDS_.test(s)) return 'доход';
  return 'расход';
}

/**
 * Разбирает текстовое сообщение о расходе или доходе.
 *
 * Возвращает {
 *   amount: число или null,
 *   currency: код валюты,
 *   date: Date,
 *   dateExplicit: была ли дата названа явно,
 *   description: строка,
 *   rawText: исходный текст
 * }
 * Вид операции определяется отдельно — detectOperationKind_.
 */
function parseExpenseText_(text) {
  var original = String(text || '').trim();

  // 1. Дата. Вырезаем её первой, чтобы «12.05» не приняли за сумму.
  var dateFound = detectDate_(original);
  var restWithoutDate = dateFound ? removeFirst_(original, dateFound.matched) : original;

  // 2. Сумма — ищем в тексте уже без даты.
  var rest;
  var amountFound = detectAmount_(restWithoutDate);
  if (amountFound) {
    rest = removeFirst_(restWithoutDate, amountFound.matched);
  } else if (dateFound) {
    // Единственное число оказалось «датой» — значит, это была сумма («12.50 кофе»).
    amountFound = detectAmount_(original);
    if (amountFound) {
      dateFound = null;
      rest = removeFirst_(original, amountFound.matched);
    } else {
      rest = restWithoutDate;
    }
  } else {
    rest = restWithoutDate;
  }

  // 3. Валюта.
  var currencyFound = detectCurrency_(rest);
  if (currencyFound) rest = removeFirst_(rest, currencyFound.matched);

  // 4. Что осталось — описание.
  var description = rest
    .replace(/[\s,;]+/g, ' ')
    .replace(/^[\s\-–—:+]+|[\s\-–—:+]+$/g, '')
    .trim();

  return {
    amount: amountFound ? amountFound.amount : null,
    currency: currencyFound ? currencyFound.code : baseCurrency_(),
    date: dateFound ? dateFound.date : startOfDay_(new Date()),
    dateExplicit: !!dateFound,
    description: description,
    rawText: original
  };
}

/**
 * Удаляет первое вхождение подстроки. Обычным поиском, а не регуляркой:
 * текст может содержать спецсимволы вроде «$» или «.».
 */
function removeFirst_(text, fragment) {
  if (!fragment) return text;
  var index = text.toLowerCase().indexOf(String(fragment).toLowerCase());
  if (index === -1) return text;
  return (text.substring(0, index) + ' ' + text.substring(index + fragment.length)).replace(/\s{2,}/g, ' ');
}


// ===========================================================================
// 05_Categorizer
// ===========================================================================

/**
 * 05_Categorizer.gs — определение категории расхода.
 *
 * Два слоя:
 *   1. Словарь ключевых слов из листа «Категории» — бесплатно и мгновенно.
 *   2. Модель Gemini — только если словарь промолчал.
 * Если оба слоя не сработали, запись всё равно сохраняется с категорией
 * «Без категории»: терять расход нельзя.
 */

var FALLBACK_CATEGORY = 'Без категории';

/**
 * Подбирает категорию по описанию и названию магазина.
 * Возвращает {category, subcategory, source}, где source — «словарь», «модель»
 * или «не определена».
 */
function categorize_(description, store) {
  var haystack = ((description || '') + ' ' + (store || '')).toLowerCase().trim();
  if (!haystack) {
    return { category: FALLBACK_CATEGORY, subcategory: '', source: 'не определена' };
  }

  // Слой 1: словарь
  var byDictionary = categorizeByDictionary_(haystack);
  if (byDictionary) return byDictionary;

  // Слой 2: модель
  try {
    var answer = geminiPickCategory_(description, store);
    if (answer && answer.category) {
      var category = String(answer.category).trim();
      var subcategory = String(answer.subcategory || '').trim();
      var known = categoryNames_();

      if (answer.isNew && known.indexOf(category) === -1) {
        // Модель предложила новую категорию — заводим её в справочнике,
        // чтобы дальше она подхватывалась словарём.
        addCategoryIfMissing_(category, subcategory);
        logEvent_('Новая категория от модели', { category: category, description: description });
      }
      return { category: category, subcategory: subcategory, source: 'модель' };
    }
  } catch (err) {
    logEvent_('Сбой категоризации', { error: String(err), description: description });
  }

  return { category: FALLBACK_CATEGORY, subcategory: '', source: 'не определена' };
}

/**
 * Поиск по ключевым словам. Выигрывает самое длинное совпавшее слово:
 * «зубной врач» точнее, чем «врач».
 */
function categorizeByDictionary_(haystack) {
  var best = null;
  readCategories_().forEach(function (item) {
    item.keywords.forEach(function (keyword) {
      if (haystack.indexOf(keyword) === -1) return;
      if (!best || keyword.length > best.keyword.length) {
        best = { keyword: keyword, category: item.category, subcategory: item.subcategory };
      }
    });
  });
  if (!best) return null;
  return { category: best.category, subcategory: best.subcategory, source: 'словарь' };
}

/**
 * Проверяет категорию, пришедшую от модели вместе с разбором голоса или чека.
 * Если такой категории в справочнике нет — пробуем обычный путь категоризации,
 * чтобы в таблице не плодились случайные названия.
 */
function resolveModelCategory_(modelCategory, modelSubcategory, description, store) {
  var candidate = String(modelCategory || '').trim();
  if (candidate && candidate !== FALLBACK_CATEGORY && categoryNames_().indexOf(candidate) !== -1) {
    return {
      category: candidate,
      subcategory: String(modelSubcategory || '').trim(),
      source: 'модель'
    };
  }
  return categorize_(description, store);
}


// ===========================================================================
// 06_Reports
// ===========================================================================

/**
 * 06_Reports.gs — сводки по запросу и месячный отчёт по триггеру.
 * Удалённые записи сюда не попадают: их отсекает readExpenses_.
 */

// ---------------------------------------------------------------------------
// Вспомогательное форматирование
// ---------------------------------------------------------------------------

function currencySymbol_(code) {
  var map = { ILS: '₪', USD: '$', EUR: '€', RUB: '₽' };
  return map[String(code).toUpperCase()] || String(code);
}

/**
 * Сумма с разделителями тысяч и символом валюты: «1 234,50 ₪».
 */
function formatMoney_(amount, currency) {
  var value = Number(amount) || 0;
  var rounded = Math.round(value * 100) / 100;
  var parts = rounded.toFixed(2).split('.');
  var whole = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  var cents = parts[1] === '00' ? '' : ',' + parts[1];
  return whole + cents + ' ' + currencySymbol_(currency || baseCurrency_());
}

function escapeHtml_(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function monthStart_(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function monthEnd_(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59);
}

var MONTH_GENITIVE_ = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
var MONTH_NOMINATIVE_ = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
var MONTH_DATIVE_ = ['январю', 'февралю', 'марту', 'апрелю', 'маю', 'июню',
  'июлю', 'августу', 'сентябрю', 'октябрю', 'ноябрю', 'декабрю'];

function monthTitle_(date) {
  return MONTH_NOMINATIVE_[date.getMonth()] + ' ' + date.getFullYear();
}

/**
 * Группировка расходов по полю. Возвращает отсортированный по убыванию массив
 * [{key, sum, count}].
 */
function groupBy_(expenses, field) {
  var map = {};
  expenses.forEach(function (item) {
    var key = String(item[field] || '—').trim() || '—';
    if (!map[key]) map[key] = { key: key, sum: 0, count: 0 };
    map[key].sum += item.baseAmount;
    map[key].count += 1;
  });
  var list = Object.keys(map).map(function (key) { return map[key]; });
  list.sort(function (a, b) { return b.sum - a.sum; });
  return list;
}

function totalOf_(expenses) {
  return expenses.reduce(function (sum, item) { return sum + item.baseAmount; }, 0);
}

// ---------------------------------------------------------------------------
// Сводки по командам
// ---------------------------------------------------------------------------

/**
 * Расходы за текущий месяц по категориям.
 */
function reportCurrentMonth_() {
  var now = new Date();
  var expenses = readExpenses_({ from: monthStart_(now), to: monthEnd_(now) });
  if (!expenses.length) return 'За ' + monthTitle_(now).toLowerCase() + ' записей пока нет.';

  var total = totalOf_(expenses);
  var groups = groupBy_(expenses, 'category');

  var lines = ['<b>' + monthTitle_(now) + '</b>', 'Всего: <b>' + formatMoney_(total) + '</b>', ''];
  groups.forEach(function (group) {
    var share = total > 0 ? Math.round((group.sum / total) * 100) : 0;
    lines.push('• ' + escapeHtml_(group.key) + ' — ' + formatMoney_(group.sum) + ' (' + share + '%)');
  });
  lines.push('');
  lines.push('Записей: ' + expenses.length);

  // Доходы показываем только когда они есть: пока их не вносят,
  // лишняя строка «Доходы: 0» в сводке ни к чему
  var incomes = readIncomes_({ from: monthStart_(now), to: monthEnd_(now) });
  if (incomes.length) {
    var incomeTotal = totalOf_(incomes);
    lines.push('');
    lines.push('Доходы: ' + formatMoney_(incomeTotal));
    var left = incomeTotal - total;
    lines.push(left >= 0
      ? 'Осталось: <b>' + formatMoney_(left) + '</b>'
      : 'Перерасход: <b>' + formatMoney_(Math.abs(left)) + '</b>');
  }

  return lines.join('\n');
}

/**
 * Доходы за текущий месяц по категориям, с итогом «осталось».
 */
function reportIncomes_() {
  var now = new Date();
  var from = monthStart_(now);
  var to = monthEnd_(now);
  var incomes = readIncomes_({ from: from, to: to });
  var expenses = readExpenses_({ from: from, to: to });

  if (!incomes.length) {
    return 'За ' + monthTitle_(now).toLowerCase() + ' доходов не записано.\n' +
      '<i>Доход записывается с плюсом: <code>+12000 зарплата</code></i>';
  }

  var total = totalOf_(incomes);
  var lines = ['<b>Доходы за ' + monthTitle_(now).toLowerCase() + '</b>',
    'Всего: <b>' + formatMoney_(total) + '</b>', ''];

  groupBy_(incomes, 'category').forEach(function (group) {
    var share = total > 0 ? Math.round((group.sum / total) * 100) : 0;
    lines.push('• ' + escapeHtml_(group.key) + ' — ' + formatMoney_(group.sum) + ' (' + share + '%)');
  });

  lines.push('');
  lines.push(balanceLine_(total, totalOf_(expenses)));
  return lines.join('\n');
}

/**
 * Строка «доход минус расход» — то, ради чего доходы и заводились.
 */
function balanceLine_(incomeTotal, expenseTotal) {
  var left = incomeTotal - expenseTotal;
  return 'Расходы: ' + formatMoney_(expenseTotal) + '\n' +
    (left >= 0
      ? 'Осталось: <b>' + formatMoney_(left) + '</b>'
      : 'Перерасход: <b>' + formatMoney_(Math.abs(left)) + '</b>');
}

/**
 * Последние десять записей.
 */
function reportLastTen_() {
  var expenses = readExpenses_({});
  if (!expenses.length) return 'Записей пока нет.';
  var last = expenses.slice(-10).reverse();

  var lines = ['<b>Последние записи</b>', ''];
  last.forEach(function (item) {
    var parts = [formatDate_(item.date), formatMoney_(item.amount, item.currency)];
    if (item.category) parts.push(escapeHtml_(item.category));
    var head = parts.join(' · ');
    var tail = item.description || item.store;
    lines.push('• ' + head + (tail ? ' — ' + escapeHtml_(tail) : ''));
  });
  return lines.join('\n');
}

/**
 * Сумма за сегодня.
 */
function reportToday_() {
  var now = new Date();
  var from = startOfDay_(now);
  var to = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 23, 59, 59);
  var expenses = readExpenses_({ from: from, to: to });
  if (!expenses.length) return 'Сегодня расходов не записано.';

  var lines = ['<b>Сегодня: ' + formatMoney_(totalOf_(expenses)) + '</b>', ''];
  expenses.forEach(function (item) {
    lines.push('• ' + formatMoney_(item.amount, item.currency) + ' · ' +
      escapeHtml_(item.category) +
      (item.description ? ' — ' + escapeHtml_(item.description) : ''));
  });
  return lines.join('\n');
}

/**
 * Справка по формату ввода.
 */
function helpText_() {
  return [
    '<b>Как записывать расходы</b>',
    '',
    '<b>Текстом</b> — сумма и описание в свободной форме:',
    '• <code>360 шек отправка машины</code>',
    '• <code>45 продукты</code>',
    '• <code>вчера 1200 гараж</code>',
    '• <code>12.05 200 руб такси</code>',
    '',
    'Можно несколько трат сразу, одним сообщением:',
    '• <code>250 продукты, 80 бензин и 45 аптека</code>',
    'Запишу их отдельными строками. Если у какой-то траты не пойму сумму —',
    'переспрошу и не запишу ничего, пока не выясним все.',
    '',
    'Валюта по умолчанию — шекель. Понимаю шекели (шек, ₪), рубли (руб, ₽),',
    'доллары ($) и евро (€). Даты — «вчера», «позавчера», «12.05», «12 мая».',
    '',
    '<b>Доходы</b> — пишите сумму с плюсом: <code>+12000 зарплата</code>.',
    'Плюс — правило железное, с ним запись всегда уйдёт в доходы.',
    'Слова «зарплата», «аванс», «премия», «гонорар» узнаю и без плюса, но тогда',
    'проверьте: в ответе будет написано «Записал доход» и кнопка «Это расход».',
    '',
    '<b>Возврат денег</b> — «вернули 200 за чайник» — не доход, а отмена траты:',
    'запишу минусом в ту же категорию расходов.',
    '',
    '<b>Снятие наличных и переводы друг другу</b> не записываю вовсе:',
    'деньги не потрачены, а переложены. Записывать надо саму трату.',
    '',
    '<b>Голосом</b> — просто наговорите: «двести шекелей супермаркет».',
    'Понимаю русский, иврит и смешанную речь. Несколько трат подряд — тоже.',
    'До минуты длиной.',
    '',
    '<b>Фотографией чека</b> — пришлите снимок, сумму возьму из строки итога.',
    'Подпись к фото использую как уточнение категории.',
    '',
    '<b>Ссылкой на чек</b> — перешлите SMS от магазина целиком, ссылку открою сам.',
    'Знаю Carrefour, Mega, «Йейнот Битан», «Рами Леви», IKEA и другие сети;',
    'по незнакомой ссылке прочитаю страницу или PDF. Если не открылась —',
    'скажу об этом, и тогда пришлите скриншот или сумму текстом.',
    '',
    '<b>Выпиской</b> — пришлите файл выгрузки из банка или карточной компании',
    '(Excel или CSV). Узнаю источник сам, разложу строки по операциям и',
    'скажу, сколько новых. Повторно тот же файл ничего не задвоит.',
    'Если файлов несколько, сложите их в папку «Выписки» рядом с таблицей',
    'и напишите /import — разберу всё разом.',
    '',
    '<b>Команды</b>',
    '/mesyac — расходы за текущий месяц по категориям',
    '/poslednie — последние 10 записей',
    '/segodnya — сумма за сегодня',
    '/dohody — доходы за месяц и сколько осталось',
    '/otchet — отчёт за прошлый месяц',
    '/import — разобрать выписки из папки «Выписки» на Диске',
    '/uchet — с какой даты брать строки выписок («/uchet 15.08.2026»)',
    '/spravka — эта справка',
    '/imya — как подписывать меня в таблице («/imya Толя»);',
    '   имя жены или мужа — «/imya 673335047 = Маша»',
    '/avtory — кто как подписан в таблице, свести имена',
    '/miniapp — адрес страницы со сводкой',
    '/obnovit — проверить, вышло ли обновление бота',
    '/whoami — мой телеграм-айди',
    '',
    'Под каждой записью есть кнопки «Изменить категорию» и «Удалить».'
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Месячный отчёт
// ---------------------------------------------------------------------------

/**
 * Полный отчёт за месяц: итог, категории с долями, сравнение с предыдущим
 * месяцем, топ-5 трат, разбивка по авторам.
 * anyDateInMonth — любая дата внутри нужного месяца.
 */
function buildMonthlyReport_(anyDateInMonth) {
  var from = monthStart_(anyDateInMonth);
  var to = monthEnd_(anyDateInMonth);
  var expenses = readExpenses_({ from: from, to: to });
  var incomes = readIncomes_({ from: from, to: to });

  var prevDate = new Date(from.getFullYear(), from.getMonth() - 1, 1);
  var prevExpenses = readExpenses_({ from: monthStart_(prevDate), to: monthEnd_(prevDate) });

  var lines = ['<b>Отчёт за ' + monthTitle_(from).toLowerCase() + '</b>', ''];

  if (!expenses.length && !incomes.length) {
    lines.push('За этот месяц записей нет.');
    return lines.join('\n');
  }

  var total = totalOf_(expenses);
  var prevTotal = totalOf_(prevExpenses);
  var incomeTotal = totalOf_(incomes);

  // Итог месяца первым делом: сколько пришло, сколько ушло, что осталось
  if (incomes.length) {
    lines.push('Доходы: <b>' + formatMoney_(incomeTotal) + '</b>');
    lines.push('Расходы: <b>' + formatMoney_(total) + '</b>');
    var left = incomeTotal - total;
    lines.push(left >= 0
      ? 'Осталось: <b>' + formatMoney_(left) + '</b>'
      : 'Потратили больше, чем заработали: <b>' + formatMoney_(Math.abs(left)) + '</b>');
    lines.push('');
  } else {
    lines.push('Всего потрачено: <b>' + formatMoney_(total) + '</b>');
  }
  lines.push('Записей: ' + expenses.length);

  // Сравнение с прошлым месяцем
  if (prevExpenses.length) {
    var diff = total - prevTotal;
    var percent = prevTotal > 0 ? Math.round((diff / prevTotal) * 100) : 0;
    var sign = diff >= 0 ? '+' : '−';
    lines.push('К ' + MONTH_DATIVE_[prevDate.getMonth()] + ': ' +
      sign + formatMoney_(Math.abs(diff)) + ' (' + sign + Math.abs(percent) + '%)');
  } else {
    lines.push('Сравнить не с чем: за прошлый месяц записей нет.');
  }

  // Категории
  lines.push('');
  lines.push('<b>По категориям</b>');
  var prevByCategory = {};
  groupBy_(prevExpenses, 'category').forEach(function (group) {
    prevByCategory[group.key] = group.sum;
  });
  groupBy_(expenses, 'category').forEach(function (group) {
    var share = total > 0 ? Math.round((group.sum / total) * 100) : 0;
    var line = '• ' + escapeHtml_(group.key) + ' — ' + formatMoney_(group.sum) + ' (' + share + '%)';
    var was = prevByCategory[group.key];
    if (was) {
      var delta = group.sum - was;
      if (Math.abs(delta) >= 1) {
        line += delta > 0 ? ' ↑' : ' ↓';
      }
    }
    lines.push(line);
  });

  // Доходы по категориям
  if (incomes.length) {
    lines.push('');
    lines.push('<b>Доходы</b>');
    groupBy_(incomes, 'category').forEach(function (group) {
      var share = incomeTotal > 0 ? Math.round((group.sum / incomeTotal) * 100) : 0;
      lines.push('• ' + escapeHtml_(group.key) + ' — ' + formatMoney_(group.sum) + ' (' + share + '%)');
    });
  }

  // Топ-5 трат
  lines.push('');
  lines.push('<b>Пять самых крупных трат</b>');
  var sorted = expenses.slice().sort(function (a, b) { return b.baseAmount - a.baseAmount; });
  sorted.slice(0, 5).forEach(function (item, index) {
    var label = item.description || item.store || item.category;
    lines.push((index + 1) + '. ' + formatMoney_(item.baseAmount) + ' — ' +
      escapeHtml_(label) + ' <i>(' + formatDate_(item.date) + ')</i>');
  });

  // Авторы
  var authors = groupBy_(expenses, 'author');
  if (authors.length > 1) {
    lines.push('');
    lines.push('<b>Кто сколько записал</b>');
    authors.forEach(function (group) {
      var share = total > 0 ? Math.round((group.sum / total) * 100) : 0;
      lines.push('• ' + escapeHtml_(group.key) + ' — ' + formatMoney_(group.sum) +
        ' (' + share + '%, записей: ' + group.count + ')');
    });
  }

  return lines.join('\n');
}

/**
 * Функция для триггера: первого числа шлёт отчёт за прошедший месяц
 * в чат из листа «Настройки».
 */
function sendMonthlyReport() {
  try {
    var chatIds = reportChatIds_();
    if (!chatIds.length) {
      logEvent_('Месячный отчёт не отправлен', 'В настройках не указан чат месячного отчёта');
      return;
    }

    var lastMonth = new Date();
    lastMonth.setDate(1);
    lastMonth.setMonth(lastMonth.getMonth() - 1);

    // Отчёт считаем один раз, а рассылаем всем адресатам из настроек
    var report = buildMonthlyReport_(lastMonth);
    var delivered = [];

    chatIds.forEach(function (chatId) {
      var result = tgSend_(chatId, report);
      if (result && result.ok) delivered.push(chatId);
      else logEvent_('Отчёт не доставлен', { chat: chatId });
    });

    logEvent_('Месячный отчёт отправлен', {
      month: monthTitle_(lastMonth),
      доставлено: delivered.join(', '),
      всего: chatIds.length
    });
  } catch (err) {
    logEvent_('Сбой месячного отчёта', String(err));
  }
}


// ===========================================================================
// 07_State
// ===========================================================================

/**
 * 07_State.gs — служебное состояние между сообщениями:
 *   • защита от повторной обработки одного апдейта;
 *   • «незавершённые» записи, ждущие ответа пользователя
 *     (не названа сумма, чек не прочитался).
 */

// ---------------------------------------------------------------------------
// Защита от повторной обработки апдейта
// ---------------------------------------------------------------------------

/**
 * Телеграм повторяет доставку, если не получил быстрый ответ. Помечаем
 * обработанные апдейты в кэше на час — этого с запасом хватает.
 * Возвращает true, если апдейт уже обрабатывался.
 */
function isDuplicateUpdate_(updateId) {
  if (!updateId) return false;
  var cache = CacheService.getScriptCache();
  var key = 'upd_' + updateId;
  if (cache.get(key)) return true;
  cache.put(key, '1', 3600);
  return false;
}

// ---------------------------------------------------------------------------
// Незавершённые записи
// ---------------------------------------------------------------------------

var PENDING_TTL_MINUTES = 120;

function pendingKey_(userId) {
  return 'PENDING_' + userId;
}

/**
 * Сохраняет незавершённую запись, ожидающую ответа пользователя.
 *
 * type:
 *   'amounts' — ждём недостающие суммы; payload = {drafts: [...], sourceType, rawText, fileLink}
 *   'confirm' — ждём подтверждения нечитаемого чека; payload = {draft: {...}}
 */
function setPending_(userId, type, payload) {
  var stored = JSON.stringify({
    type: type,
    payload: payload,
    ts: new Date().getTime()
  });
  PropertiesService.getScriptProperties().setProperty(pendingKey_(userId), stored);
}

/**
 * Возвращает незавершённую запись или null. Просроченные удаляются:
 * лучше переспросить, чем записать расход, о котором уже забыли.
 *
 * Поля payload поднимаются на верхний уровень, то есть результат выглядит как
 * {type: 'amounts', drafts: [...], sourceType: 'текст', ...}.
 */
function getPending_(userId) {
  var raw = PropertiesService.getScriptProperties().getProperty(pendingKey_(userId));
  if (!raw) return null;
  try {
    var parsed = JSON.parse(raw);
    var ageMinutes = (new Date().getTime() - parsed.ts) / 60000;
    if (ageMinutes > PENDING_TTL_MINUTES) {
      clearPending_(userId);
      return null;
    }

    var result = { type: parsed.type, ts: parsed.ts };
    var payload = parsed.payload || {};
    Object.keys(payload).forEach(function (key) { result[key] = payload[key]; });

    // Даты хранились строками — возвращаем их объектами Date
    if (result.draft) result.draft = restoreDraftDate_(result.draft);
    if (result.drafts) result.drafts = result.drafts.map(restoreDraftDate_);

    return result;
  } catch (err) {
    clearPending_(userId);
    return null;
  }
}

function restoreDraftDate_(draft) {
  if (draft && draft.dateIso) {
    draft.date = parseIsoDate_(draft.dateIso) || new Date();
  }
  return draft;
}

function clearPending_(userId) {
  PropertiesService.getScriptProperties().deleteProperty(pendingKey_(userId));
}

/**
 * Готовит черновик к сохранению: дату переводим в строку, чтобы пережить JSON.
 */
function draftForStorage_(draft) {
  var copy = {};
  Object.keys(draft).forEach(function (key) {
    if (key === 'date') return;
    copy[key] = draft[key];
  });
  var date = draft.date instanceof Date ? draft.date : new Date();
  copy.dateIso = Utilities.formatDate(date, tz_(), 'yyyy-MM-dd');
  return copy;
}

// ---------------------------------------------------------------------------
// Короткое хранение данных для инлайн-кнопок
// ---------------------------------------------------------------------------

/**
 * В callback_data телеграм пускает только 64 байта, поэтому длинные значения
 * (например, название категории) кладём в кэш и передаём короткий ключ.
 */
function stashValue_(value) {
  var key = 'v' + Utilities.getUuid().substring(0, 8);
  CacheService.getScriptCache().put(key, JSON.stringify(value), 21600); // 6 часов
  return key;
}

function unstashValue_(key) {
  var raw = CacheService.getScriptCache().get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}


// ===========================================================================
// 08_Handlers
// ===========================================================================

/**
 * 08_Handlers.gs — вся логика общения с пользователем:
 * разбор входящих сообщений, запись расхода, кнопки под сводкой.
 */

// ---------------------------------------------------------------------------
// Точка входа обработки апдейта
// ---------------------------------------------------------------------------

function handleUpdate_(update) {
  if (!update) return;

  if (isDuplicateUpdate_(update.update_id)) {
    return; // телеграм прислал тот же апдейт повторно
  }

  // Код мог смениться с прошлого раза: обновление ставит один человек,
  // а знать о новом должны все
  try {
    announceVersionChange_();
  } catch (err) {
    logEvent_('Сбой объявления версии', String(err));
  }

  if (update.callback_query) {
    handleCallback_(update.callback_query);
    return;
  }

  if (update.message) {
    handleMessage_(update.message);
    return;
  }
}

// ---------------------------------------------------------------------------
// Сообщения
// ---------------------------------------------------------------------------

function handleMessage_(message) {
  var chatId = message.chat.id;
  var from = message.from || {};
  var userId = from.id;
  var text = String(message.text || '').trim();

  // Постороннему бот не отвечает вообще: снаружи он выглядит неживым.
  // Попытка при этом попадает в лист «Лог» вместе с телеграм-айди отправителя —
  // именно оттуда при первой настройке берутся айди свои и жены.
  if (!isAllowedUser_(userId)) {
    logEvent_('Сообщение от постороннего', {
      userId: userId,
      chatId: chatId,
      username: from.username || '',
      name: userDisplayName_(from),
      text: text.substring(0, 200)
    });
    return;
  }

  // Команды
  if (text.indexOf('/') === 0) {
    handleCommand_(message, text);
    return;
  }

  // Голос
  if (message.voice || message.audio) {
    handleVoice_(message);
    return;
  }

  // Фото
  if (message.photo && message.photo.length) {
    var largest = message.photo[message.photo.length - 1]; // телеграм отдаёт размеры по возрастанию
    handleReceipt_(message, largest.file_id);
    return;
  }

  // Чек, присланный файлом: снимок или PDF. PDF выручает там, где сайт
  // магазина не пускает бота к странице чека, — «Рами Леви» отдаёт файл
  // из браузера, и его достаточно переслать сюда.
  if (message.document) {
    var mime = String(message.document.mime_type || '');
    // Выписка приходит тем же путём, что и чек, — различаем по расширению
    if (looksLikeStatement_(message.document.file_name, mime)) {
      handleStatementDocument_(message, message.document);
      return;
    }
    if (mime.indexOf('image/') === 0 || mime === 'application/pdf') {
      handleReceipt_(message, message.document.file_id, mime === 'application/pdf' ? 'файл' : 'фото');
    } else {
      tgSend_(chatId, 'Пока умею читать снимки чеков и PDF. ' +
        'Пришлите фотографию, файл PDF или напишите сумму текстом.');
    }
    return;
  }

  if (text) {
    handleTextMessage_(message, text);
    return;
  }

  tgSend_(chatId, 'Не понял сообщение. Напишите сумму и описание, ' +
    'пришлите голосовое или фото чека. Подсказка — /spravka');
}

/**
 * Команды бота. Поддержаны и русские, и английские названия.
 */
function handleCommand_(message, text) {
  var chatId = message.chat.id;
  var command = text.split(/[\s@]/)[0].toLowerCase();

  switch (command) {
    case '/start':
      tgSend_(chatId, 'Привет! Записываю семейные расходы.\n\n' + helpText_());
      return;
    case '/spravka':
    case '/help':
      tgSend_(chatId, helpText_());
      return;
    case '/mesyac':
    case '/month':
      tgSend_(chatId, reportCurrentMonth_());
      return;
    case '/poslednie':
    case '/last':
      tgSend_(chatId, reportLastTen_());
      return;
    case '/segodnya':
    case '/today':
      tgSend_(chatId, reportToday_());
      return;
    case '/dohody':
    case '/income':
      tgSend_(chatId, reportIncomes_());
      return;
    case '/otchet':
    case '/report':
      var lastMonth = new Date();
      lastMonth.setDate(1);
      lastMonth.setMonth(lastMonth.getMonth() - 1);
      tgSend_(chatId, buildMonthlyReport_(lastMonth));
      return;
    case '/otmena':
    case '/cancel':
      clearPending_(message.from.id);
      tgSend_(chatId, 'Незавершённая запись отменена.');
      return;
    case '/imya':
    case '/avtor':
    case '/name':
      handleAuthorName_(message, text);
      return;
    case '/obnovit':
    case '/update':
      tgSend_(chatId, 'Смотрю, есть ли обновления…');
      checkForUpdates(false, chatId);
      return;
    case '/import':
    case '/importt':
      importFromFolder_(chatId);
      return;
    case '/spravochnik':
      handleDirectoryUpload_(message, text);
      return;
    case '/uchet':
      handleAccountingStart_(message, text);
      return;
    case '/versiya':
    case '/version':
      tgSend_(chatId, versionReport_());
      return;
    case '/avtory':
    case '/authors':
      handleAuthorsList_(message, text);
      return;
    case '/miniapp':
      handleMiniAppUrl_(message, text);
      return;
    case '/whoami':
    case '/id':
      // Нужна, чтобы узнать айди общего чата для месячного отчёта.
      // Работает только для своих: посторонним бот молчит.
      tgSend_(chatId, 'Ваш телеграм-айди: <code>' + message.from.id + '</code>\n' +
        'Айди этого чата: <code>' + chatId + '</code>');
      return;
    default:
      tgSend_(chatId, 'Такой команды нет. Список команд — /spravka');
  }
}

/**
 * Как подписывать человека в таблице, отчётах и мини-приложении.
 *
 * Телеграмное имя для этого не годится: в записях хочется видеть «Толя»
 * и «Маша», а не «Anatoly Bezrukov» и «@masha». Имя запоминается за
 * телеграм-айди в листе «Настройки», а прошлые записи этого же человека
 * переподписываются — иначе в отчётах он раздвоится.
 */
function handleAuthorName_(message, text) {
  var chatId = message.chat.id;
  var from = message.from || {};
  var name = String(text || '').replace(/^\/\S+\s*/, '').trim();

  if (!name) {
    tgSend_(chatId, 'Сейчас я подписываю вас так: <b>' + escapeHtml_(userDisplayName_(from)) + '</b>\n\n' +
      'Чтобы поменять, напишите имя после команды:\n' +
      '<code>/imya Толя</code>\n\n' +
      '<i>Прошлые записи тоже переподпишу.</i>');
    return;
  }

  // «/imya 673335047 = Маша» — задать имя другому своему: жене или мужу,
  // чтобы не ждать, пока человек дойдёт до телефона
  var forOther = name.match(/^(\d{2,})\s*=\s*(.+)$/);
  if (forOther) {
    handleAuthorNameForOther_(message, forOther[1], forOther[2].trim());
    return;
  }

  if (name.length > 30 || /[=,;\n]/.test(name)) {
    tgSend_(chatId, 'Имя должно быть коротким и без знаков «=», «,» и «;».');
    return;
  }

  // Под какими именами человек мог записаться раньше
  var previous = [];
  var configured = userNameById_(from.id);
  if (configured) previous.push(configured);
  var fromTelegram = telegramName_(from);
  if (fromTelegram && previous.indexOf(fromTelegram) === -1) previous.push(fromTelegram);
  if (from.username) previous.push('@' + from.username);

  setUserName_(from.id, name);

  var renamed = 0;
  try {
    renamed = renameAuthorInExpenses_(previous, name);
  } catch (err) {
    logEvent_('Не удалось переподписать прошлые записи', { error: String(err), user: name });
  }

  logEvent_('Изменено имя автора', { userId: from.id, было: previous.join(' / '), стало: name });

  var lines = ['Готово. Теперь подписываю вас так: <b>' + escapeHtml_(name) + '</b>'];
  if (renamed) {
    lines.push('Прошлых записей переподписал: <b>' + renamed + '</b>.');
  }
  lines.push('');
  lines.push('<i>Имя видно в таблице, в отчётах и в мини-приложении. ' +
    'Поменять можно этой же командой.</i>');

  tgSend_(chatId, lines.join('\n'));
}

/**
 * Задать имя другому человеку из семьи по его телеграм-айди.
 *
 * Только для тех, кто уже в белом списке: команда меняет подпись в общей
 * таблице, и посторонний айди тут взяться не должен.
 */
function handleAuthorNameForOther_(message, userId, name) {
  var chatId = message.chat.id;

  if (!isAllowedUser_(userId)) {
    tgSend_(chatId, 'Айди <code>' + escapeHtml_(userId) + '</code> не в списке разрешённых.\n' +
      '<i>Список — в листе «Настройки», строка «Разрешённые телеграм-айди».</i>');
    return;
  }

  if (name.length > 30 || /[=,;\n]/.test(name)) {
    tgSend_(chatId, 'Имя должно быть коротким и без знаков «=», «,» и «;».');
    return;
  }

  var previous = userNameById_(userId);
  setUserName_(userId, name);

  var renamed = 0;
  if (previous) {
    try {
      renamed = renameAuthorInExpenses_([previous], name);
    } catch (err) {
      logEvent_('Не удалось переподписать записи', { error: String(err), user: name });
    }
  }

  logEvent_('Задано имя другому автору', { userId: userId, было: previous, стало: name });

  var lines = ['Готово. Человека с айди <code>' + escapeHtml_(String(userId)) +
    '</code> подписываю как <b>' + escapeHtml_(name) + '</b>.'];
  if (renamed) lines.push('Прошлых записей переподписал: <b>' + renamed + '</b>.');
  lines.push('');
  lines.push('<i>Если его прежние записи подписаны как-то иначе, сведите их: ' +
    '«/avtory старое имя = ' + escapeHtml_(name) + '».</i>');

  tgSend_(chatId, lines.join('\n'));
}

/**
 * Кто под какими именами записан в таблице — и как свести их воедино.
 *
 * Пока имя не задано, записи подписываются именем из телеграма. Стоит задать
 * имя позже — и в отчётах один человек оказывается двумя: «Толя» и «Sizif».
 * Здесь видно все имена сразу, а нажатие кнопки переподписывает выбранное имя
 * на имя нажавшего.
 *
 * Можно и без кнопок, если человека нет рядом: «/avtory Мария Безрукова = Маша».
 */
function handleAuthorsList_(message, text) {
  var chatId = message.chat.id;
  var argument = String(text || '').replace(/^\/\S+\s*/, '').trim();

  // Прямое переименование: «старое имя = новое имя»
  if (argument.indexOf('=') !== -1) {
    var parts = argument.split('=');
    var from = parts[0].trim();
    var to = parts.slice(1).join('=').trim();

    if (!from || !to) {
      tgSend_(chatId, 'Нужно два имени через знак равенства:\n' +
        '<code>/avtory Мария Безрукова = Маша</code>');
      return;
    }

    var renamedDirect = renameAuthorInExpenses_([from], to);
    logEvent_('Имена авторов объединены', { было: from, стало: to, записей: renamedDirect });
    tgSend_(chatId, renamedDirect
      ? 'Переподписал записей: <b>' + renamedDirect + '</b>. Теперь они на «' + escapeHtml_(to) + '».'
      : 'Записей с именем «' + escapeHtml_(from) + '» не нашёл. Посмотрите список: /avtory');
    return;
  }

  var authors = authorCounts_();
  if (!authors.length) {
    tgSend_(chatId, 'Записей пока нет.');
    return;
  }

  var mine = userDisplayName_(message.from);
  var named = !!userNameById_(message.from.id);
  var lines = ['<b>Кто как подписан в таблице</b>', ''];
  var keyboard = [];

  authors.forEach(function (author) {
    var isMine = author.name === mine;
    lines.push('• ' + escapeHtml_(author.name) + ' — ' + author.count +
      (isMine ? ' <i>(так я подписываю вас сейчас)</i>' : ''));

    // Кнопку показываем, только когда имя человека задано в настройках.
    // Иначе нажатие переписало бы правильные записи на телеграмное имя —
    // ровно наоборот тому, чего от кнопки ждут.
    if (!isMine && named) {
      keyboard.push([{
        text: '↔️ «' + shorten_(author.name, 20) + '» — это я',
        callback_data: 'author:' + stashValue_({ name: author.name })
      }]);
    }
  });

  if (!named) {
    lines.push('');
    lines.push('Сейчас я подписываю вас как <b>' + escapeHtml_(mine) + '</b> — ' +
      'это имя из телеграма, потому что своё вы мне не называли.');
    lines.push('');
    lines.push('Скажите, как вас записывать: <code>/imya Толя</code>');
    lines.push('Тогда я переподпишу прошлые записи и дальше буду звать вас так же.');
    lines.push('');
    lines.push('<i>Свести два имени можно и вручную: ' +
      '«/avtory старое имя = новое имя».</i>');
    tgSend_(chatId, lines.join('\n'));
    return;
  }

  if (!keyboard.length) {
    lines.push('');
    lines.push('<i>Все записи под одним именем — сводить нечего.</i>');
    tgSend_(chatId, lines.join('\n'));
    return;
  }

  lines.push('');
  lines.push('Если какое-то из этих имён — тоже вы, нажмите кнопку: перепишу');
  lines.push('те записи на «<b>' + escapeHtml_(mine) + '</b>».');
  lines.push('');
  lines.push('<i>За другого человека это делать не нужно — пусть он сам напишет ' +
    '/imya со своим именем. Или переименуйте вручную: ' +
    '«/avtory старое имя = новое имя».</i>');

  tgSend_(chatId, lines.join('\n'), keyboard);
}

/**
 * Адрес мини-приложения.
 *
 * Хранится в свойствах скрипта, а не в коде: у каждой установки он свой.
 * Задаётся отсюда, из чата, чтобы не лезть в редактор Apps Script —
 * там это четыре экрана вглубь и легко ошибиться в имени свойства.
 */
function handleMiniAppUrl_(message, text) {
  var chatId = message.chat.id;
  var url = String(text || '').replace(/^\/\S+\s*/, '').trim();
  var current = scriptProp_('MINIAPP_URL');

  if (!url) {
    tgSend_(chatId, current
      ? 'Адрес мини-приложения: <code>' + escapeHtml_(current) + '</code>\n\n' +
        '<i>Поменять: /miniapp и адрес через пробел.</i>'
      : 'Адрес мини-приложения не задан.\n\n' +
        'Если развернули страницу на Vercel, пришлите:\n' +
        '<code>/miniapp https://ваш-проект.vercel.app/</code>');
    return;
  }

  if (!/^https:\/\/[^\s]+$/i.test(url)) {
    tgSend_(chatId, 'Это не похоже на адрес. Нужен полный адрес страницы, ' +
      'начинающийся с <code>https://</code>');
    return;
  }

  PropertiesService.getScriptProperties().setProperty('MINIAPP_URL', url);
  logEvent_('Задан адрес мини-приложения', { url: url, user: userDisplayName_(message.from) });

  var result = setMiniAppButton();
  tgSend_(chatId, 'Адрес мини-приложения сохранён:\n<code>' + escapeHtml_(url) + '</code>\n\n' +
    '<i>' + escapeHtml_(shorten_(String(result), 300)) + '</i>');
}

// ---------------------------------------------------------------------------
// Текст
// ---------------------------------------------------------------------------

/**
 * Текстовое сообщение разбирает модель: она понимает свободную формулировку
 * и, главное, несколько трат в одном сообщении.
 * Если модель недоступна, в дело вступает локальный парсер — расход не теряется.
 */
function handleTextMessage_(message, text) {
  var chatId = message.chat.id;
  var userId = message.from.id;

  // Возможно, мы ждём от пользователя ответа по предыдущему сообщению
  var pending = getPending_(userId);
  if (pending) {
    if (continuePending_(message, text, pending)) return;
  }

  // Пересланная SMS со ссылкой на чек — по ней бот сходит сам
  var links = receiptLinksIn_(text);
  if (links.length) {
    handleReceiptLink_(message, text, links);
    return;
  }

  var parsed = geminiParseText_(text);

  if (!parsed) {
    // Модель молчит (сбой или дневной лимит) — разбираем сами, как умеем
    logEvent_('Текст разобран без модели', { text: text.substring(0, 200) });
    handleTextLocally_(message, text);
    return;
  }

  if (parsed.isExpense === false || !parsed.expenses || !parsed.expenses.length) {
    tgSend_(chatId, 'Не понял, что записать. Напишите сумму и на что потратили, ' +
      'например <code>45 продукты</code>.\n<i>Подсказка — /spravka</i>');
    return;
  }

  processExpenseList_(message, parsed.expenses, {
    sourceType: 'текст',
    rawText: text,
    comment: parsed.comment
  });
}

/**
 * Запасной путь: разбор текста без модели.
 */
function handleTextLocally_(message, text) {
  var chatId = message.chat.id;
  var parsed = parseExpenseText_(text);
  var kind = detectOperationKind_(text);

  if (kind === 'перевод') {
    tgSend_(chatId, transferExplanation_([{
      amount: parsed.amount,
      currency: parsed.currency,
      description: parsed.description
    }]));
    return;
  }

  if (!parsed.amount) {
    setPending_(message.from.id, 'amounts', {
      drafts: [draftForStorage_({
        description: parsed.description,
        currency: parsed.currency,
        date: parsed.date
      })],
      sourceType: 'текст',
      rawText: parsed.rawText
    });
    tgSend_(chatId, 'Не понял сумму. Сколько потратили' +
      (parsed.description ? ' на «' + escapeHtml_(parsed.description) + '»' : '') + '?\n' +
      '<i>Ответьте числом, например 120. Отменить — /otmena</i>');
    return;
  }

  var category = kind === 'доход'
    ? resolveIncomeCategory_('', parsed.description)
    : categorize_(parsed.description, '');

  saveAndConfirmMany_(chatId, [{
    date: parsed.date,
    amount: kind === 'возврат' ? -parsed.amount : parsed.amount,
    kind: kind,
    currency: parsed.currency,
    category: category.category,
    subcategory: category.subcategory,
    categorySource: category.source,
    description: parsed.description,
    store: '',
    items: '',
    author: userDisplayName_(message.from),
    sourceType: 'текст',
    rawText: parsed.rawText,
    fileLink: ''
  }]);
}

// ---------------------------------------------------------------------------
// Общий путь: список трат из текста или голоса
// ---------------------------------------------------------------------------

/**
 * Превращает разобранные моделью траты в записи таблицы.
 *
 * Главное правило: пока не известны ВСЕ суммы, не записывается НИЧЕГО.
 * Недостающие суммы бот спрашивает по очереди, держа остальные траты
 * в черновике.
 *
 * options: {sourceType, rawText, fileLink, transcript, comment}
 */
function processExpenseList_(message, expenses, options) {
  var chatId = message.chat.id;
  var today = startOfDay_(new Date());

  // Перекладывание денег внутри семьи не меняет бюджет — записывать нечего
  var transfers = expenses.filter(function (item) { return normalizeKind_(item.kind) === 'перевод'; });
  var real = expenses.filter(function (item) { return normalizeKind_(item.kind) !== 'перевод'; });

  if (!real.length) {
    tgSend_(chatId, transferExplanation_(transfers));
    return;
  }

  var drafts = real.map(function (item) {
    var description = String(item.description || '').trim();
    var store = String(item.store || '').trim();
    var kind = normalizeKind_(item.kind);
    var category = kind === 'доход'
      ? resolveIncomeCategory_(item.category, description)
      : resolveModelCategory_(item.category, item.subcategory, description, store);

    // Возврат — это отмена прежней траты, поэтому идёт минусом в те же расходы
    var amount = Number(item.amount) || 0;
    if (kind === 'возврат' && amount > 0) amount = -amount;

    return {
      amount: amount,
      currency: normalizeCurrency_(item.currency),
      date: parseIsoDate_(item.date) || today,
      description: description,
      store: store,
      kind: kind,
      category: category.category,
      subcategory: category.subcategory,
      categorySource: category.source
    };
  });

  if (transfers.length) {
    // Часть сообщения записали, а часть — нет; молчать об этом нельзя
    tgSend_(chatId, transferExplanation_(transfers));
  }

  var missing = drafts.filter(function (d) { return !d.amount; });

  if (missing.length) {
    // Ни одной строки в таблицу: сначала выясняем все суммы
    setPending_(message.from.id, 'amounts', {
      drafts: drafts.map(draftForStorage_),
      sourceType: options.sourceType,
      rawText: options.rawText || '',
      fileLink: options.fileLink || ''
    });
    tgSend_(chatId, askForMissingAmountText_(drafts, missing, options));
    return;
  }

  saveAndConfirmMany_(chatId, drafts.map(function (d) {
    return draftToRecord_(d, message.from, options);
  }), { transcript: options.transcript });
}

/**
 * Текст вопроса о недостающих суммах.
 */
function askForMissingAmountText_(drafts, missing, options) {
  var lines = [];

  if (options.transcript) {
    lines.push('Расслышал так:');
    lines.push('<i>' + escapeHtml_(shorten_(options.transcript, 500)) + '</i>');
    lines.push('');
  }

  if (drafts.length > 1) {
    lines.push('Разобрал ' + pluralExpenses_(drafts.length) + ':');
    drafts.forEach(function (d, index) {
      lines.push((index + 1) + '. ' + (d.amount
        ? formatMoney_(d.amount, d.currency) + ' — ' + escapeHtml_(d.description || d.category)
        : '<b>сумма?</b> — ' + escapeHtml_(d.description || d.category)));
    });
    lines.push('');
    lines.push('Пока не знаю все суммы, не записываю ничего.');
    lines.push('Сколько потратили на «' + escapeHtml_(missing[0].description || missing[0].category) + '»?');
  } else {
    lines.push('Не понял сумму. Сколько потратили' +
      (drafts[0].description ? ' на «' + escapeHtml_(drafts[0].description) + '»' : '') + '?');
  }

  lines.push('<i>Ответьте числом, например 120. Отменить — /otmena</i>');
  return lines.join('\n');
}

/**
 * Приводит вид операции к одному из четырёх известных.
 * Всё непонятное считаем расходом: это самый частый случай и самый безобидный
 * при ошибке — трата видна в отчёте, её легко поправить кнопкой.
 */
function normalizeKind_(value) {
  var kind = String(value || '').trim().toLowerCase();
  if (kind === 'доход' || kind === 'income') return 'доход';
  if (kind === 'возврат' || kind === 'refund') return 'возврат';
  if (kind === 'перевод' || kind === 'transfer') return 'перевод';
  return 'расход';
}

/**
 * Что бот отвечает на перекладывание денег внутри семьи.
 */
function transferExplanation_(transfers) {
  var what = transfers.map(function (item) {
    var amount = Number(item.amount) || 0;
    var description = String(item.description || '').trim();
    return (amount ? formatMoney_(amount, normalizeCurrency_(item.currency)) : '') +
      (description ? (amount ? ' — ' : '') + escapeHtml_(description) : '');
  }).filter(function (s) { return s; });

  var lines = ['Это перемещение денег, а не трата — в бюджет не записываю.'];
  if (what.length) {
    lines.push('');
    what.forEach(function (line) { lines.push('• ' + line); });
  }
  lines.push('');
  lines.push('<i>Снятие наличных, перевод между своими счетами или друг другу ' +
    'ничего не прибавляет и не убавляет. Записывать надо саму трату — когда ' +
    'эти деньги потратятся. Если я ошибся, напишите сумму с описанием ещё раз.</i>');
  return lines.join('\n');
}

/**
 * Категория дохода: свой справочник, без права выдумывать новые названия.
 */
function resolveIncomeCategory_(modelCategory, description) {
  var known = incomeCategoryNames_();
  var candidate = String(modelCategory || '').trim();

  if (candidate && known.indexOf(candidate) !== -1) {
    return { category: candidate, subcategory: '', source: 'модель' };
  }

  // Модель промолчала или назвала что-то своё — ищем по ключевым словам
  var haystack = String(description || '').toLowerCase();
  var best = null;
  readIncomeCategories_().forEach(function (item) {
    item.keywords.forEach(function (keyword) {
      if (haystack.indexOf(keyword) === -1) return;
      if (!best || keyword.length > best.keyword.length) {
        best = { keyword: keyword, category: item.category };
      }
    });
  });

  if (best) return { category: best.category, subcategory: '', source: 'словарь' };
  return { category: known.length ? known[known.length - 1] : 'Прочие доходы', subcategory: '', source: 'не определена' };
}

/**
 * Черновик → строка таблицы.
 */
function draftToRecord_(draft, from, options) {
  return {
    date: draft.date || startOfDay_(new Date()),
    amount: Number(draft.amount) || 0,
    kind: draft.kind || 'расход',
    currency: draft.currency || baseCurrency_(),
    category: draft.category || FALLBACK_CATEGORY,
    subcategory: draft.subcategory || '',
    categorySource: draft.categorySource || '',
    description: draft.description || '',
    store: draft.store || '',
    items: draft.items || '',
    author: userDisplayName_(from),
    sourceType: options.sourceType || 'текст',
    rawText: options.rawText || '',
    fileLink: options.fileLink || ''
  };
}

function pluralExpenses_(count) {
  var last = count % 10;
  var lastTwo = count % 100;
  if (last === 1 && lastTwo !== 11) return count + ' трату';
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return count + ' траты';
  return count + ' трат';
}

/**
 * Продолжение незавершённой записи. Возвращает true, если сообщение
 * обработано именно как продолжение.
 */
function continuePending_(message, text, pending) {
  var chatId = message.chat.id;
  var userId = message.from.id;

  // Незавершённый чек ждёт подтверждения суммы — у него свой черновик
  if (pending.type === 'confirm') return continuePendingReceipt_(message, text, pending);

  var drafts = (pending.drafts || []).slice();
  if (!drafts.length) {
    clearPending_(userId);
    return false;
  }

  var parsed = parseExpenseText_(text);
  if (!parsed.amount) {
    // Пользователь написал что-то другое — считаем незавершённую запись брошенной
    clearPending_(userId);
    return false;
  }

  // Ответ вида «38» — это ответ на вопрос. Ответ вида «120 такси» — уже новая
  // трата: человек передумал и записывает другое, черновик к нему не относится.
  var firstMissing = -1;
  for (var i = 0; i < drafts.length; i++) {
    if (!Number(drafts[i].amount)) { firstMissing = i; break; }
  }
  if (firstMissing === -1) {
    clearPending_(userId);
    return false;
  }
  if (parsed.description && drafts[firstMissing].description) {
    clearPending_(userId);
    return false;
  }

  // Подставляем названную сумму в первую трату без суммы
  drafts[firstMissing].amount = parsed.amount;
  if (parsed.currency !== baseCurrency_()) drafts[firstMissing].currency = parsed.currency;
  if (!drafts[firstMissing].description && parsed.description) {
    drafts[firstMissing].description = parsed.description;
    var recategorized = categorize_(parsed.description, '');
    drafts[firstMissing].category = recategorized.category;
    drafts[firstMissing].subcategory = recategorized.subcategory;
    drafts[firstMissing].categorySource = recategorized.source;
  }

  // Остались ли ещё траты без суммы
  var stillMissing = drafts.filter(function (d) { return !Number(d.amount); });
  if (stillMissing.length) {
    setPending_(userId, 'amounts', {
      drafts: drafts.map(draftForStorage_),
      sourceType: pending.sourceType,
      rawText: pending.rawText,
      fileLink: pending.fileLink
    });
    tgSend_(chatId, 'Записал. Осталось: сколько потратили на «' +
      escapeHtml_(stillMissing[0].description || stillMissing[0].category) + '»?\n' +
      '<i>Ответьте числом. Отменить — /otmena</i>');
    return true;
  }

  clearPending_(userId);

  var options = {
    sourceType: pending.sourceType || 'текст',
    rawText: (pending.rawText ? pending.rawText + ' | ' : '') + text,
    fileLink: pending.fileLink || ''
  };
  saveAndConfirmMany_(chatId, drafts.map(function (d) {
    return draftToRecord_(d, message.from, options);
  }));
  return true;
}

/**
 * Пользователь прислал сумму для чека, который не прочитался.
 */
function continuePendingReceipt_(message, text, pending) {
  var chatId = message.chat.id;
  var userId = message.from.id;
  var draft = pending.draft || {};

  var parsed = parseExpenseText_(text);
  if (!parsed.amount) {
    clearPending_(userId);
    return false;
  }

  clearPending_(userId);

  var description = draft.description || parsed.description || '';
  var category = draft.category
    ? { category: draft.category, subcategory: draft.subcategory || '', source: draft.categorySource || 'модель' }
    : categorize_(description, draft.store || '');

  saveAndConfirmMany_(chatId, [{
    date: draft.date || parsed.date,
    amount: parsed.amount,
    currency: parsed.currency !== baseCurrency_() ? parsed.currency : (draft.currency || parsed.currency),
    category: category.category,
    subcategory: category.subcategory,
    categorySource: category.source,
    description: description,
    store: draft.store || '',
    items: draft.items || '',
    author: userDisplayName_(message.from),
    sourceType: draft.sourceType || 'фото',
    rawText: (draft.rawText ? draft.rawText + ' | ' : '') + text,
    fileLink: draft.fileLink || ''
  }]);
  return true;
}

// ---------------------------------------------------------------------------
// Голос
// ---------------------------------------------------------------------------

function handleVoice_(message) {
  var chatId = message.chat.id;
  var media = message.voice || message.audio;

  if (media.duration && media.duration > MAX_VOICE_SECONDS) {
    tgSend_(chatId, 'Голосовое длиннее минуты я не разбираю. ' +
      'Напишите, пожалуйста, текстом: сумма и описание.');
    return;
  }

  tgSendChatAction_(chatId, 'typing');

  var file = tgDownloadFile_(media.file_id);
  if (!file) {
    logEvent_('Не скачался голосовой файл', { fileId: media.file_id });
    tgSend_(chatId, 'Не смог получить голосовое сообщение. Напишите текстом.');
    return;
  }

  var parsed = geminiParseVoice_(file.base64, file.mimeType);
  if (!parsed) {
    logEvent_('Голос не разобран', { fileId: media.file_id, duration: media.duration, перегрузка: GEMINI_BUSY_ });
    tgSend_(chatId, GEMINI_BUSY_
      ? 'Распознавание сейчас перегружено на стороне Google — это временно. ' +
        'Повторите голосовое через пару минут или напишите текстом.'
      : 'Не разобрал голосовое. Напишите, пожалуйста, текстом: сумма и описание.');
    return;
  }

  var transcript = String(parsed.transcript || '').trim();

  if (parsed.isExpense === false || !parsed.expenses || !parsed.expenses.length) {
    tgSend_(chatId, 'Расслышал так:\n<i>' + escapeHtml_(transcript || '—') + '</i>\n\n' +
      'Но трат тут не нашёл. Назовите сумму и на что потратили.');
    return;
  }

  processExpenseList_(message, parsed.expenses, {
    sourceType: 'голос',
    rawText: transcript,
    fileLink: fileReference_(media.file_id),
    transcript: transcript
  });
}

// ---------------------------------------------------------------------------
// Чеки
// ---------------------------------------------------------------------------

function handleReceipt_(message, fileId, sourceType) {
  var chatId = message.chat.id;
  var caption = String(message.caption || '').trim();
  var kind = sourceType || 'фото';

  tgSendChatAction_(chatId, 'typing');

  var file = tgDownloadFile_(fileId);
  if (!file) {
    logEvent_('Не скачалось изображение', { fileId: fileId });
    tgSend_(chatId, 'Не смог получить изображение. Пришлите ещё раз или напишите сумму текстом.');
    return;
  }

  var answer = geminiParseReceipt_(file.base64, file.mimeType, caption);
  if (!answer) {
    logEvent_('Чек не разобран', { fileId: fileId, перегрузка: GEMINI_BUSY_ });
    tgSend_(chatId, GEMINI_BUSY_
      ? 'Распознавание сейчас перегружено на стороне Google — это временно ' +
        'и от чека не зависит. Пришлите файл ещё раз через пару минут ' +
        'или напишите сумму текстом.'
      : 'Не смог прочитать чек. Напишите сумму текстом — запишу.');
    return;
  }

  var receipts = answer.receipts || [];
  if (!receipts.length) {
    logEvent_('На фото не найдено чеков', { fileId: fileId });
    tgSend_(chatId, 'Не нашёл на фотографии чек. Пришлите снимок почётче или напишите сумму текстом.');
    return;
  }

  processReceiptAnswer_(message, receipts, {
    sourceType: kind,
    fileLink: fileReference_(fileId),
    comment: caption,
    rawText: caption ? 'Подпись: ' + caption : ''
  });
}

/**
 * Разобранный чек — в таблицу. Общий путь для фотографии и для ссылки:
 * дальше уже неважно, откуда взялись данные.
 *
 * source: {sourceType, fileLink, comment, rawText}, где comment — приписка
 * пользователя (для фото это подпись к снимку).
 */
function processReceiptAnswer_(message, receipts, source) {
  var chatId = message.chat.id;
  var caption = String(source.comment || '').trim();

  // Несколько чеков сразу — каждый станет отдельной записью
  if (receipts.length > 1) {
    handleMultipleReceipts_(message, receipts, source);
    return;
  }

  var parsed = receipts[0];
  var kind = normalizeKind_(parsed.kind);
  var total = Number(parsed.total) || 0;

  // Чек на возврат уменьшает траты по своей категории, а не прибавляет доход
  if (kind === 'возврат' && total > 0) total = -total;
  var store = storeNameForTable_(parsed.store, parsed.storeRu);
  var itemsText = receiptItemsToText_(parsed.items);
  var dateFromReceipt = parseIsoDate_(parsed.datetime);

  // Подпись к фото важнее распознанного: она уточняет, что именно куплено
  var description = caption || buildReceiptDescription_(store, parsed);
  var category = resolveModelCategory_(parsed.category, parsed.subcategory, description + ' ' + itemsText, store);

  // Чек не прочитан или нет итога — без подтверждения ничего не пишем
  if (!parsed.readable || !total) { // total = 0 значит итог не прочитался
    var draft = draftForStorage_({
      description: description,
      store: store,
      items: itemsText,
      currency: normalizeCurrency_(parsed.currency),
      date: dateFromReceipt || startOfDay_(new Date()),
      category: category.category,
      subcategory: category.subcategory,
      categorySource: category.source,
      rawText: 'Чек: ' + (parsed.note || 'не распознан') + (caption ? ' | подпись: ' + caption : ''),
      sourceType: source.sourceType,
      fileLink: source.fileLink || '',
      amount: total
    });
    setPending_(message.from.id, 'confirm', { draft: draft });

    var lines = ['Чек прочитал не полностью.', ''];
    if (store) lines.push('Магазин: <b>' + escapeHtml_(store) + '</b>');
    if (dateFromReceipt) lines.push('Дата: ' + formatDate_(dateFromReceipt));
    if (itemsText) lines.push('Позиции: ' + escapeHtml_(shorten_(itemsText, 300)));
    if (total) lines.push('Сумма: <b>' + formatMoney_(total, parsed.currency) + '</b>');
    if (parsed.note) lines.push('<i>' + escapeHtml_(parsed.note) + '</i>');
    lines.push('');
    lines.push(total
      ? 'Записать так? Или пришлите верную сумму числом.'
      : 'Итоговую сумму не нашёл. Пришлите её числом — тогда запишу.');

    var keyboard = total
      ? [[{ text: '✅ Записать', callback_data: 'ok:' + message.from.id },
           { text: '✖️ Отмена', callback_data: 'no:' + message.from.id }]]
      : [[{ text: '✖️ Отмена', callback_data: 'no:' + message.from.id }]];

    tgSend_(chatId, lines.join('\n'), keyboard);
    return;
  }

  var noteParts = [];
  if (Number(parsed.tips) > 0) {
    noteParts.push('включая чаевые ' + formatMoney_(parsed.tips, parsed.currency));
  }
  if (!dateFromReceipt) {
    noteParts.push('дата с чека не прочиталась, поставил сегодняшнюю');
  }

  saveAndConfirm_(chatId, {
    date: dateFromReceipt || startOfDay_(new Date()),
    amount: total,
    kind: kind,
    currency: normalizeCurrency_(parsed.currency),
    category: category.category,
    subcategory: category.subcategory,
    categorySource: category.source,
    description: description + (noteParts.length ? ' (' + noteParts.join('; ') + ')' : ''),
    store: store,
    items: itemsText,
    author: userDisplayName_(message.from),
    sourceType: source.sourceType,
    rawText: source.rawText || '',
    fileLink: source.fileLink || ''
  }, { note: noteParts.join('; ') });
}

/**
 * Несколько чеков сразу (обычно на одном снимке): каждый становится
 * отдельной записью.
 *
 * Правило то же, что и для текста: пока не ясны все суммы, не пишем ничего.
 * Недостающие бот спросит по очереди.
 */
function handleMultipleReceipts_(message, receipts, source) {
  var chatId = message.chat.id;
  var today = startOfDay_(new Date());

  var drafts = receipts.map(function (receipt) {
    var store = storeNameForTable_(receipt.store, receipt.storeRu);
    var itemsText = receiptItemsToText_(receipt.items);
    var dateFromReceipt = parseIsoDate_(receipt.datetime);
    var description = buildReceiptDescription_(store, receipt);
    var category = resolveModelCategory_(receipt.category, receipt.subcategory,
      description + ' ' + itemsText, store);

    var notes = [];
    if (Number(receipt.tips) > 0) {
      notes.push('включая чаевые ' + formatMoney_(receipt.tips, receipt.currency));
    }
    if (!dateFromReceipt) notes.push('дата с чека не прочиталась');

    return {
      amount: Number(receipt.total) || 0,
      currency: normalizeCurrency_(receipt.currency),
      date: dateFromReceipt || today,
      description: description + (notes.length ? ' (' + notes.join('; ') + ')' : ''),
      store: store,
      items: itemsText,
      category: category.category,
      subcategory: category.subcategory,
      categorySource: category.source
    };
  });

  var comment = String(source.comment || '').trim();
  var options = {
    sourceType: source.sourceType,
    rawText: 'Несколько чеков сразу' + (comment ? '. Приписка: ' + comment : ''),
    fileLink: source.fileLink || ''
  };

  var missing = drafts.filter(function (draft) { return !draft.amount; });

  if (missing.length) {
    setPending_(message.from.id, 'amounts', {
      drafts: drafts.map(draftForStorage_),
      sourceType: options.sourceType,
      rawText: options.rawText,
      fileLink: options.fileLink
    });

    var lines = ['Нашёл ' + pluralReceipts_(drafts.length) + ':', ''];
    drafts.forEach(function (draft, index) {
      lines.push((index + 1) + '. ' + (draft.amount
        ? formatMoney_(draft.amount, draft.currency) + ' — ' + escapeHtml_(draft.store || draft.category)
        : '<b>сумма?</b> — ' + escapeHtml_(draft.store || draft.category)));
    });
    lines.push('');
    lines.push('Пока не знаю все суммы, не записываю ничего.');
    lines.push('Сколько было по чеку «' + escapeHtml_(missing[0].store || missing[0].category) + '»?');
    lines.push('<i>Ответьте числом. Отменить — /otmena</i>');

    tgSend_(chatId, lines.join('\n'));
    return;
  }

  saveAndConfirmMany_(chatId, drafts.map(function (draft) {
    return draftToRecord_(draft, message.from, options);
  }));
}

// ---------------------------------------------------------------------------
// Чек по ссылке
// ---------------------------------------------------------------------------

/**
 * Магазины всё чаще шлют не бумажный чек, а SMS со ссылкой на него.
 * Пользователь пересылает такую SMS боту — бот открывает ссылку сам.
 *
 * Ссылок в сообщении обычно две-три (чек, политика приватности, сайт сети),
 * поэтому пробуем по очереди, пока не найдётся чек.
 */
function handleReceiptLink_(message, text, links) {
  var chatId = message.chat.id;
  tgSendChatAction_(chatId, 'typing');

  var comment = userCommentInLinkMessage_(text);
  var answer = null;
  var used = '';

  for (var i = 0; i < links.length && !answer; i++) {
    answer = receiptFromLink_(links[i], comment);
    if (answer) used = links[i];
  }

  if (!answer || !answer.receipts || !answer.receipts.length) {
    offerAmountFromLinkMessage_(message, text, links[0]);
    return;
  }

  logEvent_('Чек прочитан по ссылке', {
    url: used,
    источник: answer.via,
    чеков: answer.receipts.length
  });

  processReceiptAnswer_(message, answer.receipts, {
    sourceType: 'ссылка',
    fileLink: answer.url || used,
    comment: comment,
    rawText: shorten_(text, 500)
  });
}

/**
 * Приписка пользователя к пересланной SMS.
 *
 * Сам текст SMS — служебная фраза магазина на иврите («получен новый чек»),
 * описанием расхода ей быть незачем. А вот приписка по-русски — это как раз
 * то, что человек хочет видеть в таблице.
 */
function userCommentInLinkMessage_(text) {
  var rest = textWithoutLinks_(text);
  return /[а-яё]/i.test(rest) ? rest : '';
}

/**
 * Чек по ссылке не открылся.
 *
 * В самой SMS сумма часто есть — предлагаем записать её кнопкой. Сами не
 * пишем: в служебном тексте попадаются номер магазина и номер чека, принять
 * их за сумму легко, а молча испортить таблицу нельзя.
 */
function offerAmountFromLinkMessage_(message, text, url) {
  var chatId = message.chat.id;
  logEvent_('Чек по ссылке не прочитан', { url: url, text: shorten_(text, 300) });

  var parsed = parseExpenseText_(textWithoutLinks_(text));

  if (!parsed.amount) {
    tgSend_(chatId, 'Не смог прочитать чек по ссылке.\n' +
      'Откройте её сами и пришлите скриншот — или напишите сумму текстом.');
    return;
  }

  var category = categorize_(parsed.description, '');
  setPending_(message.from.id, 'confirm', {
    draft: draftForStorage_({
      amount: parsed.amount,
      currency: parsed.currency,
      date: parsed.date,
      description: parsed.description || 'Покупка по ссылке из SMS',
      store: '',
      items: '',
      category: category.category,
      subcategory: category.subcategory,
      categorySource: category.source,
      sourceType: 'ссылка',
      rawText: shorten_(text, 500),
      fileLink: url || ''
    })
  });

  tgSend_(chatId, 'Не смог прочитать чек по ссылке, но в сообщении вижу сумму <b>' +
    formatMoney_(parsed.amount, parsed.currency) + '</b>.\n' +
    'Записать её? Или пришлите верную сумму числом.',
    [[{ text: '✅ Записать', callback_data: 'ok:' + message.from.id },
      { text: '✖️ Отмена', callback_data: 'no:' + message.from.id }]]);
}

function pluralReceipts_(count) {
  var last = count % 10;
  var lastTwo = count % 100;
  if (last === 1 && lastTwo !== 11) return count + ' чек';
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return count + ' чека';
  return count + ' чеков';
}

/**
 * Позиции чека — одной строкой для таблицы, по-русски.
 *
 * Перевод берётся из словаря на листе «Переводы», а предложенный моделью
 * используется только для незнакомых названий и тут же запоминается. Иначе
 * одно и то же «חלב» попадало бы в таблицу то «молоком», то «молоко 3%».
 */
function receiptItemsToText_(items) {
  if (!items || !items.length) return '';

  return items.map(function (item) {
    var suggested = String(item.name || '').trim();
    var original = String(item.original || '').trim();
    if (!suggested && !original) return '';

    var name = suggested;
    if (original) {
      var known = knownTranslation_(original);
      if (known) {
        name = known;
      } else if (suggested && normalizeForDictionary_(suggested) !== normalizeForDictionary_(original)) {
        // Позицию, оставшуюся без перевода, в словарь не заносим: иначе
        // ивритское название закрепится там как «перевод» навсегда
        rememberTranslation_(original, suggested, 'позиция чека');
      }
    }

    // Позиции хранятся в одной ячейке через точку с запятой, поэтому в самом
    // названии её быть не должно: иначе одна позиция позже прочитается как две
    name = name.replace(/;/g, ',');

    var price = Number(item.price);
    return price ? name + ' — ' + price.toFixed(2) : name;
  }).filter(function (s) { return s; }).join('; ');
}

/**
 * Название магазина для таблицы: оригинал, а в скобках — русское написание.
 * «שופרסל דיל (Шуферсаль Диль)».
 *
 * Перевод тоже проходит через словарь, чтобы один магазин не оказался в
 * таблице под тремя разными именами.
 */
function storeNameForTable_(store, suggestedRu) {
  var original = String(store || '').trim();
  if (!original) return '';

  // Название уже по-русски — переводить нечего
  if (/[а-яё]/i.test(original)) return original;

  var translation = knownTranslation_(original);
  if (!translation) {
    translation = String(suggestedRu || '').trim();
    if (translation) rememberTranslation_(original, translation, 'магазин');
  }

  if (!translation || normalizeForDictionary_(translation) === normalizeForDictionary_(original)) {
    return original;
  }
  return original + ' (' + translation + ')';
}

/**
 * Описание для чека, если пользователь не дал подпись.
 */
function buildReceiptDescription_(store, parsed) {
  if (store) return 'Покупка: ' + store;
  if (parsed.category) return String(parsed.category);
  return 'Покупка по чеку';
}

function shorten_(text, limit) {
  var s = String(text || '');
  return s.length > limit ? s.substring(0, limit) + '…' : s;
}

// ---------------------------------------------------------------------------
// Запись и подтверждение
// ---------------------------------------------------------------------------

/**
 * Пишет одну или несколько трат и отправляет одну общую сводку.
 * Одна трата — подробная карточка, несколько — нумерованный список,
 * под которым у каждой траты своя пара кнопок.
 *
 * extra: {transcript, note} — что дополнительно показать в сводке.
 */
function saveAndConfirmMany_(chatId, records, extra) {
  extra = extra || {};
  if (!records || !records.length) return;

  if (records.length === 1) {
    saveAndConfirm_(chatId, records[0], extra);
    return;
  }

  var saved = [];
  var failed = 0;
  records.forEach(function (record) {
    try {
      saved.push(appendExpense_(record));
    } catch (err) {
      failed++;
      logEvent_('Не удалось записать расход', { error: String(err), record: JSON.stringify(record) });
    }
  });

  if (!saved.length) {
    tgSend_(chatId, 'Не смог записать в таблицу. Подробности — в листе «Лог».');
    return;
  }

  // Доходы и расходы в одну сумму не складываем: это разные вещи
  var incomes = saved.filter(function (item) { return item.kind === 'доход'; });
  var spendings = saved.filter(function (item) { return item.kind !== 'доход'; });

  var head = [];
  if (spendings.length) {
    head.push('расходов на <b>' + formatMoney_(spendings.reduce(function (sum, item) {
      return sum + item.baseAmount;
    }, 0), baseCurrency_()) + '</b>');
  }
  if (incomes.length) {
    head.push('доходов на <b>' + formatMoney_(incomes.reduce(function (sum, item) {
      return sum + item.baseAmount;
    }, 0), baseCurrency_()) + '</b>');
  }

  var lines = ['✅ Записал ' + pluralExpenses_(saved.length) + ': ' + head.join(' и '), ''];

  saved.forEach(function (item, index) {
    var mark = item.kind === 'доход' ? '↗️ ' : (item.kind === 'возврат' ? '↩️ ' : '');
    var line = '<b>' + (index + 1) + '.</b> ' + mark + formatMoney_(item.amount, item.currency) +
      ' · ' + escapeHtml_(item.category);
    if (item.description) line += ' — ' + escapeHtml_(shorten_(item.description, 120));
    lines.push(line);

    var itemDate = formatDate_(item.date);
    if (itemDate !== formatDate_(startOfDay_(new Date()))) {
      lines.push('    <i>дата: ' + itemDate + '</i>');
    }
  });

  if (extra.transcript) {
    lines.push('');
    lines.push('Расслышал: <i>' + escapeHtml_(shorten_(extra.transcript, 500)) + '</i>');
  }
  if (failed) {
    lines.push('');
    lines.push('<i>Не удалось записать: ' + failed + '. Подробности в листе «Лог».</i>');
  }

  tgSend_(chatId, lines.join('\n'), recordsKeyboard_(saved));
}

/**
 * Пишет расход в таблицу и отправляет сводку с кнопками.
 * extra: {transcript, note} — что дополнительно показать в сводке.
 */
function saveAndConfirm_(chatId, record, extra) {
  extra = extra || {};
  var saved;
  try {
    saved = appendExpense_(record);
  } catch (err) {
    logEvent_('Не удалось записать расход', { error: String(err), record: JSON.stringify(record) });
    tgSend_(chatId, 'Не смог записать в таблицу: ' + escapeHtml_(String(err)) +
      '\nЗапись не потеряна — она в листе «Лог».');
    return;
  }

  var kind = saved.kind || 'расход';
  var title = kind === 'доход' ? '✅ Записал доход: '
    : (kind === 'возврат' ? '✅ Записал возврат: ' : '✅ Записал: ');

  var lines = [title + '<b>' + formatMoney_(saved.amount, saved.currency) + '</b>'];

  if (kind === 'возврат') {
    lines.push('<i>Уменьшил траты по этой категории — доходом не считаю.</i>');
  }

  if (saved.currency !== baseCurrency_()) {
    lines.push('В базовой валюте: ' + formatMoney_(saved.baseAmount, baseCurrency_()));
  }

  lines.push('Категория: ' + escapeHtml_(saved.category) +
    (saved.subcategory ? ' / ' + escapeHtml_(saved.subcategory) : ''));

  if (saved.description) lines.push('Описание: ' + escapeHtml_(shorten_(saved.description, 300)));
  if (saved.store) lines.push('Магазин: ' + escapeHtml_(saved.store));

  var today = formatDate_(startOfDay_(new Date()));
  var recordDate = formatDate_(saved.date);
  if (recordDate !== today) lines.push('Дата расхода: ' + recordDate);

  if (extra.transcript) {
    lines.push('');
    lines.push('Расслышал: <i>' + escapeHtml_(shorten_(extra.transcript, 500)) + '</i>');
  }
  if (saved.items) {
    lines.push('');
    itemsLines_(saved.items, lines.join('\n').length).forEach(function (line) {
      lines.push(line);
    });
  }
  if (saved.category === FALLBACK_CATEGORY) {
    lines.push('');
    lines.push('<i>Категорию подобрать не удалось — поправьте кнопкой ниже.</i>');
  }

  tgSend_(chatId, lines.join('\n'), recordKeyboard_(saved.id, kind));
}

/**
 * Позиции чека для сводки — столбиком, по строке на позицию.
 *
 * В таблице позиции лежат одной строкой через точку с запятой, а в сообщении
 * их удобнее читать списком: в чеке из супермаркета их бывает и три десятка.
 * Телеграм не принимает сообщения длиннее 4096 знаков, поэтому длинный список
 * обрезаем с честной пометкой, сколько позиций осталось за кадром.
 *
 * usedLength — сколько знаков сообщения уже занято.
 */
function itemsLines_(itemsText, usedLength) {
  var items = String(itemsText || '').split(/;\s*/).filter(function (item) {
    return item.trim();
  });
  if (!items.length) return [];

  var header = items.length > 1 ? 'Позиции (' + items.length + '):' : 'Позиция:';
  var lines = [header];
  var budget = 3600 - (usedLength || 0) - header.length;

  for (var i = 0; i < items.length; i++) {
    var line = '• ' + escapeHtml_(items[i].trim());
    if (budget - line.length < 60 && i < items.length - 1) {
      lines.push('<i>…и ещё ' + (items.length - i) + ' — полный список в таблице</i>');
      break;
    }
    lines.push(line);
    budget -= line.length + 1;
  }

  return lines;
}

/**
 * Кнопки под сводкой одной записи.
 */
function recordKeyboard_(id, kind) {
  var rows = [[
    { text: '✏️ Изменить категорию', callback_data: 'cat:' + id },
    { text: '🗑 Удалить', callback_data: 'del:' + id }
  ]];

  // У дохода кнопка переноса на виду: перепутать доход с расходом —
  // самая дорогая ошибка, поправить её надо в одно нажатие.
  // У расхода такой кнопки нет: она висела бы под каждой записью,
  // а нужна редко — её место в списке категорий.
  if (kind === 'доход') {
    rows.unshift([{ text: '↙️ Это расход', callback_data: 'toexp:' + id }]);
  }

  return rows;
}

/**
 * Кнопки под сводкой нескольких записей: по строке на каждую трату,
 * номер кнопки совпадает с номером в списке.
 */
function recordsKeyboard_(savedRecords) {
  return savedRecords.map(function (item, index) {
    return [
      { text: '✏️ ' + (index + 1), callback_data: 'cat:' + item.id },
      { text: '🗑 ' + (index + 1), callback_data: 'del:' + item.id }
    ];
  });
}

// ---------------------------------------------------------------------------
// Нажатия кнопок
// ---------------------------------------------------------------------------

function handleCallback_(callback) {
  var data = String(callback.data || '');
  var message = callback.message || {};
  var chatId = message.chat ? message.chat.id : null;
  var messageId = message.message_id;
  var from = callback.from || {};

  if (!isAllowedUser_(from.id)) {
    // Молча гасим «часики» на кнопке, ничего не поясняя
    tgAnswerCallback_(callback.id, '');
    logEvent_('Нажатие кнопки от постороннего', { userId: from.id, data: data });
    return;
  }

  // Удалить запись
  if (data.indexOf('del:') === 0) {
    var delId = data.substring(4);
    var doomed = readExpenseById_(delId);
    var deleted = markExpenseDeleted_(delId);
    tgAnswerCallback_(callback.id, deleted ? 'Удалено' : 'Запись не найдена');
    if (!deleted) return;

    logEvent_('Запись удалена', { id: delId, user: userDisplayName_(from) });

    if (isGroupSummary_(message)) {
      // В сводке на несколько трат остальные записи никуда не делись:
      // помечаем удалённую подписью и убираем только её кнопки.
      var note = '🗑 Удалено: ' + (doomed
        ? formatMoney_(doomed.amount, doomed.currency) +
          (doomed.description ? ' — ' + doomed.description : '')
        : 'запись');
      tgEditText_(chatId, messageId, escapeHtml_(String(message.text || '')) + '\n' + escapeHtml_(note),
        keyboardWithout_(message, delId));
    } else {
      tgEditText_(chatId, messageId, '🗑 <s>Запись удалена</s>', []);
    }
    return;
  }

  // Показать список категорий
  if (data.indexOf('cat:') === 0) {
    var catId = data.substring(4);
    tgAnswerCallback_(callback.id, '');
    // Запоминаем исходные кнопки, чтобы потом вернуть их как были:
    // в сводке на несколько трат их не собрать заново из одного идентификатора
    stashKeyboard_(messageId, message.reply_markup ? message.reply_markup.inline_keyboard : null);
    var catRecord = readExpenseById_(catId);
    tgEditKeyboard_(chatId, messageId, categoriesKeyboard_(catId, catRecord ? catRecord.kind : 'расход'));
    return;
  }

  // Склейка строки выписки с ручной записью
  if (data.indexOf('mg:') === 0) {
    var parts = data.substring(3).split(':');
    var merged = mergeOperationWithRecord_(parts[0], parts[1]);
    tgAnswerCallback_(callback.id, merged ? 'Склеил' : 'Строка не найдена');
    tgEditText_(chatId, messageId,
      escapeHtml_(String(message.text || '')) + '\n\n✅ Считаем одной тратой', []);
    return;
  }

  if (data.indexOf('mgn:') === 0) {
    keepOperationSeparate_(data.substring(4));
    tgAnswerCallback_(callback.id, 'Оставил раздельно');
    tgEditText_(chatId, messageId,
      escapeHtml_(String(message.text || '')) + '\n\n↔️ Разные траты', []);
    return;
  }

  // Как обновиться: файл с кодом и указания
  if (data.indexOf('update:') === 0) {
    tgAnswerCallback_(callback.id, 'Присылаю');
    tgEditKeyboard_(chatId, messageId, []);
    sendUpdateInstructions_(chatId);
    return;
  }

  // «Позже» — просто убираем кнопки, напомним при следующей версии
  if (data.indexOf('updatelater:') === 0) {
    tgAnswerCallback_(callback.id, 'Хорошо, напомню при следующей версии');
    tgEditKeyboard_(chatId, messageId, []);
    return;
  }

  // «Это тоже я» — свести чужое на вид имя со своим
  if (data.indexOf('author:') === 0) {
    var chosenAuthor = unstashValue_(data.substring(7));
    if (!chosenAuthor || !chosenAuthor.name) {
      tgAnswerCallback_(callback.id, 'Список устарел, наберите /avtory заново');
      return;
    }

    var myName = userDisplayName_(from);
    var moved = renameAuthorInExpenses_([chosenAuthor.name], myName);
    tgAnswerCallback_(callback.id, moved ? 'Переподписал: ' + moved : 'Записей не нашёл');
    logEvent_('Имена авторов объединены кнопкой', {
      было: chosenAuthor.name, стало: myName, записей: moved
    });

    if (moved) {
      tgEditText_(chatId, messageId,
        '✅ Записи с именем «' + escapeHtml_(chosenAuthor.name) + '» теперь подписаны как <b>' +
        escapeHtml_(myName) + '</b>.\nПереподписал: <b>' + moved + '</b>.\n\n' +
        '<i>Проверить, что осталось — /avtory</i>', []);
    }
    return;
  }

  // Перенести запись между расходами и доходами
  if (data.indexOf('toexp:') === 0 || data.indexOf('toinc:') === 0) {
    var moveToIncome = data.indexOf('toinc:') === 0;
    moveRecordKind_(callback, chatId, messageId, data.substring(6),
      moveToIncome ? 'доход' : 'расход');
    return;
  }

  // Вернуться к обычным кнопкам записи
  if (data.indexOf('back:') === 0) {
    tgAnswerCallback_(callback.id, '');
    tgEditKeyboard_(chatId, messageId, restoreKeyboard_(message, data.substring(5)));
    return;
  }

  // Выбрана категория: если у неё есть подкатегории — предлагаем их вторым шагом
  if (data.indexOf('cs:') === 0) {
    var csParts = data.split(':');
    var csId = csParts[1];
    var chosen = unstashValue_(csParts[2]);
    if (!chosen) {
      tgAnswerCallback_(callback.id, 'Список устарел, нажмите «Изменить категорию» заново');
      tgEditKeyboard_(chatId, messageId, recordKeyboard_(csId));
      return;
    }
    var subs = subcategoriesOf_(chosen.category);
    if (subs.length) {
      tgAnswerCallback_(callback.id, '');
      tgEditKeyboard_(chatId, messageId, subcategoriesKeyboard_(csId, chosen.category, subs));
      return;
    }
    applyCategory_(callback, chatId, messageId, csId, chosen.category, '');
    return;
  }

  // Установить категорию окончательно: sc:<id>:<ключ значения в кэше>
  if (data.indexOf('sc:') === 0) {
    var parts = data.split(':');
    var targetId = parts[1];
    var value = unstashValue_(parts[2]);
    if (!value) {
      tgAnswerCallback_(callback.id, 'Список устарел, нажмите «Изменить категорию» заново');
      tgEditKeyboard_(chatId, messageId, recordKeyboard_(targetId));
      return;
    }
    applyCategory_(callback, chatId, messageId, targetId, value.category, value.subcategory);
    return;
  }

  // Подтверждение чека
  if (data.indexOf('ok:') === 0) {
    var ownerId = data.substring(3);
    if (String(ownerId) !== String(from.id)) {
      tgAnswerCallback_(callback.id, 'Это чужая незавершённая запись');
      return;
    }
    var pending = getPending_(ownerId);
    if (!pending) {
      tgAnswerCallback_(callback.id, 'Запись уже неактуальна');
      tgEditKeyboard_(chatId, messageId, []);
      return;
    }
    clearPending_(ownerId);
    tgAnswerCallback_(callback.id, 'Записываю');
    tgEditKeyboard_(chatId, messageId, []);

    var draft = pending.draft;
    saveAndConfirm_(chatId, {
      date: draft.date || startOfDay_(new Date()),
      amount: Number(draft.amount) || 0,
      currency: draft.currency || baseCurrency_(),
      category: draft.category || FALLBACK_CATEGORY,
      subcategory: draft.subcategory || '',
      categorySource: draft.categorySource || '',
      description: draft.description || '',
      store: draft.store || '',
      items: draft.items || '',
      author: userDisplayName_(from),
      sourceType: draft.sourceType || 'фото',
      rawText: draft.rawText || '',
      fileLink: draft.fileLink || ''
    });
    return;
  }

  // Отмена незавершённой записи
  if (data.indexOf('no:') === 0) {
    clearPending_(data.substring(3));
    tgAnswerCallback_(callback.id, 'Отменено');
    tgEditText_(chatId, messageId, '✖️ Запись отменена', []);
    return;
  }

  tgAnswerCallback_(callback.id, '');
}

/**
 * Записывает выбранную категорию и обновляет сводку в чате.
 */
/**
 * Переносит запись между «Расходами» и «Доходами».
 *
 * Строку не двигаем, а помечаем удалённой и пишем заново в нужный лист: так
 * в истории видно, что операция была переосмыслена, и ничего не пропадает.
 * Категорию подбираем заново — справочники у доходов и расходов разные.
 */
function moveRecordKind_(callback, chatId, messageId, recordId, newKind) {
  var record = readExpenseById_(recordId);

  if (!record) {
    tgAnswerCallback_(callback.id, 'Запись не найдена');
    return;
  }
  if (record.kind === newKind) {
    tgAnswerCallback_(callback.id, newKind === 'доход' ? 'Это уже доход' : 'Это уже расход');
    return;
  }

  var category = newKind === 'доход'
    ? resolveIncomeCategory_('', record.description + ' ' + record.store)
    : categorize_(record.description, record.store);

  markExpenseDeleted_(recordId);

  var moved;
  try {
    moved = appendExpense_({
      date: record.date || startOfDay_(new Date()),
      amount: Math.abs(Number(record.amount) || 0),
      currency: record.currency,
      kind: newKind,
      category: category.category,
      subcategory: category.subcategory,
      categorySource: category.source,
      description: record.description,
      store: record.store,
      items: record.items,
      author: record.author,
      sourceType: record.sourceType,
      rawText: record.rawText,
      fileLink: record.fileLink
    });
  } catch (err) {
    logEvent_('Не удалось перенести запись', { id: recordId, error: String(err) });
    tgAnswerCallback_(callback.id, 'Не получилось перенести');
    return;
  }

  tgAnswerCallback_(callback.id, newKind === 'доход' ? 'Перенёс в доходы' : 'Перенёс в расходы');
  logEvent_('Запись перенесена', {
    было: record.kind, стало: newKind, id: recordId, новый: moved.id
  });

  var lines = [
    newKind === 'доход' ? '↗️ Перенёс в доходы: ' : '↙️ Перенёс в расходы: ',
    ''
  ];
  lines[0] += '<b>' + formatMoney_(moved.amount, moved.currency) + '</b>';
  lines.push('Категория: ' + escapeHtml_(moved.category) +
    (moved.subcategory ? ' / ' + escapeHtml_(moved.subcategory) : ''));
  if (moved.description) lines.push('Описание: ' + escapeHtml_(shorten_(moved.description, 200)));
  lines.push('');
  lines.push('<i>Прежняя запись помечена удалённой — в отчётах её нет.</i>');

  tgEditText_(chatId, messageId, lines.join('\n'), recordKeyboard_(moved.id, newKind));
}

function applyCategory_(callback, chatId, messageId, recordId, category, subcategory) {
  var updated = updateExpenseCategory_(recordId, category, subcategory);
  tgAnswerCallback_(callback.id, updated ? 'Категория изменена' : 'Запись не найдена');
  if (!updated) return;

  // message.text приходит без разметки, поэтому текст пересобираем и экранируем
  var message = callback.message || {};
  var text = String(message.text || '');
  var label = category + (subcategory ? ' / ' + subcategory : '');
  var newText;

  if (isGroupSummary_(message)) {
    // В списке нескольких трат правим строку именно этой записи
    var changed = readExpenseById_(recordId);
    var note = '✏️ ' + (changed && changed.description ? '«' + changed.description + '» → ' : '') + label;
    newText = text + '\n' + note;
  } else {
    newText = text.replace(/Категория: .*/, 'Категория: ' + label);
    if (newText === text) newText = text + '\nКатегория изменена на: ' + label;
  }

  tgEditText_(chatId, messageId, escapeHtml_(newText), restoreKeyboard_(message, recordId));
  logEvent_('Категория изменена вручную', { id: recordId, category: label });
}

/**
 * Сводка на несколько трат узнаётся по первой строке.
 */
function isGroupSummary_(message) {
  return /^✅ Записал \d+ трат/.test(String((message || {}).text || ''));
}

/**
 * Кнопки, которые были под сообщением до того, как мы показали список
 * категорий. Живут в кэше шесть часов; если не нашлись — собираем обычную
 * пару кнопок для одной записи.
 */
function stashKeyboard_(messageId, keyboard) {
  if (!messageId || !keyboard) return;
  CacheService.getScriptCache().put('kb' + messageId, JSON.stringify(keyboard), 21600);
}

function restoreKeyboard_(message, recordId) {
  var messageId = (message || {}).message_id;
  if (messageId) {
    var raw = CacheService.getScriptCache().get('kb' + messageId);
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch (err) { /* ниже соберём кнопки заново */ }
    }
  }
  return recordKeyboard_(recordId);
}

/**
 * Та же клавиатура, но без кнопок удалённой записи.
 */
function keyboardWithout_(message, recordId) {
  var markup = (message || {}).reply_markup;
  if (!markup || !markup.inline_keyboard) return [];
  return markup.inline_keyboard.filter(function (row) {
    return !row.some(function (button) {
      return String(button.callback_data || '').indexOf(':' + recordId) !== -1 ||
        String(button.callback_data || '') === 'del:' + recordId ||
        String(button.callback_data || '') === 'cat:' + recordId;
    });
  });
}

/**
 * Первый шаг выбора: уникальные категории справочника, по две в ряд.
 * Названия длинные, а в callback_data влезает 64 байта — поэтому значение
 * кладём в кэш и передаём короткий ключ.
 */
function categoriesKeyboard_(recordId, kind) {
  var rows = [];
  var current = [];
  var names = kind === 'доход' ? incomeCategoryNames_() : categoryNames_();

  names.forEach(function (name) {
    var key = stashValue_({ category: name, subcategory: '' });
    current.push({ text: shorten_(name, 28), callback_data: 'cs:' + recordId + ':' + key });
    if (current.length === 2) {
      rows.push(current);
      current = [];
    }
  });
  if (current.length) rows.push(current);

  // Перенос расхода в доходы живёт здесь, а не под каждой записью:
  // случай редкий, а место под сообщением дорогое
  if (kind !== 'доход') {
    rows.push([{ text: '↗️ Это доход, а не расход', callback_data: 'toinc:' + recordId }]);
  }

  rows.push([{ text: '↩️ Назад', callback_data: 'back:' + recordId }]);
  return rows;
}

/**
 * Второй шаг выбора: подкатегории выбранной категории.
 */
function subcategoriesKeyboard_(recordId, category, subs) {
  var rows = [];
  var current = [];

  subs.forEach(function (sub) {
    var key = stashValue_({ category: category, subcategory: sub });
    current.push({ text: shorten_(sub, 28), callback_data: 'sc:' + recordId + ':' + key });
    if (current.length === 2) {
      rows.push(current);
      current = [];
    }
  });
  if (current.length) rows.push(current);

  var plainKey = stashValue_({ category: category, subcategory: '' });
  rows.push([{ text: 'Без подкатегории', callback_data: 'sc:' + recordId + ':' + plainKey }]);
  rows.push([{ text: '↩️ Назад', callback_data: 'cat:' + recordId }]);
  return rows;
}

/**
 * Имя автора записи для таблицы.
 *
 * Сначала смотрим, задано ли имя в настройках («66902800=Толя»): в семейной
 * таблице удобнее «Толя», чем то, как человек подписан в телеграме.
 * Не задано — берём имя из телеграма.
 */
function userDisplayName_(from) {
  if (!from) return '';
  return userNameById_(from.id) || telegramName_(from);
}

/**
 * Как звали бы человека без настройки — по данным телеграма.
 * Нужно и само по себе, и чтобы найти его прежние записи при смене имени.
 */
function telegramName_(from) {
  if (!from) return '';

  var name = [from.first_name, from.last_name].filter(function (s) { return s; }).join(' ').trim();
  if (name) return name;
  if (from.username) return '@' + from.username;
  return String(from.id || '');
}


// ===========================================================================
// 09_Main
// ===========================================================================

/**
 * 09_Main.gs — точка входа веб-приложения (вебхук телеграма).
 */

/**
 * Телеграм присылает апдейты POST-запросом на адрес веб-приложения.
 *
 * Правило одно: что бы ни случилось внутри, наружу отдаём 200 OK.
 * Иначе телеграм начнёт повторять доставку одного и того же сообщения.
 */
function doPost(e) {
  try {
    // Необязательная защита адреса: если задано свойство WEBHOOK_SECRET,
    // принимаем только запросы с этим параметром в адресе.
    var secret = scriptProp_(PROP_WEBHOOK_SECRET);
    if (secret) {
      var provided = e && e.parameter ? e.parameter.s : '';
      if (provided !== secret) {
        logEvent_('Запрос с неверным секретом', { provided: String(provided).substring(0, 40) });
        return ContentService.createTextOutput('forbidden');
      }
    }

    if (!e || !e.postData || !e.postData.contents) {
      return ContentService.createTextOutput('no data');
    }

    var body = JSON.parse(e.postData.contents);

    // Запрос от мини-приложения, а не сообщение от телеграма
    var mode = e.parameter ? e.parameter.mode : '';
    if (mode === 'data' || mode === 'delete') {
      var answer = mode === 'data'
        ? handleMiniAppRequest_(body)
        : handleMiniAppDelete_(body);
      return ContentService
        .createTextOutput(JSON.stringify(answer))
        .setMimeType(ContentService.MimeType.JSON);
    }

    handleUpdate_(body);
  } catch (err) {
    logEvent_('Необработанная ошибка', {
      error: String(err),
      stack: err && err.stack ? String(err.stack) : '',
      body: e && e.postData ? String(e.postData.contents).substring(0, 3000) : ''
    });
  }
  return ContentService.createTextOutput('ok');
}

/**
 * GET-запрос нужен только для проверки, что веб-приложение развёрнуто.
 */
function doGet() {
  return ContentService.createTextOutput('Бот учёта расходов работает. ' + formatDateTime_(new Date()));
}


// ===========================================================================
// 10_Setup
// ===========================================================================

/**
 * 10_Setup.gs — первичная настройка: создание листов, стартовый справочник
 * категорий, триггер месячного отчёта, самопроверка.
 *
 * Эти функции запускаются вручную из редактора Apps Script.
 */

// ---------------------------------------------------------------------------
// Стартовый справочник категорий
// ---------------------------------------------------------------------------

/**
 * Категории под семью, живущую в Израиле.
 * Формат строки: [категория, подкатегория, ключевые слова через запятую].
 * Ключевые слова сравниваются по вхождению в текст, поэтому пишем корни слов
 * («продукт» поймает и «продукты», и «продуктов»).
 */
/**
 * Стартовый справочник доходов. Он отдельный от расходного: слова там разные,
 * и мешать их в одном списке — верный способ получить «Зарплату» у похода
 * в магазин.
 */
function starterIncomeCategories_() {
  return [
    ['Зарплата', '', 'зарплат, зп, оклад, аванс, премия, бонус, מש, משכורת'],
    ['Фриланс и подработки', '', 'фриланс, подработк, гонорар, заказ, консультаци, проект, самозанят'],
    ['Подарки', '', 'подарок, подарил, подарили, дарен, матана, מתנה'],
    ['Проценты и вклады', '', 'процент, вклад, депозит, дивиденд, инвестици, купон, рибит'],
    ['Продажа вещей', '', 'продал, продали, продажа, яд шния, авито, olx'],
    ['Пособия и выплаты', '', 'пособи, битуах леуми, выплат, компенсаци, пенси, стипенди, ביטוח לאומי'],
    ['Возврат налогов', '', 'налог, возврат налог, мас ахнаса, מס הכנסה'],
    ['Прочие доходы', '', '']
  ];
}

function starterCategories_() {
  return [
    ['Продукты', 'Супермаркет', 'продукт, супермаркет, рами леви, шуферсаль, шуперсаль, ошер ад, виктори, ям суф, тив таам, яйнот битан, סופר, רמי לוי, שופרסל'],
    ['Продукты', 'Рынок и овощи', 'рынок, овощи, фрукты, зелень, махане еуда'],
    ['Продукты', 'Мясо и рыба', 'мясо, мясн, курица, рыба, касап'],
    ['Продукты', 'Хлеб и выпечка', 'хлеб, булк, пекарн, выпечк'],

    ['Транспорт и автомобиль', 'Бензин', 'бензин, заправк, солярк, делек, сонол, дор алон, פז, דלק'],
    ['Транспорт и автомобиль', 'Ремонт и обслуживание', 'гараж, ремонт машин, техосмотр, тех осмотр, мусах, шиномонтаж, замена масла, автосервис, מוסך'],
    ['Транспорт и автомобиль', 'Страховка и налоги', 'страховка машин, ситуах, ришуй, дорожный налог'],
    ['Транспорт и автомобиль', 'Парковка и платные дороги', 'парковк, паркинг, пангo, pango, cellopark, шоссе 6, квиш 6, платная дорог'],
    ['Транспорт и автомобиль', 'Общественный транспорт', 'автобус, поезд, ракевет, рав кав, такси, метро, эгед'],
    ['Транспорт и автомобиль', 'Перевозка и доставка авто', 'отправка машин, перевозка машин, эвакуатор'],

    ['Жильё и коммунальные', 'Аренда', 'аренд, съём квартир, квартплат, схират'],
    ['Жильё и коммунальные', 'Электричество', 'электричеств, хашмаль, счёт за свет, חשמל'],
    ['Жильё и коммунальные', 'Вода', 'счёт за воду, мекорот, מים'],
    ['Жильё и коммунальные', 'Газ', 'газ балон, пазгаз, амисрагаз, супергаз, סופרגז'],
    ['Жильё и коммунальные', 'Ваад байт и муниципалитет', 'ваад байт, арнона, муниципалитет, ирия, ארנונה'],
    ['Жильё и коммунальные', 'Ремонт и товары для дома', 'ремонт дома, сантехник, электрик, инструмент, хоум сентер, икеа, ikea, мебель, посуд'],

    ['Здоровье и аптека', 'Аптека', 'аптек, супер фарм, super-pharm, суперфарм, бе тем, лекарств, таблетк, מרקחת'],
    ['Здоровье и аптека', 'Врачи и анализы', 'врач, доктор, анализы, клиник, купат холим, клалит, маккаби, меухедет, леумит'],
    ['Здоровье и аптека', 'Стоматология', 'стоматолог, зубн, шинаим'],
    ['Здоровье и аптека', 'Медстраховка', 'медстраховк, битуах бриют, страховка здоров'],
    ['Здоровье и аптека', 'Оптика', 'оптик, очк, линз, мишкафаим'],

    ['Кафе и рестораны', 'Кафе и кофе', 'кофе, кафе, кафетери, капучино, ландвер, кофикс, арома'],
    ['Кафе и рестораны', 'Ресторан', 'ресторан, мисада, поужинал, пообедал'],
    ['Кафе и рестораны', 'Доставка еды', 'вольт, wolt, 10bis, тенбис, доставка еды, глово'],
    ['Кафе и рестораны', 'Фастфуд', 'фалафель, шаурм, шаварм, хумус, бургер, пицц, макдоналдс'],

    ['Дети', 'Сад и школа', 'детский сад, школ, бейт сефер, цхарон, продлёнк, учебник'],
    ['Дети', 'Кружки и секции', 'кружок, секци, тренировк, музыкальная школ'],
    ['Дети', 'Детские товары', 'подгузник, игруш, детск, коляск'],

    ['Одежда', 'Взрослая одежда', 'одежд, футболк, брюк, куртк, платье, обув, кроссовк, туфл, castro, zara, h&m, renuar'],
    ['Одежда', 'Детская одежда', 'детская одежд, детская обув, комбинезон'],

    ['Связь и подписки', 'Мобильная связь', 'мобильн связь, селлком, cellcom, партнёр, partner, пелефон, голан телеком, hot mobile, симка'],
    ['Связь и подписки', 'Интернет и ТВ', 'интернет, безек, bezeq, yes tv, роутер, телевидение'],
    ['Связь и подписки', 'Цифровые подписки', 'подписк, netflix, нетфликс, spotify, спотифай, youtube, icloud, google one, chatgpt, claude'],

    ['Развлечения', 'Кино и театр', 'кино, театр, концерт, спектакль, синема'],
    ['Развлечения', 'Спорт и фитнес', 'спортзал, тренажёр, фитнес, холмс плейс, йога, бассейн'],
    ['Развлечения', 'Поездки и отдых', 'отель, гостиниц, цимер, экскурс, поездк, отпуск, авиабилет'],
    ['Развлечения', 'Хобби', 'книг, хобби, настольная игр, рукодели'],

    ['Подарки', 'Подарки', 'подарок, подарк, букет, цветы, матана'],
    ['Подарки', 'Благотворительность', 'пожертвован, цдака, благотворительн'],

    ['Прочее', 'Банк и комиссии', 'комисси, банк, обмен валют'],
    ['Прочее', 'Услуги', 'парикмахер, маникюр, косметолог, химчистк, прачечн, ремонт обуви'],
    ['Прочее', '', 'прочее, разное'],

    ['Без категории', '', '']
  ];
}

// ---------------------------------------------------------------------------
// Создание таблицы
// ---------------------------------------------------------------------------

/**
 * Создаёт все листы и заполняет справочники стартовыми значениями.
 * Повторный запуск безопасен: существующие данные не трогаются.
 */
function setupSpreadsheet() {
  var ss = getSpreadsheet_();

  // Лист «Расходы»
  var expenses = ensureSheet_(SHEET_EXPENSES, EXPENSE_COLUMNS);
  expenses.setColumnWidth(COL_CREATED, 130);
  expenses.setColumnWidth(COL_DATE, 100);
  expenses.setColumnWidth(COL_DESCRIPTION, 260);
  expenses.setColumnWidth(COL_ITEMS, 300);
  expenses.setColumnWidth(COL_RAW_TEXT, 260);
  expenses.getRange(2, COL_CREATED, expenses.getMaxRows() - 1, 1).setNumberFormat('dd.MM.yyyy HH:mm');
  expenses.getRange(2, COL_DATE, expenses.getMaxRows() - 1, 1).setNumberFormat('dd.MM.yyyy');
  expenses.getRange(2, COL_AMOUNT, expenses.getMaxRows() - 1, 1).setNumberFormat('#,##0.00');
  expenses.getRange(2, COL_BASE_AMOUNT, expenses.getMaxRows() - 1, 1).setNumberFormat('#,##0.00');

  // Лист «Доходы» — структура та же, что у расходов
  var incomes = ensureSheet_(SHEET_INCOMES, EXPENSE_COLUMNS);
  incomes.setColumnWidth(COL_CREATED, 130);
  incomes.setColumnWidth(COL_DATE, 100);
  incomes.setColumnWidth(COL_DESCRIPTION, 260);
  incomes.getRange(2, COL_CREATED, incomes.getMaxRows() - 1, 1).setNumberFormat('dd.MM.yyyy HH:mm');
  incomes.getRange(2, COL_DATE, incomes.getMaxRows() - 1, 1).setNumberFormat('dd.MM.yyyy');
  incomes.getRange(2, COL_AMOUNT, incomes.getMaxRows() - 1, 1).setNumberFormat('#,##0.00');
  incomes.getRange(2, COL_BASE_AMOUNT, incomes.getMaxRows() - 1, 1).setNumberFormat('#,##0.00');

  // Лист «Категории доходов» — свой справочник, правится так же руками
  var incomeCategories = ensureSheet_(SHEET_INCOME_CATEGORIES, CATEGORY_COLUMNS);
  if (incomeCategories.getLastRow() < 2) {
    var incomeRows = starterIncomeCategories_();
    incomeCategories.getRange(2, 1, incomeRows.length, 3).setValues(incomeRows);
    incomeCategories.setColumnWidth(1, 200);
    incomeCategories.setColumnWidth(2, 200);
    incomeCategories.setColumnWidth(3, 600);
  }

  // Лист «Категории»
  var categories = ensureSheet_(SHEET_CATEGORIES, CATEGORY_COLUMNS);
  if (categories.getLastRow() < 2) {
    var rows = starterCategories_();
    categories.getRange(2, 1, rows.length, 3).setValues(rows);
    categories.setColumnWidth(1, 200);
    categories.setColumnWidth(2, 200);
    categories.setColumnWidth(3, 600);
  }

  // Лист «Настройки»
  var settings = ensureSheet_(SHEET_SETTINGS, SETTINGS_COLUMNS);
  if (settings.getLastRow() < 2) {
    var defaults = defaultSettings_();
    settings.getRange(2, 1, defaults.length, 3).setValues(defaults);
    settings.setColumnWidth(1, 240);
    settings.setColumnWidth(2, 200);
    settings.setColumnWidth(3, 520);
  } else {
    // Настройки, появившиеся в новых версиях, дописываем в существующий лист:
    // иначе о них узнаёт только тот, кто заводит таблицу с нуля
    addMissingSettings_(settings);
  }

  // Еженедельная проверка обновлений: код лежит копией в проекте каждой семьи,
  // и без напоминания о новых версиях никто не узнает
  try {
    createUpdateTrigger();
  } catch (err) {
    logEvent_('Не удалось включить проверку обновлений', String(err));
  }

  // Лист «Переводы» — словарь ивритских названий, чтобы одно и то же
  // переводилось всегда одинаково
  var translations = ensureSheet_(SHEET_TRANSLATIONS, TRANSLATION_COLUMNS);
  translations.setColumnWidth(1, 220);
  translations.setColumnWidth(2, 220);
  translations.setColumnWidth(3, 140);
  translations.setColumnWidth(4, 150);

  // Лист «Операции» — сюда ложатся строки выписок
  var operations = ensureSheet_(SHEET_OPERATIONS, OPERATION_COLUMNS);
  operations.setColumnWidth(1, 110);
  operations.setColumnWidth(2, 110);
  operations.setColumnWidth(11, 240);
  operations.setColumnWidth(16, 260);
  operations.getRange(2, 1, operations.getMaxRows() - 1, 2).setNumberFormat('dd.MM.yyyy');
  operations.getRange(2, 3, operations.getMaxRows() - 1, 1).setNumberFormat('#,##0.00');
  operations.getRange(2, 5, operations.getMaxRows() - 1, 1).setNumberFormat('#,##0.00');

  // Журнал импорта: по нему видно, какой файл когда разобран
  var imports = ensureSheet_(SHEET_IMPORTS, IMPORT_COLUMNS);
  imports.setColumnWidth(1, 130);
  imports.setColumnWidth(2, 300);
  imports.getRange(2, 1, imports.getMaxRows() - 1, 1).setNumberFormat('dd.MM.yyyy HH:mm');

  // Реестр карт и список источников. Наполняются руками: номера карт и имена
  // — личные данные, им не место в коде, который лежит в открытом репозитории
  var cards = ensureSheet_(SHEET_CARDS, CARD_COLUMNS);
  cards.setColumnWidth(2, 190);
  cards.setColumnWidth(5, 380);

  var sources = ensureSheet_(SHEET_SOURCES, SOURCE_COLUMNS);
  sources.setColumnWidth(1, 190);
  sources.setColumnWidth(2, 260);
  sources.setColumnWidth(4, 420);

  // Лист «Лог»
  var log = ensureSheet_(SHEET_LOG, LOG_COLUMNS);
  log.setColumnWidth(1, 150);
  log.setColumnWidth(2, 220);
  log.setColumnWidth(3, 700);

  SETTINGS_CACHE_ = null;
  CATEGORIES_CACHE_ = null;

  var message = 'Готово. Таблица: ' + ss.getUrl();
  console.log(message);
  return message;
}

/**
 * Дописывает в лист «Настройки» параметры, которых там ещё нет.
 * Существующие значения не трогает — они правлены руками.
 */
function addMissingSettings_(sheet) {
  var last = sheet.getLastRow();
  var known = {};
  if (last >= 2) {
    sheet.getRange(2, 1, last - 1, 1).getValues().forEach(function (row) {
      known[String(row[0]).trim()] = true;
    });
  }

  var missing = defaultSettings_().filter(function (row) { return !known[row[0]]; });
  if (!missing.length) return 0;

  sheet.getRange(sheet.getLastRow() + 1, 1, missing.length, 3).setValues(missing);
  SETTINGS_CACHE_ = null;
  logEvent_('Добавлены новые настройки', missing.map(function (row) { return row[0]; }).join(', '));
  return missing.length;
}

// ---------------------------------------------------------------------------
// Триггер месячного отчёта
// ---------------------------------------------------------------------------

/**
 * Ставит триггер: первое число каждого месяца, около 10 утра.
 * Старый триггер той же функции удаляется, чтобы отчёт не задваивался.
 */
function createMonthlyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'sendMonthlyReport') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger('sendMonthlyReport')
    .timeBased()
    .onMonthDay(1)
    .atHour(10)
    .create();

  console.log('Триггер месячного отчёта поставлен на 1-е число, около 10:00');
  return 'ok';
}

// ---------------------------------------------------------------------------
// Курсы валют
// ---------------------------------------------------------------------------

/**
 * Переводит курсы на автоматические: вместо чисел ставит в лист «Настройки»
 * формулы GOOGLEFINANCE. Это тот же источник, который отвечает на запрос
 * «100 рублей в шекелях» в поиске Google.
 *
 * Курс подставляется в момент записи расхода. Уже записанные строки не
 * пересчитываются — и правильно: трата была по тогдашнему курсу.
 */
function enableAutoRates() {
  var base = baseCurrency_();
  var sheet = ensureSheet_(SHEET_SETTINGS, SETTINGS_COLUMNS);
  var last = sheet.getLastRow();
  if (last < 2) return 'Лист «Настройки» пуст — сначала запустите setupSpreadsheet';

  var names = sheet.getRange(2, 1, last - 1, 1).getValues();
  var updated = [];

  names.forEach(function (row, index) {
    var name = String(row[0]).trim();
    var match = name.match(/^Курс\s+([A-Z]{3})$/i);
    if (!match) return;

    var code = match[1].toUpperCase();
    if (code === base) return; // курс базовой валюты к самой себе всегда 1

    var cell = sheet.getRange(index + 2, 2);
    cell.setFormula('=GOOGLEFINANCE("CURRENCY:' + code + base + '")');
    sheet.getRange(index + 2, 3).setValue(
      'Курс берётся у Google автоматически. Чтобы задать вручную, впишите в соседнюю ячейку число.'
    );
    updated.push(code + '→' + base);
  });

  SETTINGS_CACHE_ = null;
  SpreadsheetApp.flush();

  // Показываем, что получилось: формула считается не мгновенно
  var results = [];
  updated.forEach(function (pair) {
    var code = pair.split('→')[0];
    results.push('  ' + code + ': ' + currencyRate_(code));
  });

  var report = [
    'Курсы переведены на автоматические: ' + (updated.join(', ') || 'нечего менять'),
    '',
    'Сейчас получается так:',
    results.join('\n'),
    '',
    'Google обновляет курс с задержкой до 20 минут — это нормально.',
    'Если по какой-то валюте вместо числа появится ошибка, бот возьмёт',
    'последний удачный курс, а причина попадёт в лист «Лог».'
  ].join('\n');

  console.log(report);
  logEvent_('Курсы переведены на автоматические', updated.join(', '));
  return report;
}

/**
 * Возвращает курсы к ручным числам: подставляет текущие значения вместо формул.
 * Пригодится, если Google перестанет отдавать какую-то пару.
 */
function disableAutoRates() {
  var sheet = ensureSheet_(SHEET_SETTINGS, SETTINGS_COLUMNS);
  var last = sheet.getLastRow();
  if (last < 2) return 'Лист «Настройки» пуст';

  var names = sheet.getRange(2, 1, last - 1, 1).getValues();
  var frozen = [];

  names.forEach(function (row, index) {
    var name = String(row[0]).trim();
    var match = name.match(/^Курс\s+([A-Z]{3})$/i);
    if (!match) return;

    var cell = sheet.getRange(index + 2, 2);
    if (!cell.getFormula()) return; // уже число

    var code = match[1].toUpperCase();
    var value = currencyRate_(code);
    cell.setValue(value);
    frozen.push(code + ' = ' + value);
  });

  SETTINGS_CACHE_ = null;
  var report = 'Курсы зафиксированы числами:\n  ' + (frozen.join('\n  ') || 'нечего фиксировать');
  console.log(report);
  return report;
}

/**
 * Показывает, какие курсы бот видит прямо сейчас.
 */
function showRates() {
  var base = baseCurrency_();
  var lines = ['Базовая валюта: ' + base, ''];

  ['USD', 'EUR', 'RUB', 'ILS'].forEach(function (code) {
    if (code === base) return;
    var rate = currencyRate_(code);
    lines.push('1 ' + code + ' = ' + rate + ' ' + base +
      '   (100 ' + code + ' = ' + Math.round(100 * rate * 100) / 100 + ' ' + base + ')');
  });

  var text = lines.join('\n');
  console.log(text);
  return text;
}

// ---------------------------------------------------------------------------
// Модели Gemini
// ---------------------------------------------------------------------------

/**
 * Показывает, какие модели доступны вашему ключу. Запускать вручную, когда
 * нужно понять, что вообще предлагает Google.
 */
function listGeminiModels() {
  var models = availableGeminiModels_();
  if (!models.length) {
    var message = 'Список моделей получить не удалось. Проверьте GEMINI_API_KEY ' +
      'и посмотрите лист «Лог».';
    console.log(message);
    return message;
  }

  var text = 'Доступно моделей: ' + models.length + '\n' +
    models.map(function (name) { return '  • ' + name; }).join('\n') +
    '\n\nСейчас используются:\n' +
    '  для медиа (голос, чеки): ' + modelForMedia_() + '\n' +
    '  для текста: ' + modelForText_() +
    '\n\nПоменять их можно на листе «Настройки» или функцией autoSelectModels.';
  console.log(text);
  return text;
}

/**
 * Подбирает рабочие модели из доступных и записывает их в лист «Настройки».
 *
 * Запускать, когда бот начал отвечать «не разобрал», а в логе появилась
 * запись «Модель Gemini недоступна»: Google снял старую модель с публикации.
 * Код при этом править не нужно — имена моделей живут в таблице.
 */
function autoSelectModels() {
  var models = availableGeminiModels_();
  if (!models.length) {
    var problem = 'Не удалось получить список моделей. Проверьте GEMINI_API_KEY ' +
      'и посмотрите лист «Лог».';
    console.log(problem);
    return problem;
  }

  // Названию модели верить нельзя: Google выкладывает и такие, что обычный
  // запрос не принимают. Поэтому кандидатов пробуем по очереди и берём
  // первого, кто действительно ответил.
  var media = firstWorkingModel_(rankModels_(models, 'media'));
  var text = firstWorkingModel_(rankModels_(models, 'text'));

  if (!media.model) {
    var nothing = [
      'Ни одна из моделей не ответила. Перепробовано: ' + (media.tried.join(', ') || 'нечего пробовать'),
      '',
      'Похоже, дело не в выборе модели, а в ключе или лимитах — смотрите лист «Лог».',
      'Весь список доступных моделей покажет функция listGeminiModels.'
    ].join('\n');
    console.log(nothing);
    return nothing;
  }

  var textModel = text.model || media.model;
  updateSetting_('Модель для медиа', media.model);
  updateSetting_('Модель для текста', textModel);

  var report = ['Записал в лист «Настройки»:',
    '  Модель для медиа (голос, чеки): ' + media.model,
    '  Модель для текста: ' + textModel,
    '',
    'Обе проверены пробным запросом — отвечают.'];

  // Модель, выбранную в одной роли, не показываем как «не подошедшую» в другой:
  // отказ мог быть временным (перегрузка), и путать это с непригодностью незачем
  var chosen = [media.model, textModel];
  var skipped = media.tried.concat(text.tried).filter(function (name, index, all) {
    return all.indexOf(name) === index && chosen.indexOf(name) === -1;
  });
  if (skipped.length) {
    report.push('');
    report.push('Не подошли (не ответили на проверку): ' + skipped.join(', '));
  }
  if (media.model !== textModel && media.tried.concat(text.tried).indexOf(media.model) !== -1) {
    report.push('');
    report.push('Заметка: ' + media.model + ' в одной из проверок ответила отказом — ' +
      'скорее всего, временная перегрузка. Модель рабочая.');
  }

  report.push('');
  report.push('Всего доступно моделей: ' + models.length + ' (список — функция listGeminiModels)');

  var text2 = report.join('\n');
  console.log(text2);
  logEvent_('Модели подобраны', { медиа: media.model, текст: textModel });
  return text2;
}

// ---------------------------------------------------------------------------
// Самопроверка
// ---------------------------------------------------------------------------

/**
 * Проверяет, что всё настроено: свойства, таблица, доступ к телеграму и Gemini.
 * Результат печатается в журнал выполнения.
 */
function selfCheck() {
  var problems = [];
  var notes = [];

  // Свойства скрипта
  if (!scriptProp_(PROP_BOT_TOKEN)) problems.push('Не задан ' + PROP_BOT_TOKEN);
  if (!scriptProp_(PROP_GEMINI_KEY)) problems.push('Не задан ' + PROP_GEMINI_KEY + ' (голос и чеки работать не будут)');
  if (!scriptProp_(PROP_SPREADSHEET_ID)) notes.push('SPREADSHEET_ID не задан — используется таблица, к которой привязан скрипт');

  // Таблица
  try {
    var ss = getSpreadsheet_();
    notes.push('Таблица: ' + ss.getName());
    [SHEET_EXPENSES, SHEET_CATEGORIES, SHEET_SETTINGS, SHEET_LOG].forEach(function (name) {
      if (!ss.getSheetByName(name)) problems.push('Нет листа «' + name + '» — запустите setupSpreadsheet');
    });
  } catch (err) {
    problems.push('Таблица недоступна: ' + err);
  }

  // Настройки
  try {
    var allowed = allowedUserIds_();
    if (!allowed.length) problems.push('Пустой белый список — бот никого не пустит. Заполните «Разрешённые телеграм-айди»');
    else notes.push('Разрешённых пользователей: ' + allowed.length);

    var reportChats = reportChatIds_();
    if (!reportChats.length) notes.push('Не указан чат месячного отчёта — отчёт отправляться не будет');
    else notes.push('Месячный отчёт получат: ' + reportChats.join(', '));
    notes.push('Категорий в справочнике: ' + categoryNames_().length);
    notes.push('Базовая валюта: ' + baseCurrency_());
  } catch (err) {
    problems.push('Настройки не читаются: ' + err);
  }

  // Телеграм
  try {
    var me = tgCall_('getMe', {});
    if (me.ok) notes.push('Бот: @' + me.result.username);
    else problems.push('Телеграм не принял токен');
  } catch (err) {
    problems.push('Телеграм недоступен: ' + err);
  }

  // Как принимаются сообщения
  try {
    var polling = pollingEnabled_();
    var info = tgCall_('getWebhookInfo', {});
    var webhookUrl = info.ok && info.result ? info.result.url : '';

    if (polling) {
      notes.push('Режим приёма: опрос раз в минуту (триггер pollUpdates)');
      if (webhookUrl) {
        problems.push('Вебхук всё ещё установлен и мешает опросу — запустите switchToPolling');
      }
      if (info.ok && info.result && info.result.pending_update_count) {
        notes.push('Ждут обработки сообщений: ' + info.result.pending_update_count);
      }
    } else if (webhookUrl) {
      notes.push('Режим приёма: вебхук — ' + webhookUrl);
      if (info.result.last_error_message) {
        problems.push('Вебхук не работает: ' + info.result.last_error_message +
          '. Если это «302 Found» — запустите switchToPolling, вебхук в Apps Script ненадёжен');
      }
    } else {
      problems.push('Бот не принимает сообщения: нет ни триггера опроса, ни вебхука. ' +
        'Запустите switchToPolling');
    }
  } catch (err) {
    problems.push('Не удалось проверить приём сообщений: ' + err);
  }

  // Gemini
  if (scriptProp_(PROP_GEMINI_KEY)) {
    notes.push('Модель для медиа: ' + modelForMedia_() + ', для текста: ' + modelForText_());
    var answer = geminiPickCategory_('проверка связи, покупка хлеба', '');
    if (answer && answer.category) {
      notes.push('Gemini отвечает, тестовая категория: ' + answer.category);
    } else {
      problems.push('Gemini не ответил. Если в листе «Лог» написано «Модель Gemini недоступна» — ' +
        'запустите функцию autoSelectModels, она подберёт рабочую модель. ' +
        'Иначе проверьте ключ и дневные лимиты');
    }
  }

  var report = ['=== Проверка настройки ==='];
  report.push(problems.length ? '❌ Проблемы:' : '✅ Проблем не найдено');
  problems.forEach(function (p) { report.push('  • ' + p); });
  report.push('ℹ️ Сведения:');
  notes.forEach(function (n) { report.push('  • ' + n); });

  var text = report.join('\n');
  console.log(text);
  return text;
}

/**
 * Разовая проверка разбора текста — удобно посмотреть, как бот понимает фразы.
 */
function testParser() {
  var samples = [
    '360 шек отправка машины',
    '45 продукты',
    'вчера 1200 гараж',
    '12.05 200 руб такси',
    '$45 подписка нетфликс',
    '1 250,50 шекелей ремонт машины',
    'позавчера 89 аптека',
    'кофе с коллегой'
  ];
  var output = samples.map(function (sample) {
    var parsed = parseExpenseText_(sample);
    return sample + '  →  ' +
      'сумма: ' + parsed.amount +
      ', валюта: ' + parsed.currency +
      ', дата: ' + formatDate_(parsed.date) +
      ', описание: «' + parsed.description + '»';
  }).join('\n');
  console.log(output);
  return output;
}


// ===========================================================================
// 11_Polling
// ===========================================================================

/**
 * 11_Polling.gs — приём сообщений опросом, без вебхука.
 *
 * Зачем: Apps Script на POST отвечает перенаправлением (302) на
 * script.googleusercontent.com. Браузер за таким перенаправлением идёт, а
 * Telegram — нет: он считает 302 ошибкой и сообщение не доставляет.
 * Поэтому вместо «телеграм стучится к нам» делаем наоборот — «мы раз в минуту
 * спрашиваем телеграм, нет ли нового».
 *
 * Триггер по времени раз в минуту вызывает pollUpdates. Сообщения при этом
 * не теряются: телеграм хранит их до 24 часов и отдаёт все накопившиеся разом.
 */

var PROP_UPDATE_OFFSET = 'TELEGRAM_OFFSET';

/**
 * Один цикл опроса. Вызывается триггером.
 *
 * Пустой запуск занимает около секунды — это важно, потому что суточный
 * бюджет триггеров ограничен, а запусков в сутки 1440.
 */
function pollUpdates() {
  // Два триггера могли наложиться — тогда второй просто пропускает ход,
  // иначе одно и то же сообщение обработается дважды
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;

  try {
    var rounds = 0;

    // Пока сообщения идут, продолжаем забирать их в этом же запуске:
    // человек обычно пишет несколько подряд, и ждать следующей минуты незачем
    while (rounds < 5) {
      var updates = fetchUpdates_();
      if (!updates.length) break;

      updates.forEach(function (update) {
        try {
          handleUpdate_(update);
        } catch (err) {
          logEvent_('Ошибка обработки сообщения', {
            error: String(err),
            stack: err && err.stack ? String(err.stack) : '',
            update: JSON.stringify(update).substring(0, 2000)
          });
        }
        // Сдвигаем указатель сразу после каждого сообщения: если следующее
        // уронит скрипт, обработанное не придёт повторно
        setUpdateOffset_(update.update_id + 1);
      });

      rounds++;
      if (updates.length < 10) break; // забрали всё, что было
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * Забирает порцию новых сообщений.
 */
function fetchUpdates_() {
  var offset = getUpdateOffset_();
  var payload = {
    limit: 10,
    timeout: 0, // без ожидания: длинные соединения съедают суточный лимит
    allowed_updates: ['message', 'callback_query']
  };
  if (offset) payload.offset = offset;

  var data = tgCall_('getUpdates', payload);

  if (!data.ok) {
    // 409 означает, что остался вебхук: telegram не отдаёт сообщения,
    // пока он установлен
    if (data.error_code === 409) {
      logEvent_('Вебхук мешает опросу', 'Запустите функцию switchToPolling — она снимет вебхук');
    }
    return [];
  }

  return data.result || [];
}

function getUpdateOffset_() {
  var raw = scriptProp_(PROP_UPDATE_OFFSET);
  var value = parseInt(raw, 10);
  return isNaN(value) ? 0 : value;
}

function setUpdateOffset_(offset) {
  PropertiesService.getScriptProperties().setProperty(PROP_UPDATE_OFFSET, String(offset));
}

// ---------------------------------------------------------------------------
// Переключение режимов (запускать вручную)
// ---------------------------------------------------------------------------

/**
 * Переводит бота на опрос: снимает вебхук и ставит триггер раз в минуту.
 * Это основной режим работы.
 */
function switchToPolling() {
  // 1. Снимаем вебхук — иначе телеграм не отдаст сообщения опросу.
  //    drop_pending_updates не ставим: накопившиеся сообщения нужны.
  var removed = tgCall_('deleteWebhook', {});

  // 2. Убираем старые триггеры опроса, чтобы не задвоить
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'pollUpdates') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  // 3. Ставим новый
  ScriptApp.newTrigger('pollUpdates')
    .timeBased()
    .everyMinutes(1)
    .create();

  // 4. Сразу забираем всё, что накопилось
  pollUpdates();

  var report = [
    'Бот переведён на опрос.',
    '  Вебхук снят: ' + (removed && removed.ok ? 'да' : 'не потребовалось'),
    '  Триггер: pollUpdates, каждую минуту',
    '',
    'Сообщения приходят с задержкой до минуты — это плата за отказ от вебхука.',
    'Накопившиеся сообщения уже забраны.'
  ].join('\n');

  console.log(report);
  logEvent_('Режим приёма', 'опрос раз в минуту');
  return report;
}

/**
 * Переводит бота на вебхук через посредника: снимает триггер опроса и
 * прописывает в телеграме адрес из свойства WEBHOOK_URL.
 *
 * Прямой адрес Apps Script сюда не годится — телеграм не умеет ходить по
 * перенаправлениям, которыми тот отвечает. Нужен адрес посредника.
 */
function switchToWebhook() {
  var url = scriptProp_('WEBHOOK_URL');
  if (!url) {
    var problem = 'Не задано свойство скрипта WEBHOOK_URL — адрес посредника. ' +
      'Без него телеграму некуда слать сообщения.';
    console.log(problem);
    return problem;
  }

  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'pollUpdates') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  var result = setWebhook(url);
  if (!result || !result.ok) {
    var failed = 'Телеграм не принял адрес вебхука. Ответ: ' + JSON.stringify(result);
    console.log(failed);
    return failed;
  }

  var report = [
    'Бот переведён на вебхук.',
    '  Адрес: ' + url,
    '  Триггер опроса снят.',
    '',
    'Сообщения теперь приходят мгновенно.',
    'Проверить: функция getWebhookInfo — в ответе не должно быть last_error_message.'
  ].join('\n');

  console.log(report);
  logEvent_('Режим приёма', 'вебхук через посредника');
  return report;
}

/**
 * В каком режиме сейчас работает приём сообщений.
 */
function pollingEnabled_() {
  return ScriptApp.getProjectTriggers().some(function (trigger) {
    return trigger.getHandlerFunction() === 'pollUpdates';
  });
}


// ===========================================================================
// 12_Links
// ===========================================================================

/**
 * 12_Links.gs — чек, присланный ссылкой.
 *
 * Магазины всё чаще шлют не бумажный чек, а SMS со ссылкой на него.
 * Пользователь пересылает такую SMS боту, а бот открывает ссылку сам.
 *
 * Три пути, в порядке предпочтения:
 *   1. Известный сервис цифровых чеков: Pairzon (Carrefour, Mega, «Йейнот
 *      Битан»), Weezmo (IKEA и другие), «Рами Леви». У каждого чек лежит
 *      готовой таблицей — рядом со страницей или прямо в ней. Сумма, дата и
 *      позиции берутся оттуда точными, распознавать нечего.
 *   2. PDF или картинка по ссылке — это и есть чек, отдаём его модели так же,
 *      как присланную фотографию.
 *   3. Обычная страница — вычищаем разметку и отдаём модели текстом.
 *
 * Ни один путь не должен ронять обработку: не открылось — вызывающий код
 * предложит записать сумму из самой SMS.
 */

var LINK_MAX_REDIRECTS = 5;      // короткая ссылка из SMS ведёт на длинную, иногда через две
var LINK_TEXT_LIMIT = 20000;     // столько текста страницы отдаём модели
var LINK_MIN_TEXT_LENGTH = 200;  // меньше — страница пустая, чек в ней рисует скрипт

// Некоторые сайты не отвечают запросу без имени браузера
var LINK_USER_AGENT = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

// ---------------------------------------------------------------------------
// Ссылки в тексте
// ---------------------------------------------------------------------------

/**
 * Все веб-адреса из текста, без повторов.
 */
function findLinks_(text) {
  var found = String(text || '').match(/https?:\/\/[^\s<>"'«»()\[\]]+/gi) || [];
  var result = [];

  found.forEach(function (raw) {
    // Точка или скобка в конце фразы к адресу не относится
    var url = raw.replace(/[.,;:!?)»"'‏‎]+$/, '');
    if (url.length > 12 && result.indexOf(url) === -1) result.push(url);
  });

  return result;
}

/**
 * Ссылки, за которыми чека заведомо нет. В той же SMS обычно есть ещё ссылка
 * на политику приватности, отписку или страницу сети — ходить по ним незачем.
 */
function isServiceLink_(url) {
  var lower = String(url).toLowerCase();
  return /(polic|privacy|terms|takanon|unsubscribe|opt-?out|help|support)/.test(lower) ||
    /(facebook|instagram|twitter|youtube|tiktok|whatsapp|t\.me|waze|maps\.google|apps\.apple|play\.google)/.test(lower);
}

/**
 * Ссылки, по которым имеет смысл искать чек: сначала все «неслужебные»,
 * а если таких не осталось — что есть, вдруг чек всё-таки там.
 */
function receiptLinksIn_(text) {
  var links = findLinks_(text);
  if (!links.length) return [];

  var useful = links.filter(function (url) { return !isServiceLink_(url); });
  return (useful.length ? useful : links).slice(0, 3); // больше трёх адресов в SMS не бывает
}

/**
 * Текст сообщения без ссылок.
 */
function textWithoutLinks_(text) {
  var rest = String(text || '');
  findLinks_(text).forEach(function (url) {
    rest = rest.split(url).join(' ');
  });
  return rest.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Разбор адреса
// ---------------------------------------------------------------------------

/**
 * Раскодирует HTML-подстановки: сервисы отдают названия товаров прямо из
 * кассовой программы, и кавычка в них приезжает как «&quot;».
 */
function decodeHtmlEntities_(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function decodeSafe_(value) {
  try {
    return decodeURIComponent(String(value).replace(/\+/g, ' '));
  } catch (err) {
    return String(value);
  }
}

/**
 * Разбирает адрес на части. Своими руками, потому что в Apps Script нет
 * привычного браузерного разборщика адресов.
 */
function parseUrl_(url) {
  var m = String(url || '').match(/^(https?):\/\/([^\/?#]+)([^?#]*)(?:\?([^#]*))?/i);
  if (!m) return null;

  var query = {};
  String(m[4] || '').split('&').forEach(function (pair) {
    if (!pair) return;
    var eq = pair.indexOf('=');
    var key = decodeSafe_(eq === -1 ? pair : pair.substring(0, eq));
    query[key] = eq === -1 ? '' : decodeSafe_(pair.substring(eq + 1));
  });

  var scheme = m[1].toLowerCase();
  var host = m[2].toLowerCase();
  return {
    scheme: scheme,
    host: host,
    origin: scheme + '://' + host,
    path: m[3] || '/',
    query: query
  };
}

/**
 * Приводит ссылку со страницы к полному адресу.
 */
function resolveUrl_(baseUrl, href) {
  var link = String(href || '').trim();
  if (!link) return '';
  if (/^https?:\/\//i.test(link)) return link;

  var base = parseUrl_(baseUrl);
  if (!base) return '';

  if (link.indexOf('//') === 0) return base.scheme + ':' + link;
  if (link.charAt(0) === '/') return base.origin + link;
  if (link.charAt(0) === '#' || link.charAt(0) === '?') return '';

  return base.origin + base.path.replace(/[^\/]*$/, '') + link;
}

/**
 * Значение заголовка ответа без оглядки на регистр имени.
 */
function headerValue_(headers, name) {
  var wanted = String(name).toLowerCase();
  var keys = Object.keys(headers || {});
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === wanted) {
      var value = headers[keys[i]];
      return String(value && value.length !== undefined && typeof value !== 'string' ? value[0] : value);
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Загрузка
// ---------------------------------------------------------------------------

/**
 * Скачивает адрес, проходя перенаправления по шагам.
 *
 * По шагам, а не автоматически, потому что нам нужен конечный адрес: короткая
 * ссылка из SMS ведёт на длинную, и опознавательные знаки чека (какой сервис,
 * какой документ) есть только в ней. Готового способа узнать конечный адрес
 * Apps Script не даёт.
 *
 * Возвращает {url, code, contentType, response} или null.
 */
function fetchLink_(url) {
  var current = String(url || '');
  if (!/^https?:\/\//i.test(current)) return null;

  for (var hop = 0; hop <= LINK_MAX_REDIRECTS; hop++) {
    var response;
    try {
      response = UrlFetchApp.fetch(current, {
        method: 'get',
        followRedirects: false,
        muteHttpExceptions: true,
        headers: {
          'User-Agent': LINK_USER_AGENT,
          'Accept-Language': 'he,ru;q=0.8,en;q=0.6'
        }
      });
    } catch (err) {
      var afterError = fetchViaProxy_(current);
      if (afterError) {
        logEvent_('Чек взят через посредника', { url: current, причина: String(err) });
        return afterError;
      }
      logEvent_('Ссылка не открылась', { url: current, error: String(err) });
      return null;
    }

    var code = response.getResponseCode();
    var headers = response.getHeaders() || {};

    if (code >= 300 && code < 400) {
      var next = resolveUrl_(current, headerValue_(headers, 'Location'));
      if (!next) {
        logEvent_('Перенаправление без адреса', { url: current, code: code });
        return null;
      }
      current = next;
      continue;
    }

    if (code !== 200) {
      var viaProxy = fetchViaProxy_(current);
      if (viaProxy) {
        logEvent_('Чек взят через посредника', { url: current, отказ: code });
        return viaProxy;
      }
      logEvent_('Сайт отказал', { url: current, code: code });
      return null;
    }

    return {
      url: current,
      code: code,
      contentType: headerValue_(headers, 'Content-Type').toLowerCase(),
      response: response
    };
  }

  logEvent_('Слишком много перенаправлений', { url: url });
  return null;
}

/**
 * Адрес посредника на Vercel. Отдельного свойства обычно нет: посредник и
 * мини-приложение живут одним проектом, поэтому берём тот же адрес.
 */
function proxyBaseUrl_() {
  var url = String(scriptProp_('PROXY_URL') || scriptProp_('MINIAPP_URL') || '').trim();
  return url ? url.replace(/\/+$/, '') : '';
}

/**
 * Второй заход за страницей — через посредника.
 *
 * Некоторые сети закрываются от серверных запросов: «Рами Леви» отвечает
 * Apps Script кодом 403, хотя с домашнего адреса та же страница открывается.
 * Посредник на Vercel живёт в другом облаке, и для таких сайтов выглядит
 * иначе, поэтому чек через него доходит.
 *
 * Возвращает такой же объект, как fetchLink_, — с ответом, у которого есть
 * привычные getContentText и getBlob, чтобы дальше код ничего не различал.
 */
function fetchViaProxy_(url) {
  var base = proxyBaseUrl_();
  if (!base) return null;

  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ url: String(url) }),
    muteHttpExceptions: true
  };

  var secret = scriptProp_(PROP_WEBHOOK_SECRET);
  if (secret) options.headers = { 'X-Proxy-Secret': secret };

  var response;
  try {
    response = UrlFetchApp.fetch(base + '/api/fetch', options);
  } catch (err) {
    logEvent_('Посредник не ответил', { url: url, error: String(err) });
    return null;
  }

  if (response.getResponseCode() !== 200) {
    logEvent_('Посредник не отдал страницу', { url: url, code: response.getResponseCode() });
    return null;
  }

  var data;
  try {
    data = JSON.parse(response.getContentText());
  } catch (err) {
    logEvent_('Посредник ответил не таблицей', { url: url });
    return null;
  }

  if (!data || !data.ok) {
    logEvent_('Посредник не отдал страницу', {
      url: url,
      статус: data && data.status,
      error: data && data.error,
      начало: data && data.sample
    });
    return null;
  }

  return {
    url: String(data.url || url),
    code: 200,
    contentType: String(data.contentType || '').toLowerCase(),
    response: proxyPageResponse_(data)
  };
}

/**
 * Ответ посредника в том виде, в каком его ждёт остальной код: текст страницы
 * приходит строкой, PDF и картинки — закодированными, и разворачиваются
 * обратно только если понадобятся.
 */
function proxyPageResponse_(data) {
  var contentType = String(data.contentType || 'text/html');

  function blob() {
    if (data.base64) {
      return Utilities.newBlob(Utilities.base64Decode(data.base64), contentType.split(';')[0], 'receipt');
    }
    return Utilities.newBlob(String(data.body || ''), contentType.split(';')[0], 'receipt');
  }

  return {
    getResponseCode: function () { return Number(data.status) || 200; },
    getContentText: function () {
      if (typeof data.body === 'string') return data.body;
      return data.base64 ? blob().getDataAsString() : '';
    },
    getHeaders: function () { return { 'Content-Type': contentType }; },
    getBlob: blob
  };
}

/**
 * Тот же запрос, но ответ ожидается таблицей (JSON).
 */
function fetchLinkJson_(url) {
  var page = fetchLink_(url);
  if (!page) return null;
  try {
    return JSON.parse(page.response.getContentText());
  } catch (err) {
    logEvent_('Ответ по ссылке не разобрался', { url: url, error: String(err) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Главный вход
// ---------------------------------------------------------------------------

/**
 * Читает чек по ссылке.
 *
 * Возвращает {receipts: [...], via: 'откуда взяли', url: 'конечный адрес'} —
 * список чеков в том же виде, в каком его отдаёт модель по фотографии,
 * чтобы дальше запись шла общим путём. Или null.
 */
function receiptFromLink_(url, comment) {
  var page = fetchLink_(url) || ramiLevyPdfFallback_(url);
  if (!page) return null;

  // 1. Известный сервис цифровых чеков
  var known = knownServiceReceipt_(page);
  if (known) return known;

  var type = page.contentType;

  // 2. По ссылке сразу документ — читаем его как фотографию чека
  if (type.indexOf('application/pdf') === 0 || type.indexOf('image/') === 0) {
    return receiptFromBinary_(page, comment);
  }

  // 3. Обычная страница
  if (!type || type.indexOf('text/') === 0 || type.indexOf('application/xhtml') === 0) {
    return receiptFromPage_(page, comment);
  }

  logEvent_('По ссылке неизвестный тип содержимого', { url: page.url, type: type });
  return null;
}

/**
 * Последняя попытка для «Рами Леви»: у чека, кроме страницы, есть PDF-версия
 * по адресу /api/receipts/{номер}/pdf. Защита сайта смотрит на страницы
 * строже, чем на файлы, поэтому файл иногда доходит там, где страница нет.
 *
 * Данные из PDF читает модель — они выйдут чуть менее точными, чем со
 * страницы, но это лучше, чем просить фотографировать бумажный чек.
 */
function ramiLevyPdfFallback_(url) {
  var parts = parseUrl_(url);
  if (!parts || !/(^|\.)rami-levy\.co\.il$/.test(parts.host)) return null;

  var id = String(parts.path || '').replace(/^\/+|\/+$/g, '');
  if (!id || id.indexOf('/') !== -1) return null; // адрес чека — один короткий кусок

  var page = fetchLink_(parts.origin + '/api/receipts/' + id + '/pdf');
  if (page) logEvent_('Чек «Рами Леви» взят PDF-файлом', { url: page.url });
  return page;
}

/**
 * Файл по ссылке (PDF или картинка) — тот же разбор, что и у фотографии.
 */
function receiptFromBinary_(page, comment) {
  var blob = page.response.getBlob();
  var bytes = blob.getBytes();

  if (bytes.length > MAX_FILE_BYTES) {
    logEvent_('Файл по ссылке слишком большой', { url: page.url, size: bytes.length });
    return null;
  }

  var mime = page.contentType.split(';')[0] || blob.getContentType();
  var answer = geminiParseReceipt_(Utilities.base64Encode(bytes), mime, comment);
  if (!answer || !answer.receipts || !answer.receipts.length) return null;

  return {
    receipts: answer.receipts,
    via: mime.indexOf('pdf') !== -1 ? 'PDF по ссылке' : 'картинка по ссылке',
    url: page.url
  };
}

/**
 * Обычная веб-страница.
 *
 * Сначала смотрим, не лежит ли сам чек рядом файлом: страница часто только
 * обёртка с кнопкой «скачать». Если файла нет — отдаём модели текст страницы.
 */
function receiptFromPage_(page, comment) {
  var html = page.response.getContentText();

  var fileUrl = documentLinkInHtml_(html, page.url);
  if (fileUrl) {
    var filePage = fetchLink_(fileUrl);
    if (filePage && /^(application\/pdf|image\/)/.test(filePage.contentType)) {
      var fromFile = receiptFromBinary_(filePage, comment);
      if (fromFile) return fromFile;
    }
  }

  var text = htmlToText_(html);
  if (text.length < LINK_MIN_TEXT_LENGTH) {
    // Страница собирается скриптом уже в браузере — текста в ней нет
    logEvent_('Страница по ссылке пустая', { url: page.url, length: text.length });
    return null;
  }

  var answer = geminiParseReceiptText_(text.substring(0, LINK_TEXT_LIMIT), comment, page.url);
  if (!answer || !answer.receipts || !answer.receipts.length) return null;

  return { receipts: answer.receipts, via: 'страница по ссылке', url: page.url };
}

/**
 * Текст страницы без разметки.
 *
 * Ивритские страницы пишутся справа налево: в разметке рассыпаны служебные
 * знаки направления письма, а цена часто разбита на части («17 .90 ₪» —
 * каждая часть своим элементом). Знаки убираем, число собираем обратно,
 * иначе сумма чека уедет в десять раз.
 */
function htmlToText_(html) {
  return decodeHtmlEntities_(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section)>/gi, '\n')
    .replace(/<[^>]*>/g, ' '))
    .replace(/[‎‏‪-‮⁦-⁩﻿]/g, '') // знаки направления письма
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/(\d)\s+([.,])\s*(\d{2})(?!\d)/g, '$1.$3') // «17 .90» — это одна цена
    .trim();
}

/**
 * Ссылка на сам документ внутри страницы-обёртки.
 * PDF предпочтительнее картинки, оформление (логотипы, баннеры) пропускаем.
 */
function documentLinkInHtml_(html, baseUrl) {
  var pattern = /(?:href|src|data-src|data-href)\s*=\s*["']([^"']+)["']/gi;
  var picture = '';
  var match;

  while ((match = pattern.exec(String(html || ''))) !== null) {
    var href = match[1];
    if (!/\.(pdf|jpe?g|png|webp)(\?|#|$)/i.test(href)) continue;
    if (/(logo|icon|favicon|banner|sprite|placeholder|avatar|header|footer|social|share|button|bg[-_])/i.test(href)) continue;

    var full = resolveUrl_(baseUrl, href);
    if (!full) continue;
    if (/\.pdf(\?|#|$)/i.test(href)) return full;
    if (!picture) picture = full;
  }

  return picture;
}

// ---------------------------------------------------------------------------
// Известные сервисы цифровых чеков
// ---------------------------------------------------------------------------

/**
 * Разбор для сервисов, устройство которых мы знаем. Здесь данные берутся
 * готовыми, поэтому сумма и дата не зависят от распознавания.
 *
 * Не получилось — возвращаем null, и ссылка пойдёт общим путём.
 */
function knownServiceReceipt_(page) {
  var parts = parseUrl_(page.url);
  if (!parts) return null;
  if (/(^|\.)pairzon\.com$/.test(parts.host)) return pairzonReceipt_(parts);
  if (/(^|\.)weezmo\.com$/.test(parts.host)) return weezmoReceipt_(parts);
  if (/(^|\.)rami-levy\.co\.il$/.test(parts.host)) return ramiLevyReceipt_(page, parts);
  return null;
}

/**
 * Время, записанное по Гринвичу (с буквой Z на конце), — в местное.
 * Иначе ночная покупка попадёт в таблицу вчерашним днём.
 */
function localDateTime_(value) {
  var raw = String(value || '').trim();
  if (!raw) return '';
  if (!/([zZ]|[+-]\d{2}:?\d{2})$/.test(raw)) return raw; // время и так местное

  var date = new Date(raw);
  if (isNaN(date.getTime())) return raw;
  return Utilities.formatDate(date, tz_(), 'yyyy-MM-dd HH:mm');
}

/**
 * Pairzon — через него шлют чеки Carrefour, Mega, «Йейнот Битан», «Битан
 * маркет» и другие израильские сети.
 *
 * Страница чека пустая: содержимое подгружается скриптом уже в браузере.
 * Тот же чек отдаётся таблицей по служебному адресу /v1.0/documents/<чек>,
 * и опознаватель чека есть в адресе страницы — берём данные оттуда.
 */
function pairzonReceipt_(parts) {
  var id = parts.query.id;
  if (!id) {
    logEvent_('Ссылка Pairzon без опознавателя чека', { url: parts.origin + parts.path });
    return null;
  }

  var api = parts.origin + '/v1.0/documents/' + encodeURIComponent(id) +
    (parts.query.p ? '?p=' + encodeURIComponent(parts.query.p) : '');

  var doc = fetchLinkJson_(api);
  if (!doc || !doc.id) {
    logEvent_('Чек Pairzon не получен', { url: api });
    return null;
  }

  var receipt = enrichReceipt_(pairzonToReceipt_(doc));
  return {
    receipts: [receipt],
    via: 'Pairzon',
    url: parts.origin + parts.path + '?id=' + id,
    exact: true // числа пришли готовыми, а не распознаны
  };
}

/**
 * Чек Pairzon — в тот же вид, в каком чек приходит от модели.
 */
function pairzonToReceipt_(doc) {
  var store = doc.store || {};
  var business = store.business || {};

  var total = Number(doc.total) || 0;
  if (!total && doc.payments && doc.payments.length) {
    // Итога нет — складываем то, чем платили
    total = doc.payments.reduce(function (sum, payment) {
      return sum + (Number(payment.amount) || 0);
    }, 0);
  }
  total = Math.round(total * 100) / 100;

  var items = (doc.items || []).map(function (item) {
    // total — сколько заплачено за позицию, price — цена за килограмм или штуку;
    // в таблицу нужна заплаченная сумма
    var price = Number(item.total);
    if (!price && price !== 0) price = Number(item.price) || 0;
    return {
      name: '', // заполнится переводом
      original: decodeHtmlEntities_(item.name).trim(),
      price: Math.round(price * 100) / 100
    };
  }).filter(function (item) { return item.original; });

  var storeName = decodeHtmlEntities_(store.alias || business.englishName || business.name).trim();
  var isRefund = /refund|credit|zikuy/i.test(String(doc.documentType || ''));

  return {
    total: total,
    currency: String(store.currency || business.currency || 'ILS').toUpperCase(),
    datetime: localDateTime_(doc.createdDate || doc.uploadedDate),
    store: storeName,
    storeRu: '',
    category: '',
    subcategory: '',
    items: items,
    tips: 0,
    kind: isRefund ? 'возврат' : 'расход',
    readable: total > 0,
    note: total > 0
      ? (isRefund ? 'Чек на возврат — записал минусом' : '')
      : 'В чеке нет итоговой суммы'
  };
}

/**
 * Weezmo — через него шлют чеки IKEA и другие сети; короткая ссылка выглядит
 * как wee.ai/r/..., а ведёт на receipts.weezmo.com.
 *
 * Страница чека собирается скриптом в браузере, читать в ней нечего. Но сам
 * чек лежит рядом таблицей по адресу /api/receipts/<чек>, где опознаватель
 * чека — это параметр q из адреса страницы.
 */
function weezmoReceipt_(parts) {
  var id = parts.query.q;
  if (!id) {
    logEvent_('Ссылка Weezmo без опознавателя чека', { url: parts.origin + parts.path });
    return null;
  }

  var api = parts.origin + '/api/receipts/' + encodeURIComponent(id);
  var answer = fetchLinkJson_(api);

  // Сервис отвечает списком, даже когда чек один
  var doc = answer && answer.length ? answer[0] : answer;
  if (!doc || !doc.id) {
    logEvent_('Чек Weezmo не получен', { url: api });
    return null;
  }

  var receipt = enrichReceipt_(weezmoToReceipt_(doc));
  return {
    receipts: [receipt],
    via: 'Weezmo',
    url: parts.origin + parts.path + '?q=' + id,
    exact: true
  };
}

/**
 * Чек Weezmo — в тот же вид, в каком чек приходит от модели.
 */
function weezmoToReceipt_(doc) {
  var business = doc.tBusiness || {};
  var branch = doc.tBranch || {};

  var items = (doc.items || []).map(function (item) {
    // Поле total у этого сервиса часто нулевое — тогда считаем сами
    var price = Number(item.total);
    if (!price) price = (Number(item.price) || 0) * (Number(item.quantity) || 1);
    return {
      name: '',
      original: decodeHtmlEntities_(item.name).trim(),
      price: Math.round(price * 100) / 100
    };
  }).filter(function (item) { return item.original; });

  var storeName = decodeHtmlEntities_(business.businessNameEnglish || business.businessName).trim();
  if (storeName && branch.branchName) storeName += ' ' + String(branch.branchName).trim();

  var total = Math.round((Number(doc.total) || 0) * 100) / 100;
  var isRefund = /refund|return/i.test(String(doc.receiptType || ''));

  return {
    total: total,
    currency: String(doc.currency || 'ILS').toUpperCase(),
    datetime: localDateTime_(doc.createdDate || doc.uploadedDate),
    store: storeName,
    storeRu: '',
    category: '',
    subcategory: '',
    items: items,
    tips: 0,
    kind: isRefund ? 'возврат' : 'расход',
    readable: total > 0,
    note: total > 0
      ? (isRefund ? 'Чек на возврат — записал минусом' : '')
      : 'В чеке нет итоговой суммы'
  };
}

/**
 * «Рами Леви» — свой сервис цифровых чеков (digi.rami-levy.co.il).
 *
 * Здесь страница не пустая, чек в ней виден. Но иврит пишется справа налево,
 * и в тексте подписи разъезжаются с числами: рядом стоят сумма без НДС, сам
 * НДС и итог — перепутать легко. Поэтому берём данные, которые страница несёт
 * в себе готовыми, а разбор текста оставляем как запасной путь.
 */
function ramiLevyReceipt_(page, parts) {
  var text = page.response.getContentText();
  var doc = nuxtPayload_(text, ['items', 'payments', 'created_at']);
  if (!doc) {
    logEvent_('Чек «Рами Леви» не разобрался, читаем страницу текстом', {
      url: page.url,
      длина: String(text || '').length,
      данныеЕсть: /__NUXT_DATA__/.test(String(text || '')),
      начало: String(text || '').replace(/\s+/g, ' ').slice(0, 200)
    });
    return null;
  }

  var receipt = enrichReceipt_(ramiLevyToReceipt_(doc));
  return {
    receipts: [receipt],
    via: 'Рами Леви',
    url: parts.origin + parts.path,
    exact: true
  };
}

/**
 * Чек «Рами Леви» — в тот же вид, в каком чек приходит от модели.
 */
function ramiLevyToReceipt_(doc) {
  var payments = doc.payments || {};
  var company = doc.company || {};
  var branch = doc.branch || {};

  var total = Number(payments.total) || 0;
  if (!total && payments.methods && payments.methods.length) {
    total = payments.methods.reduce(function (sum, method) {
      return sum + (Number(method.amount) || 0);
    }, 0);
  }
  total = Math.round(total * 100) / 100;

  var items = (doc.items || []).map(function (item) {
    var price = Number(item.total);
    if (!price) price = (Number(item.price) || 0) * (Number(item.quantity) || 1);

    // Акционные скидки лежат отдельными строками с отрицательным значением:
    // без них цена позиции будет как без скидки, и итог не сойдётся
    (item.additional_info || []).forEach(function (extra) {
      var value = parseFloat(String(extra && extra.value).replace(',', '.'));
      if (!isNaN(value)) price += value;
    });

    return {
      name: '',
      original: decodeHtmlEntities_(item.name).trim(),
      price: Math.round(price * 100) / 100
    };
  }).filter(function (item) { return item.original; });

  var storeName = decodeHtmlEntities_(company.name).trim();
  if (branch.name) storeName += (storeName ? ' ' : '') + String(branch.name).trim();

  var isRefund = /refund|credit|zikuy/i.test(String(doc.document_type || ''));

  return {
    total: total,
    currency: 'ILS',
    datetime: localDateTime_(doc.created_at),
    store: storeName,
    storeRu: '',
    category: '',
    subcategory: '',
    items: items,
    tips: 0,
    kind: isRefund ? 'возврат' : 'расход',
    readable: total > 0,
    note: total > 0
      ? (isRefund ? 'Чек на возврат — записал минусом' : '')
      : 'В чеке нет итоговой суммы'
  };
}

/**
 * Данные, которые страница на Nuxt несёт в себе готовыми.
 *
 * Лежат они плоским списком: внутри объектов вместо самих значений стоят
 * номера ячеек этого же списка. Находим ячейку, похожую на чек (по набору
 * полей), и собираем её обратно в обычный объект.
 */
function nuxtPayload_(html, requiredKeys) {
  var match = String(html || '').match(/id=["']__NUXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/);
  if (!match) return null;

  var flat;
  try {
    flat = JSON.parse(match[1]);
  } catch (err) {
    return null;
  }
  if (!flat || !flat.length) return null;

  for (var i = 0; i < flat.length; i++) {
    var node = flat[i];
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;

    var suitable = true;
    for (var k = 0; k < requiredKeys.length; k++) {
      if (node[requiredKeys[k]] === undefined) { suitable = false; break; }
    }
    if (suitable) return nuxtValue_(flat, i, 0);
  }

  return null;
}

/**
 * Собирает значение из плоского списка Nuxt по номеру ячейки.
 * Глубина ограничена: список может ссылаться сам на себя.
 */
function nuxtValue_(flat, ref, depth) {
  if (depth > 12) return null;

  var node = flat[ref];
  if (node === null || node === undefined) return null;
  if (typeof node !== 'object') return node;

  if (Array.isArray(node)) {
    return node.map(function (item) { return nuxtValue_(flat, item, depth + 1); });
  }

  var result = {};
  Object.keys(node).forEach(function (key) {
    result[key] = nuxtValue_(flat, node[key], depth + 1);
  });
  return result;
}

/**
 * Готовому чеку не хватает только русских названий и категории — за ними
 * идём к модели. Числа ей на правку не отдаём: они уже точные.
 *
 * Модель может быть недоступна (сбой, дневной лимит) — тогда позиции
 * останутся на языке оригинала, но расход всё равно запишется.
 */
function enrichReceipt_(receipt) {
  var answer = null;
  try {
    answer = geminiEnrichReceipt_(receipt);
  } catch (err) {
    logEvent_('Сбой перевода чека', { error: String(err) });
  }

  if (answer) {
    if (answer.storeRu) receipt.storeRu = String(answer.storeRu).trim();
    if (answer.category) {
      receipt.category = String(answer.category).trim();
      receipt.subcategory = String(answer.subcategory || '').trim();
    }

    var byOriginal = {};
    (answer.items || []).forEach(function (item) {
      var key = normalizeForDictionary_(item.original);
      var name = String(item.name || '').trim();
      if (key && name) byOriginal[key] = name;
    });

    receipt.items.forEach(function (item) {
      var translated = byOriginal[normalizeForDictionary_(item.original)];
      if (translated) item.name = translated;
    });
  }

  // Непереведённая позиция всё равно должна попасть в таблицу — пусть на иврите
  receipt.items.forEach(function (item) {
    if (!item.name) item.name = item.original;
  });

  return receipt;
}


// ===========================================================================
// 13_MiniApp
// ===========================================================================

/**
 * 13_MiniApp.gs — данные для мини-приложения в телеграме.
 *
 * Страница живёт на Vercel, а данные берёт отсюда. Запрос приходит через того
 * же посредника, что и сообщения бота, но с пометкой mode=data.
 *
 * Кто спрашивает — проверяется по подписи, которую телеграм выдаёт мини-приложению.
 * Подпись считается по токену бота, а он есть только здесь, на стороне Google.
 * Поэтому посреднику доверять ничего не приходится: он просто передаёт запрос.
 */

// Подпись живёт сутки: дольше держать открытую страницу смысла нет
var MINIAPP_MAX_AGE_SECONDS = 86400;

// Адрес страницы мини-приложения — свой у каждой установки, поэтому берётся
// из свойства скрипта MINIAPP_URL, а в коде его нет. Чужой адрес тут был бы
// хуже пустого: страница открылась бы, но данных не показала.
var MINIAPP_DEFAULT_URL = '';

/**
 * Проверяет подпись телеграма и возвращает {ok, userId, name, error}.
 *
 * initData — строка вида «query_id=…&user=…&auth_date=…&hash=…», её отдаёт
 * телеграм самой странице при открытии.
 */
function verifyTelegramInitData_(initData) {
  if (!initData) return { ok: false, error: 'Нет данных авторизации' };

  var pairs = String(initData).split('&');
  var hash = '';
  var fields = [];

  pairs.forEach(function (pair) {
    var index = pair.indexOf('=');
    if (index === -1) return;
    var key = pair.substring(0, index);
    var value = pair.substring(index + 1);
    if (key === 'hash') {
      hash = value;
    } else {
      fields.push({ key: key, value: decodeURIComponent(value) });
    }
  });

  if (!hash) return { ok: false, error: 'Нет подписи' };

  // Строка для проверки: пары «ключ=значение», отсортированные по ключу
  fields.sort(function (a, b) { return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0); });
  var dataCheckString = fields.map(function (f) { return f.key + '=' + f.value; }).join('\n');

  // Ключ подписи выводится из токена бота
  var secretKey = Utilities.computeHmacSha256Signature(getBotToken_(), 'WebAppData');
  var signature = Utilities.computeHmacSha256Signature(
    Utilities.newBlob(dataCheckString).getBytes(),
    secretKey
  );

  var computed = signature.map(function (byte) {
    var hex = (byte < 0 ? byte + 256 : byte).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');

  if (computed !== hash) return { ok: false, error: 'Подпись не сходится' };

  // Просроченная подпись не годится: страницу могли открыть давно
  var authDate = 0;
  var userJson = '';
  fields.forEach(function (f) {
    if (f.key === 'auth_date') authDate = parseInt(f.value, 10) || 0;
    if (f.key === 'user') userJson = f.value;
  });

  var ageSeconds = Math.floor(new Date().getTime() / 1000) - authDate;
  if (!authDate || ageSeconds > MINIAPP_MAX_AGE_SECONDS) {
    return { ok: false, error: 'Данные авторизации устарели, откройте заново' };
  }

  var user = {};
  try {
    user = JSON.parse(userJson);
  } catch (err) {
    return { ok: false, error: 'Не разобрать данные пользователя' };
  }

  if (!isAllowedUser_(user.id)) {
    logEvent_('Мини-приложение: чужой', { userId: user.id, name: user.first_name || '' });
    return { ok: false, error: 'Доступ ограничен' };
  }

  // Имя берём то же, что и в таблице: заданное в настройках, а не телеграмное.
  // Иначе один и тот же человек в записях «Толя», а в приветствии «Anatoly».
  return {
    ok: true,
    userId: user.id,
    name: userDisplayName_({
      id: user.id,
      first_name: user.first_name,
      last_name: user.last_name,
      username: user.username
    })
  };
}

/**
 * Список источников для страницы загрузки выписок: кабинет, что скачивать и
 * какие карты за ним стоят. Берётся из листов «Источники» и «Карты», чтобы
 * ссылки и номера правились без изменения кода.
 */
function miniAppSources_() {
  var sheet = ensureSheet_(SHEET_SOURCES, SOURCE_COLUMNS);
  var last = sheet.getLastRow();
  if (last < 2) return [];

  var cards = readCards_();
  var rows = sheet.getRange(2, 1, last - 1, SOURCE_COLUMNS.length).getValues();

  return rows
    .filter(function (row) { return String(row[0] || '').trim(); })
    .sort(function (a, b) { return (Number(a[6]) || 99) - (Number(b[6]) || 99); })
    .map(function (row) {
      var digits = String(row[2] || '').split(/[,;]/)
        .map(function (part) { return part.replace(/\D/g, ''); })
        .filter(function (part) { return part; });

      return {
        name: String(row[0] || ''),
        url: String(row[1] || ''),
        what: String(row[3] || ''),
        format: String(row[4] || ''),
        howOften: String(row[5] || ''),
        cards: digits.map(function (digit) {
          var known = cards[digit];
          return {
            card: digit,
            title: known ? known.title : '',
            owner: known ? known.owner : '',
            purpose: known ? known.purpose : '',
            chargeDay: known ? known.chargeDay : '',
            status: known ? known.status : ''
          };
        })
      };
    });
}

/**
 * Собирает данные для страницы.
 * monthKey — «ГГГГ-ММ»; пусто = текущий месяц.
 */
function miniAppPayload_(monthKey) {
  var base = baseCurrency_();
  var now = new Date();

  var month = parseMonthKey_(monthKey) || new Date(now.getFullYear(), now.getMonth(), 1);
  var from = monthStart_(month);
  var to = monthEnd_(month);

  var all = readExpenses_({});
  var expenses = all.filter(function (item) { return item.date >= from && item.date <= to; });

  var allIncomes = readIncomes_({});
  var incomes = allIncomes.filter(function (item) { return item.date >= from && item.date <= to; });

  var prevMonth = new Date(month.getFullYear(), month.getMonth() - 1, 1);
  var prevExpenses = all.filter(function (item) {
    return item.date >= monthStart_(prevMonth) && item.date <= monthEnd_(prevMonth);
  });
  var prevIncomes = allIncomes.filter(function (item) {
    return item.date >= monthStart_(prevMonth) && item.date <= monthEnd_(prevMonth);
  });

  var total = totalOf_(expenses);
  var incomeTotal = totalOf_(incomes);

  // Какие месяцы вообще есть в таблице — для переключателя.
  // Месяц с одними доходами тоже должен быть в списке.
  var monthsSeen = {};
  all.concat(allIncomes).forEach(function (item) {
    monthsSeen[monthKeyOf_(item.date)] = true;
  });
  var months = Object.keys(monthsSeen).sort().reverse();
  var currentKey = monthKeyOf_(month);
  if (months.indexOf(currentKey) === -1) months.unshift(currentKey);

  // Траты по дням — для графика
  var byDay = {};
  expenses.forEach(function (item) {
    var day = item.date.getDate();
    byDay[day] = (byDay[day] || 0) + item.baseAmount;
  });
  var daysInMonth = to.getDate();
  var daily = [];
  for (var day = 1; day <= daysInMonth; day++) {
    daily.push({ day: day, sum: Math.round((byDay[day] || 0) * 100) / 100 });
  }

  return {
    ok: true,
    currency: base,
    // Таблица — то место, где правят руками: категории, курсы, чужие ошибки.
    // Со страницы до неё раньше можно было добраться только через историю чата
    sheetUrl: getSpreadsheet_().getUrl(),
    // Памятка «что откуда выгружать»: раз в неделю нужно обойти четыре
    // кабинета, и держать этот список в голове незачем
    sources: miniAppSources_(),
    month: currentKey,
    monthTitle: monthTitle_(month),
    months: months.slice(0, 24),
    total: Math.round(total * 100) / 100,
    prevTotal: Math.round(totalOf_(prevExpenses) * 100) / 100,
    count: expenses.length,
    incomeTotal: Math.round(incomeTotal * 100) / 100,
    prevIncomeTotal: Math.round(totalOf_(prevIncomes) * 100) / 100,
    // Остаток считаем только когда доходы вносят: иначе страница показывала бы
    // огромный минус и пугала на пустом месте
    balance: incomes.length ? Math.round((incomeTotal - total) * 100) / 100 : null,
    incomeCategories: groupBy_(incomes, 'category').map(function (group) {
      return {
        name: group.key,
        sum: Math.round(group.sum * 100) / 100,
        count: group.count,
        share: incomeTotal > 0 ? Math.round((group.sum / incomeTotal) * 1000) / 10 : 0
      };
    }),
    incomes: incomes.slice().reverse().map(function (item) {
      return {
        id: item.id,
        date: formatDate_(item.date),
        amount: item.amount,
        currency: item.currency,
        baseAmount: item.baseAmount,
        category: item.category,
        description: item.description,
        author: item.author,
        sourceType: item.sourceType
      };
    }),
    daily: daily,
    categories: groupBy_(expenses, 'category').map(function (group) {
      return {
        name: group.key,
        sum: Math.round(group.sum * 100) / 100,
        count: group.count,
        share: total > 0 ? Math.round((group.sum / total) * 1000) / 10 : 0
      };
    }),
    authors: groupBy_(expenses, 'author').map(function (group) {
      return { name: group.key, sum: Math.round(group.sum * 100) / 100, count: group.count };
    }),
    expenses: expenses.slice().reverse().map(function (item) {
      return {
        id: item.id,
        date: formatDate_(item.date),
        amount: item.amount,
        currency: item.currency,
        baseAmount: item.baseAmount,
        category: item.category,
        subcategory: item.subcategory,
        description: item.description,
        store: item.store,
        author: item.author,
        sourceType: item.sourceType
      };
    })
  };
}

function monthKeyOf_(date) {
  var month = date.getMonth() + 1;
  return date.getFullYear() + '-' + (month < 10 ? '0' + month : month);
}

function parseMonthKey_(key) {
  var m = String(key || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, 1);
}

/**
 * Точка входа для запроса данных: проверяет подпись и отдаёт содержимое.
 * Вызывается из doPost, когда пришёл запрос с mode=data.
 */
function handleMiniAppRequest_(body) {
  var check = verifyTelegramInitData_(body.initData);
  if (!check.ok) {
    return { ok: false, error: check.error };
  }

  try {
    var payload = miniAppPayload_(body.month);
    payload.viewer = check.name;
    return payload;
  } catch (err) {
    logEvent_('Сбой мини-приложения', { error: String(err), user: check.name });
    return { ok: false, error: 'Не удалось собрать данные: ' + err };
  }
}

/**
 * Удаление записи из мини-приложения — та же пометка, что и кнопкой в чате.
 */
function handleMiniAppDelete_(body) {
  var check = verifyTelegramInitData_(body.initData);
  if (!check.ok) return { ok: false, error: check.error };

  var deleted = markExpenseDeleted_(body.id);
  if (deleted) logEvent_('Запись удалена из мини-приложения', { id: body.id, user: check.name });
  return { ok: deleted, error: deleted ? '' : 'Запись не найдена' };
}

// ---------------------------------------------------------------------------
// Кнопка запуска (запускать вручную)
// ---------------------------------------------------------------------------

/**
 * Ставит кнопку мини-приложения рядом с полем ввода в чате с ботом.
 * Адрес страницы берётся из свойства скрипта MINIAPP_URL.
 */
function setMiniAppButton() {
  var url = scriptProp_('MINIAPP_URL') || MINIAPP_DEFAULT_URL;

  if (!url) {
    var hint = 'Не задан адрес мини-приложения. Впишите свойство скрипта ' +
      'MINIAPP_URL — это адрес вашей страницы на Vercel, вида ' +
      'https://имя-проекта.vercel.app/';
    console.log(hint);
    return hint;
  }

  var result = tgCall_('setChatMenuButton', {
    menu_button: {
      type: 'web_app',
      text: 'Бюджет',
      web_app: { url: url }
    }
  });

  if (!result || !result.ok) {
    var failed = 'Телеграм не принял кнопку. Ответ: ' + JSON.stringify(result);
    console.log(failed);
    return failed;
  }

  var report = 'Кнопка «Бюджет» поставлена рядом с полем ввода в чате с ботом.\n' +
    'Адрес страницы: ' + url + '\n\n' +
    'Если кнопка не появилась сразу — закройте и откройте чат с ботом заново.';
  console.log(report);
  return report;
}

/**
 * Убирает кнопку мини-приложения, возвращая обычное меню команд.
 */
function removeMiniAppButton() {
  var result = tgCall_('setChatMenuButton', { menu_button: { type: 'commands' } });
  console.log(JSON.stringify(result));
  return result;
}


// ===========================================================================
// 14_Updates
// ===========================================================================

/**
 * 14_Updates.gs — уведомления о новых версиях.
 *
 * Зачем. Код живёт копией в проекте каждой семьи. Автор правит свой
 * репозиторий, а чужие установки об этом не знают — и остаются со старым
 * ботом навсегда, потому что писать каждому владельцу никто не станет.
 *
 * Как. Раз в неделю бот сверяет свою версию с dist/version.json на GitHub.
 * Вышла новее — пишет ответственному, что изменилось, и по кнопке присылает
 * файл с новым кодом и три шага, что с ним сделать.
 *
 * Почему бот не ставит обновление сам. Пробовали: Apps Script не выдаёт
 * скрипту право переписывать собственный код — разрешение в манифесте
 * остаётся просьбой, а токен приходит без него. Обойти это можно только
 * отдельным проектом Google Cloud, и тогда установка для обычной семьи
 * вырастает вдвое. Полминуты ручной работы раз в месяц того не стоят.
 *
 * Кому писать. Заменить код может лишь владелец таблицы — у остальных
 * доступа к редактору нет. Поэтому предупреждение идёт одному человеку,
 * а когда обновление встанет, бот сам расскажет остальным, что нового.
 */

// О какой версии уже сообщали — чтобы не напоминать каждую неделю об одном
var PROP_UPDATE_NOTIFIED = 'UPDATE_NOTIFIED_VERSION';

// Какая версия работала в прошлый раз — по ней видно, что код обновили
var PROP_RUNNING_VERSION = 'RUNNING_VERSION';

/**
 * Адрес, откуда берутся обновления. У форка он свой.
 */
function updateSource_() {
  var source = scriptProp_('UPDATE_SOURCE') || UPDATE_SOURCE_DEFAULT;
  return source.charAt(source.length - 1) === '/' ? source : source + '/';
}

/**
 * Кому писать про обновления.
 *
 * Настройка «Кто обновляет бота» — телеграм-айди того, у кого есть доступ
 * к редактору Apps Script. Не задана — берём первого из разрешённых:
 * обычно это тот, кто бота и ставил.
 */
function updateManagerId_() {
  var configured = String(setting_('Кто обновляет бота', '')).trim();
  if (configured) return configured;

  var users = allowedUserIds_();
  return users.length ? users[0] : '';
}

/**
 * Сравнивает версии вида «1.5.0». Возвращает 1, если первая новее.
 */
function compareVersions_(a, b) {
  var left = String(a || '').split('.').map(function (n) { return parseInt(n, 10) || 0; });
  var right = String(b || '').split('.').map(function (n) { return parseInt(n, 10) || 0; });

  for (var i = 0; i < Math.max(left.length, right.length); i++) {
    var x = left[i] || 0;
    var y = right[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/**
 * Что лежит в репозитории: {version, date, changes}. null — не достучались.
 */
function fetchLatestVersion_() {
  try {
    var response = UrlFetchApp.fetch(updateSource_() + 'dist/version.json', {
      muteHttpExceptions: true,
      headers: { 'Cache-Control': 'no-cache' }
    });
    if (response.getResponseCode() !== 200) {
      logEvent_('Не удалось проверить обновления', { code: response.getResponseCode() });
      return null;
    }
    return JSON.parse(response.getContentText());
  } catch (err) {
    logEvent_('Сбой проверки обновлений', String(err));
    return null;
  }
}

/**
 * Проверка обновлений. Запускается триггером раз в неделю и командой /obnovit.
 *
 * silent = true — молчать, когда всё по-старому: еженедельное «обновлений нет»
 * никому не нужно. chatId — куда отвечать на ручную проверку.
 */
function checkForUpdates(silent, chatId) {
  var reply = chatId || updateManagerId_();
  var latest = fetchLatestVersion_();

  if (!latest || !latest.version) {
    if (!silent && reply) tgSend_(reply, 'Не смог проверить обновления — репозиторий не ответил.');
    return null;
  }

  if (compareVersions_(latest.version, BOT_VERSION) <= 0) {
    if (!silent && reply) {
      tgSend_(reply, 'Обновлений нет, у вас последняя версия: <b>' + escapeHtml_(BOT_VERSION) + '</b>');
    }
    return null;
  }

  // Об одной и той же версии напоминаем один раз
  if (silent && scriptProp_(PROP_UPDATE_NOTIFIED) === latest.version) return latest;

  var target = chatId || updateManagerId_();
  if (!target) return latest;

  tgSend_(target, updateAnnouncement_(latest), [[
    { text: '⬇️ Как обновиться', callback_data: 'update:' + latest.version },
    { text: 'Позже', callback_data: 'updatelater:' + latest.version }
  ]]);

  PropertiesService.getScriptProperties().setProperty(PROP_UPDATE_NOTIFIED, latest.version);
  logEvent_('Найдено обновление', { было: BOT_VERSION, стало: latest.version, кому: target });

  return latest;
}

/**
 * Текст сообщения о новой версии.
 */
function updateAnnouncement_(latest) {
  var lines = ['🔄 <b>Вышло обновление</b>',
    'У вас ' + escapeHtml_(BOT_VERSION) + ', вышла ' + escapeHtml_(latest.version) +
    (latest.date ? ' от ' + escapeHtml_(latest.date) : ''), ''];

  (latest.changes || []).slice(0, 12).forEach(function (change) {
    lines.push('• ' + escapeHtml_(String(change)));
  });

  lines.push('');
  lines.push('<i>Обновление занимает полминуты и делается в редакторе таблицы. ' +
    'Записи и настройки не тронутся.</i>');

  return lines.join('\n');
}

/**
 * Ответ на «/versiya»: своя версия и сразу — свежая ли она.
 *
 * Отдельно спрашивать «а нет ли обновлений» неудобно: человек интересуется
 * версией именно затем, чтобы понять, не отстал ли он.
 */
function versionReport_() {
  var lines = ['Версия бота: <b>' + escapeHtml_(BOT_VERSION) + '</b>'];
  var latest = fetchLatestVersion_();

  if (!latest || !latest.version) {
    lines.push('<i>Проверить обновления не вышло — репозиторий не ответил.</i>');
    return lines.join('\n');
  }

  if (compareVersions_(latest.version, BOT_VERSION) > 0) {
    lines.push('Вышла новее: <b>' + escapeHtml_(latest.version) + '</b>' +
      (latest.date ? ' от ' + escapeHtml_(latest.date) : ''));
    lines.push('');
    lines.push('Обновиться — /obnovit');
  } else {
    lines.push('<i>Это последняя версия.</i>');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Как обновиться
// ---------------------------------------------------------------------------

/**
 * Присылает новый код файлом и объясняет, что с ним делать.
 *
 * Файлом, а не ссылкой: копировать двести килобайт кода из браузера на
 * телефоне неудобно, а файл открывается и выделяется целиком.
 */
function sendUpdateInstructions_(chatId) {
  var latest = fetchLatestVersion_();
  if (!latest || !latest.version) {
    tgSend_(chatId, 'Не смог получить сведения о новой версии. Попробуйте позже.');
    return false;
  }

  var code = fetchUpdateFile_('dist/Код.gs');

  // Проверяем скачанное: обрыв связи или страница-заглушка вместо файла
  // отправили бы человека вставлять в редактор мусор
  if (!code || code.length < 50000 || code.indexOf('function doPost') === -1) {
    tgSend_(chatId, 'Не смог скачать новый код. Он всегда лежит здесь:\n' +
      updateSource_() + 'dist/Код.gs');
    return false;
  }

  var declared = (code.match(/var BOT_VERSION = '([^']+)'/) || [])[1];
  if (declared !== latest.version) {
    tgSend_(chatId, 'Скачанный код не той версии — лучше обновиться вручную с GitHub.');
    return false;
  }

  // Имя латиницей: кириллица в имени файла при отправке теряется, и человек
  // получает документ без названия — непонятно, что это и зачем
  tgSendDocument_(chatId,
    Utilities.newBlob(code, 'text/plain', 'family-budget-' + latest.version + '.gs'),
    'Код версии ' + latest.version);

  tgSend_(chatId, [
    '<b>Как обновиться</b> — три шага, полминуты:',
    '',
    '1. Откройте таблицу → меню <b>Расширения → Apps Script</b>',
    '2. Откройте файл <b>Код</b>, выделите всё (Ctrl+A) и вставьте ' +
      'содержимое присланного файла',
    '3. Сохраните (Ctrl+S)',
    '',
    'Если бот отвечает по вебхуку, нужен ещё один шаг: ' +
    '<b>Начать развёртывание → Управление развёртываниями</b> → карандаш → ' +
    '<b>Версия: Новая версия</b> → <b>Развернуть</b>. Без этого телеграм ' +
    'продолжит говорить со старым кодом.',
    '',
    '<b>Если файлов в проекте много</b> (00_Config, 01_Sheets и так далее) — ' +
    'значит код ставили из папки исходников. Тогда либо обновите его оттуда ' +
    'же (<code>git pull</code> и <code>node tools/deploy.js</code>), либо ' +
    'удалите все файлы кроме <b>appsscript</b>, создайте один файл <b>Код</b> ' +
    'и вставьте присланное в него — на работу это не влияет, Apps Script всё ' +
    'равно склеивает файлы при запуске.',
    '',
    '<i>Прежний код никуда не денется: в редакторе есть «История версий», ' +
    'откуда его можно вернуть.</i>',
    '',
    'Когда закончите, напишите /versiya — проверим, что встало новое.'
  ].join('\n'));

  logEvent_('Отправлены указания по обновлению', { версия: latest.version, кому: chatId });
  return true;
}

/**
 * Файл из репозитория текстом.
 */
function fetchUpdateFile_(path) {
  try {
    var response = UrlFetchApp.fetch(updateSource_() + path, {
      muteHttpExceptions: true,
      headers: { 'Cache-Control': 'no-cache' }
    });
    if (response.getResponseCode() !== 200) return '';
    return response.getContentText();
  } catch (err) {
    logEvent_('Сбой скачивания обновления', { path: path, error: String(err) });
    return '';
  }
}

// ---------------------------------------------------------------------------
// «Бота обновили»
// ---------------------------------------------------------------------------

/**
 * Замечает, что код заменили на более новый, и рассказывает об этом всем.
 *
 * Обновление ставит один человек, а пользуются ботом все: жена не должна
 * узнавать о новых возможностях случайно. Проверка дешёвая — чтение одного
 * свойства, — поэтому делается при каждом сообщении.
 */
function announceVersionChange_() {
  var known = scriptProp_(PROP_RUNNING_VERSION);

  if (!known) {
    // Первый запуск после установки: просто запоминаем, никого не тревожим
    PropertiesService.getScriptProperties().setProperty(PROP_RUNNING_VERSION, BOT_VERSION);
    return;
  }

  if (compareVersions_(BOT_VERSION, known) <= 0) return;

  PropertiesService.getScriptProperties().setProperty(PROP_RUNNING_VERSION, BOT_VERSION);

  // Список берём из кода, а не с GitHub: рассказ бота о самом себе не должен
  // зависеть от сети, а репозиторий сразу после выпуска ещё отдаёт из кэша
  // прежнюю версию — список оказался бы пустым
  var changes = typeof BOT_CHANGES === 'undefined' ? [] : BOT_CHANGES;

  var lines = ['✨ <b>Бот обновился</b> — версия ' + escapeHtml_(BOT_VERSION)];
  if (changes.length) {
    lines.push('');
    changes.slice(0, 12).forEach(function (change) {
      lines.push('• ' + escapeHtml_(String(change)));
    });
  }
  lines.push('');
  lines.push('<i>Что умею — /spravka</i>');

  allowedUserIds_().forEach(function (id) {
    tgSend_(id, lines.join('\n'));
  });

  logEvent_('Объявлено обновление', { было: known, стало: BOT_VERSION });
}

// ---------------------------------------------------------------------------
// Триггер
// ---------------------------------------------------------------------------

/**
 * Еженедельная проверка обновлений. Запускается при первичной настройке.
 */
function createUpdateTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'weeklyUpdateCheck') ScriptApp.deleteTrigger(trigger);
  });

  ScriptApp.newTrigger('weeklyUpdateCheck')
    .timeBased()
    .everyWeeks(1)
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(10)
    .create();

  var report = 'Проверка обновлений включена: по понедельникам утром.';
  console.log(report);
  return report;
}

function weeklyUpdateCheck() {
  checkForUpdates(true);
}


// ===========================================================================
// 15_Changes
// ===========================================================================

/**
 * 15_Changes.gs — что нового в этой версии.
 *
 * Файл собирается автоматически из CHANGELOG.md (node tools/build.js).
 * Править руками не нужно: при следующей сборке всё перезапишется.
 *
 * Список лежит в коде, а не берётся с GitHub, потому что бот рассказывает
 * о нём сразу после обновления — когда репозиторий ещё отдаёт из кэша
 * прежнюю версию, а сети может не быть вовсе.
 */

var BOT_VERSION_DATE = "22.08.2026";

var BOT_CHANGES = [
  "Импорт выписок больше не спрашивает категорию у модели по каждой строке. На банковской выписке это давало полторы сотни запросов подряд, упиралось в дневной лимит Gemini и обрывало разбор молча, без единого сообщения",
  "Категории при импорте берутся из словаря на листе «Категории»; строки, которых словарь не знает, остаются без категории — их разложим отдельно",
  "Получив файл, бот сразу пишет «взял, читаю»: раньше во время разбора чат молчал, и было непонятно, дошёл ли файл вообще"
];


// ===========================================================================
// 16_Import
// ===========================================================================

/**
 * 16_Import.gs — разбор выписок банка и карточных компаний.
 *
 * Устройство простое: файл превращается в таблицу строк, по названиям
 * столбцов узнаётся источник, строки раскладываются в лист «Операции».
 *
 * Почему ищем строку заголовков, а не читаем с фиксированной позиции: у всех
 * четырёх источников сверху лежит шапка своей высоты, и она меняется от
 * выгрузки к выгрузке (месяц, имя владельца, итог). Названия столбцов при
 * этом устойчивы.
 */

// Названия столбцов, по которым узнаём источник. Иврит взят прямо из выгрузок.
var STATEMENT_FORMATS_ = [
  {
    source: 'Isracard',
    marker: ['מס\' שובר'],
    columns: {
      date: ['תאריך רכישה'],
      merchant: ['שם בית עסק'],
      amount: ['סכום חיוב'],
      currency: ['מטבע חיוב'],
      originalAmount: ['סכום עסקה'],
      originalCurrency: ['מטבע עסקה'],
      voucher: ['מס\' שובר'],
      note: ['פירוט נוסף']
    }
  },
  {
    source: 'Max',
    marker: ['4 ספרות אחרונות'],
    columns: {
      date: ['תאריך עסקה'],
      merchant: ['שם בית העסק'],
      category: ['קטגוריה'],
      card: ['4 ספרות אחרונות'],
      kind: ['סוג עסקה'],
      amount: ['סכום חיוב'],
      currency: ['מטבע חיוב'],
      originalAmount: ['סכום עסקה מקורי'],
      originalCurrency: ['מטבע עסקה מקורי'],
      chargeDate: ['תאריך חיוב'],
      note: ['הערות']
    }
  },
  {
    source: 'Cal',
    marker: ['תאריך עסקה', 'שם בית העסק'],
    columns: {
      date: ['תאריך עסקה'],
      merchant: ['שם בית העסק', 'שם בית עסק'],
      amount: ['סכום חיוב', 'סכום החיוב'],
      currency: ['מטבע חיוב', 'מטבע'],
      originalAmount: ['סכום עסקה מקורי', 'סכום עסקה'],
      originalCurrency: ['מטבע עסקה מקורי', 'מטבע עסקה'],
      chargeDate: ['תאריך חיוב', 'מועד חיוב'],
      card: ['4 ספרות אחרונות', 'מספר כרטיס'],
      kind: ['סוג עסקה'],
      note: ['הערות', 'פירוט נוסף']
    }
  },
  {
    source: 'Банк',
    marker: ['חובה', 'זכות'],
    columns: {
      date: ['תאריך'],
      operation: ['הפעולה', 'תיאור הפעולה'],
      details: ['פרטים'],
      reference: ['אסמכתא'],
      debit: ['חובה'],
      credit: ['זכות'],
      balance: ['יתרה בש\'\'ח', 'יתרה לאחר פעולה'],
      valueDate: ['תאריך ערך'],
      payee: ['לטובת'],
      purpose: ['עבור']
    }
  }
];

/**
 * Ищет строку заголовков и определяет источник.
 * Возвращает {source, headerRow, index: {поле: номер столбца}} или null.
 */
function detectStatementFormat_(rows) {
  var limit = Math.min(rows.length, 30); // шапка ни у кого не длиннее

  for (var r = 0; r < limit; r++) {
    var cells = (rows[r] || []).map(function (cell) { return String(cell == null ? '' : cell).trim(); });
    if (!cells.join('')) continue;

    for (var f = 0; f < STATEMENT_FORMATS_.length; f++) {
      var format = STATEMENT_FORMATS_[f];
      var hasAll = format.marker.every(function (marker) {
        return cells.some(function (cell) { return cell.indexOf(marker) !== -1; });
      });
      if (!hasAll) continue;

      var index = {};
      Object.keys(format.columns).forEach(function (field) {
        var variants = format.columns[field];
        for (var c = 0; c < cells.length; c++) {
          for (var v = 0; v < variants.length; v++) {
            if (cells[c] && cells[c].indexOf(variants[v]) !== -1 && index[field] === undefined) {
              index[field] = c;
            }
          }
        }
      });

      return { source: format.source, headerRow: r, index: index };
    }
  }
  return null;
}

/**
 * Из шапки Isracard достаём номер карты и дату списания: в самих строках
 * их нет, а без карты непонятно, чья это трата.
 */
function isracardHeaderHints_(rows, headerRow) {
  var hints = { card: '', chargeDay: '' };

  for (var r = 0; r < headerRow; r++) {
    var line = (rows[r] || []).map(function (c) { return String(c == null ? '' : c); }).join(' ');
    // Ищем четыре цифры рядом с названием карты: просто «последние четыре
    // цифры строки» ловят год из заголовка «פירוט עסקאות · יולי 2026»
    var card = line.match(/(?:כרטיס|מסטרקארד|מאסטרקארד|ויזה|דירקט|ישראכרט|גולד)[^\d]{0,12}(\d{4})/);
    if (card && !hints.card && !/^(19|20)\d\d$/.test(card[1])) hints.card = card[1];
    var charge = line.match(/לחיוב\s*ב-?\s*(\d{1,2})[.\/](\d{1,2})/);
    if (charge && !hints.chargeDay) hints.chargeDay = charge[1] + '.' + charge[2];
  }
  return hints;
}

/**
 * Даты в выгрузках бывают тремя видами: настоящая дата (Excel), «11.07.26»
 * (Isracard) и «04-03-2024» (Max). Разбираем все, иначе строка потеряется.
 */
function parseStatementDate_(value) {
  if (!value && value !== 0) return null;
  if (Object.prototype.toString.call(value) === '[object Date]') return value;

  // Из файла Excel, прочитанного без Google Диска, даты приходят числом
  if (typeof value === 'number') return excelSerialToDate_(value);

  var text = String(value).trim();
  if (!text) return null;

  var m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));

  m = text.match(/^(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{2,4})/);
  if (m) {
    var year = Number(m[3]);
    if (year < 100) year += 2000;
    return new Date(year, Number(m[2]) - 1, Number(m[1]));
  }
  return null;
}

/**
 * Числа приходят и числом, и строкой с запятыми и знаком валюты.
 */
function parseStatementNumber_(value) {
  if (typeof value === 'number') return value;
  var text = String(value == null ? '' : value).replace(/[^\d.,\-]/g, '').replace(/,/g, '');
  var number = parseFloat(text);
  return isNaN(number) ? 0 : number;
}

function statementCurrency_(value) {
  var text = String(value == null ? '' : value).trim();
  if (!text) return 'ILS';
  if (text.indexOf('₪') !== -1 || text.indexOf('ש') !== -1 || /ILS|NIS/i.test(text)) return 'ILS';
  if (text.indexOf('$') !== -1 || /USD/i.test(text)) return 'USD';
  if (text.indexOf('€') !== -1 || /EUR/i.test(text)) return 'EUR';
  if (text.indexOf('₽') !== -1 || /RUB/i.test(text)) return 'RUB';
  return text.toUpperCase().substring(0, 3);
}

/**
 * Строка банковской выписки, которой соответствует общее списание по карте:
 * «מסטרקרד», «דירקט», «ויזה כאל» и подобные, а в графе «אסמכתא» — четыре
 * цифры карты. Такую строку считать тратой нельзя: покупки по этой карте
 * уже пришли отдельными строками из выгрузки эмитента.
 */
function isCardSettlement_(operation, reference, knownCards) {
  var text = String(operation || '');
  var byName = /מסטרקרד|מסטרקארד|ויזה|דירקט|ישראכרט|כאל|מקס|max|לאומי קארד/i.test(text);
  var digits = String(reference || '').replace(/\D/g, '');
  var byCard = digits.length === 4 && knownCards.indexOf(digits) !== -1;
  return byName && (byCard || digits.length === 4);
}

/**
 * Реестр карт: 4 цифры → {владелец, эмитент, название}.
 */
function readCards_() {
  var sheet = ensureSheet_(SHEET_CARDS, CARD_COLUMNS);
  var last = sheet.getLastRow();
  var map = {};
  if (last < 2) return map;

  sheet.getRange(2, 1, last - 1, CARD_COLUMNS.length).getValues().forEach(function (row) {
    var digits = String(row[0] == null ? '' : row[0]).replace(/\D/g, '');
    if (!digits) return;
    map[digits] = {
      card: digits,
      title: String(row[1] || ''),
      issuer: String(row[2] || ''),
      owner: String(row[3] || ''),
      purpose: String(row[4] || ''),
      chargeDay: String(row[5] || ''),
      status: String(row[6] || '')
    };
  });
  return map;
}

/**
 * Превращает строки файла в операции. Ничего не пишет — только разбирает,
 * чтобы разбор можно было проверить тестом без таблицы.
 */
function parseStatement_(rows, fileName) {
  var format = detectStatementFormat_(rows);
  if (!format) return { ok: false, error: 'Не понял, чья это выписка: не нашёл знакомых столбцов' };

  var cards = readCards_();
  var knownCards = Object.keys(cards);
  var index = format.index;
  var hints = format.source === 'Isracard' ? isracardHeaderHints_(rows, format.headerRow) : { card: '', chargeDay: '' };
  var operations = [];

  function cell(row, field) {
    var position = index[field];
    return position === undefined ? '' : row[position];
  }

  for (var r = format.headerRow + 1; r < rows.length; r++) {
    var row = rows[r] || [];
    var date = parseStatementDate_(cell(row, 'date'));
    if (!date) continue; // итоговые строки и разделители дат не имеют

    var operation = {
      date: date,
      chargeDate: parseStatementDate_(cell(row, 'chargeDate')) || null,
      source: format.source,
      card: String(cell(row, 'card') || hints.card || '').replace(/\D/g, '').slice(-4),
      merchant: String(cell(row, 'merchant') || '').trim(),
      currency: 'ILS',
      originalAmount: 0,
      originalCurrency: '',
      kind: 'покупка',
      notTrackable: '',
      note: String(cell(row, 'note') || '').trim(),
      file: fileName || ''
    };

    if (format.source === 'Банк') {
      var debit = parseStatementNumber_(cell(row, 'debit'));
      var credit = parseStatementNumber_(cell(row, 'credit'));
      var title = String(cell(row, 'operation') || '').trim();
      var reference = String(cell(row, 'reference') || '').trim();
      var details = String(cell(row, 'details') || '').trim();

      if (!debit && !credit) continue;

      operation.merchant = title;
      operation.note = [details, String(cell(row, 'payee') || ''), String(cell(row, 'purpose') || '')]
        .filter(function (part) { return String(part).trim(); }).join(' · ');
      operation.amount = debit || credit;
      operation.key = 'bank:' + formatDate_(date) + ':' + reference + ':' + operation.amount.toFixed(2);

      if (credit) {
        operation.kind = 'поступление';
        operation.notTrackable = 'да'; // доходы ведём отдельно, в тратах их быть не должно
      } else if (isCardSettlement_(title, reference, knownCards)) {
        operation.kind = 'списание по карте';
        operation.notTrackable = 'да'; // покупки уже пришли из выгрузки эмитента
        operation.card = String(reference).replace(/\D/g, '').slice(-4);
      }
    } else {
      operation.amount = parseStatementNumber_(cell(row, 'amount'));
      if (!operation.amount) continue;

      operation.currency = statementCurrency_(cell(row, 'currency'));
      operation.originalAmount = parseStatementNumber_(cell(row, 'originalAmount'));
      operation.originalCurrency = statementCurrency_(cell(row, 'originalCurrency'));
      if (operation.originalCurrency === operation.currency &&
          Math.abs(operation.originalAmount - operation.amount) < 0.005) {
        operation.originalAmount = 0;
        operation.originalCurrency = '';
      }

      var kindText = String(cell(row, 'kind') || '');
      if (/תשלום|תשלומים|קרדיט|רכישה עתידית/.test(kindText)) operation.kind = 'рассрочка';

      if (format.source === 'Isracard') {
        var voucher = String(cell(row, 'voucher') || '').replace(/\s/g, '');
        // Номер ваучера у Isracard уникален — лучшего ключа не найти
        operation.key = 'isracard:' + voucher;
        if (!voucher) {
          operation.key = 'isracard:' + operation.card + ':' + formatDate_(date) + ':' +
            operation.merchant + ':' + operation.amount.toFixed(2);
        }
        if (!operation.chargeDate && hints.chargeDay) {
          operation.chargeDate = parseStatementDate_(hints.chargeDay + '.' + date.getFullYear());
        }
      } else {
        var prefix = format.source === 'Max' ? 'max:' : 'cal:';
        operation.key = prefix + operation.card + ':' + formatDate_(date) + ':' +
          operation.merchant + ':' + operation.amount.toFixed(2);
      }
    }

    var known = cards[operation.card];
    operation.owner = known ? known.owner : '';

    // Категорию берём ТОЛЬКО из словаря. Обращаться к модели по каждой строке
    // нельзя: в банковской выписке их полторы сотни, и бесплатный лимит
    // Gemini кончается на середине файла — импорт молча умирает
    var guess = operation.notTrackable
      ? null
      : categorizeByDictionary_(String(operation.merchant || '').toLowerCase());
    operation.category = guess ? guess.category : '';
    operation.subcategory = guess ? guess.subcategory : '';

    operations.push(operation);
  }

  return { ok: true, source: format.source, operations: operations };
}

/**
 * Дата, раньше которой импортировать нечего: до неё бюджет просто не вели.
 */
function accountingStartDate_() {
  var raw = String(setting_('Учёт с', '')).trim();
  if (!raw) return null;
  return parseStatementDate_(raw);
}

/**
 * Пишет операции в лист, пропуская уже импортированные.
 */
function saveOperations_(operations, fileName, fileKey) {
  var sheet = ensureSheet_(SHEET_OPERATIONS, OPERATION_COLUMNS);
  var last = sheet.getLastRow();

  var seen = {};
  if (last >= 2) {
    sheet.getRange(2, 16, last - 1, 1).getValues().forEach(function (row) {
      if (row[0]) seen[String(row[0])] = true;
    });
  }

  var startDate = accountingStartDate_();
  var rows = [];
  var stats = { total: operations.length, added: 0, dupes: 0, skipped: 0 };

  operations.forEach(function (op) {
    if (startDate && op.date < startDate) { stats.skipped++; return; }
    if (seen[op.key]) { stats.dupes++; return; }
    seen[op.key] = true;

    rows.push([
      op.date,
      op.chargeDate || '',
      op.amount,
      op.currency,
      toBaseAmount_(op.amount, op.currency),
      op.originalAmount || '',
      op.originalCurrency || '',
      op.source,
      op.card || '',
      op.owner || '',
      op.merchant,
      op.category || '',
      op.subcategory || '',
      op.kind,
      op.notTrackable || '',
      op.key,
      '', // склейка с записью в «Расходах» проставляется отдельно
      op.file || fileName || '',
      op.note || '',
      newRecordId_()
    ]);
    stats.added++;
  });

  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, OPERATION_COLUMNS.length).setValues(rows);
  }

  var journal = ensureSheet_(SHEET_IMPORTS, IMPORT_COLUMNS);
  journal.appendRow([
    new Date(), fileName || '', operations.length ? operations[0].source : '',
    statementPeriod_(operations), stats.total, stats.added, stats.dupes, stats.skipped, fileKey || ''
  ]);

  return stats;
}

/**
 * Период выписки — для журнала: «15.08.2026 — 22.08.2026».
 */
function statementPeriod_(operations) {
  if (!operations.length) return '';
  var min = operations[0].date;
  var max = operations[0].date;
  operations.forEach(function (op) {
    if (op.date < min) min = op.date;
    if (op.date > max) max = op.date;
  });
  return formatDate_(min) + ' — ' + formatDate_(max);
}

/**
 * Разбирает готовые строки и сохраняет. Возвращает текст отчёта для чата.
 */
function importStatementRows_(rows, fileName, fileKey) {
  var parsed = parseStatement_(rows, fileName);
  if (!parsed.ok) {
    logEvent_('Выписка не разобрана', { файл: fileName, причина: parsed.error });
    return { ok: false, error: parsed.error };
  }

  var stats = saveOperations_(parsed.operations, fileName, fileKey);
  logEvent_('Выписка импортирована', {
    файл: fileName, источник: parsed.source,
    строк: stats.total, новых: stats.added, повторов: stats.dupes, раньшеУчёта: stats.skipped
  });

  return { ok: true, source: parsed.source, stats: stats };
}

/**
 * Отчёт по импорту одним понятным абзацем.
 */
function importReportText_(fileName, result) {
  if (!result.ok) {
    return '<b>' + escapeHtml_(fileName) + '</b>\n' + escapeHtml_(result.error);
  }

  var s = result.stats;
  var lines = [
    '<b>' + escapeHtml_(fileName) + '</b> · ' + escapeHtml_(result.source),
    'Строк в файле: ' + s.total,
    'Записано новых: <b>' + s.added + '</b>'
  ];
  if (s.dupes) lines.push('Уже были: ' + s.dupes);
  if (s.skipped) lines.push('Раньше начала учёта: ' + s.skipped);
  if (!s.added && !s.dupes) lines.push('Ничего подходящего не нашлось — проверьте, тот ли файл.');
  return lines.join('\n');
}


// ===========================================================================
// 17_ImportFiles
// ===========================================================================

/**
 * 17_ImportFiles.gs — как выписка попадает к боту.
 *
 * Два пути, оба нужны: файл в чат (быстро, с телефона) и папка на Google
 * Диске рядом с таблицей (удобно, когда за раз выгружено четыре файла).
 *
 * Excel бот разбирает сам (см. 20_Xlsx.gs), поэтому для файла из чата Диск
 * не нужен вовсе. Доступ к Диску нужен только для второго пути — забрать
 * файлы из папки «Выписки», и берётся он встроенным сервисом DriveApp.
 */

var DRIVE_FILES_API_ = 'https://www.googleapis.com/drive/v3/files';
var DRIVE_UPLOAD_API_ = 'https://www.googleapis.com/upload/drive/v3/files';

function driveRequest_(url, options) {
  var params = options || {};
  params.muteHttpExceptions = true;
  params.headers = params.headers || {};
  params.headers.Authorization = 'Bearer ' + ScriptApp.getOAuthToken();
  return UrlFetchApp.fetch(url, params);
}

/**
 * Строки из CSV: кодировка бывает и UTF-8 с меткой, и ивритская windows-1255.
 */
function rowsFromCsv_(blob) {
  var text = '';
  try {
    text = blob.getDataAsString('UTF-8');
    // Признак того, что файл на самом деле в другой кодировке: вместо букв
    // приходят символы замены
    if (text.indexOf('�') !== -1) text = blob.getDataAsString('windows-1255');
  } catch (err) {
    text = blob.getDataAsString();
  }
  text = text.replace(/^﻿/, '');
  return Utilities.parseCsv(text);
}

/**
 * Строки из Excel — через временную копию в виде Google Таблицы.
 */
function rowsFromExcel_(blob, fileName) {
  var metadata = { name: 'Разбор выписки ' + (fileName || ''), mimeType: MimeType.GOOGLE_SHEETS };
  var boundary = '-----statement' + new Date().getTime();

  var payload = Utilities.newBlob(
    '--' + boundary + '\r\n' +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) + '\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Type: ' + (blob.getContentType() || 'application/octet-stream') + '\r\n\r\n'
  ).getBytes()
    .concat(blob.getBytes())
    .concat(Utilities.newBlob('\r\n--' + boundary + '--\r\n').getBytes());

  var response = driveRequest_(DRIVE_UPLOAD_API_ + '?uploadType=multipart&supportsAllDrives=true', {
    method: 'post',
    contentType: 'multipart/related; boundary=' + boundary,
    payload: payload
  });

  if (response.getResponseCode() !== 200) {
    logEvent_('Excel не преобразовался', {
      файл: fileName, код: response.getResponseCode(),
      ответ: response.getContentText().substring(0, 500)
    });
    return null;
  }

  var id = JSON.parse(response.getContentText()).id;
  try {
    var sheet = SpreadsheetApp.openById(id).getSheets()[0];
    return sheet.getDataRange().getValues();
  } finally {
    // Временная копия нужна была ровно на один разбор
    driveRequest_(DRIVE_FILES_API_ + '/' + id, { method: 'delete' });
  }
}

/**
 * Разбирает файл любого из поддерживаемых видов.
 */
function rowsFromStatementBlob_(blob, fileName) {
  var name = String(fileName || '').toLowerCase();
  var type = String(blob.getContentType() || '').toLowerCase();

  if (name.indexOf('.csv') !== -1 || type.indexOf('csv') !== -1) return rowsFromCsv_(blob);

  if (/\.xlsx?$/.test(name) || type.indexOf('spreadsheet') !== -1 || type.indexOf('excel') !== -1) {
    // Свой разбор архива — основной путь: он не зависит ни от прав на Диск,
    // ни от того, включён ли Drive API в проекте скрипта
    try {
      var rows = xlsxRows_(blob);
      if (rows && rows.length) return rows;
    } catch (err) {
      logEvent_('Не разобрал Excel своими силами', { файл: fileName, ошибка: String(err) });
    }
    return rowsFromExcel_(blob, fileName); // запасной путь через Диск
  }
  return null;
}

/**
 * Похоже ли присланное на выписку. Чек и выписка приходят одинаково —
 * документом, поэтому решаем по расширению.
 */
function looksLikeStatement_(fileName, mimeType) {
  var name = String(fileName || '').toLowerCase();
  var type = String(mimeType || '').toLowerCase();
  return /\.(csv|xlsx|xls)$/.test(name) ||
    type.indexOf('csv') !== -1 || type.indexOf('excel') !== -1 || type.indexOf('spreadsheet') !== -1;
}

/**
 * Выписка, присланная файлом в чат.
 */
function handleStatementDocument_(message, document) {
  var chatId = message.chat.id;
  var fileName = String(document.file_name || 'выписка');

  // Разбор большой выписки занимает секунды, и всё это время человек смотрит
  // в пустой чат. Лучше сразу сказать, что файл взят в работу
  tgSendChatAction_(chatId, 'typing');
  tgSend_(chatId, 'Взял <b>' + escapeHtml_(fileName) + '</b>, читаю…');

  var file = tgDownloadFile_(document.file_id);
  if (!file) {
    tgSend_(chatId, 'Не смог забрать файл. Пришлите ещё раз или положите его в папку «Выписки» на Диске.');
    return;
  }

  var rows;
  try {
    rows = rowsFromStatementBlob_(file.blob.setName(fileName), fileName);
  } catch (err) {
    logEvent_('Сбой чтения выписки', { файл: fileName, ошибка: String(err) });
    rows = null;
  }

  if (!rows || !rows.length) {
    tgSend_(chatId, 'Не смог прочитать файл: не нашёл в нём таблицы с данными. ' +
      'Проверьте, что это выгрузка операций, а не сводка или PDF, — ' +
      'или пришлите её в CSV.');
    return;
  }

  var result = importStatementRows_(rows, fileName, 'tg:' + document.file_id);
  tgSend_(chatId, importReportText_(fileName, result));
  if (result.ok && result.stats.added) offerMergeCandidates_(chatId);
}

/**
 * Папка «Выписки» рядом с таблицей: бот сам находит её по расположению
 * таблицы, чтобы не заводить ещё один идентификатор в настройках.
 */
function statementsFolder_() {
  var folderName = String(setting_('Папка выписок', 'Выписки')).trim() || 'Выписки';

  // DriveApp — встроенный сервис Apps Script: в отличие от обращения к
  // Drive API напрямую, он работает без включения этого API в консоли Google
  try {
    var parents = DriveApp.getFileById(getSpreadsheet_().getId()).getParents();
    if (!parents.hasNext()) return { error: 'Не понял, в какой папке лежит таблица' };

    var parent = parents.next();
    var folders = parent.getFoldersByName(folderName);
    if (!folders.hasNext()) {
      return { error: 'Папки «' + folderName + '» рядом с таблицей нет' };
    }

    var folder = folders.next();
    return { folder: folder, id: folder.getId(), name: folder.getName() };
  } catch (err) {
    logEvent_('Диск недоступен', String(err));
    return { error: 'Нет доступа к Диску: ' + err };
  }
}

/**
 * Уже разобранные файлы: помним ключ (идентификатор Диска), чтобы повторный
 * запуск команды не пересчитывал то же самое.
 */
function importedFileKeys_() {
  var journal = ensureSheet_(SHEET_IMPORTS, IMPORT_COLUMNS);
  var last = journal.getLastRow();
  var keys = {};
  if (last < 2) return keys;
  journal.getRange(2, 9, last - 1, 1).getValues().forEach(function (row) {
    if (row[0]) keys[String(row[0])] = true;
  });
  return keys;
}

/**
 * Команда /импорт: разбирает всё новое из папки «Выписки».
 */
function importFromFolder_(chatId) {
  var folder = statementsFolder_();
  if (folder.error) {
    tgSend_(chatId, 'Папку с выписками не нашёл: ' + escapeHtml_(folder.error) + '.\n' +
      'Создайте её рядом с таблицей бюджета — или просто пришлите файл сюда, в чат.');
    return;
  }

  var done = importedFileKeys_();
  var fresh = [];
  var files = folder.folder.getFiles();

  while (files.hasNext()) {
    var file = files.next();
    if (!looksLikeStatement_(file.getName(), file.getMimeType())) continue;
    // Ключ учитывает время правки: обновлённый файл разбираем заново, а
    // повторы всё равно отсеются на уровне отдельных операций
    var key = 'drive:' + file.getId() + ':' + file.getLastUpdated().getTime();
    if (done[key]) continue;
    fresh.push({ file: file, key: key });
  }

  if (!fresh.length) {
    tgSend_(chatId, 'В папке «' + escapeHtml_(folder.name) + '» нового нет.');
    return;
  }

  tgSend_(chatId, 'Разбираю файлов: ' + fresh.length + '…');

  var added = 0;
  fresh.forEach(function (item) {
    var name = item.file.getName();
    var rows;
    try {
      rows = rowsFromStatementBlob_(item.file.getBlob(), name);
    } catch (err) {
      logEvent_('Сбой чтения выписки с Диска', { файл: name, ошибка: String(err) });
      rows = null;
    }

    if (!rows || !rows.length) {
      tgSend_(chatId, '<b>' + escapeHtml_(name) + '</b>\nНе смог прочитать файл.');
      return;
    }

    var result = importStatementRows_(rows, name, item.key);
    if (result.ok) added += result.stats.added;
    tgSend_(chatId, importReportText_(name, result));
  });

  if (added) offerMergeCandidates_(chatId);
}

/**
 * Разрешение на Диск запрашивается один раз: функция ничего не делает,
 * кроме обращения к Диску, зато после её запуска в редакторе появляется
 * окно «Разрешить», и дальше бот работает сам.
 */
function authorizeDrive() {
  var lines = [];

  lines.push('Excel бот читает сам, без Диска — для файлов из чата доступ не нужен.');

  try {
    var parents = DriveApp.getFileById(getSpreadsheet_().getId()).getParents();
    lines.push('Доступ к Диску: есть');
    lines.push(parents.hasNext()
      ? 'Таблица лежит в папке: ' + parents.next().getName()
      : 'Таблица не лежит ни в одной папке');
  } catch (err) {
    lines.push('Доступ к Диску: НЕТ (' + err + ')');
  }

  var folder = statementsFolder_();
  lines.push(folder.error ? 'Папка выписок: ' + folder.error : 'Папка выписок найдена: ' + folder.name);

  var message = lines.join('\n');
  console.log(message);
  return message;
}


// ===========================================================================
// 18_Merge
// ===========================================================================

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


// ===========================================================================
// 19_Directories
// ===========================================================================

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


// ===========================================================================
// 20_Xlsx
// ===========================================================================

/**
 * 20_Xlsx.gs — чтение файлов Excel без Google Диска.
 *
 * Почему свой разбор: обычный путь — залить файл на Диск с просьбой
 * преобразовать его в таблицу — упирается в то, что Drive API в проекте
 * скрипта выключен, а включать его нужно руками в консоли Google Cloud.
 * Для семейного бота это лишний барьер.
 *
 * Файл .xlsx — это zip-архив с XML внутри, а Apps Script умеет и
 * распаковывать (Utilities.unzip), и читать текст. Нам нужны два файла из
 * архива: лист с ячейками и словарь строк, на который лист ссылается
 * номерами вместо самих слов.
 */

/**
 * Достаёт из архива нужные части. Возвращает {sheet, shared} — тексты XML.
 */
function xlsxParts_(blob) {
  var files = Utilities.unzip(blob.setContentType('application/zip'));
  var parts = { sheet: '', shared: '', sheetName: '' };

  files.forEach(function (file) {
    var name = String(file.getName() || '');
    if (name.indexOf('xl/sharedStrings.xml') !== -1) {
      parts.shared = file.getDataAsString('UTF-8');
    } else if (/xl\/worksheets\/sheet\d+\.xml$/.test(name)) {
      // Берём первый лист по порядку: у всех наших выгрузок он единственный
      // либо главный, а остальные — пустые «גיליון2», «גיליון3»
      if (!parts.sheet || name < parts.sheetName) {
        parts.sheet = file.getDataAsString('UTF-8');
        parts.sheetName = name;
      }
    }
  });

  return parts;
}

/**
 * Разворачивает XML-экранирование: в ячейках попадаются кавычки и амперсанды.
 */
function xmlUnescape_(text) {
  return String(text == null ? '' : text)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, function (match, code) { return String.fromCharCode(Number(code)); })
    .replace(/&amp;/g, '&');
}

/**
 * Словарь строк: лист хранит не сами слова, а их номера в этом списке.
 */
function xlsxSharedStrings_(xml) {
  if (!xml) return [];
  // Выгрузки Isracard подписывают теги пространством имён — «<x:si>» вместо
  // «<si>», поэтому приставку всюду считаем необязательной
  var items = xml.match(/<(?:\w+:)?si[\s>][\s\S]*?<\/(?:\w+:)?si>|<(?:\w+:)?si\/>/g) || [];

  return items.map(function (item) {
    // Внутри одной ячейки текст бывает разбит на куски с разным оформлением
    var pieces = item.match(/<(?:\w+:)?t[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g) || [];
    return pieces.map(function (piece) {
      return xmlUnescape_(piece.replace(/<(?:\w+:)?t[^>]*>/, '').replace(/<\/(?:\w+:)?t>/, ''));
    }).join('');
  });
}

/**
 * Буквенный адрес столбца («AB») в его номер.
 */
function xlsxColumnNumber_(reference) {
  var letters = String(reference || '').replace(/\d+/g, '').toUpperCase();
  var number = 0;
  for (var i = 0; i < letters.length; i++) {
    number = number * 26 + (letters.charCodeAt(i) - 64);
  }
  return number;
}

/**
 * Строки листа как массив массивов — в том же виде, в каком их отдаёт
 * getDataRange().getValues() у обычной таблицы.
 */
function xlsxRowsFromParts_(sheetXml, sharedXml) {
  if (!sheetXml) return [];
  var shared = xlsxSharedStrings_(sharedXml);
  var rows = [];

  var rowMatches = sheetXml.match(
    /<(?:\w+:)?row[\s>][\s\S]*?<\/(?:\w+:)?row>|<(?:\w+:)?row[^>]*\/>/g) || [];

  rowMatches.forEach(function (rowXml) {
    var cells = rowXml.match(
      /<(?:\w+:)?c[\s>][\s\S]*?<\/(?:\w+:)?c>|<(?:\w+:)?c[^>]*\/>/g) || [];
    var line = [];

    cells.forEach(function (cellXml) {
      var reference = (cellXml.match(/\sr="([A-Z]+\d+)"/) || [])[1] || '';
      var type = (cellXml.match(/\st="([^"]+)"/) || [])[1] || '';
      var column = reference ? xlsxColumnNumber_(reference) : line.length + 1;

      var value = '';
      if (type === 'inlineStr') {
        var inline = cellXml.match(/<(?:\w+:)?t[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/);
        value = inline ? xmlUnescape_(inline[1]) : '';
      } else {
        var raw = cellXml.match(/<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/);
        var text = raw ? xmlUnescape_(raw[1]) : '';
        if (type === 's') {
          value = shared[Number(text)] === undefined ? '' : shared[Number(text)];
        } else if (text === '') {
          value = '';
        } else {
          var number = Number(text);
          value = isNaN(number) ? text : number;
        }
      }

      while (line.length < column - 1) line.push('');
      line[column - 1] = value;
    });

    rows.push(line);
  });

  return rows;
}

/**
 * Полный путь: файл Excel → строки.
 */
function xlsxRows_(blob) {
  var parts = xlsxParts_(blob);
  return xlsxRowsFromParts_(parts.sheet, parts.shared);
}

/**
 * Даты Excel хранит числом: сколько дней прошло с 30 декабря 1899 года.
 * Отдельная функция, потому что применять её можно только к тем столбцам,
 * про которые мы точно знаем, что там дата, — иначе сумма 45 000 ₪
 * превратится в 2023 год.
 */
function excelSerialToDate_(serial) {
  var number = Number(serial);
  if (!number || number < 20000 || number > 80000) return null; // 1954–2119
  var days = Math.floor(number);
  var base = new Date(1899, 11, 30);
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + days);
}

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
var BOT_VERSION = '1.10.3';

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
// Модели, у которых сегодня кончилась дневная квота: {имя: 'ДД.ММ.ГГГГ'}
var PROP_EXHAUSTED_MODELS = 'GEMINI_EXHAUSTED';
// Модель, которую бот считает лучшей: на неё он вернётся, когда у той
// обновится суточный лимит
var PROP_PREFERRED_MEDIA_MODEL = 'GEMINI_PREFERRED_MEDIA';

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

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

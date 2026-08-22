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

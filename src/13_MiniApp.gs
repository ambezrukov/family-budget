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

  // Страница показывает бюджет целиком: и записанное руками, и траты по
  // картам из выписок
  var all = budgetExpenses_({});
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
    // Сколько ещё уйдёт с карт и к какому числу
    upcoming: miniAppUpcoming_(),
    // Удалённые записи месяца: кнопка «удалить» срабатывает без переспроса,
    // и промахнуться мимо соседней строки ничего не стоит
    deleted: readDeletedRecords_({ from: from, to: to }).map(function (item) {
      return {
        id: item.id,
        date: formatDate_(item.date),
        amount: item.amount,
        currency: item.currency,
        category: item.category,
        description: item.description || item.store,
        author: item.author,
        kind: item.kind
      };
    }),
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
        sourceType: item.sourceType,
        // Строку из выписки удалять нечего: она отражает то, что уже
        // случилось со счётом. Поправить её можно только в таблице
        fromStatement: !!item.fromOperations
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

/**
 * Возврат удалённой записи. Удаление мягкое, поэтому вернуть можно что угодно
 * и когда угодно — строка всё это время лежит на месте с пометкой.
 */
function handleMiniAppRestore_(body) {
  var check = verifyTelegramInitData_(body.initData);
  if (!check.ok) return { ok: false, error: check.error };

  var restored = markExpenseRestored_(body.id);
  if (restored) logEvent_('Запись возвращена из мини-приложения', { id: body.id, user: check.name });
  return { ok: restored, error: restored ? '' : 'Запись не найдена' };
}

/**
 * Предстоящие списания для страницы: даты, карты и суммы.
 */
function miniAppUpcoming_() {
  var data = upcomingCharges_({});

  return {
    asOf: data.asOf ? formatDate_(data.asOf) : '',
    total: Math.round(data.groups.reduce(function (sum, group) {
      return sum + group.amount;
    }, 0) * 100) / 100,
    groups: data.groups.map(function (group) {
      return {
        date: formatDate_(group.date),
        card: group.card,
        title: group.title,
        issuer: group.issuer,
        owner: group.owner,
        amount: Math.round(group.amount * 100) / 100,
        count: group.count,
        // Сколько из суммы — платежи по рассрочке, которых в выписке ещё нет
        forecast: Math.round(group.forecast * 100) / 100
      };
    }),
    later: data.later
      ? {
          count: data.later.count,
          monthly: Math.round(data.later.monthly * 100) / 100,
          until: data.later.until ? formatDate_(data.later.until) : ''
        }
      : null
  };
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

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

  // Изображение, присланное файлом
  if (message.document) {
    var mime = String(message.document.mime_type || '');
    if (mime.indexOf('image/') === 0) {
      handleReceipt_(message, message.document.file_id);
    } else {
      tgSend_(chatId, 'Пока умею читать только изображения чеков. ' +
        'Пришлите фото или напишите сумму текстом.');
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
  var lines = ['<b>Кто как подписан в таблице</b>', ''];
  var keyboard = [];

  authors.forEach(function (author) {
    var isMine = author.name === mine;
    lines.push('• ' + escapeHtml_(author.name) + ' — ' + author.count +
      (isMine ? ' <i>(это вы)</i>' : ''));
    if (!isMine) {
      keyboard.push([{
        text: '↔️ «' + shorten_(author.name, 20) + '» — это я',
        callback_data: 'author:' + stashValue_({ name: author.name })
      }]);
    }
  });

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
    logEvent_('Голос не разобран', { fileId: media.file_id, duration: media.duration });
    tgSend_(chatId, 'Не разобрал голосовое. Напишите, пожалуйста, текстом: сумма и описание.');
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

function handleReceipt_(message, fileId) {
  var chatId = message.chat.id;
  var caption = String(message.caption || '').trim();

  tgSendChatAction_(chatId, 'typing');

  var file = tgDownloadFile_(fileId);
  if (!file) {
    logEvent_('Не скачалось изображение', { fileId: fileId });
    tgSend_(chatId, 'Не смог получить изображение. Пришлите ещё раз или напишите сумму текстом.');
    return;
  }

  var answer = geminiParseReceipt_(file.base64, file.mimeType, caption);
  if (!answer) {
    logEvent_('Чек не разобран', { fileId: fileId });
    tgSend_(chatId, 'Не смог прочитать чек. Напишите сумму текстом — запишу.');
    return;
  }

  var receipts = answer.receipts || [];
  if (!receipts.length) {
    logEvent_('На фото не найдено чеков', { fileId: fileId });
    tgSend_(chatId, 'Не нашёл на фотографии чек. Пришлите снимок почётче или напишите сумму текстом.');
    return;
  }

  processReceiptAnswer_(message, receipts, {
    sourceType: 'фото',
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

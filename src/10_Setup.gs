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
    // Деньги, пришедшие в Израиле взамен рублей, переведённых в России.
    // Для израильского контура это приход, хотя в назначении платежа
    // человек напишет «возврат долга»
    ['Обменные операции', '', 'обмен, обменн, החזר חוב, החזר כספים, החזר, возврат долга, возврат средств'],
    // Уроки и частная практика: имена учеников дописываются в таблице —
    // в коде, который лежит в открытом репозитории, им не место
    ['Заработок Маши', '', 'урок, уроки, lesson, lessons, репетит, занятия, ученик, שיעור'],
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

  addMissingIncomeCategories_();

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
 * Дописывает в справочник доходов категории, появившиеся в новых версиях.
 * Существующие строки не трогает — они правлены руками.
 */
function addMissingIncomeCategories_() {
  var sheet = ensureSheet_(SHEET_INCOME_CATEGORIES, CATEGORY_COLUMNS);
  var last = sheet.getLastRow();
  var known = {};
  if (last >= 2) {
    sheet.getRange(2, 1, last - 1, 1).getValues().forEach(function (row) {
      known[String(row[0]).trim()] = true;
    });
  }

  var missing = starterIncomeCategories_().filter(function (row) { return !known[row[0]]; });
  if (!missing.length) return 0;

  sheet.getRange(sheet.getLastRow() + 1, 1, missing.length, 3).setValues(missing);
  INCOME_CATEGORIES_CACHE_ = null;
  logEvent_('Добавлены новые категории доходов',
    missing.map(function (row) { return row[0]; }).join(', '));
  return missing.length;
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

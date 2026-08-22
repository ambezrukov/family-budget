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

// Дневная квота модели кончилась — до полуночи она отвечать не будет
var GEMINI_QUOTA_OUT_ = false;

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
        GEMINI_QUOTA_OUT_ = false;
        return JSON.parse(text);
      }

      if (code === 429 || code >= 500) {
        busy = true;
        logEvent_('Gemini временная ошибка', { code: code, attempt: attempt + 1, body: text.substring(0, 1000) });

        // 429 бывает двух видов: «слишком часто» лечится паузой, а «кончилась
        // дневная квота» — нет, её ждать до полуночи. Во втором случае
        // повторы только тратят время: сразу уходим к другой модели, у неё
        // счётчик свой
        if (code === 429 && /quota|per day|daily/i.test(text)) {
          logEvent_('Дневная квота модели исчерпана', { модель: url.split('/models/')[1] });
          GEMINI_QUOTA_OUT_ = true;
          break;
        }
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

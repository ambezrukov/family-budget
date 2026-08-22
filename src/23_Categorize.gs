/**
 * 23_Categorize.gs — разбор незнакомых магазинов из выписок.
 *
 * В выписке нет ни категории, ни русского названия: «שווארמה חאזן-קניון ח»,
 * «דרדסטור רמת אלון», «סטפן שניצל». Спрашивать модель про каждую строку
 * нельзя — на банковской выписке это полторы сотни запросов и исчерпанный
 * за минуту дневной лимит.
 *
 * Поэтому спрашиваем один раз про весь список сразу, а ответ кладём в
 * справочники: русское название — в «Переводы», название магазина — в
 * ключевые слова нужной категории. Дальше эти магазины узнаются словарём,
 * бесплатно и навсегда.
 */

var CATEGORIZE_BATCH_ = 40;

/**
 * Названия магазинов, которых словарь ещё не знает.
 */
function unknownStores_() {
  var sheet = ensureSheet_(SHEET_OPERATIONS, OPERATION_COLUMNS);
  var last = sheet.getLastRow();
  if (last < 2) return [];

  var rows = sheet.getRange(2, 1, last - 1, OPERATION_COLUMNS.length).getValues();
  var seen = {};
  var stores = [];

  rows.forEach(function (row) {
    if (String(row[14]).trim()) return;            // «не трата» категорий не требует
    if (String(row[11] || '').trim()) return;      // категория уже стоит

    var store = String(row[10] || '').trim();
    if (!store || seen[store]) return;

    // Словарь мог пополниться после импорта — проверяем ещё раз
    if (categorizeByDictionary_(store.toLowerCase())) return;

    seen[store] = true;
    stores.push(store);
  });

  return stores;
}

/**
 * Спрашивает модель про список магазинов разом.
 * Возвращает [{store, name, category, subcategory}].
 */
function geminiClassifyStores_(stores) {
  if (!stores.length) return [];

  var pairs = [];
  readCategories_().forEach(function (item) {
    pairs.push(item.category + (item.subcategory ? ' · ' + item.subcategory : ''));
  });

  var answer = geminiJson_({
    model: modelForText_(),
    systemInstruction: 'Ты помощник семейного учёта расходов в Израиле. ' +
      'Отвечай только строгим JSON по заданной схеме.',
    parts: [{ text:
      'Ниже список названий магазинов и услуг из банковских выписок — на иврите ' +
      'и английском, часто в сокращении. Для КАЖДОГО названия верни:\n' +
      '- store: название ровно как в списке;\n' +
      '- name: понятное русское название («שווארמה חאזן» → «Шаварма Хазан»);\n' +
      '- category и subcategory: строго из этого списка пар, ничего не выдумывая:\n' +
      pairs.join('; ') + '\n\n' +
      'Если по названию понять невозможно — категория «' + FALLBACK_CATEGORY + '».\n\n' +
      'Список:\n' + stores.map(function (store, i) { return (i + 1) + '. ' + store; }).join('\n')
    }],
    schema: {
      type: 'OBJECT',
      properties: {
        stores: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              store: { type: 'STRING' },
              name: { type: 'STRING' },
              category: { type: 'STRING' },
              subcategory: { type: 'STRING' }
            },
            required: ['store', 'category']
          }
        }
      },
      required: ['stores']
    },
    maxOutputTokens: 16384
  });

  return answer && answer.stores ? answer.stores : [];
}

/**
 * Дописывает название магазина в ключевые слова его категории.
 * Так следующий импорт разложит эту строку сам, без модели.
 */
function rememberStoreCategory_(store, category, subcategory) {
  var sheet = ensureSheet_(SHEET_CATEGORIES, CATEGORY_COLUMNS);
  var last = sheet.getLastRow();
  if (last < 2) return false;

  var rows = sheet.getRange(2, 1, last - 1, 3).getValues();
  var key = String(store || '').toLowerCase().trim();
  if (!key) return false;

  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]).trim() !== category) continue;
    if (String(rows[i][1]).trim() !== String(subcategory || '').trim()) continue;

    var keywords = String(rows[i][2] || '');
    if (keywords.toLowerCase().indexOf(key) !== -1) return false;

    sheet.getRange(i + 2, 3).setValue(keywords ? keywords + ', ' + key : key);
    CATEGORIES_CACHE_ = null;
    return true;
  }
  return false;
}

/**
 * Проставляет категорию во всех строках «Операций» с этим магазином.
 */
function applyStoreCategory_(store, category, subcategory) {
  var sheet = ensureSheet_(SHEET_OPERATIONS, OPERATION_COLUMNS);
  var last = sheet.getLastRow();
  if (last < 2) return 0;

  var rows = sheet.getRange(2, 1, last - 1, OPERATION_COLUMNS.length).getValues();
  var touched = 0;

  rows.forEach(function (row, position) {
    if (String(row[10] || '').trim() !== store) return;
    if (String(row[11] || '').trim()) return;
    sheet.getRange(position + 2, 12, 1, 2).setValues([[category, subcategory || '']]);
    touched++;
  });

  return touched;
}

/**
 * Разбирает незнакомые магазины пачкой. Возвращает отчёт для чата.
 */
function categorizeOperations_(limit) {
  var stores = unknownStores_();
  if (!stores.length) return { ok: true, stores: 0, rows: 0 };

  var batch = stores.slice(0, limit || CATEGORIZE_BATCH_);
  var answers = geminiClassifyStores_(batch);

  if (!answers.length) {
    logEvent_('Магазины не разобраны', { просили: batch.length, перегрузка: GEMINI_BUSY_ });
    return { ok: false, busy: GEMINI_BUSY_, quota: GEMINI_QUOTA_OUT_, stores: batch.length };
  }

  var known = categoryNames_();
  var rows = 0;
  var learned = 0;

  answers.forEach(function (item) {
    var store = String(item.store || '').trim();
    if (!store) return;

    var category = String(item.category || '').trim();
    if (known.indexOf(category) === -1) category = FALLBACK_CATEGORY;
    var subcategory = String(item.subcategory || '').trim();

    rows += applyStoreCategory_(store, category, subcategory);
    if (rememberStoreCategory_(store, category, subcategory)) learned++;

    var name = String(item.name || '').trim();
    if (name && name !== store) rememberTranslation_(store, name, 'магазин');
  });

  logEvent_('Магазины разобраны по категориям', {
    магазинов: answers.length, строк: rows, вСловарь: learned, осталось: stores.length - batch.length
  });

  return {
    ok: true,
    stores: answers.length,
    rows: rows,
    learned: learned,
    left: Math.max(0, stores.length - batch.length)
  };
}

/**
 * Команда /kategorii: разложить незнакомые магазины по категориям.
 */
function handleCategorizeCommand_(message, text) {
  var chatId = message.chat.id;

  // «/kategorii заново» — пересчитать уже разложенное по текущему словарю
  if (/\s(заново|пересчитать)\s*$/i.test(String(text || ''))) {
    var changed = recategorizeOperations_();
    tgSend_(chatId, changed
      ? 'Пересчитал по справочнику: строк изменилось — <b>' + changed + '</b>.'
      : 'Пересчитал — всё и так соответствует справочнику.');
    return;
  }

  var pending = unknownStores_();

  if (!pending.length) {
    tgSend_(chatId, 'Все траты из выписок уже разложены по категориям.');
    return;
  }

  tgSend_(chatId, 'Разбираю незнакомые магазины: <b>' + pending.length + '</b>. ' +
    'Это один запрос к модели, займёт полминуты…');

  var result = categorizeOperations_();

  if (!result.ok) {
    tgSend_(chatId, result.quota
      ? 'На сегодня лимит распознавания у Google исчерпан — попробуйте завтра.'
      : 'Модель сейчас занята. Попробуйте через несколько минут: <code>/kategorii</code>');
    return;
  }

  var lines = [
    'Разобрано магазинов: <b>' + result.stores + '</b>',
    'Обновлено строк: ' + result.rows,
    'Запомнено в справочнике: ' + result.learned + ' — дальше узнаю их сам'
  ];
  if (result.left) lines.push('Осталось на следующий заход: ' + result.left);

  tgSend_(chatId, lines.join('\n'));
}

/**
 * Перекладывает строки выписок по категориям заново — по текущему словарю.
 *
 * Нужно, когда справочник поправили: модель разложила «יופיי סבטלנה זינגר»
 * в «Уход за собой», потому что «יופי» значит «красота», а на деле это курс
 * иврита. Дописали ключевое слово — и старые строки должны переехать следом,
 * иначе правка справочника имеет смысл только для будущих выписок.
 */
function recategorizeOperations_() {
  var sheet = ensureSheet_(SHEET_OPERATIONS, OPERATION_COLUMNS);
  var last = sheet.getLastRow();
  if (last < 2) return 0;

  var rows = sheet.getRange(2, 1, last - 1, OPERATION_COLUMNS.length).getValues();
  var changed = 0;

  rows.forEach(function (row, position) {
    if (String(row[14]).trim()) return; // «не трата» без категории и живёт

    var store = String(row[10] || '').trim();
    if (!store) return;

    var guess = categorizeByDictionary_(store.toLowerCase());
    if (!guess) return;

    var category = String(row[11] || '');
    var subcategory = String(row[12] || '');
    if (category === guess.category && subcategory === (guess.subcategory || '')) return;

    sheet.getRange(position + 2, 12, 1, 2).setValues([[guess.category, guess.subcategory || '']]);
    changed++;
  });

  if (changed) logEvent_('Категории пересчитаны по словарю', { строк: changed });
  return changed;
}

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

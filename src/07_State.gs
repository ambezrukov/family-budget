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
// Затянувшаяся работа и обрыв на полуслове
// ---------------------------------------------------------------------------

// Google обрывает скрипт на шестой минуте без предупреждения: ни ответа
// человеку, ни строчки в журнале. Чтобы такое не выглядело как «бот молчит»,
// перед долгой работой оставляем отметку, а после — снимаем. Уцелевшая
// отметка означает, что прошлый запуск не дожил до ответа.
var LONG_WORK_KEY_ = 'LONG_WORK';

// Порог заведомо больше шести минут: пока отметка моложе, работа может идти
// прямо сейчас — параллельным запуском, и мешать ему незачем.
var LONG_WORK_STALE_MS = 420000;

function markLongWork_(chatId, what) {
  PropertiesService.getScriptProperties().setProperty(LONG_WORK_KEY_, JSON.stringify({
    chatId: chatId,
    what: what || 'работа',
    ts: new Date().getTime()
  }));
}

function clearLongWork_() {
  PropertiesService.getScriptProperties().deleteProperty(LONG_WORK_KEY_);
}

/**
 * Рассказывает о работе, которая оборвалась. Возвращает true, если было
 * о чём рассказать.
 */
function reportInterruptedWork_() {
  var raw = PropertiesService.getScriptProperties().getProperty(LONG_WORK_KEY_);
  if (!raw) return false;

  var mark;
  try {
    mark = JSON.parse(raw);
  } catch (err) {
    clearLongWork_();
    return false;
  }

  var age = new Date().getTime() - Number(mark.ts || 0);
  if (age < LONG_WORK_STALE_MS) return false; // возможно, идёт прямо сейчас

  clearLongWork_();
  logEvent_('Прошлая работа оборвалась', {
    что: mark.what,
    возраст: Math.round(age / 60000) + ' мин'
  });

  if (!mark.chatId) return false;
  tgSend_(mark.chatId, 'Прошлый чек я дочитать не успел: Google не ответил вовремя, ' +
    'и Apps Script оборвал разбор. Пришлите его ещё раз — или напишите сумму текстом, ' +
    'запишу без распознавания.');
  return true;
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

/**
 * 14_Updates.gs — уведомления о новых версиях.
 *
 * Зачем. Код живёт копией в проекте каждой семьи. Автор правит свой
 * репозиторий, а чужие установки об этом не знают — и остаются со старым
 * ботом навсегда, потому что писать каждому владельцу никто не станет.
 *
 * Как. Раз в неделю бот сверяет свою версию с dist/version.json на GitHub.
 * Вышла новее — пишет ответственному, что изменилось, и по кнопке присылает
 * файл с новым кодом и три шага, что с ним сделать.
 *
 * Почему бот не ставит обновление сам. Пробовали: Apps Script не выдаёт
 * скрипту право переписывать собственный код — разрешение в манифесте
 * остаётся просьбой, а токен приходит без него. Обойти это можно только
 * отдельным проектом Google Cloud, и тогда установка для обычной семьи
 * вырастает вдвое. Полминуты ручной работы раз в месяц того не стоят.
 *
 * Кому писать. Заменить код может лишь владелец таблицы — у остальных
 * доступа к редактору нет. Поэтому предупреждение идёт одному человеку,
 * а когда обновление встанет, бот сам расскажет остальным, что нового.
 */

// О какой версии уже сообщали — чтобы не напоминать каждую неделю об одном
var PROP_UPDATE_NOTIFIED = 'UPDATE_NOTIFIED_VERSION';

// Какая версия работала в прошлый раз — по ней видно, что код обновили
var PROP_RUNNING_VERSION = 'RUNNING_VERSION';

/**
 * Адрес, откуда берутся обновления. У форка он свой.
 */
function updateSource_() {
  var source = scriptProp_('UPDATE_SOURCE') || UPDATE_SOURCE_DEFAULT;
  return source.charAt(source.length - 1) === '/' ? source : source + '/';
}

/**
 * Кому писать про обновления.
 *
 * Настройка «Кто обновляет бота» — телеграм-айди того, у кого есть доступ
 * к редактору Apps Script. Не задана — берём первого из разрешённых:
 * обычно это тот, кто бота и ставил.
 */
function updateManagerId_() {
  var configured = String(setting_('Кто обновляет бота', '')).trim();
  if (configured) return configured;

  var users = allowedUserIds_();
  return users.length ? users[0] : '';
}

/**
 * Сравнивает версии вида «1.5.0». Возвращает 1, если первая новее.
 */
function compareVersions_(a, b) {
  var left = String(a || '').split('.').map(function (n) { return parseInt(n, 10) || 0; });
  var right = String(b || '').split('.').map(function (n) { return parseInt(n, 10) || 0; });

  for (var i = 0; i < Math.max(left.length, right.length); i++) {
    var x = left[i] || 0;
    var y = right[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/**
 * Что лежит в репозитории: {version, date, changes}. null — не достучались.
 */
function fetchLatestVersion_() {
  try {
    var response = UrlFetchApp.fetch(updateSource_() + 'dist/version.json', {
      muteHttpExceptions: true,
      headers: { 'Cache-Control': 'no-cache' }
    });
    if (response.getResponseCode() !== 200) {
      logEvent_('Не удалось проверить обновления', { code: response.getResponseCode() });
      return null;
    }
    return JSON.parse(response.getContentText());
  } catch (err) {
    logEvent_('Сбой проверки обновлений', String(err));
    return null;
  }
}

/**
 * Проверка обновлений. Запускается триггером раз в неделю и командой /obnovit.
 *
 * silent = true — молчать, когда всё по-старому: еженедельное «обновлений нет»
 * никому не нужно. chatId — куда отвечать на ручную проверку.
 */
function checkForUpdates(silent, chatId) {
  var reply = chatId || updateManagerId_();
  var latest = fetchLatestVersion_();

  if (!latest || !latest.version) {
    if (!silent && reply) tgSend_(reply, 'Не смог проверить обновления — репозиторий не ответил.');
    return null;
  }

  if (compareVersions_(latest.version, BOT_VERSION) <= 0) {
    if (!silent && reply) {
      tgSend_(reply, 'Обновлений нет, у вас последняя версия: <b>' + escapeHtml_(BOT_VERSION) + '</b>');
    }
    return null;
  }

  // Об одной и той же версии напоминаем один раз
  if (silent && scriptProp_(PROP_UPDATE_NOTIFIED) === latest.version) return latest;

  var target = chatId || updateManagerId_();
  if (!target) return latest;

  tgSend_(target, updateAnnouncement_(latest), [[
    { text: '⬇️ Как обновиться', callback_data: 'update:' + latest.version },
    { text: 'Позже', callback_data: 'updatelater:' + latest.version }
  ]]);

  PropertiesService.getScriptProperties().setProperty(PROP_UPDATE_NOTIFIED, latest.version);
  logEvent_('Найдено обновление', { было: BOT_VERSION, стало: latest.version, кому: target });

  return latest;
}

/**
 * Текст сообщения о новой версии.
 */
function updateAnnouncement_(latest) {
  var lines = ['🔄 <b>Вышло обновление</b>',
    'У вас ' + escapeHtml_(BOT_VERSION) + ', вышла ' + escapeHtml_(latest.version) +
    (latest.date ? ' от ' + escapeHtml_(latest.date) : ''), ''];

  (latest.changes || []).slice(0, 12).forEach(function (change) {
    lines.push('• ' + escapeHtml_(String(change)));
  });

  lines.push('');
  lines.push('<i>Обновление занимает полминуты и делается в редакторе таблицы. ' +
    'Записи и настройки не тронутся.</i>');

  return lines.join('\n');
}

/**
 * Ответ на «/versiya»: своя версия и сразу — свежая ли она.
 *
 * Отдельно спрашивать «а нет ли обновлений» неудобно: человек интересуется
 * версией именно затем, чтобы понять, не отстал ли он.
 */
function versionReport_() {
  var lines = ['Версия бота: <b>' + escapeHtml_(BOT_VERSION) + '</b>'];
  var latest = fetchLatestVersion_();

  if (!latest || !latest.version) {
    lines.push('<i>Проверить обновления не вышло — репозиторий не ответил.</i>');
    return lines.join('\n');
  }

  if (compareVersions_(latest.version, BOT_VERSION) > 0) {
    lines.push('Вышла новее: <b>' + escapeHtml_(latest.version) + '</b>' +
      (latest.date ? ' от ' + escapeHtml_(latest.date) : ''));
    lines.push('');
    lines.push('Обновиться — /obnovit');
  } else {
    lines.push('<i>Это последняя версия.</i>');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Как обновиться
// ---------------------------------------------------------------------------

/**
 * Присылает новый код файлом и объясняет, что с ним делать.
 *
 * Файлом, а не ссылкой: копировать двести килобайт кода из браузера на
 * телефоне неудобно, а файл открывается и выделяется целиком.
 */
function sendUpdateInstructions_(chatId) {
  var latest = fetchLatestVersion_();
  if (!latest || !latest.version) {
    tgSend_(chatId, 'Не смог получить сведения о новой версии. Попробуйте позже.');
    return false;
  }

  var code = fetchUpdateFile_('dist/Код.gs');

  // Проверяем скачанное: обрыв связи или страница-заглушка вместо файла
  // отправили бы человека вставлять в редактор мусор
  if (!code || code.length < 50000 || code.indexOf('function doPost') === -1) {
    tgSend_(chatId, 'Не смог скачать новый код. Он всегда лежит здесь:\n' +
      updateSource_() + 'dist/Код.gs');
    return false;
  }

  var declared = (code.match(/var BOT_VERSION = '([^']+)'/) || [])[1];
  if (declared !== latest.version) {
    tgSend_(chatId, 'Скачанный код не той версии — лучше обновиться вручную с GitHub.');
    return false;
  }

  tgSendDocument_(chatId, Utilities.newBlob(code, 'text/plain', 'Код.gs'),
    'Код версии ' + latest.version);

  tgSend_(chatId, [
    '<b>Как обновиться</b> — три шага, полминуты:',
    '',
    '1. Откройте таблицу → меню <b>Расширения → Apps Script</b>',
    '2. Откройте файл <b>Код</b>, выделите всё (Ctrl+A) и вставьте ' +
      'содержимое присланного файла',
    '3. Сохраните (Ctrl+S)',
    '',
    'Если бот отвечает по вебхуку, нужен ещё один шаг: ' +
    '<b>Начать развёртывание → Управление развёртываниями</b> → карандаш → ' +
    '<b>Версия: Новая версия</b> → <b>Развернуть</b>. Без этого телеграм ' +
    'продолжит говорить со старым кодом.',
    '',
    '<b>Если файлов в проекте много</b> (00_Config, 01_Sheets и так далее) — ' +
    'значит код ставили из папки исходников. Тогда либо обновите его оттуда ' +
    'же (<code>git pull</code> и <code>node tools/deploy.js</code>), либо ' +
    'удалите все файлы кроме <b>appsscript</b>, создайте один файл <b>Код</b> ' +
    'и вставьте присланное в него — на работу это не влияет, Apps Script всё ' +
    'равно склеивает файлы при запуске.',
    '',
    '<i>Прежний код никуда не денется: в редакторе есть «История версий», ' +
    'откуда его можно вернуть.</i>',
    '',
    'Когда закончите, напишите /versiya — проверим, что встало новое.'
  ].join('\n'));

  logEvent_('Отправлены указания по обновлению', { версия: latest.version, кому: chatId });
  return true;
}

/**
 * Файл из репозитория текстом.
 */
function fetchUpdateFile_(path) {
  try {
    var response = UrlFetchApp.fetch(updateSource_() + path, {
      muteHttpExceptions: true,
      headers: { 'Cache-Control': 'no-cache' }
    });
    if (response.getResponseCode() !== 200) return '';
    return response.getContentText();
  } catch (err) {
    logEvent_('Сбой скачивания обновления', { path: path, error: String(err) });
    return '';
  }
}

// ---------------------------------------------------------------------------
// «Бота обновили»
// ---------------------------------------------------------------------------

/**
 * Замечает, что код заменили на более новый, и рассказывает об этом всем.
 *
 * Обновление ставит один человек, а пользуются ботом все: жена не должна
 * узнавать о новых возможностях случайно. Проверка дешёвая — чтение одного
 * свойства, — поэтому делается при каждом сообщении.
 */
function announceVersionChange_() {
  var known = scriptProp_(PROP_RUNNING_VERSION);

  if (!known) {
    // Первый запуск после установки: просто запоминаем, никого не тревожим
    PropertiesService.getScriptProperties().setProperty(PROP_RUNNING_VERSION, BOT_VERSION);
    return;
  }

  if (compareVersions_(BOT_VERSION, known) <= 0) return;

  PropertiesService.getScriptProperties().setProperty(PROP_RUNNING_VERSION, BOT_VERSION);

  var latest = fetchLatestVersion_();
  var changes = latest && latest.version === BOT_VERSION ? (latest.changes || []) : [];

  var lines = ['✨ <b>Бот обновился</b> — версия ' + escapeHtml_(BOT_VERSION)];
  if (changes.length) {
    lines.push('');
    changes.slice(0, 12).forEach(function (change) {
      lines.push('• ' + escapeHtml_(String(change)));
    });
  }
  lines.push('');
  lines.push('<i>Что умею — /spravka</i>');

  allowedUserIds_().forEach(function (id) {
    tgSend_(id, lines.join('\n'));
  });

  logEvent_('Объявлено обновление', { было: known, стало: BOT_VERSION });
}

// ---------------------------------------------------------------------------
// Триггер
// ---------------------------------------------------------------------------

/**
 * Еженедельная проверка обновлений. Запускается при первичной настройке.
 */
function createUpdateTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'weeklyUpdateCheck') ScriptApp.deleteTrigger(trigger);
  });

  ScriptApp.newTrigger('weeklyUpdateCheck')
    .timeBased()
    .everyWeeks(1)
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(10)
    .create();

  var report = 'Проверка обновлений включена: по понедельникам утром.';
  console.log(report);
  return report;
}

function weeklyUpdateCheck() {
  checkForUpdates(true);
}

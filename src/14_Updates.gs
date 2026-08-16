/**
 * 14_Updates.gs — уведомления о новых версиях и обновление по кнопке.
 *
 * Зачем. Код живёт копией в проекте каждой семьи. Автор правит свой
 * репозиторий, а чужие установки об этом не знают — и остаются со старым
 * ботом навсегда, потому что писать каждому владельцу никто не станет.
 *
 * Как. Раз в неделю бот сверяет свою версию с dist/version.json на GitHub.
 * Вышла новее — пишет владельцу, что изменилось, и предлагает кнопку.
 * Само по себе ничего не ставится: обновление меняет код, который работает
 * с семейными деньгами, и решение остаётся за человеком.
 *
 * Обновление идёт через Apps Script API: скрипт переписывает сам себя.
 * Перед заменой сохраняется версия «до обновления» — если новое окажется
 * сломанным, в редакторе Apps Script есть история, откуда можно вернуться.
 */

var SCRIPT_API = 'https://script.googleapis.com/v1/projects/';

// О какой версии уже сообщали — чтобы не напоминать каждую неделю об одном
var PROP_UPDATE_NOTIFIED = 'UPDATE_NOTIFIED_VERSION';

/**
 * Адрес, откуда берутся обновления. У форка он свой.
 */
function updateSource_() {
  var source = scriptProp_('UPDATE_SOURCE') || UPDATE_SOURCE_DEFAULT;
  return source.charAt(source.length - 1) === '/' ? source : source + '/';
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
 * Еженедельная проверка. Запускается триггером, а также вручную командой.
 *
 * silent = true — молчать, если обновлений нет (так работает триггер:
 * «всё по-старому» каждую неделю никому не нужно).
 */
function checkForUpdates(silent) {
  var latest = fetchLatestVersion_();
  if (!latest || !latest.version) {
    if (!silent) notifyOwners_('Не смог проверить обновления — репозиторий не ответил.');
    return null;
  }

  if (compareVersions_(latest.version, BOT_VERSION) <= 0) {
    if (!silent) {
      notifyOwners_('Обновлений нет, у вас последняя версия: <b>' + escapeHtml_(BOT_VERSION) + '</b>');
    }
    return null;
  }

  // Об одной и той же версии напоминаем только раз
  if (silent && scriptProp_(PROP_UPDATE_NOTIFIED) === latest.version) return latest;

  var lines = ['🔄 <b>Вышло обновление</b>',
    'У вас ' + escapeHtml_(BOT_VERSION) + ', вышла ' + escapeHtml_(latest.version) +
    (latest.date ? ' от ' + escapeHtml_(latest.date) : ''), ''];

  (latest.changes || []).slice(0, 12).forEach(function (change) {
    lines.push('• ' + escapeHtml_(String(change)));
  });

  lines.push('');
  lines.push('Обновление заменит код бота на свежий. Записи и настройки не тронет.');

  var keyboard = [[
    { text: '⬇️ Обновить сейчас', callback_data: 'update:' + latest.version },
    { text: 'Позже', callback_data: 'updatelater:' + latest.version }
  ]];

  notifyOwners_(lines.join('\n'), keyboard);
  PropertiesService.getScriptProperties().setProperty(PROP_UPDATE_NOTIFIED, latest.version);
  logEvent_('Найдено обновление', { было: BOT_VERSION, стало: latest.version });

  return latest;
}

/**
 * Пишет всем разрешённым пользователям: обновление касается всей семьи.
 */
function notifyOwners_(text, keyboard) {
  allowedUserIds_().forEach(function (id) {
    tgSend_(id, text, keyboard);
  });
}

// ---------------------------------------------------------------------------
// Установка обновления
// ---------------------------------------------------------------------------

/**
 * Скачивает свежий код и переписывает им проект.
 *
 * Возвращает {ok, message}. Ошибки объясняются по-человечески: чаще всего
 * дело в выключенном Apps Script API, и человеку нужно знать, куда нажать.
 */
function applyUpdate_() {
  var latest = fetchLatestVersion_();
  if (!latest || !latest.version) {
    return { ok: false, message: 'Не смог получить сведения о новой версии.' };
  }

  var code = fetchUpdateFile_('dist/Код.gs');
  if (!code) {
    return { ok: false, message: 'Не смог скачать новый код с GitHub.' };
  }

  // Проверяем скачанное, прежде чем менять рабочий код: обрыв связи или
  // страница-заглушка вместо файла оставили бы семью без бота
  var declared = (code.match(/var BOT_VERSION = '([^']+)'/) || [])[1];
  if (!declared || declared !== latest.version) {
    return { ok: false, message: 'Скачанный код не той версии — обновление отменил.' };
  }
  if (code.length < 50000 || code.indexOf('function doPost') === -1) {
    return { ok: false, message: 'Скачанный код выглядит неполным — обновление отменил.' };
  }

  var scriptId = ScriptApp.getScriptId();
  var manifest = updatedManifest_(code);
  if (!manifest) {
    return { ok: false, message: 'Не смог прочитать настройки проекта — обновление отменил.' };
  }

  // Точка возврата: версия со старым кодом остаётся в истории Apps Script
  createProjectVersion_(scriptId, 'перед обновлением до ' + latest.version);

  var written = writeProjectContent_(scriptId, code, manifest);
  if (!written.ok) return written;

  // Вебхук исполняет развёрнутую версию, а не последнюю сохранённую,
  // поэтому мало залить код — нужно ещё передвинуть развёртывания
  var version = createProjectVersion_(scriptId, 'обновление до ' + latest.version);
  var moved = version ? updateDeployments_(scriptId, version) : 0;

  logEvent_('Обновление установлено', {
    было: BOT_VERSION, стало: latest.version, развёртываний: moved
  });

  return {
    ok: true,
    version: latest.version,
    deployments: moved,
    message: 'Обновил до ' + latest.version + '.'
  };
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

/**
 * Манифест для обновлённого проекта.
 *
 * Берём новый — в нём могут быть новые разрешения, — но часовой пояс
 * оставляем свой: он у каждой семьи свой и к версии кода отношения не имеет.
 */
function updatedManifest_(code) {
  var fresh = fetchUpdateFile_('dist/appsscript.json');
  if (!fresh) return null;

  try {
    var manifest = JSON.parse(fresh);
    var current = currentProjectFiles_();
    var mine = current ? current.filter(function (file) { return file.name === 'appsscript'; })[0] : null;

    if (mine) {
      var old = JSON.parse(mine.source);
      if (old.timeZone) manifest.timeZone = old.timeZone;
      if (old.webapp) manifest.webapp = old.webapp;
    }

    return JSON.stringify(manifest, null, 2);
  } catch (err) {
    logEvent_('Не разобрался в манифесте', String(err));
    return null;
  }
}

/**
 * Текущее содержимое проекта через Apps Script API.
 */
function currentProjectFiles_() {
  try {
    var response = UrlFetchApp.fetch(SCRIPT_API + ScriptApp.getScriptId() + '/content', {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });
    if (response.getResponseCode() !== 200) return null;
    return JSON.parse(response.getContentText()).files || null;
  } catch (err) {
    return null;
  }
}

/**
 * Заменяет содержимое проекта: один файл кода и манифест.
 *
 * Если код был разложен по нескольким файлам, они схлопнутся в один — на
 * работу это не влияет, Apps Script всё равно склеивает их при запуске.
 */
function writeProjectContent_(scriptId, code, manifest) {
  var payload = {
    files: [
      { name: 'appsscript', type: 'JSON', source: manifest },
      { name: 'Код', type: 'SERVER_JS', source: code }
    ]
  };

  try {
    var response = UrlFetchApp.fetch(SCRIPT_API + scriptId + '/content', {
      method: 'put',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    var code_ = response.getResponseCode();
    if (code_ === 200) return { ok: true };

    var body = response.getContentText();
    logEvent_('Обновление не записалось', { code: code_, body: body.substring(0, 800) });

    if (code_ === 403 && body.indexOf('Apps Script API') !== -1) {
      return {
        ok: false,
        needsApi: true,
        message: 'Apps Script API выключен — без него бот не может обновить сам себя.'
      };
    }
    return { ok: false, message: 'Google отказал при записи кода (' + code_ + ').' };
  } catch (err) {
    logEvent_('Сбой записи обновления', String(err));
    return { ok: false, message: 'Не получилось записать новый код: ' + err };
  }
}

/**
 * Создаёт версию проекта. Возвращает её номер или 0.
 */
function createProjectVersion_(scriptId, description) {
  try {
    var response = UrlFetchApp.fetch(SCRIPT_API + scriptId + '/versions', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      payload: JSON.stringify({ description: description }),
      muteHttpExceptions: true
    });
    if (response.getResponseCode() !== 200) return 0;
    return JSON.parse(response.getContentText()).versionNumber || 0;
  } catch (err) {
    return 0;
  }
}

/**
 * Переводит существующие развёртывания на новую версию.
 * Возвращает, сколько удалось передвинуть.
 */
function updateDeployments_(scriptId, versionNumber) {
  var moved = 0;

  try {
    var list = UrlFetchApp.fetch(SCRIPT_API + scriptId + '/deployments', {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });
    if (list.getResponseCode() !== 200) return 0;

    var deployments = JSON.parse(list.getContentText()).deployments || [];

    deployments.forEach(function (deployment) {
      var config = deployment.deploymentConfig || {};
      // Черновое развёртывание (@HEAD) и так исполняет свежий код
      if (!deployment.deploymentId || config.versionNumber === undefined) return;

      var response = UrlFetchApp.fetch(SCRIPT_API + scriptId + '/deployments/' + deployment.deploymentId, {
        method: 'put',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
        payload: JSON.stringify({
          deploymentConfig: {
            scriptId: scriptId,
            versionNumber: versionNumber,
            manifestFileName: 'appsscript',
            description: config.description || ''
          }
        }),
        muteHttpExceptions: true
      });

      if (response.getResponseCode() === 200) moved++;
      else logEvent_('Развёртывание не обновилось', {
        id: deployment.deploymentId,
        code: response.getResponseCode()
      });
    });
  } catch (err) {
    logEvent_('Сбой обновления развёртываний', String(err));
  }

  return moved;
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

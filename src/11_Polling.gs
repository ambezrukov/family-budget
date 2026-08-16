/**
 * 11_Polling.gs — приём сообщений опросом, без вебхука.
 *
 * Зачем: Apps Script на POST отвечает перенаправлением (302) на
 * script.googleusercontent.com. Браузер за таким перенаправлением идёт, а
 * Telegram — нет: он считает 302 ошибкой и сообщение не доставляет.
 * Поэтому вместо «телеграм стучится к нам» делаем наоборот — «мы раз в минуту
 * спрашиваем телеграм, нет ли нового».
 *
 * Триггер по времени раз в минуту вызывает pollUpdates. Сообщения при этом
 * не теряются: телеграм хранит их до 24 часов и отдаёт все накопившиеся разом.
 */

var PROP_UPDATE_OFFSET = 'TELEGRAM_OFFSET';

/**
 * Один цикл опроса. Вызывается триггером.
 *
 * Пустой запуск занимает около секунды — это важно, потому что суточный
 * бюджет триггеров ограничен, а запусков в сутки 1440.
 */
function pollUpdates() {
  // Два триггера могли наложиться — тогда второй просто пропускает ход,
  // иначе одно и то же сообщение обработается дважды
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;

  try {
    var rounds = 0;

    // Пока сообщения идут, продолжаем забирать их в этом же запуске:
    // человек обычно пишет несколько подряд, и ждать следующей минуты незачем
    while (rounds < 5) {
      var updates = fetchUpdates_();
      if (!updates.length) break;

      updates.forEach(function (update) {
        try {
          handleUpdate_(update);
        } catch (err) {
          logEvent_('Ошибка обработки сообщения', {
            error: String(err),
            stack: err && err.stack ? String(err.stack) : '',
            update: JSON.stringify(update).substring(0, 2000)
          });
        }
        // Сдвигаем указатель сразу после каждого сообщения: если следующее
        // уронит скрипт, обработанное не придёт повторно
        setUpdateOffset_(update.update_id + 1);
      });

      rounds++;
      if (updates.length < 10) break; // забрали всё, что было
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * Забирает порцию новых сообщений.
 */
function fetchUpdates_() {
  var offset = getUpdateOffset_();
  var payload = {
    limit: 10,
    timeout: 0, // без ожидания: длинные соединения съедают суточный лимит
    allowed_updates: ['message', 'callback_query']
  };
  if (offset) payload.offset = offset;

  var data = tgCall_('getUpdates', payload);

  if (!data.ok) {
    // 409 означает, что остался вебхук: telegram не отдаёт сообщения,
    // пока он установлен
    if (data.error_code === 409) {
      logEvent_('Вебхук мешает опросу', 'Запустите функцию switchToPolling — она снимет вебхук');
    }
    return [];
  }

  return data.result || [];
}

function getUpdateOffset_() {
  var raw = scriptProp_(PROP_UPDATE_OFFSET);
  var value = parseInt(raw, 10);
  return isNaN(value) ? 0 : value;
}

function setUpdateOffset_(offset) {
  PropertiesService.getScriptProperties().setProperty(PROP_UPDATE_OFFSET, String(offset));
}

// ---------------------------------------------------------------------------
// Переключение режимов (запускать вручную)
// ---------------------------------------------------------------------------

/**
 * Переводит бота на опрос: снимает вебхук и ставит триггер раз в минуту.
 * Это основной режим работы.
 */
function switchToPolling() {
  // 1. Снимаем вебхук — иначе телеграм не отдаст сообщения опросу.
  //    drop_pending_updates не ставим: накопившиеся сообщения нужны.
  var removed = tgCall_('deleteWebhook', {});

  // 2. Убираем старые триггеры опроса, чтобы не задвоить
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'pollUpdates') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  // 3. Ставим новый
  ScriptApp.newTrigger('pollUpdates')
    .timeBased()
    .everyMinutes(1)
    .create();

  // 4. Сразу забираем всё, что накопилось
  pollUpdates();

  var report = [
    'Бот переведён на опрос.',
    '  Вебхук снят: ' + (removed && removed.ok ? 'да' : 'не потребовалось'),
    '  Триггер: pollUpdates, каждую минуту',
    '',
    'Сообщения приходят с задержкой до минуты — это плата за отказ от вебхука.',
    'Накопившиеся сообщения уже забраны.'
  ].join('\n');

  console.log(report);
  logEvent_('Режим приёма', 'опрос раз в минуту');
  return report;
}

/**
 * Переводит бота на вебхук через посредника: снимает триггер опроса и
 * прописывает в телеграме адрес из свойства WEBHOOK_URL.
 *
 * Прямой адрес Apps Script сюда не годится — телеграм не умеет ходить по
 * перенаправлениям, которыми тот отвечает. Нужен адрес посредника.
 */
function switchToWebhook() {
  var url = scriptProp_('WEBHOOK_URL');
  if (!url) {
    var problem = 'Не задано свойство скрипта WEBHOOK_URL — адрес посредника. ' +
      'Без него телеграму некуда слать сообщения.';
    console.log(problem);
    return problem;
  }

  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'pollUpdates') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  var result = setWebhook(url);
  if (!result || !result.ok) {
    var failed = 'Телеграм не принял адрес вебхука. Ответ: ' + JSON.stringify(result);
    console.log(failed);
    return failed;
  }

  var report = [
    'Бот переведён на вебхук.',
    '  Адрес: ' + url,
    '  Триггер опроса снят.',
    '',
    'Сообщения теперь приходят мгновенно.',
    'Проверить: функция getWebhookInfo — в ответе не должно быть last_error_message.'
  ].join('\n');

  console.log(report);
  logEvent_('Режим приёма', 'вебхук через посредника');
  return report;
}

/**
 * В каком режиме сейчас работает приём сообщений.
 */
function pollingEnabled_() {
  return ScriptApp.getProjectTriggers().some(function (trigger) {
    return trigger.getHandlerFunction() === 'pollUpdates';
  });
}

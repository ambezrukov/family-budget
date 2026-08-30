/**
 * 09_Main.gs — точка входа веб-приложения (вебхук телеграма).
 */

/**
 * Телеграм присылает апдейты POST-запросом на адрес веб-приложения.
 *
 * Правило одно: что бы ни случилось внутри, наружу отдаём 200 OK.
 * Иначе телеграм начнёт повторять доставку одного и того же сообщения.
 */
function doPost(e) {
  RUN_STARTED_ = new Date().getTime();
  try {
    // Необязательная защита адреса: если задано свойство WEBHOOK_SECRET,
    // принимаем только запросы с этим параметром в адресе.
    var secret = scriptProp_(PROP_WEBHOOK_SECRET);
    if (secret) {
      var provided = e && e.parameter ? e.parameter.s : '';
      if (provided !== secret) {
        logEvent_('Запрос с неверным секретом', { provided: String(provided).substring(0, 40) });
        return ContentService.createTextOutput('forbidden');
      }
    }

    if (!e || !e.postData || !e.postData.contents) {
      return ContentService.createTextOutput('no data');
    }

    var body = JSON.parse(e.postData.contents);

    // Запрос от мини-приложения, а не сообщение от телеграма
    var mode = e.parameter ? e.parameter.mode : '';
    if (mode === 'data' || mode === 'delete' || mode === 'restore') {
      var answer = mode === 'data' ? handleMiniAppRequest_(body)
        : mode === 'delete' ? handleMiniAppDelete_(body)
        : handleMiniAppRestore_(body);
      return ContentService
        .createTextOutput(JSON.stringify(answer))
        .setMimeType(ContentService.MimeType.JSON);
    }

    handleUpdate_(body);
  } catch (err) {
    logEvent_('Необработанная ошибка', {
      error: String(err),
      stack: err && err.stack ? String(err.stack) : '',
      body: e && e.postData ? String(e.postData.contents).substring(0, 3000) : ''
    });
  }
  return ContentService.createTextOutput('ok');
}

/**
 * GET-запрос нужен только для проверки, что веб-приложение развёрнуто.
 */
function doGet() {
  return ContentService.createTextOutput('Бот учёта расходов работает. ' + formatDateTime_(new Date()));
}

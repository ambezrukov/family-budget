/**
 * 02_Telegram.gs — тонкий слой над Telegram Bot API.
 * Здесь только транспорт: отправка сообщений, кнопки, скачивание файлов.
 */

function tgApiUrl_(method) {
  return 'https://api.telegram.org/bot' + getBotToken_() + '/' + method;
}

/**
 * Вызов метода Bot API. Ошибки не бросаем наружу — телеграм может ответить
 * отказом (например, чат заблокирован), но обработку сообщения это ронять
 * не должно: расход уже записан.
 */
function tgCall_(method, payload) {
  try {
    var response = UrlFetchApp.fetch(tgApiUrl_(method), {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload || {}),
      muteHttpExceptions: true
    });
    var text = response.getContentText();
    var data = JSON.parse(text);
    if (!data.ok) {
      logEvent_('Ошибка Telegram API', { method: method, response: text });
    }
    return data;
  } catch (err) {
    logEvent_('Сбой запроса к Telegram', { method: method, error: String(err) });
    return { ok: false };
  }
}

/**
 * Отправка текста. Разметка HTML, лишние теги в тексте экранируем заранее.
 */
function tgSend_(chatId, text, keyboard) {
  var payload = {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
  return tgCall_('sendMessage', payload);
}

function tgEditText_(chatId, messageId, text, keyboard) {
  var payload = {
    chat_id: chatId,
    message_id: messageId,
    text: text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
  return tgCall_('editMessageText', payload);
}

function tgEditKeyboard_(chatId, messageId, keyboard) {
  return tgCall_('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: keyboard || [] }
  });
}

/**
 * Ответ на нажатие инлайн-кнопки: убирает «часики» на кнопке.
 */
function tgAnswerCallback_(callbackId, text) {
  return tgCall_('answerCallbackQuery', {
    callback_query_id: callbackId,
    text: text || '',
    show_alert: false
  });
}

/**
 * Отправка файла. Нужна, чтобы прислать новый код бота прямо в чат:
 * человеку остаётся открыть его и вставить в редактор.
 */
function tgSendDocument_(chatId, blob, caption) {
  try {
    var response = UrlFetchApp.fetch(tgApiUrl_('sendDocument'), {
      method: 'post',
      payload: {
        chat_id: String(chatId),
        caption: String(caption || '').substring(0, 1000),
        parse_mode: 'HTML',
        document: blob
      },
      muteHttpExceptions: true
    });

    var data = JSON.parse(response.getContentText());
    if (!data.ok) logEvent_('Файл не отправился', { response: response.getContentText().substring(0, 500) });
    return data;
  } catch (err) {
    logEvent_('Сбой отправки файла', String(err));
    return { ok: false };
  }
}

function tgSendChatAction_(chatId, action) {
  return tgCall_('sendChatAction', { chat_id: chatId, action: action || 'typing' });
}

// ---------------------------------------------------------------------------
// Файлы
// ---------------------------------------------------------------------------

/**
 * Путь к файлу на серверах телеграма (метод getFile).
 */
function tgGetFilePath_(fileId) {
  var data = tgCall_('getFile', { file_id: fileId });
  if (!data.ok || !data.result || !data.result.file_path) return null;
  return data.result.file_path;
}

/**
 * Скачивает файл телеграма и возвращает {bytes, mimeType, url, sizeBytes}.
 * Возвращает null, если скачать не удалось или файл слишком велик.
 */
function tgDownloadFile_(fileId) {
  var path = tgGetFilePath_(fileId);
  if (!path) return null;
  var url = 'https://api.telegram.org/file/bot' + getBotToken_() + '/' + path;
  try {
    var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) {
      logEvent_('Не удалось скачать файл', { fileId: fileId, code: response.getResponseCode() });
      return null;
    }
    var blob = response.getBlob();
    var bytes = blob.getBytes();
    if (bytes.length > MAX_FILE_BYTES) {
      logEvent_('Файл слишком большой', { fileId: fileId, size: bytes.length });
      return null;
    }
    return {
      blob: blob,
      base64: Utilities.base64Encode(bytes),
      mimeType: guessMimeType_(path, blob.getContentType()),
      path: path,
      sizeBytes: bytes.length
    };
  } catch (err) {
    logEvent_('Сбой скачивания файла', { fileId: fileId, error: String(err) });
    return null;
  }
}

/**
 * Телеграм не всегда отдаёт вменяемый content-type, поэтому смотрим ещё
 * и на расширение.
 */
function guessMimeType_(path, fallback) {
  var lower = String(path).toLowerCase();
  if (/\.ogg$/.test(lower) || /\.oga$/.test(lower)) return 'audio/ogg';
  if (/\.mp3$/.test(lower)) return 'audio/mp3';
  if (/\.m4a$/.test(lower)) return 'audio/mp4';
  if (/\.wav$/.test(lower)) return 'audio/wav';
  if (/\.jpg$/.test(lower) || /\.jpeg$/.test(lower)) return 'image/jpeg';
  if (/\.png$/.test(lower)) return 'image/png';
  if (/\.webp$/.test(lower)) return 'image/webp';
  if (/\.heic$/.test(lower)) return 'image/heic';
  if (/\.pdf$/.test(lower)) return 'application/pdf';
  return fallback || 'application/octet-stream';
}

/**
 * Ссылка на файл для таблицы. Прямой URL телеграма содержит токен бота, поэтому
 * в таблицу его писать нельзя — сохраняем file_id, по которому файл всегда
 * можно достать повторно.
 */
function fileReference_(fileId) {
  return fileId ? 'tg:' + fileId : '';
}

// ---------------------------------------------------------------------------
// Установка вебхука (запускается вручную из редактора)
// ---------------------------------------------------------------------------

/**
 * Ставит вебхук.
 *
 * Адрес берётся из свойства WEBHOOK_URL — это адрес посредника, а не самого
 * Apps Script: на прямой адрес телеграм ходить не умеет, потому что Apps Script
 * отвечает перенаправлением. Если WEBHOOK_URL не задан, пробуем WEBAPP_URL.
 *
 * Секретное слово из WEBHOOK_SECRET передаём телеграму: он будет присылать его
 * заголовком в каждом запросе, а посредник — проверять. Так на адрес посредника
 * не пройдёт чужой запрос.
 */
function setWebhook(webhookUrl) {
  var url = webhookUrl || scriptProp_('WEBHOOK_URL') || scriptProp_('WEBAPP_URL');
  if (!url) {
    throw new Error('Не задан адрес вебхука. Пропишите свойство скрипта WEBHOOK_URL ' +
      '(адрес посредника) или передайте адрес параметром.');
  }

  var payload = {
    url: url,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: false // накопившиеся сообщения нужны
  };

  var secret = scriptProp_(PROP_WEBHOOK_SECRET);
  if (secret) payload.secret_token = secret;

  var result = tgCall_('setWebhook', payload);
  console.log(JSON.stringify(result));
  return result;
}

function deleteWebhook() {
  var result = tgCall_('deleteWebhook', { drop_pending_updates: true });
  console.log(JSON.stringify(result));
  return result;
}

function getWebhookInfo() {
  var result = tgCall_('getWebhookInfo', {});
  console.log(JSON.stringify(result));
  return result;
}

/**
 * Прописывает боту список команд — они появятся в меню телеграма.
 */
function setBotCommands() {
  var result = tgCall_('setMyCommands', {
    commands: [
      { command: 'mesyac', description: 'Расходы за текущий месяц по категориям' },
      { command: 'poslednie', description: 'Последние 10 записей' },
      { command: 'segodnya', description: 'Сумма за сегодня' },
      { command: 'dohody', description: 'Доходы за месяц и остаток' },
      { command: 'otchet', description: 'Отчёт за прошлый месяц' },
      { command: 'spravka', description: 'Как вводить расходы' },
      { command: 'imya', description: 'Как подписывать меня в таблице' },
      { command: 'avtory', description: 'Свести имена авторов' },
      { command: 'whoami', description: 'Показать мой телеграм-айди' }
    ]
  });
  console.log(JSON.stringify(result));
  return result;
}

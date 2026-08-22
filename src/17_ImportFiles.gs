/**
 * 17_ImportFiles.gs — как выписка попадает к боту.
 *
 * Два пути, оба нужны: файл в чат (быстро, с телефона) и папка на Google
 * Диске рядом с таблицей (удобно, когда за раз выгружено четыре файла).
 *
 * Excel скрипт сам читать не умеет, поэтому файл заливается на Диск с
 * просьбой преобразовать его в Google Таблицу, читается — и копия удаляется.
 * Для этого у скрипта есть права: читать файлы Диска и создавать свои.
 */

var DRIVE_FILES_API_ = 'https://www.googleapis.com/drive/v3/files';
var DRIVE_UPLOAD_API_ = 'https://www.googleapis.com/upload/drive/v3/files';

function driveRequest_(url, options) {
  var params = options || {};
  params.muteHttpExceptions = true;
  params.headers = params.headers || {};
  params.headers.Authorization = 'Bearer ' + ScriptApp.getOAuthToken();
  return UrlFetchApp.fetch(url, params);
}

/**
 * Строки из CSV: кодировка бывает и UTF-8 с меткой, и ивритская windows-1255.
 */
function rowsFromCsv_(blob) {
  var text = '';
  try {
    text = blob.getDataAsString('UTF-8');
    // Признак того, что файл на самом деле в другой кодировке: вместо букв
    // приходят символы замены
    if (text.indexOf('�') !== -1) text = blob.getDataAsString('windows-1255');
  } catch (err) {
    text = blob.getDataAsString();
  }
  text = text.replace(/^﻿/, '');
  return Utilities.parseCsv(text);
}

/**
 * Строки из Excel — через временную копию в виде Google Таблицы.
 */
function rowsFromExcel_(blob, fileName) {
  var metadata = { name: 'Разбор выписки ' + (fileName || ''), mimeType: MimeType.GOOGLE_SHEETS };
  var boundary = '-----statement' + new Date().getTime();

  var payload = Utilities.newBlob(
    '--' + boundary + '\r\n' +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) + '\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Type: ' + (blob.getContentType() || 'application/octet-stream') + '\r\n\r\n'
  ).getBytes()
    .concat(blob.getBytes())
    .concat(Utilities.newBlob('\r\n--' + boundary + '--\r\n').getBytes());

  var response = driveRequest_(DRIVE_UPLOAD_API_ + '?uploadType=multipart&supportsAllDrives=true', {
    method: 'post',
    contentType: 'multipart/related; boundary=' + boundary,
    payload: payload
  });

  if (response.getResponseCode() !== 200) {
    logEvent_('Excel не преобразовался', {
      файл: fileName, код: response.getResponseCode(),
      ответ: response.getContentText().substring(0, 500)
    });
    return null;
  }

  var id = JSON.parse(response.getContentText()).id;
  try {
    var sheet = SpreadsheetApp.openById(id).getSheets()[0];
    return sheet.getDataRange().getValues();
  } finally {
    // Временная копия нужна была ровно на один разбор
    driveRequest_(DRIVE_FILES_API_ + '/' + id, { method: 'delete' });
  }
}

/**
 * Разбирает файл любого из поддерживаемых видов.
 */
function rowsFromStatementBlob_(blob, fileName) {
  var name = String(fileName || '').toLowerCase();
  var type = String(blob.getContentType() || '').toLowerCase();

  if (name.indexOf('.csv') !== -1 || type.indexOf('csv') !== -1) return rowsFromCsv_(blob);
  if (/\.xlsx?$/.test(name) || type.indexOf('spreadsheet') !== -1 || type.indexOf('excel') !== -1) {
    return rowsFromExcel_(blob, fileName);
  }
  return null;
}

/**
 * Похоже ли присланное на выписку. Чек и выписка приходят одинаково —
 * документом, поэтому решаем по расширению.
 */
function looksLikeStatement_(fileName, mimeType) {
  var name = String(fileName || '').toLowerCase();
  var type = String(mimeType || '').toLowerCase();
  return /\.(csv|xlsx|xls)$/.test(name) ||
    type.indexOf('csv') !== -1 || type.indexOf('excel') !== -1 || type.indexOf('spreadsheet') !== -1;
}

/**
 * Выписка, присланная файлом в чат.
 */
function handleStatementDocument_(message, document) {
  var chatId = message.chat.id;
  var fileName = String(document.file_name || 'выписка');

  tgSendChatAction_(chatId, 'typing');
  var file = tgDownloadFile_(document.file_id);
  if (!file) {
    tgSend_(chatId, 'Не смог забрать файл. Пришлите ещё раз или положите его в папку «Выписки» на Диске.');
    return;
  }

  var rows;
  try {
    rows = rowsFromStatementBlob_(file.blob.setName(fileName), fileName);
  } catch (err) {
    logEvent_('Сбой чтения выписки', { файл: fileName, ошибка: String(err) });
    rows = null;
  }

  if (!rows || !rows.length) {
    tgSend_(chatId, 'Не смог прочитать файл. Excel я читаю через Google Диск — ' +
      'если бот ещё не получил к нему доступ, выгрузите выписку в CSV или запустите ' +
      'в редакторе скрипта функцию <code>authorizeDrive</code>.');
    return;
  }

  var result = importStatementRows_(rows, fileName, 'tg:' + document.file_id);
  tgSend_(chatId, importReportText_(fileName, result));
  if (result.ok && result.stats.added) offerMergeCandidates_(chatId);
}

/**
 * Папка «Выписки» рядом с таблицей: бот сам находит её по расположению
 * таблицы, чтобы не заводить ещё один идентификатор в настройках.
 */
function statementsFolder_() {
  var folderName = String(setting_('Папка выписок', 'Выписки')).trim() || 'Выписки';
  var spreadsheetId = getSpreadsheet_().getId();

  var meta = driveRequest_(DRIVE_FILES_API_ + '/' + spreadsheetId +
    '?fields=parents&supportsAllDrives=true', {});
  if (meta.getResponseCode() !== 200) return { error: 'Нет доступа к Диску' };

  var parents = JSON.parse(meta.getContentText()).parents || [];
  if (!parents.length) return { error: 'Не понял, в какой папке лежит таблица' };

  var query = "name='" + folderName.replace(/'/g, "\\'") + "' and '" + parents[0] +
    "' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false";
  var found = driveRequest_(DRIVE_FILES_API_ + '?q=' + encodeURIComponent(query) +
    '&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true', {});
  if (found.getResponseCode() !== 200) return { error: 'Не удалось найти папку' };

  var files = JSON.parse(found.getContentText()).files || [];
  if (!files.length) return { error: 'Папки «' + folderName + '» рядом с таблицей нет', parent: parents[0] };
  return { id: files[0].id, name: files[0].name };
}

/**
 * Уже разобранные файлы: помним ключ (идентификатор Диска), чтобы повторный
 * запуск команды не пересчитывал то же самое.
 */
function importedFileKeys_() {
  var journal = ensureSheet_(SHEET_IMPORTS, IMPORT_COLUMNS);
  var last = journal.getLastRow();
  var keys = {};
  if (last < 2) return keys;
  journal.getRange(2, 9, last - 1, 1).getValues().forEach(function (row) {
    if (row[0]) keys[String(row[0])] = true;
  });
  return keys;
}

/**
 * Команда /импорт: разбирает всё новое из папки «Выписки».
 */
function importFromFolder_(chatId) {
  var folder = statementsFolder_();
  if (folder.error) {
    tgSend_(chatId, 'Папку с выписками не нашёл: ' + escapeHtml_(folder.error) + '.\n' +
      'Создайте её рядом с таблицей бюджета — или просто пришлите файл сюда, в чат.');
    return;
  }

  var query = "'" + folder.id + "' in parents and trashed=false";
  var response = driveRequest_(DRIVE_FILES_API_ + '?q=' + encodeURIComponent(query) +
    '&fields=files(id,name,mimeType,modifiedTime,md5Checksum)&orderBy=name' +
    '&supportsAllDrives=true&includeItemsFromAllDrives=true', {});
  if (response.getResponseCode() !== 200) {
    tgSend_(chatId, 'Не смог заглянуть в папку «' + escapeHtml_(folder.name) + '».');
    return;
  }

  var files = JSON.parse(response.getContentText()).files || [];
  var done = importedFileKeys_();
  var fresh = files.filter(function (file) {
    return looksLikeStatement_(file.name, file.mimeType) &&
      !done['drive:' + (file.md5Checksum || file.id)];
  });

  if (!fresh.length) {
    tgSend_(chatId, files.length
      ? 'В папке «' + escapeHtml_(folder.name) + '» всё уже разобрано.'
      : 'Папка «' + escapeHtml_(folder.name) + '» пуста.');
    return;
  }

  tgSend_(chatId, 'Разбираю файлов: ' + fresh.length + '…');

  var added = 0;
  fresh.forEach(function (file) {
    var content = driveRequest_(DRIVE_FILES_API_ + '/' + file.id + '?alt=media', {});
    if (content.getResponseCode() !== 200) {
      tgSend_(chatId, '<b>' + escapeHtml_(file.name) + '</b>\nНе смог скачать файл с Диска.');
      return;
    }

    var rows;
    try {
      rows = rowsFromStatementBlob_(content.getBlob().setName(file.name), file.name);
    } catch (err) {
      logEvent_('Сбой чтения выписки с Диска', { файл: file.name, ошибка: String(err) });
      rows = null;
    }

    if (!rows || !rows.length) {
      tgSend_(chatId, '<b>' + escapeHtml_(file.name) + '</b>\nНе смог прочитать файл.');
      return;
    }

    var result = importStatementRows_(rows, file.name, 'drive:' + (file.md5Checksum || file.id));
    if (result.ok) added += result.stats.added;
    tgSend_(chatId, importReportText_(file.name, result));
  });

  if (added) offerMergeCandidates_(chatId);
}

/**
 * Разрешение на Диск запрашивается один раз: функция ничего не делает,
 * кроме обращения к Диску, зато после её запуска в редакторе появляется
 * окно «Разрешить», и дальше бот работает сам.
 */
function authorizeDrive() {
  var lines = [];

  // Права смотрим у самого Google: манифест может обещать что угодно, а
  // значение имеет только то, что человек действительно разрешил в окне согласия
  var scopes = '';
  try {
    var info = UrlFetchApp.fetch(
      'https://oauth2.googleapis.com/tokeninfo?access_token=' +
      encodeURIComponent(ScriptApp.getOAuthToken()),
      { muteHttpExceptions: true }
    );
    scopes = info.getResponseCode() === 200
      ? String(JSON.parse(info.getContentText()).scope || '')
      : 'не удалось спросить (' + info.getResponseCode() + ')';
  } catch (err) {
    scopes = 'ошибка: ' + err;
  }

  lines.push('Права токена: ' + scopes);
  lines.push('Право читать Диск: ' + (scopes.indexOf('drive') !== -1 ? 'есть' : 'НЕТ'));

  var spreadsheetId = getSpreadsheet_().getId();
  var probe = driveRequest_(DRIVE_FILES_API_ + '/' + spreadsheetId +
    '?fields=name,parents&supportsAllDrives=true', {});
  lines.push('Ответ Диска на запрос о таблице: ' + probe.getResponseCode());
  if (probe.getResponseCode() !== 200) {
    lines.push('Что ответил Google: ' + probe.getContentText().substring(0, 300));
  } else {
    var data = JSON.parse(probe.getContentText());
    lines.push('Таблица: ' + data.name + ', папок-родителей: ' + ((data.parents || []).length));

    var folder = statementsFolder_();
    lines.push(folder.error ? 'Папка выписок: ' + folder.error : 'Папка выписок найдена: ' + folder.name);
  }

  var message = lines.join('\n');
  console.log(message);
  return message;
}

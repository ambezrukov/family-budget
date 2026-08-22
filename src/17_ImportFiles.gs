/**
 * 17_ImportFiles.gs — как выписка попадает к боту.
 *
 * Два пути, оба нужны: файл в чат (быстро, с телефона) и папка на Google
 * Диске рядом с таблицей (удобно, когда за раз выгружено четыре файла).
 *
 * Excel бот разбирает сам (см. 20_Xlsx.gs), поэтому для файла из чата Диск
 * не нужен вовсе. Доступ к Диску нужен только для второго пути — забрать
 * файлы из папки «Выписки», и берётся он встроенным сервисом DriveApp.
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
  return parseCsvRows_(text.replace(/^﻿/, ''));
}

/**
 * Свой разбор CSV вместо Utilities.parseCsv.
 *
 * Причина простая: выписка Hapoalim содержит поля вроде «אורגד ש.נ בע"מ» —
 * двойная кавычка стоит посреди незакавыченного поля. Строгий разборщик
 * считает её началом закавыченного текста и склеивает строки: 22.08.2026 из
 * выписки на 42 операции бот прочитал ровно половину, а вторая половина —
 * все свежие августовские строки — молча пропала.
 *
 * Правило здесь мягче: кавычка что-то значит, только если поле с неё
 * начинается. В середине слова это обычный символ, чем она и является.
 */
function parseCsvRows_(text) {
  var rows = [];
  var row = [];
  var field = '';
  var quoted = false;
  var atFieldStart = true;
  var NEWLINE = String.fromCharCode(10);
  var RETURN = String.fromCharCode(13);

  for (var i = 0; i < text.length; i++) {
    var ch = text.charAt(i);

    if (quoted) {
      if (ch === '"') {
        if (text.charAt(i + 1) === '"') { field += '"'; i++; }
        else quoted = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && atFieldStart) { quoted = true; atFieldStart = false; continue; }

    if (ch === ',') {
      row.push(field.trim());
      field = '';
      atFieldStart = true;
      continue;
    }

    if (ch === NEWLINE || ch === RETURN) {
      if (ch === RETURN && text.charAt(i + 1) === NEWLINE) i++;
      row.push(field.trim());
      // Пустые строки между блоками выписки пропускаем
      if (row.join('')) rows.push(row);
      row = [];
      field = '';
      atFieldStart = true;
      continue;
    }

    field += ch;
    atFieldStart = false;
  }

  row.push(field.trim());
  if (row.join('')) rows.push(row);

  return rows;
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
    // Свой разбор архива — основной путь: он не зависит ни от прав на Диск,
    // ни от того, включён ли Drive API в проекте скрипта
    try {
      var rows = xlsxRows_(blob);
      if (rows && rows.length) return rows;
    } catch (err) {
      logEvent_('Не разобрал Excel своими силами', { файл: fileName, ошибка: String(err) });
    }
    return rowsFromExcel_(blob, fileName); // запасной путь через Диск
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

  // Разбор большой выписки занимает секунды, и всё это время человек смотрит
  // в пустой чат. Лучше сразу сказать, что файл взят в работу
  tgSendChatAction_(chatId, 'typing');
  tgSend_(chatId, 'Взял <b>' + escapeHtml_(fileName) + '</b>, читаю…');

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
    tgSend_(chatId, 'Не смог прочитать файл: не нашёл в нём таблицы с данными. ' +
      'Проверьте, что это выгрузка операций, а не сводка или PDF, — ' +
      'или пришлите её в CSV.');
    return;
  }

  var result = importStatementRows_(rows, fileName, 'tg:' + document.file_id);
  tgSend_(chatId, importReportText_(fileName, result));
  if (result.ok && result.stats.added) {
    offerIncomeCandidates_(chatId);
    offerMergeCandidates_(chatId);
  }
}

/**
 * Папка «Выписки» рядом с таблицей: бот сам находит её по расположению
 * таблицы, чтобы не заводить ещё один идентификатор в настройках.
 */
function statementsFolder_() {
  var folderName = String(setting_('Папка выписок', 'Выписки')).trim() || 'Выписки';

  // DriveApp — встроенный сервис Apps Script: в отличие от обращения к
  // Drive API напрямую, он работает без включения этого API в консоли Google
  try {
    var parents = DriveApp.getFileById(getSpreadsheet_().getId()).getParents();
    if (!parents.hasNext()) return { error: 'Не понял, в какой папке лежит таблица' };

    var parent = parents.next();
    var folders = parent.getFoldersByName(folderName);
    if (!folders.hasNext()) {
      return { error: 'Папки «' + folderName + '» рядом с таблицей нет' };
    }

    var folder = folders.next();
    return { folder: folder, id: folder.getId(), name: folder.getName() };
  } catch (err) {
    logEvent_('Диск недоступен', String(err));
    return { error: 'Нет доступа к Диску: ' + err };
  }
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

  var done = importedFileKeys_();
  var fresh = [];
  var files = folder.folder.getFiles();

  while (files.hasNext()) {
    var file = files.next();
    if (!looksLikeStatement_(file.getName(), file.getMimeType())) continue;
    // Ключ учитывает время правки: обновлённый файл разбираем заново, а
    // повторы всё равно отсеются на уровне отдельных операций
    var key = 'drive:' + file.getId() + ':' + file.getLastUpdated().getTime();
    if (done[key]) continue;
    fresh.push({ file: file, key: key });
  }

  if (!fresh.length) {
    tgSend_(chatId, 'В папке «' + escapeHtml_(folder.name) + '» нового нет.');
    return;
  }

  tgSend_(chatId, 'Разбираю файлов: ' + fresh.length + '…');

  var added = 0;
  fresh.forEach(function (item) {
    var name = item.file.getName();
    var rows;
    try {
      rows = rowsFromStatementBlob_(item.file.getBlob(), name);
    } catch (err) {
      logEvent_('Сбой чтения выписки с Диска', { файл: name, ошибка: String(err) });
      rows = null;
    }

    if (!rows || !rows.length) {
      tgSend_(chatId, '<b>' + escapeHtml_(name) + '</b>\nНе смог прочитать файл.');
      return;
    }

    var result = importStatementRows_(rows, name, item.key);
    if (result.ok) added += result.stats.added;
    tgSend_(chatId, importReportText_(name, result));
  });

  if (added) {
    offerIncomeCandidates_(chatId);
    offerMergeCandidates_(chatId);
  }
}

/**
 * Разрешение на Диск запрашивается один раз: функция ничего не делает,
 * кроме обращения к Диску, зато после её запуска в редакторе появляется
 * окно «Разрешить», и дальше бот работает сам.
 */
function authorizeDrive() {
  var lines = [];

  lines.push('Excel бот читает сам, без Диска — для файлов из чата доступ не нужен.');

  try {
    var parents = DriveApp.getFileById(getSpreadsheet_().getId()).getParents();
    lines.push('Доступ к Диску: есть');
    lines.push(parents.hasNext()
      ? 'Таблица лежит в папке: ' + parents.next().getName()
      : 'Таблица не лежит ни в одной папке');
  } catch (err) {
    lines.push('Доступ к Диску: НЕТ (' + err + ')');
  }

  var folder = statementsFolder_();
  lines.push(folder.error ? 'Папка выписок: ' + folder.error : 'Папка выписок найдена: ' + folder.name);

  var message = lines.join('\n');
  console.log(message);
  return message;
}

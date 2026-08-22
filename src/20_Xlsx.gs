/**
 * 20_Xlsx.gs — чтение файлов Excel без Google Диска.
 *
 * Почему свой разбор: обычный путь — залить файл на Диск с просьбой
 * преобразовать его в таблицу — упирается в то, что Drive API в проекте
 * скрипта выключен, а включать его нужно руками в консоли Google Cloud.
 * Для семейного бота это лишний барьер.
 *
 * Файл .xlsx — это zip-архив с XML внутри, а Apps Script умеет и
 * распаковывать (Utilities.unzip), и читать текст. Нам нужны два файла из
 * архива: лист с ячейками и словарь строк, на который лист ссылается
 * номерами вместо самих слов.
 */

/**
 * Достаёт из архива нужные части. Возвращает {sheet, shared} — тексты XML.
 */
function xlsxParts_(blob) {
  var files = Utilities.unzip(blob.setContentType('application/zip'));
  var parts = { sheet: '', shared: '', sheetName: '' };

  files.forEach(function (file) {
    var name = String(file.getName() || '');
    if (name.indexOf('xl/sharedStrings.xml') !== -1) {
      parts.shared = file.getDataAsString('UTF-8');
    } else if (/xl\/worksheets\/sheet\d+\.xml$/.test(name)) {
      // Берём первый лист по порядку: у всех наших выгрузок он единственный
      // либо главный, а остальные — пустые «גיליון2», «גיליון3»
      if (!parts.sheet || name < parts.sheetName) {
        parts.sheet = file.getDataAsString('UTF-8');
        parts.sheetName = name;
      }
    }
  });

  return parts;
}

/**
 * Разворачивает XML-экранирование: в ячейках попадаются кавычки и амперсанды.
 */
function xmlUnescape_(text) {
  return String(text == null ? '' : text)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, function (match, code) { return String.fromCharCode(Number(code)); })
    .replace(/&amp;/g, '&');
}

/**
 * Словарь строк: лист хранит не сами слова, а их номера в этом списке.
 */
function xlsxSharedStrings_(xml) {
  if (!xml) return [];
  // Выгрузки Isracard подписывают теги пространством имён — «<x:si>» вместо
  // «<si>», поэтому приставку всюду считаем необязательной
  var items = xml.match(/<(?:\w+:)?si[\s>][\s\S]*?<\/(?:\w+:)?si>|<(?:\w+:)?si\/>/g) || [];

  return items.map(function (item) {
    // Внутри одной ячейки текст бывает разбит на куски с разным оформлением
    var pieces = item.match(/<(?:\w+:)?t[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g) || [];
    return pieces.map(function (piece) {
      return xmlUnescape_(piece.replace(/<(?:\w+:)?t[^>]*>/, '').replace(/<\/(?:\w+:)?t>/, ''));
    }).join('');
  });
}

/**
 * Буквенный адрес столбца («AB») в его номер.
 */
function xlsxColumnNumber_(reference) {
  var letters = String(reference || '').replace(/\d+/g, '').toUpperCase();
  var number = 0;
  for (var i = 0; i < letters.length; i++) {
    number = number * 26 + (letters.charCodeAt(i) - 64);
  }
  return number;
}

/**
 * Строки листа как массив массивов — в том же виде, в каком их отдаёт
 * getDataRange().getValues() у обычной таблицы.
 */
function xlsxRowsFromParts_(sheetXml, sharedXml) {
  if (!sheetXml) return [];
  var shared = xlsxSharedStrings_(sharedXml);
  var rows = [];

  var rowMatches = sheetXml.match(
    /<(?:\w+:)?row[\s>][\s\S]*?<\/(?:\w+:)?row>|<(?:\w+:)?row[^>]*\/>/g) || [];

  rowMatches.forEach(function (rowXml) {
    var cells = rowXml.match(
      /<(?:\w+:)?c[\s>][\s\S]*?<\/(?:\w+:)?c>|<(?:\w+:)?c[^>]*\/>/g) || [];
    var line = [];

    cells.forEach(function (cellXml) {
      var reference = (cellXml.match(/\sr="([A-Z]+\d+)"/) || [])[1] || '';
      var type = (cellXml.match(/\st="([^"]+)"/) || [])[1] || '';
      var column = reference ? xlsxColumnNumber_(reference) : line.length + 1;

      var value = '';
      if (type === 'inlineStr') {
        var inline = cellXml.match(/<(?:\w+:)?t[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/);
        value = inline ? xmlUnescape_(inline[1]) : '';
      } else {
        var raw = cellXml.match(/<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/);
        var text = raw ? xmlUnescape_(raw[1]) : '';
        if (type === 's') {
          value = shared[Number(text)] === undefined ? '' : shared[Number(text)];
        } else if (text === '') {
          value = '';
        } else {
          var number = Number(text);
          value = isNaN(number) ? text : number;
        }
      }

      while (line.length < column - 1) line.push('');
      line[column - 1] = value;
    });

    rows.push(line);
  });

  return rows;
}

/**
 * Полный путь: файл Excel → строки.
 */
function xlsxRows_(blob) {
  var parts = xlsxParts_(blob);
  return xlsxRowsFromParts_(parts.sheet, parts.shared);
}

/**
 * Даты Excel хранит числом: сколько дней прошло с 30 декабря 1899 года.
 * Отдельная функция, потому что применять её можно только к тем столбцам,
 * про которые мы точно знаем, что там дата, — иначе сумма 45 000 ₪
 * превратится в 2023 год.
 */
function excelSerialToDate_(serial) {
  var number = Number(serial);
  if (!number || number < 20000 || number > 80000) return null; // 1954–2119
  var days = Math.floor(number);
  var base = new Date(1899, 11, 30);
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + days);
}

/**
 * 16_Import.gs — разбор выписок банка и карточных компаний.
 *
 * Устройство простое: файл превращается в таблицу строк, по названиям
 * столбцов узнаётся источник, строки раскладываются в лист «Операции».
 *
 * Почему ищем строку заголовков, а не читаем с фиксированной позиции: у всех
 * четырёх источников сверху лежит шапка своей высоты, и она меняется от
 * выгрузки к выгрузке (месяц, имя владельца, итог). Названия столбцов при
 * этом устойчивы.
 */

// Названия столбцов, по которым узнаём источник. Иврит взят прямо из выгрузок.
var STATEMENT_FORMATS_ = [
  {
    source: 'Isracard',
    marker: ['מס\' שובר'],
    columns: {
      date: ['תאריך רכישה'],
      merchant: ['שם בית עסק'],
      amount: ['סכום חיוב'],
      currency: ['מטבע חיוב'],
      originalAmount: ['סכום עסקה'],
      originalCurrency: ['מטבע עסקה'],
      voucher: ['מס\' שובר'],
      note: ['פירוט נוסף']
    }
  },
  {
    source: 'Max',
    marker: ['4 ספרות אחרונות'],
    columns: {
      date: ['תאריך עסקה'],
      merchant: ['שם בית העסק'],
      category: ['קטגוריה'],
      card: ['4 ספרות אחרונות'],
      kind: ['סוג עסקה'],
      amount: ['סכום חיוב'],
      currency: ['מטבע חיוב'],
      originalAmount: ['סכום עסקה מקורי'],
      originalCurrency: ['מטבע עסקה מקורי'],
      chargeDate: ['תאריך חיוב'],
      note: ['הערות']
    }
  },
  {
    source: 'Cal',
    marker: ['תאריך עסקה', 'שם בית העסק'],
    columns: {
      date: ['תאריך עסקה'],
      merchant: ['שם בית העסק', 'שם בית עסק'],
      amount: ['סכום חיוב', 'סכום החיוב'],
      currency: ['מטבע חיוב', 'מטבע'],
      originalAmount: ['סכום עסקה מקורי', 'סכום עסקה'],
      originalCurrency: ['מטבע עסקה מקורי', 'מטבע עסקה'],
      chargeDate: ['תאריך חיוב', 'מועד חיוב'],
      card: ['4 ספרות אחרונות', 'מספר כרטיס'],
      kind: ['סוג עסקה'],
      note: ['הערות', 'פירוט נוסף']
    }
  },
  {
    source: 'Банк',
    marker: ['חובה', 'זכות'],
    columns: {
      date: ['תאריך'],
      operation: ['הפעולה', 'תיאור הפעולה'],
      details: ['פרטים'],
      reference: ['אסמכתא'],
      debit: ['חובה'],
      credit: ['זכות'],
      balance: ['יתרה בש\'\'ח', 'יתרה לאחר פעולה'],
      valueDate: ['תאריך ערך'],
      payee: ['לטובת'],
      purpose: ['עבור']
    }
  }
];

/**
 * Ищет строку заголовков и определяет источник.
 * Возвращает {source, headerRow, index: {поле: номер столбца}} или null.
 */
function detectStatementFormat_(rows) {
  var limit = Math.min(rows.length, 30); // шапка ни у кого не длиннее

  for (var r = 0; r < limit; r++) {
    var cells = (rows[r] || []).map(function (cell) { return String(cell == null ? '' : cell).trim(); });
    if (!cells.join('')) continue;

    for (var f = 0; f < STATEMENT_FORMATS_.length; f++) {
      var format = STATEMENT_FORMATS_[f];
      var hasAll = format.marker.every(function (marker) {
        return cells.some(function (cell) { return cell.indexOf(marker) !== -1; });
      });
      if (!hasAll) continue;

      var index = {};
      Object.keys(format.columns).forEach(function (field) {
        var variants = format.columns[field];
        for (var c = 0; c < cells.length; c++) {
          for (var v = 0; v < variants.length; v++) {
            if (cells[c] && cells[c].indexOf(variants[v]) !== -1 && index[field] === undefined) {
              index[field] = c;
            }
          }
        }
      });

      return { source: format.source, headerRow: r, index: index };
    }
  }
  return null;
}

/**
 * Из шапки Isracard достаём номер карты и дату списания: в самих строках
 * их нет, а без карты непонятно, чья это трата.
 */
function isracardHeaderHints_(rows, headerRow) {
  var hints = { card: '', chargeDay: '' };

  for (var r = 0; r < headerRow; r++) {
    var line = (rows[r] || []).map(function (c) { return String(c == null ? '' : c); }).join(' ');
    // Ищем четыре цифры рядом с названием карты: просто «последние четыре
    // цифры строки» ловят год из заголовка «פירוט עסקאות · יולי 2026»
    var card = line.match(/(?:כרטיס|מסטרקארד|מאסטרקארד|ויזה|דירקט|ישראכרט|גולד)[^\d]{0,12}(\d{4})/);
    if (card && !hints.card && !/^(19|20)\d\d$/.test(card[1])) hints.card = card[1];
    var charge = line.match(/לחיוב\s*ב-?\s*(\d{1,2})[.\/](\d{1,2})/);
    if (charge && !hints.chargeDay) hints.chargeDay = charge[1] + '.' + charge[2];
  }
  return hints;
}

/**
 * Даты в выгрузках бывают тремя видами: настоящая дата (Excel), «11.07.26»
 * (Isracard) и «04-03-2024» (Max). Разбираем все, иначе строка потеряется.
 */
function parseStatementDate_(value) {
  if (!value && value !== 0) return null;
  if (Object.prototype.toString.call(value) === '[object Date]') return value;

  // Из файла Excel, прочитанного без Google Диска, даты приходят числом
  if (typeof value === 'number') return excelSerialToDate_(value);

  var text = String(value).trim();
  if (!text) return null;

  var m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));

  m = text.match(/^(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{2,4})/);
  if (m) {
    var year = Number(m[3]);
    if (year < 100) year += 2000;
    return new Date(year, Number(m[2]) - 1, Number(m[1]));
  }
  return null;
}

/**
 * Числа приходят и числом, и строкой с запятыми и знаком валюты.
 */
function parseStatementNumber_(value) {
  if (typeof value === 'number') return value;
  var text = String(value == null ? '' : value).replace(/[^\d.,\-]/g, '').replace(/,/g, '');
  var number = parseFloat(text);
  return isNaN(number) ? 0 : number;
}

function statementCurrency_(value) {
  var text = String(value == null ? '' : value).trim();
  if (!text) return 'ILS';
  if (text.indexOf('₪') !== -1 || text.indexOf('ש') !== -1 || /ILS|NIS/i.test(text)) return 'ILS';
  if (text.indexOf('$') !== -1 || /USD/i.test(text)) return 'USD';
  if (text.indexOf('€') !== -1 || /EUR/i.test(text)) return 'EUR';
  if (text.indexOf('₽') !== -1 || /RUB/i.test(text)) return 'RUB';
  return text.toUpperCase().substring(0, 3);
}

/**
 * Строка банковской выписки, которой соответствует общее списание по карте:
 * «מסטרקרד», «דירקט», «ויזה כאל» и подобные, а в графе «אסמכתא» — четыре
 * цифры карты. Такую строку считать тратой нельзя: покупки по этой карте
 * уже пришли отдельными строками из выгрузки эмитента.
 */
function isCardSettlement_(operation, reference, knownCards) {
  var text = String(operation || '');
  var digits = String(reference || '').replace(/\D/g, '');

  // Названия, за которыми стоит карточная компания целиком: банк списывает
  // одной строкой всё, что накопилось за месяц. Номера карты в такой строке
  // может и не быть — «כרטיסי אשראי» (кредитные карты) или «מקס איט פיננסי»
  // (расчётный центр Max) говорят сами за себя
  var byIssuer = /כרטיסי אשראי|מקס איט|כאל|ישראכרט|לאומי קארד|דיינרס|אמריקן אקספרס|cal|isracard/i.test(text);
  if (byIssuer) return true;

  // Названия видов карт менее однозначны: «ויזה» встречается и в названии
  // магазина. Здесь требуем ещё и четыре цифры в графе «אסמכתא»
  var byCardName = /מסטרקרד|מסטרקארד|ויזה|דירקט|מקס|max/i.test(text);
  var byCard = digits.length === 4 && knownCards.indexOf(digits) !== -1;
  return byCardName && (byCard || digits.length === 4);
}

/**
 * Реестр карт: 4 цифры → {владелец, эмитент, название}.
 */
function readCards_() {
  var sheet = ensureSheet_(SHEET_CARDS, CARD_COLUMNS);
  var last = sheet.getLastRow();
  var map = {};
  if (last < 2) return map;

  sheet.getRange(2, 1, last - 1, CARD_COLUMNS.length).getValues().forEach(function (row) {
    var digits = String(row[0] == null ? '' : row[0]).replace(/\D/g, '');
    if (!digits) return;
    map[digits] = {
      card: digits,
      title: String(row[1] || ''),
      issuer: String(row[2] || ''),
      owner: String(row[3] || ''),
      purpose: String(row[4] || ''),
      chargeDay: String(row[5] || ''),
      status: String(row[6] || '')
    };
  });
  return map;
}

/**
 * Превращает строки файла в операции. Ничего не пишет — только разбирает,
 * чтобы разбор можно было проверить тестом без таблицы.
 */
function parseStatement_(rows, fileName) {
  var format = detectStatementFormat_(rows);
  if (!format) return { ok: false, error: 'Не понял, чья это выписка: не нашёл знакомых столбцов' };

  var cards = readCards_();
  var knownCards = Object.keys(cards);
  var index = format.index;
  var hints = format.source === 'Isracard' ? isracardHeaderHints_(rows, format.headerRow) : { card: '', chargeDay: '' };
  var operations = [];

  function cell(row, field) {
    var position = index[field];
    return position === undefined ? '' : row[position];
  }

  for (var r = format.headerRow + 1; r < rows.length; r++) {
    var row = rows[r] || [];
    var date = parseStatementDate_(cell(row, 'date'));
    if (!date) continue; // итоговые строки и разделители дат не имеют

    var operation = {
      date: date,
      chargeDate: parseStatementDate_(cell(row, 'chargeDate')) || null,
      source: format.source,
      card: String(cell(row, 'card') || hints.card || '').replace(/\D/g, '').slice(-4),
      merchant: String(cell(row, 'merchant') || '').trim(),
      currency: 'ILS',
      originalAmount: 0,
      originalCurrency: '',
      kind: 'покупка',
      notTrackable: '',
      note: String(cell(row, 'note') || '').trim(),
      file: fileName || ''
    };

    if (format.source === 'Банк') {
      var debit = parseStatementNumber_(cell(row, 'debit'));
      var credit = parseStatementNumber_(cell(row, 'credit'));
      var title = String(cell(row, 'operation') || '').trim();
      var reference = String(cell(row, 'reference') || '').trim();
      var details = String(cell(row, 'details') || '').trim();

      if (!debit && !credit) continue;

      operation.merchant = title;
      operation.note = [details, String(cell(row, 'payee') || ''), String(cell(row, 'purpose') || '')]
        .filter(function (part) { return String(part).trim(); }).join(' · ');
      operation.amount = debit || credit;
      operation.key = 'bank:' + formatDate_(date) + ':' + reference + ':' + operation.amount.toFixed(2);

      if (credit) {
        operation.kind = 'поступление';
        operation.notTrackable = 'да'; // доходы ведём отдельно, в тратах их быть не должно
      } else if (isCardSettlement_(title, reference, knownCards)) {
        operation.kind = 'списание по карте';
        operation.notTrackable = 'да'; // покупки уже пришли из выгрузки эмитента
        operation.card = String(reference).replace(/\D/g, '').slice(-4);
      }
    } else {
      operation.amount = parseStatementNumber_(cell(row, 'amount'));
      if (!operation.amount) continue;

      operation.currency = statementCurrency_(cell(row, 'currency'));
      operation.originalAmount = parseStatementNumber_(cell(row, 'originalAmount'));
      operation.originalCurrency = statementCurrency_(cell(row, 'originalCurrency'));
      if (operation.originalCurrency === operation.currency &&
          Math.abs(operation.originalAmount - operation.amount) < 0.005) {
        operation.originalAmount = 0;
        operation.originalCurrency = '';
      }

      var kindText = String(cell(row, 'kind') || '');
      if (/תשלום|תשלומים|קרדיט|רכישה עתידית/.test(kindText)) operation.kind = 'рассрочка';

      if (format.source === 'Isracard') {
        var voucher = String(cell(row, 'voucher') || '').replace(/\s/g, '');
        // Номер ваучера у Isracard уникален — лучшего ключа не найти
        operation.key = 'isracard:' + voucher;
        if (!voucher) {
          operation.key = 'isracard:' + operation.card + ':' + formatDate_(date) + ':' +
            operation.merchant + ':' + operation.amount.toFixed(2);
        }
        if (!operation.chargeDate && hints.chargeDay) {
          operation.chargeDate = parseStatementDate_(hints.chargeDay + '.' + date.getFullYear());
        }
      } else {
        var prefix = format.source === 'Max' ? 'max:' : 'cal:';
        operation.key = prefix + operation.card + ':' + formatDate_(date) + ':' +
          operation.merchant + ':' + operation.amount.toFixed(2);
      }
    }

    var known = cards[operation.card];
    operation.owner = known ? known.owner : '';

    // Категорию берём ТОЛЬКО из словаря. Обращаться к модели по каждой строке
    // нельзя: в банковской выписке их полторы сотни, и бесплатный лимит
    // Gemini кончается на середине файла — импорт молча умирает
    var guess = operation.notTrackable
      ? null
      : categorizeByDictionary_(String(operation.merchant || '').toLowerCase());
    operation.category = guess ? guess.category : '';
    operation.subcategory = guess ? guess.subcategory : '';

    operations.push(operation);
  }

  return { ok: true, source: format.source, operations: operations };
}

/**
 * Дата, раньше которой импортировать нечего: до неё бюджет просто не вели.
 */
function accountingStartDate_() {
  var raw = setting_('Учёт с', '');
  // Таблица распознаёт «15.08.2026» как дату и хранит её объектом, а не
  // текстом. Строковый разбор на таком значении молча возвращал пустоту,
  // и в бюджет уезжали июльские строки
  if (Object.prototype.toString.call(raw) === '[object Date]') return raw;
  var text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  return parseStatementDate_(text);
}

/**
 * Пишет операции в лист, пропуская уже импортированные.
 */
function saveOperations_(operations, fileName, fileKey) {
  var sheet = ensureSheet_(SHEET_OPERATIONS, OPERATION_COLUMNS);
  var last = sheet.getLastRow();

  var seen = {};
  if (last >= 2) {
    sheet.getRange(2, 16, last - 1, 1).getValues().forEach(function (row) {
      if (row[0]) seen[String(row[0])] = true;
    });
  }

  var startDate = accountingStartDate_();
  var rows = [];
  var stats = { total: operations.length, added: 0, dupes: 0, skipped: 0 };

  operations.forEach(function (op) {
    if (startDate && op.date < startDate) { stats.skipped++; return; }
    if (seen[op.key]) { stats.dupes++; return; }
    seen[op.key] = true;

    rows.push([
      op.date,
      op.chargeDate || '',
      op.amount,
      op.currency,
      toBaseAmount_(op.amount, op.currency),
      op.originalAmount || '',
      op.originalCurrency || '',
      op.source,
      op.card || '',
      op.owner || '',
      op.merchant,
      op.category || '',
      op.subcategory || '',
      op.kind,
      op.notTrackable || '',
      op.key,
      '', // склейка с записью в «Расходах» проставляется отдельно
      op.file || fileName || '',
      op.note || '',
      newRecordId_()
    ]);
    stats.added++;
  });

  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, OPERATION_COLUMNS.length).setValues(rows);
  }

  var journal = ensureSheet_(SHEET_IMPORTS, IMPORT_COLUMNS);
  journal.appendRow([
    new Date(), fileName || '', operations.length ? operations[0].source : '',
    statementPeriod_(operations), stats.total, stats.added, stats.dupes, stats.skipped, fileKey || ''
  ]);

  return stats;
}

/**
 * Период выписки — для журнала: «15.08.2026 — 22.08.2026».
 */
function statementPeriod_(operations) {
  if (!operations.length) return '';
  var min = operations[0].date;
  var max = operations[0].date;
  operations.forEach(function (op) {
    if (op.date < min) min = op.date;
    if (op.date > max) max = op.date;
  });
  return formatDate_(min) + ' — ' + formatDate_(max);
}

/**
 * Разбирает готовые строки и сохраняет. Возвращает текст отчёта для чата.
 */
function importStatementRows_(rows, fileName, fileKey) {
  var parsed = parseStatement_(rows, fileName);
  if (!parsed.ok) {
    logEvent_('Выписка не разобрана', { файл: fileName, причина: parsed.error });
    return { ok: false, error: parsed.error };
  }

  var stats = saveOperations_(parsed.operations, fileName, fileKey);
  logEvent_('Выписка импортирована', {
    файл: fileName, источник: parsed.source,
    строк: stats.total, новых: stats.added, повторов: stats.dupes, раньшеУчёта: stats.skipped
  });

  return { ok: true, source: parsed.source, stats: stats };
}

/**
 * Отчёт по импорту одним понятным абзацем.
 */
function importReportText_(fileName, result) {
  if (!result.ok) {
    return '<b>' + escapeHtml_(fileName) + '</b>\n' + escapeHtml_(result.error);
  }

  var s = result.stats;
  var lines = [
    '<b>' + escapeHtml_(fileName) + '</b> · ' + escapeHtml_(result.source),
    'Строк в файле: ' + s.total,
    'Записано новых: <b>' + s.added + '</b>'
  ];
  if (s.dupes) lines.push('Уже были: ' + s.dupes);
  if (s.skipped) lines.push('Раньше начала учёта: ' + s.skipped);
  if (!s.added && !s.dupes) lines.push('Ничего подходящего не нашлось — проверьте, тот ли файл.');
  return lines.join('\n');
}

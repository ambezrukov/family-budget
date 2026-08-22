/**
 * 24_Charts.gs — наглядная раскладка по категориям.
 *
 * Два уровня наглядности, и оба нужны.
 *
 * Полоски из символов идут прямо в тексте сообщения: они видны сразу, не
 * требуют загрузки картинки и читаются даже там, где изображения отключены.
 *
 * Круговая диаграмма приходит отдельной картинкой. Рисует её сама Google
 * Таблица: бот создаёт скрытый лист, кладёт туда числа, просит построить
 * диаграмму и забирает её изображением. Внешние сервисы для этого не нужны —
 * а значит, ничего не сломается, когда очередной бесплатный сервис закроется.
 */

var CHART_BARS_ = '▇';
var CHART_BAR_WIDTH_ = 12;

/**
 * Полоска под категорию: доля от самой крупной строки списка.
 */
function categoryBar_(value, maxValue) {
  if (!maxValue || value <= 0) return '';
  var filled = Math.max(1, Math.round((value / maxValue) * CHART_BAR_WIDTH_));
  var bar = '';
  for (var i = 0; i < filled; i++) bar += CHART_BARS_;
  return bar;
}

/**
 * Строки раскладки: название, полоска, сумма и доля.
 */
function categoryLines_(groups, total) {
  if (!groups.length) return [];
  var max = groups[0].sum;

  return groups.map(function (group) {
    var share = total > 0 ? Math.round((group.sum / total) * 100) : 0;
    return escapeHtml_(group.key) + ' — <b>' + formatMoney_(group.sum) + '</b>' +
      (share ? ' · ' + share + '%' : '') + '\n' +
      '<code>' + categoryBar_(group.sum, max) + '</code>';
  });
}

/**
 * Круговая диаграмма по категориям — изображением.
 * Возвращает null, если построить не удалось: отчёт должен уйти в любом случае.
 */
function categoryChartBlob_(groups, title) {
  if (!groups || groups.length < 2) return null; // одна категория — не диаграмма

  var ss = getSpreadsheet_();
  var sheet = null;

  try {
    sheet = ss.insertSheet('_диаграмма_' + new Date().getTime());
    sheet.hideSheet();

    // Мелкие категории сводим в «Прочее»: десяток подписей на круге
    // превращает диаграмму в кашу
    var top = groups.slice(0, 8);
    var rest = groups.slice(8).reduce(function (sum, group) { return sum + group.sum; }, 0);

    var rows = [['Категория', 'Сумма']];
    top.forEach(function (group) { rows.push([group.key, Math.round(group.sum * 100) / 100]); });
    if (rest > 0) rows.push(['Остальное', Math.round(rest * 100) / 100]);

    sheet.getRange(1, 1, rows.length, 2).setValues(rows);

    var chart = sheet.newChart()
      .asPieChart()
      .addRange(sheet.getRange(1, 1, rows.length, 2))
      .setOption('title', title || 'Расходы по категориям')
      .setOption('width', 720)
      .setOption('height', 460)
      .setOption('pieSliceText', 'percentage')
      .setOption('legend', { position: 'right', textStyle: { fontSize: 12 } })
      .build();

    sheet.insertChart(chart);
    SpreadsheetApp.flush();

    var charts = sheet.getCharts();
    if (!charts.length) return null;

    return charts[0].getBlob().getAs('image/png').setName('categories.png');
  } catch (err) {
    logEvent_('Диаграмма не построилась', String(err));
    return null;
  } finally {
    // Лист временный: остаться в таблице он не должен ни при каком исходе
    if (sheet) {
      try { ss.deleteSheet(sheet); } catch (err2) { /* уже удалён */ }
    }
  }
}

/**
 * Отправляет отчёт с диаграммой: текст, затем картинка.
 */
function sendReportWithChart_(chatId, text, groups, title) {
  tgSend_(chatId, text);

  var blob = categoryChartBlob_(groups, title);
  if (blob) tgSendPhoto_(chatId, blob, title);
}

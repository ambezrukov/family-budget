/**
 * 24_Charts.gs — наглядная раскладка по категориям.
 *
 * Полоски из символов идут прямо в тексте сообщения: видны сразу, не требуют
 * загрузки картинки и читаются в любом клиенте.
 *
 * Картинку с круговой диаграммой пробовали — Google Таблица умеет отдавать
 * график изображением. Отказались: сообщение с полосками отвечает на вопрос
 * «куда ушли деньги» не хуже, а лишний файл в переписке только мешает.
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

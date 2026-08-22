/**
 * 12_Links.gs — чек, присланный ссылкой.
 *
 * Магазины всё чаще шлют не бумажный чек, а SMS со ссылкой на него.
 * Пользователь пересылает такую SMS боту, а бот открывает ссылку сам.
 *
 * Три пути, в порядке предпочтения:
 *   1. Известный сервис цифровых чеков: Pairzon (Carrefour, Mega, «Йейнот
 *      Битан»), Weezmo (IKEA и другие), «Рами Леви». У каждого чек лежит
 *      готовой таблицей — рядом со страницей или прямо в ней. Сумма, дата и
 *      позиции берутся оттуда точными, распознавать нечего.
 *   2. PDF или картинка по ссылке — это и есть чек, отдаём его модели так же,
 *      как присланную фотографию.
 *   3. Обычная страница — вычищаем разметку и отдаём модели текстом.
 *
 * Ни один путь не должен ронять обработку: не открылось — вызывающий код
 * предложит записать сумму из самой SMS.
 */

var LINK_MAX_REDIRECTS = 5;      // короткая ссылка из SMS ведёт на длинную, иногда через две
var LINK_TEXT_LIMIT = 20000;     // столько текста страницы отдаём модели
var LINK_MIN_TEXT_LENGTH = 200;  // меньше — страница пустая, чек в ней рисует скрипт

// Некоторые сайты не отвечают запросу без имени браузера
var LINK_USER_AGENT = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

// ---------------------------------------------------------------------------
// Ссылки в тексте
// ---------------------------------------------------------------------------

/**
 * Все веб-адреса из текста, без повторов.
 */
function findLinks_(text) {
  var found = String(text || '').match(/https?:\/\/[^\s<>"'«»()\[\]]+/gi) || [];
  var result = [];

  found.forEach(function (raw) {
    // Точка или скобка в конце фразы к адресу не относится
    var url = raw.replace(/[.,;:!?)»"'‏‎]+$/, '');
    if (url.length > 12 && result.indexOf(url) === -1) result.push(url);
  });

  return result;
}

/**
 * Ссылки, за которыми чека заведомо нет. В той же SMS обычно есть ещё ссылка
 * на политику приватности, отписку или страницу сети — ходить по ним незачем.
 */
function isServiceLink_(url) {
  var lower = String(url).toLowerCase();
  return /(polic|privacy|terms|takanon|unsubscribe|opt-?out|help|support)/.test(lower) ||
    /(facebook|instagram|twitter|youtube|tiktok|whatsapp|t\.me|waze|maps\.google|apps\.apple|play\.google)/.test(lower);
}

/**
 * Ссылки, по которым имеет смысл искать чек: сначала все «неслужебные»,
 * а если таких не осталось — что есть, вдруг чек всё-таки там.
 */
function receiptLinksIn_(text) {
  var links = findLinks_(text);
  if (!links.length) return [];

  var useful = links.filter(function (url) { return !isServiceLink_(url); });
  return (useful.length ? useful : links).slice(0, 3); // больше трёх адресов в SMS не бывает
}

/**
 * Текст сообщения без ссылок.
 */
function textWithoutLinks_(text) {
  var rest = String(text || '');
  findLinks_(text).forEach(function (url) {
    rest = rest.split(url).join(' ');
  });
  return rest.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Разбор адреса
// ---------------------------------------------------------------------------

/**
 * Раскодирует HTML-подстановки: сервисы отдают названия товаров прямо из
 * кассовой программы, и кавычка в них приезжает как «&quot;».
 */
function decodeHtmlEntities_(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function decodeSafe_(value) {
  try {
    return decodeURIComponent(String(value).replace(/\+/g, ' '));
  } catch (err) {
    return String(value);
  }
}

/**
 * Разбирает адрес на части. Своими руками, потому что в Apps Script нет
 * привычного браузерного разборщика адресов.
 */
function parseUrl_(url) {
  var m = String(url || '').match(/^(https?):\/\/([^\/?#]+)([^?#]*)(?:\?([^#]*))?/i);
  if (!m) return null;

  var query = {};
  String(m[4] || '').split('&').forEach(function (pair) {
    if (!pair) return;
    var eq = pair.indexOf('=');
    var key = decodeSafe_(eq === -1 ? pair : pair.substring(0, eq));
    query[key] = eq === -1 ? '' : decodeSafe_(pair.substring(eq + 1));
  });

  var scheme = m[1].toLowerCase();
  var host = m[2].toLowerCase();
  return {
    scheme: scheme,
    host: host,
    origin: scheme + '://' + host,
    path: m[3] || '/',
    query: query
  };
}

/**
 * Приводит ссылку со страницы к полному адресу.
 */
function resolveUrl_(baseUrl, href) {
  var link = String(href || '').trim();
  if (!link) return '';
  if (/^https?:\/\//i.test(link)) return link;

  var base = parseUrl_(baseUrl);
  if (!base) return '';

  if (link.indexOf('//') === 0) return base.scheme + ':' + link;
  if (link.charAt(0) === '/') return base.origin + link;
  if (link.charAt(0) === '#' || link.charAt(0) === '?') return '';

  return base.origin + base.path.replace(/[^\/]*$/, '') + link;
}

/**
 * Значение заголовка ответа без оглядки на регистр имени.
 */
function headerValue_(headers, name) {
  var wanted = String(name).toLowerCase();
  var keys = Object.keys(headers || {});
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === wanted) {
      var value = headers[keys[i]];
      return String(value && value.length !== undefined && typeof value !== 'string' ? value[0] : value);
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Загрузка
// ---------------------------------------------------------------------------

/**
 * Скачивает адрес, проходя перенаправления по шагам.
 *
 * По шагам, а не автоматически, потому что нам нужен конечный адрес: короткая
 * ссылка из SMS ведёт на длинную, и опознавательные знаки чека (какой сервис,
 * какой документ) есть только в ней. Готового способа узнать конечный адрес
 * Apps Script не даёт.
 *
 * Возвращает {url, code, contentType, response} или null.
 */
function fetchLink_(url) {
  var current = String(url || '');
  if (!/^https?:\/\//i.test(current)) return null;

  for (var hop = 0; hop <= LINK_MAX_REDIRECTS; hop++) {
    var response;
    try {
      response = UrlFetchApp.fetch(current, {
        method: 'get',
        followRedirects: false,
        muteHttpExceptions: true,
        headers: {
          'User-Agent': LINK_USER_AGENT,
          'Accept-Language': 'he,ru;q=0.8,en;q=0.6'
        }
      });
    } catch (err) {
      var afterError = fetchViaProxy_(current);
      if (afterError) {
        logEvent_('Чек взят через посредника', { url: current, причина: String(err) });
        return afterError;
      }
      logEvent_('Ссылка не открылась', { url: current, error: String(err) });
      return null;
    }

    var code = response.getResponseCode();
    var headers = response.getHeaders() || {};

    if (code >= 300 && code < 400) {
      var next = resolveUrl_(current, headerValue_(headers, 'Location'));
      if (!next) {
        logEvent_('Перенаправление без адреса', { url: current, code: code });
        return null;
      }
      current = next;
      continue;
    }

    if (code !== 200) {
      var viaProxy = fetchViaProxy_(current);
      if (viaProxy) {
        logEvent_('Чек взят через посредника', { url: current, отказ: code });
        return viaProxy;
      }
      logEvent_('Сайт отказал', { url: current, code: code });
      return null;
    }

    return {
      url: current,
      code: code,
      contentType: headerValue_(headers, 'Content-Type').toLowerCase(),
      response: response
    };
  }

  logEvent_('Слишком много перенаправлений', { url: url });
  return null;
}

/**
 * Адрес посредника на Vercel. Отдельного свойства обычно нет: посредник и
 * мини-приложение живут одним проектом, поэтому берём тот же адрес.
 */
function proxyBaseUrl_() {
  var url = String(scriptProp_('PROXY_URL') || scriptProp_('MINIAPP_URL') || '').trim();
  return url ? url.replace(/\/+$/, '') : '';
}

/**
 * Второй заход за страницей — через посредника.
 *
 * Некоторые сети закрываются от серверных запросов: «Рами Леви» отвечает
 * Apps Script кодом 403, хотя с домашнего адреса та же страница открывается.
 * Посредник на Vercel живёт в другом облаке, и для таких сайтов выглядит
 * иначе, поэтому чек через него доходит.
 *
 * Возвращает такой же объект, как fetchLink_, — с ответом, у которого есть
 * привычные getContentText и getBlob, чтобы дальше код ничего не различал.
 */
function fetchViaProxy_(url) {
  var base = proxyBaseUrl_();
  if (!base) return null;

  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ url: String(url) }),
    muteHttpExceptions: true
  };

  var secret = scriptProp_(PROP_WEBHOOK_SECRET);
  if (secret) options.headers = { 'X-Proxy-Secret': secret };

  var response;
  try {
    response = UrlFetchApp.fetch(base + '/api/fetch', options);
  } catch (err) {
    logEvent_('Посредник не ответил', { url: url, error: String(err) });
    return null;
  }

  if (response.getResponseCode() !== 200) {
    logEvent_('Посредник не отдал страницу', { url: url, code: response.getResponseCode() });
    return null;
  }

  var data;
  try {
    data = JSON.parse(response.getContentText());
  } catch (err) {
    logEvent_('Посредник ответил не таблицей', { url: url });
    return null;
  }

  if (!data || !data.ok) {
    logEvent_('Посредник не отдал страницу', {
      url: url,
      статус: data && data.status,
      error: data && data.error,
      начало: data && data.sample
    });
    return null;
  }

  return {
    url: String(data.url || url),
    code: 200,
    contentType: String(data.contentType || '').toLowerCase(),
    response: proxyPageResponse_(data)
  };
}

/**
 * Ответ посредника в том виде, в каком его ждёт остальной код: текст страницы
 * приходит строкой, PDF и картинки — закодированными, и разворачиваются
 * обратно только если понадобятся.
 */
function proxyPageResponse_(data) {
  var contentType = String(data.contentType || 'text/html');

  function blob() {
    if (data.base64) {
      return Utilities.newBlob(Utilities.base64Decode(data.base64), contentType.split(';')[0], 'receipt');
    }
    return Utilities.newBlob(String(data.body || ''), contentType.split(';')[0], 'receipt');
  }

  return {
    getResponseCode: function () { return Number(data.status) || 200; },
    getContentText: function () {
      if (typeof data.body === 'string') return data.body;
      return data.base64 ? blob().getDataAsString() : '';
    },
    getHeaders: function () { return { 'Content-Type': contentType }; },
    getBlob: blob
  };
}

/**
 * Тот же запрос, но ответ ожидается таблицей (JSON).
 */
function fetchLinkJson_(url) {
  var page = fetchLink_(url);
  if (!page) return null;
  try {
    return JSON.parse(page.response.getContentText());
  } catch (err) {
    logEvent_('Ответ по ссылке не разобрался', { url: url, error: String(err) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Главный вход
// ---------------------------------------------------------------------------

/**
 * Читает чек по ссылке.
 *
 * Возвращает {receipts: [...], via: 'откуда взяли', url: 'конечный адрес'} —
 * список чеков в том же виде, в каком его отдаёт модель по фотографии,
 * чтобы дальше запись шла общим путём. Или null.
 */
function receiptFromLink_(url, comment) {
  var page = fetchLink_(url) || ramiLevyPdfFallback_(url);
  if (!page) return null;

  // 1. Известный сервис цифровых чеков
  var known = knownServiceReceipt_(page);
  if (known) return known;

  var type = page.contentType;

  // 2. По ссылке сразу документ — читаем его как фотографию чека
  if (type.indexOf('application/pdf') === 0 || type.indexOf('image/') === 0) {
    return receiptFromBinary_(page, comment);
  }

  // 3. Обычная страница
  if (!type || type.indexOf('text/') === 0 || type.indexOf('application/xhtml') === 0) {
    return receiptFromPage_(page, comment);
  }

  logEvent_('По ссылке неизвестный тип содержимого', { url: page.url, type: type });
  return null;
}

/**
 * Последняя попытка для «Рами Леви»: у чека, кроме страницы, есть PDF-версия
 * по адресу /api/receipts/{номер}/pdf. Защита сайта смотрит на страницы
 * строже, чем на файлы, поэтому файл иногда доходит там, где страница нет.
 *
 * Данные из PDF читает модель — они выйдут чуть менее точными, чем со
 * страницы, но это лучше, чем просить фотографировать бумажный чек.
 */
function ramiLevyPdfFallback_(url) {
  var parts = parseUrl_(url);
  if (!parts || !/(^|\.)rami-levy\.co\.il$/.test(parts.host)) return null;

  var id = String(parts.path || '').replace(/^\/+|\/+$/g, '');
  if (!id || id.indexOf('/') !== -1) return null; // адрес чека — один короткий кусок

  var page = fetchLink_(parts.origin + '/api/receipts/' + id + '/pdf');
  if (page) logEvent_('Чек «Рами Леви» взят PDF-файлом', { url: page.url });
  return page;
}

/**
 * Файл по ссылке (PDF или картинка) — тот же разбор, что и у фотографии.
 */
function receiptFromBinary_(page, comment) {
  var blob = page.response.getBlob();
  var bytes = blob.getBytes();

  if (bytes.length > MAX_FILE_BYTES) {
    logEvent_('Файл по ссылке слишком большой', { url: page.url, size: bytes.length });
    return null;
  }

  var mime = page.contentType.split(';')[0] || blob.getContentType();
  var answer = geminiParseReceipt_(Utilities.base64Encode(bytes), mime, comment);
  if (!answer || !answer.receipts || !answer.receipts.length) return null;

  return {
    receipts: answer.receipts,
    via: mime.indexOf('pdf') !== -1 ? 'PDF по ссылке' : 'картинка по ссылке',
    url: page.url
  };
}

/**
 * Обычная веб-страница.
 *
 * Сначала смотрим, не лежит ли сам чек рядом файлом: страница часто только
 * обёртка с кнопкой «скачать». Если файла нет — отдаём модели текст страницы.
 */
function receiptFromPage_(page, comment) {
  var html = page.response.getContentText();

  var fileUrl = documentLinkInHtml_(html, page.url);
  if (fileUrl) {
    var filePage = fetchLink_(fileUrl);
    if (filePage && /^(application\/pdf|image\/)/.test(filePage.contentType)) {
      var fromFile = receiptFromBinary_(filePage, comment);
      if (fromFile) return fromFile;
    }
  }

  var text = htmlToText_(html);
  if (text.length < LINK_MIN_TEXT_LENGTH) {
    // Страница собирается скриптом уже в браузере — текста в ней нет
    logEvent_('Страница по ссылке пустая', { url: page.url, length: text.length });
    return null;
  }

  var answer = geminiParseReceiptText_(text.substring(0, LINK_TEXT_LIMIT), comment, page.url);
  if (!answer || !answer.receipts || !answer.receipts.length) return null;

  return { receipts: answer.receipts, via: 'страница по ссылке', url: page.url };
}

/**
 * Текст страницы без разметки.
 *
 * Ивритские страницы пишутся справа налево: в разметке рассыпаны служебные
 * знаки направления письма, а цена часто разбита на части («17 .90 ₪» —
 * каждая часть своим элементом). Знаки убираем, число собираем обратно,
 * иначе сумма чека уедет в десять раз.
 */
function htmlToText_(html) {
  return decodeHtmlEntities_(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section)>/gi, '\n')
    .replace(/<[^>]*>/g, ' '))
    .replace(/[‎‏‪-‮⁦-⁩﻿]/g, '') // знаки направления письма
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/(\d)\s+([.,])\s*(\d{2})(?!\d)/g, '$1.$3') // «17 .90» — это одна цена
    .trim();
}

/**
 * Ссылка на сам документ внутри страницы-обёртки.
 * PDF предпочтительнее картинки, оформление (логотипы, баннеры) пропускаем.
 */
function documentLinkInHtml_(html, baseUrl) {
  var pattern = /(?:href|src|data-src|data-href)\s*=\s*["']([^"']+)["']/gi;
  var picture = '';
  var match;

  while ((match = pattern.exec(String(html || ''))) !== null) {
    var href = match[1];
    if (!/\.(pdf|jpe?g|png|webp)(\?|#|$)/i.test(href)) continue;
    if (/(logo|icon|favicon|banner|sprite|placeholder|avatar|header|footer|social|share|button|bg[-_])/i.test(href)) continue;

    var full = resolveUrl_(baseUrl, href);
    if (!full) continue;
    if (/\.pdf(\?|#|$)/i.test(href)) return full;
    if (!picture) picture = full;
  }

  return picture;
}

// ---------------------------------------------------------------------------
// Известные сервисы цифровых чеков
// ---------------------------------------------------------------------------

/**
 * Разбор для сервисов, устройство которых мы знаем. Здесь данные берутся
 * готовыми, поэтому сумма и дата не зависят от распознавания.
 *
 * Не получилось — возвращаем null, и ссылка пойдёт общим путём.
 */
function knownServiceReceipt_(page) {
  var parts = parseUrl_(page.url);
  if (!parts) return null;
  if (/(^|\.)pairzon\.com$/.test(parts.host)) return pairzonReceipt_(parts);
  if (/(^|\.)weezmo\.com$/.test(parts.host)) return weezmoReceipt_(parts);
  if (/(^|\.)rami-levy\.co\.il$/.test(parts.host)) return ramiLevyReceipt_(page, parts);
  return null;
}

/**
 * Время, записанное по Гринвичу (с буквой Z на конце), — в местное.
 * Иначе ночная покупка попадёт в таблицу вчерашним днём.
 */
function localDateTime_(value) {
  var raw = String(value || '').trim();
  if (!raw) return '';
  if (!/([zZ]|[+-]\d{2}:?\d{2})$/.test(raw)) return raw; // время и так местное

  var date = new Date(raw);
  if (isNaN(date.getTime())) return raw;
  return Utilities.formatDate(date, tz_(), 'yyyy-MM-dd HH:mm');
}

/**
 * Pairzon — через него шлют чеки Carrefour, Mega, «Йейнот Битан», «Битан
 * маркет» и другие израильские сети.
 *
 * Страница чека пустая: содержимое подгружается скриптом уже в браузере.
 * Тот же чек отдаётся таблицей по служебному адресу /v1.0/documents/<чек>,
 * и опознаватель чека есть в адресе страницы — берём данные оттуда.
 */
function pairzonReceipt_(parts) {
  var id = parts.query.id;
  if (!id) {
    logEvent_('Ссылка Pairzon без опознавателя чека', { url: parts.origin + parts.path });
    return null;
  }

  var api = parts.origin + '/v1.0/documents/' + encodeURIComponent(id) +
    (parts.query.p ? '?p=' + encodeURIComponent(parts.query.p) : '');

  var doc = fetchLinkJson_(api);
  if (!doc || !doc.id) {
    logEvent_('Чек Pairzon не получен', { url: api });
    return null;
  }

  var receipt = enrichReceipt_(pairzonToReceipt_(doc));
  return {
    receipts: [receipt],
    via: 'Pairzon',
    url: parts.origin + parts.path + '?id=' + id,
    exact: true // числа пришли готовыми, а не распознаны
  };
}

/**
 * Чек Pairzon — в тот же вид, в каком чек приходит от модели.
 */
function pairzonToReceipt_(doc) {
  var store = doc.store || {};
  var business = store.business || {};

  var total = Number(doc.total) || 0;
  if (!total && doc.payments && doc.payments.length) {
    // Итога нет — складываем то, чем платили
    total = doc.payments.reduce(function (sum, payment) {
      return sum + (Number(payment.amount) || 0);
    }, 0);
  }
  total = Math.round(total * 100) / 100;

  var items = (doc.items || []).map(function (item) {
    // total — сколько заплачено за позицию, price — цена за килограмм или штуку;
    // в таблицу нужна заплаченная сумма
    var price = Number(item.total);
    if (!price && price !== 0) price = Number(item.price) || 0;
    return {
      name: '', // заполнится переводом
      original: decodeHtmlEntities_(item.name).trim(),
      price: Math.round(price * 100) / 100
    };
  }).filter(function (item) { return item.original; });

  var storeName = decodeHtmlEntities_(store.alias || business.englishName || business.name).trim();
  var isRefund = /refund|credit|zikuy/i.test(String(doc.documentType || ''));

  return {
    total: total,
    currency: String(store.currency || business.currency || 'ILS').toUpperCase(),
    datetime: localDateTime_(doc.createdDate || doc.uploadedDate),
    store: storeName,
    storeRu: '',
    category: '',
    subcategory: '',
    items: items,
    tips: 0,
    kind: isRefund ? 'возврат' : 'расход',
    readable: total > 0,
    note: total > 0
      ? (isRefund ? 'Чек на возврат — записал минусом' : '')
      : 'В чеке нет итоговой суммы'
  };
}

/**
 * Weezmo — через него шлют чеки IKEA и другие сети; короткая ссылка выглядит
 * как wee.ai/r/..., а ведёт на receipts.weezmo.com.
 *
 * Страница чека собирается скриптом в браузере, читать в ней нечего. Но сам
 * чек лежит рядом таблицей по адресу /api/receipts/<чек>, где опознаватель
 * чека — это параметр q из адреса страницы.
 */
function weezmoReceipt_(parts) {
  var id = parts.query.q;
  if (!id) {
    logEvent_('Ссылка Weezmo без опознавателя чека', { url: parts.origin + parts.path });
    return null;
  }

  var api = parts.origin + '/api/receipts/' + encodeURIComponent(id);
  var answer = fetchLinkJson_(api);

  // Сервис отвечает списком, даже когда чек один
  var doc = answer && answer.length ? answer[0] : answer;
  if (!doc || !doc.id) {
    logEvent_('Чек Weezmo не получен', { url: api });
    return null;
  }

  var receipt = enrichReceipt_(weezmoToReceipt_(doc));
  return {
    receipts: [receipt],
    via: 'Weezmo',
    url: parts.origin + parts.path + '?q=' + id,
    exact: true
  };
}

/**
 * Чек Weezmo — в тот же вид, в каком чек приходит от модели.
 */
function weezmoToReceipt_(doc) {
  var business = doc.tBusiness || {};
  var branch = doc.tBranch || {};

  var items = (doc.items || []).map(function (item) {
    // Поле total у этого сервиса часто нулевое — тогда считаем сами
    var price = Number(item.total);
    if (!price) price = (Number(item.price) || 0) * (Number(item.quantity) || 1);
    return {
      name: '',
      original: decodeHtmlEntities_(item.name).trim(),
      price: Math.round(price * 100) / 100
    };
  }).filter(function (item) { return item.original; });

  var storeName = decodeHtmlEntities_(business.businessNameEnglish || business.businessName).trim();
  if (storeName && branch.branchName) storeName += ' ' + String(branch.branchName).trim();

  var total = Math.round((Number(doc.total) || 0) * 100) / 100;
  var isRefund = /refund|return/i.test(String(doc.receiptType || ''));

  return {
    total: total,
    currency: String(doc.currency || 'ILS').toUpperCase(),
    datetime: localDateTime_(doc.createdDate || doc.uploadedDate),
    store: storeName,
    storeRu: '',
    category: '',
    subcategory: '',
    items: items,
    tips: 0,
    kind: isRefund ? 'возврат' : 'расход',
    readable: total > 0,
    note: total > 0
      ? (isRefund ? 'Чек на возврат — записал минусом' : '')
      : 'В чеке нет итоговой суммы'
  };
}

/**
 * «Рами Леви» — свой сервис цифровых чеков (digi.rami-levy.co.il).
 *
 * Здесь страница не пустая, чек в ней виден. Но иврит пишется справа налево,
 * и в тексте подписи разъезжаются с числами: рядом стоят сумма без НДС, сам
 * НДС и итог — перепутать легко. Поэтому берём данные, которые страница несёт
 * в себе готовыми, а разбор текста оставляем как запасной путь.
 */
function ramiLevyReceipt_(page, parts) {
  var text = page.response.getContentText();
  var doc = nuxtPayload_(text, ['items', 'payments', 'created_at']);
  if (!doc) {
    logEvent_('Чек «Рами Леви» не разобрался, читаем страницу текстом', {
      url: page.url,
      длина: String(text || '').length,
      данныеЕсть: /__NUXT_DATA__/.test(String(text || '')),
      начало: String(text || '').replace(/\s+/g, ' ').slice(0, 200)
    });
    return null;
  }

  var receipt = enrichReceipt_(ramiLevyToReceipt_(doc));
  return {
    receipts: [receipt],
    via: 'Рами Леви',
    url: parts.origin + parts.path,
    exact: true
  };
}

/**
 * Чек «Рами Леви» — в тот же вид, в каком чек приходит от модели.
 */
function ramiLevyToReceipt_(doc) {
  var payments = doc.payments || {};
  var company = doc.company || {};
  var branch = doc.branch || {};

  var total = Number(payments.total) || 0;
  if (!total && payments.methods && payments.methods.length) {
    total = payments.methods.reduce(function (sum, method) {
      return sum + (Number(method.amount) || 0);
    }, 0);
  }
  total = Math.round(total * 100) / 100;

  var items = (doc.items || []).map(function (item) {
    var price = Number(item.total);
    if (!price) price = (Number(item.price) || 0) * (Number(item.quantity) || 1);

    // Акционные скидки лежат отдельными строками с отрицательным значением:
    // без них цена позиции будет как без скидки, и итог не сойдётся
    (item.additional_info || []).forEach(function (extra) {
      var value = parseFloat(String(extra && extra.value).replace(',', '.'));
      if (!isNaN(value)) price += value;
    });

    return {
      name: '',
      original: decodeHtmlEntities_(item.name).trim(),
      price: Math.round(price * 100) / 100
    };
  }).filter(function (item) { return item.original; });

  var storeName = decodeHtmlEntities_(company.name).trim();
  if (branch.name) storeName += (storeName ? ' ' : '') + String(branch.name).trim();

  var isRefund = /refund|credit|zikuy/i.test(String(doc.document_type || ''));

  return {
    total: total,
    currency: 'ILS',
    datetime: localDateTime_(doc.created_at),
    store: storeName,
    storeRu: '',
    category: '',
    subcategory: '',
    items: items,
    tips: 0,
    kind: isRefund ? 'возврат' : 'расход',
    readable: total > 0,
    note: total > 0
      ? (isRefund ? 'Чек на возврат — записал минусом' : '')
      : 'В чеке нет итоговой суммы'
  };
}

/**
 * Данные, которые страница на Nuxt несёт в себе готовыми.
 *
 * Лежат они плоским списком: внутри объектов вместо самих значений стоят
 * номера ячеек этого же списка. Находим ячейку, похожую на чек (по набору
 * полей), и собираем её обратно в обычный объект.
 */
function nuxtPayload_(html, requiredKeys) {
  var match = String(html || '').match(/id=["']__NUXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/);
  if (!match) return null;

  var flat;
  try {
    flat = JSON.parse(match[1]);
  } catch (err) {
    return null;
  }
  if (!flat || !flat.length) return null;

  for (var i = 0; i < flat.length; i++) {
    var node = flat[i];
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;

    var suitable = true;
    for (var k = 0; k < requiredKeys.length; k++) {
      if (node[requiredKeys[k]] === undefined) { suitable = false; break; }
    }
    if (suitable) return nuxtValue_(flat, i, 0);
  }

  return null;
}

/**
 * Собирает значение из плоского списка Nuxt по номеру ячейки.
 * Глубина ограничена: список может ссылаться сам на себя.
 */
function nuxtValue_(flat, ref, depth) {
  if (depth > 12) return null;

  var node = flat[ref];
  if (node === null || node === undefined) return null;
  if (typeof node !== 'object') return node;

  if (Array.isArray(node)) {
    return node.map(function (item) { return nuxtValue_(flat, item, depth + 1); });
  }

  var result = {};
  Object.keys(node).forEach(function (key) {
    result[key] = nuxtValue_(flat, node[key], depth + 1);
  });
  return result;
}

/**
 * Готовому чеку не хватает только русских названий и категории — за ними
 * идём к модели. Числа ей на правку не отдаём: они уже точные.
 *
 * Модель может быть недоступна (сбой, дневной лимит) — тогда позиции
 * останутся на языке оригинала, но расход всё равно запишется.
 */
function enrichReceipt_(receipt) {
  var answer = null;
  try {
    answer = geminiEnrichReceipt_(receipt);
  } catch (err) {
    logEvent_('Сбой перевода чека', { error: String(err) });
  }

  if (answer) {
    if (answer.storeRu) receipt.storeRu = String(answer.storeRu).trim();
    if (answer.category) {
      receipt.category = String(answer.category).trim();
      receipt.subcategory = String(answer.subcategory || '').trim();
    }

    var byOriginal = {};
    (answer.items || []).forEach(function (item) {
      var key = normalizeForDictionary_(item.original);
      var name = String(item.name || '').trim();
      if (key && name) byOriginal[key] = name;
    });

    receipt.items.forEach(function (item) {
      var translated = byOriginal[normalizeForDictionary_(item.original)];
      if (translated) item.name = translated;
    });
  }

  // Непереведённая позиция всё равно должна попасть в таблицу — пусть на иврите
  receipt.items.forEach(function (item) {
    if (!item.name) item.name = item.original;
  });

  return receipt;
}

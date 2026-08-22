/**
 * Загрузка страницы чека вместо бота.
 *
 * Зачем: сети всё чаще закрываются от серверных запросов. «Рами Леви»
 * отвечает Apps Script кодом 403 — не из-за заголовков, а потому что запрос
 * приходит из облака Google. С обычного домашнего адреса та же страница
 * открывается спокойно. Vercel живёт в другом облаке, и для таких сайтов
 * выглядит иначе, поэтому чек через него доходит.
 *
 * Открытым прокси эта функция быть не должна, поэтому:
 *   — ходит только по адресам известных сервисов цифровых чеков;
 *   — если задано слово WEBHOOK_SECRET, проверяет его в заголовке.
 *
 * Ничего не хранит: скачал, отдал, забыл.
 */

export const config = {
  maxDuration: 30
};

// Сервисы, которые рассылают чеки. Ходить куда-то ещё этой функции незачем.
const ALLOWED_HOSTS = [
  'rami-levy.co.il',
  'pairzon.com',
  'weezmo.com',
  'wee.ai',
  'shufersal.co.il',
  'victoryonline.co.il',
  'ybitan.co.il',
  'mega.co.il',
  'osherad.co.il',
  'yohananof.co.il'
];

const MAX_BYTES = 3 * 1024 * 1024; // ответ Vercel ограничен, а чек столько не весит

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'he-IL,he;q=0.9,ru;q=0.8,en;q=0.7'
};

function hostAllowed(hostname) {
  const host = String(hostname || '').toLowerCase();
  return ALLOWED_HOSTS.some(allowed => host === allowed || host.endsWith('.' + allowed));
}

function isTextual(contentType) {
  return /^(text\/|application\/(json|javascript|xhtml))/i.test(String(contentType || ''));
}

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    return response.status(405).json({ ok: false, error: 'Только POST' });
  }

  const expected = process.env.WEBHOOK_SECRET;
  if (expected && request.headers['x-proxy-secret'] !== expected) {
    return response.status(401).json({ ok: false, error: 'forbidden' });
  }

  const target = request.body && request.body.url;
  let parsed;
  try {
    parsed = new URL(String(target));
  } catch (error) {
    return response.status(400).json({ ok: false, error: 'Неверный адрес' });
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return response.status(400).json({ ok: false, error: 'Только http и https' });
  }
  if (!hostAllowed(parsed.hostname)) {
    return response.status(403).json({ ok: false, error: 'Адрес не из списка сервисов чеков' });
  }

  try {
    const fetched = await fetch(parsed.toString(), {
      headers: BROWSER_HEADERS,
      redirect: 'follow'
    });

    const contentType = fetched.headers.get('content-type') || '';
    const buffer = Buffer.from(await fetched.arrayBuffer());

    // Сайт мог ответить отказом и нам: тогда в теле не чек, а страница ошибки.
    // Отдавать её боту нельзя — он примет мусор за содержимое чека.
    if (!fetched.ok) {
      return response.status(200).json({
        ok: false,
        status: fetched.status,
        error: 'Сайт ответил ' + fetched.status,
        sample: buffer.toString('utf8').replace(/\s+/g, ' ').slice(0, 300)
      });
    }

    if (buffer.length > MAX_BYTES) {
      return response.status(502).json({ ok: false, error: 'Страница слишком большая' });
    }

    const result = {
      ok: true,
      status: fetched.status,
      url: fetched.url || parsed.toString(),
      contentType
    };

    if (isTextual(contentType)) {
      result.body = buffer.toString('utf8');
    } else {
      result.base64 = buffer.toString('base64');
    }

    return response.status(200).json(result);
  } catch (error) {
    console.error('Не удалось скачать страницу: ' + error);
    return response.status(502).json({ ok: false, error: 'Сайт не ответил' });
  }
}

/**
 * Данные для мини-приложения.
 *
 * Страница не ходит в Apps Script напрямую по двум причинам: браузер не любит
 * запросы на чужой домен, а Apps Script отвечает перенаправлением. Поэтому
 * запрос идёт сюда, а отсюда — дальше.
 *
 * Проверять, кто спрашивает, здесь не нужно и не хочется: подпись телеграма
 * проверяется на стороне Apps Script, где лежит токен бота. Сюда токен
 * не попадает.
 */

export const config = {
  maxDuration: 30
};

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    return response.status(405).json({ ok: false, error: 'Только POST' });
  }

  const target = process.env.APPS_SCRIPT_URL;
  if (!target) {
    return response.status(500).json({ ok: false, error: 'Посредник не настроен' });
  }

  const secret = process.env.WEBHOOK_SECRET;
  const mode = request.body && request.body.action === 'delete' ? 'delete' : 'data';

  const url = new URL(target);
  url.searchParams.set('mode', mode);
  if (secret) url.searchParams.set('s', secret);

  try {
    const forwarded = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request.body || {}),
      redirect: 'follow'
    });

    const text = await forwarded.text();

    try {
      return response.status(200).json(JSON.parse(text));
    } catch (parseError) {
      console.error('Apps Script ответил не JSON: ' + text.slice(0, 300));
      return response.status(502).json({ ok: false, error: 'Таблица ответила неожиданно' });
    }
  } catch (error) {
    console.error('Не удалось получить данные: ' + error);
    return response.status(502).json({ ok: false, error: 'Не удалось связаться с таблицей' });
  }
}

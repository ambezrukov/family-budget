/**
 * Посредник между Telegram и Google Apps Script.
 *
 * Зачем он нужен: Apps Script на любой запрос отвечает перенаправлением (302)
 * на script.googleusercontent.com. Телеграм за перенаправлением не идёт и
 * считает такой ответ ошибкой, поэтому вебхук напрямую не работает.
 * Эта функция принимает сообщение от телеграма, отвечает ему «принято» и
 * передаёт сообщение дальше в Apps Script, спокойно проходя перенаправление.
 *
 * Ничего не хранит и не записывает — только передаёт.
 */

export const config = {
  maxDuration: 60 // Apps Script обрабатывает чек с распознаванием до нескольких секунд
};

export default async function handler(request, response) {
  // Телеграм ходит только POST. Всё остальное — проверка живости.
  if (request.method !== 'POST') {
    return response.status(200).send('Посредник для бота расходов работает.');
  }

  // Телеграм подписывает свои запросы секретным словом. Чужой запрос,
  // пришедший на этот адрес, дальше не пойдёт.
  const expected = process.env.WEBHOOK_SECRET;
  if (expected) {
    const provided = request.headers['x-telegram-bot-api-secret-token'];
    if (provided !== expected) {
      return response.status(401).send('forbidden');
    }
  }

  const target = process.env.APPS_SCRIPT_URL;
  if (!target) {
    console.error('Не задана переменная APPS_SCRIPT_URL');
    return response.status(200).send('ok'); // телеграму всё равно отвечаем ок
  }

  const url = expected
    ? target + (target.includes('?') ? '&' : '?') + 's=' + encodeURIComponent(expected)
    : target;

  try {
    const forwarded = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request.body),
      redirect: 'follow' // вот ради этой строчки всё и затевалось
    });

    if (!forwarded.ok) {
      console.error('Apps Script ответил ' + forwarded.status);
    }
  } catch (error) {
    console.error('Не удалось передать сообщение: ' + error);
  }

  // Телеграму всегда отвечаем успехом: если Apps Script подвёл, повторная
  // доставка того же сообщения ничего не исправит, а очередь застопорит.
  return response.status(200).send('ok');
}

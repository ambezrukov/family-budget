/**
 * Посредник между Telegram и Google Apps Script.
 *
 * Зачем он нужен: Apps Script на любой запрос отвечает перенаправлением (302)
 * на script.googleusercontent.com. Телеграм за перенаправлением не идёт и
 * считает такой ответ ошибкой, поэтому вебхук напрямую не работает.
 * Эта функция принимает сообщение от телеграма, отвечает ему «принято» и
 * передаёт сообщение дальше в Apps Script, спокойно проходя перенаправление.
 *
 * Телеграму отвечаем сразу, не дожидаясь Apps Script, а передачу доделываем
 * в фоне (waitUntil). Так задумывалось с самого начала — ответ всё равно
 * всегда «ок», — но пока ответ ждал Apps Script, долгий разбор чека упирался
 * в лимит времени: телеграм не получал ответа, считал доставку неудачной и
 * присылал то же сообщение снова. Отсюда были потерянные чеки и задвоенные
 * траты (11 обрывов за неделю к 23.08.2026). Теперь долгий разбор задерживает
 * только фоновую часть и на телеграм не влияет.
 *
 * Ничего не хранит и не записывает — только передаёт.
 */

import { waitUntil } from '@vercel/functions';

export const config = {
  maxDuration: 60 // столько живёт фоновая передача; телеграм столько уже не ждёт
};

// Передача в Apps Script. Наружу ошибку не бросает: жаловаться уже некому —
// телеграм к этому моменту получил ответ и ушёл.
async function forwardToScript(url, body) {
  try {
    const forwarded = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'follow' // вот ради этой строчки всё и затевалось
    });

    if (!forwarded.ok) {
      console.error('Apps Script ответил ' + forwarded.status);
    }
  } catch (error) {
    console.error('Не удалось передать сообщение: ' + error);
  }
}

export default function handler(request, response) {
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

  // waitUntil просит Vercel не гасить функцию, пока передача не закончится,
  // хотя ответ телеграму уже ушёл.
  waitUntil(forwardToScript(url, request.body));

  // Телеграму всегда отвечаем успехом: если Apps Script подвёл, повторная
  // доставка того же сообщения ничего не исправит, а очередь застопорит.
  return response.status(200).send('ok');
}

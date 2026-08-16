// Интеграционный прогон: реальный код бота в эмуляции Apps Script.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const M = require('./mocks');

// Обычно проверяем исходники; с BUNDLE=1 — собранный dist/Код.gs,
// то есть ровно то, что попадёт в Apps Script при установке.
const SRC = path.join(__dirname, '..', 'src');
const code = process.env.BUNDLE
  ? fs.readFileSync(path.join(__dirname, '..', 'dist', 'Код.gs'), 'utf8')
  : fs.readdirSync(SRC).filter(f => f.endsWith('.gs')).sort()
      .map(f => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');

const ctx = vm.createContext(M.env);
vm.runInContext(code, ctx, { filename: 'bot.gs' });
const call = (name, ...args) => ctx[name](...args);

let fails = 0;
const check = (label, ok, extra) => {
  if (!ok) fails++;
  console.log((ok ? '  OK       ' : '  ОШИБКА   ') + label + (ok || !extra ? '' : '  → ' + extra));
};

// --- Настройка окружения -----------------------------------------------------
M.scriptProps.TELEGRAM_TOKEN = '123:TEST';
M.scriptProps.GEMINI_API_KEY = 'test-key';
M.scriptProps.SPREADSHEET_ID = 'TEST';

// Заглушка модели: по тексту запроса понимаем, о чём её спросили.
// По умолчанию текст «разбирает» локальный парсер самого бота — это близко
// к тому, что вернула бы модель на простую фразу с одной тратой.
let geminiPlan = {};
const gemini = (plan) => { geminiPlan = plan; };
const isoOf = (d) => d.getFullYear() + '-' +
  String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

const defaultTextModel = (payload) => {
  const prompt = JSON.stringify(payload);
  const m = prompt.match(/Сообщение: «(.*?)»\\n\\n/);
  const text = m ? m[1] : '';
  const p = ctx.parseExpenseText_(text);
  const cat = ctx.categorize_(p.description, '');
  return {
    isExpense: !!(p.amount || p.description),
    expenses: [{
      amount: p.amount || 0,
      currency: p.currency,
      date: p.dateExplicit ? isoOf(p.date) : '',
      description: p.description,
      store: '',
      category: cat.category,
      subcategory: cat.subcategory
    }],
    comment: ''
  };
};

M.setGeminiResponder((payload, url) => {
  const prompt = JSON.stringify(payload);
  if (prompt.includes('кассовый чек')) return geminiPlan.receipt ? geminiPlan.receipt() : null;
  if (prompt.includes('текст страницы с чеком')) {
    return geminiPlan.pageReceipt ? geminiPlan.pageReceipt(payload) : null;
  }
  if (prompt.includes('уже разобран')) return geminiPlan.enrich ? geminiPlan.enrich(payload) : null;
  if (prompt.includes('голосовое сообщение')) return geminiPlan.voice ? geminiPlan.voice() : null;
  if (prompt.includes('Разбери сообщение о расходах')) {
    if (geminiPlan.text === null) return null;
    return (geminiPlan.text || defaultTextModel)(payload);
  }
  if (prompt.includes('Определи категорию')) return geminiPlan.category ? geminiPlan.category() : null;
  if (prompt.includes('проверка связи')) return geminiPlan.probe ? geminiPlan.probe(payload, url) : null;
  return null;
});

const sent = [];        // сообщения, ушедшие пользователю
const edits = [];       // правки сообщений
M.setTelegramResponder((url, payload) => {
  if (url.includes('/sendMessage')) { sent.push(payload); return { ok: true, result: { message_id: sent.length } }; }
  if (url.includes('/editMessageText')) { edits.push(payload); return { ok: true, result: {} }; }
  if (url.includes('/editMessageReplyMarkup')) { edits.push(payload); return { ok: true, result: {} }; }
  if (url.includes('/getFile')) return { ok: true, result: { file_path: 'voice/file_1.oga' } };
  if (url.includes('/getMe')) return { ok: true, result: { username: 'test_bot' } };
  return { ok: true, result: {} };
});

console.log('=== Первичная настройка таблицы ===');
call('setupSpreadsheet');
const ss = M.spreadsheet;
check('созданы все листы',
  ['Расходы', 'Доходы', 'Категории', 'Настройки', 'Лог'].every(n => ss.getSheetByName(n)));
check('справочник категорий заполнен', ss.getSheetByName('Категории').getLastRow() > 30,
  'строк: ' + ss.getSheetByName('Категории').getLastRow());

// Разрешаем двух пользователей и чат отчёта
const settings = ss.getSheetByName('Настройки');
for (let r = 1; r <= settings.getLastRow(); r++) {
  const key = settings.getRange(r, 1).getValues()[0][0];
  if (key === 'Разрешённые телеграм-айди') settings.getRange(r, 2).setValue('111, 222');
  if (key === 'Чат месячного отчёта') settings.getRange(r, 2).setValue('-100500');
}
ctx.SETTINGS_CACHE_ = null;

const expenses = () => ss.getSheetByName('Расходы');
const rowsCount = () => Math.max(0, expenses().getLastRow() - 1);
const lastRow = () => expenses().getRange(expenses().getLastRow(), 1, 1, 17).getValues()[0];

const HUSBAND = { id: 111, first_name: 'Анатолий' };
const WIFE = { id: 222, first_name: 'Жена' };
const msg = (over) => ({ message_id: Math.floor(Math.random() * 1e6), chat: { id: 555 }, from: HUSBAND, ...over });

let updateId = 1;
const post = (update) => call('doPost', { postData: { contents: JSON.stringify({ update_id: updateId++, ...update }) } });

// --- 1. Текстовый расход -----------------------------------------------------
console.log('\n=== Текстовый ввод ===');
post({ message: msg({ text: '360 шек отправка машины' }) });
check('запись создана', rowsCount() === 1, 'строк: ' + rowsCount());
let row = lastRow();
check('сумма 360', row[2] === 360, String(row[2]));
check('валюта ILS', row[3] === 'ILS', String(row[3]));
check('категория «Транспорт и автомобиль»', row[5] === 'Транспорт и автомобиль', String(row[5]));
check('источник категории «модель»', row[13] === 'модель', String(row[13]));
check('способ ввода «текст»', row[11] === 'текст', String(row[11]));
check('автор записан', row[10] === 'Анатолий', String(row[10]));
check('в ответе есть кнопки', !!(sent[sent.length - 1].reply_markup));
check('в ответе есть сумма', sent[sent.length - 1].text.includes('360'));

// --- 2. Повторная доставка того же апдейта -----------------------------------
console.log('\n=== Защита от повторов ===');
const beforeDup = rowsCount();
const dup = { update_id: 777, message: msg({ text: '50 хлеб' }) };
call('doPost', { postData: { contents: JSON.stringify(dup) } });
call('doPost', { postData: { contents: JSON.stringify(dup) } });
check('дубликат не записан второй раз', rowsCount() === beforeDup + 1,
  'было ' + beforeDup + ', стало ' + rowsCount());

// --- 3. Сообщение без суммы --------------------------------------------------
console.log('\n=== Уточнение суммы ===');
const beforeAsk = rowsCount();
post({ message: msg({ text: 'кофе с коллегой' }) });
check('запись не создана без суммы', rowsCount() === beforeAsk);
check('бот переспросил', /сколько потратили/i.test(sent[sent.length - 1].text),
  sent[sent.length - 1].text.slice(0, 60));
post({ message: msg({ text: '38' }) });
check('после ответа числом запись создана', rowsCount() === beforeAsk + 1);
row = lastRow();
check('сумма из ответа', row[2] === 38, String(row[2]));
check('описание из первого сообщения', String(row[7]).includes('кофе'), String(row[7]));
check('категория «Кафе и рестораны»', row[5] === 'Кафе и рестораны', String(row[5]));

// --- Несколько трат в одном сообщении ---------------------------------------
console.log('\n=== Несколько трат одним сообщением ===');
gemini({
  text: () => ({
    isExpense: true,
    expenses: [
      { amount: 250, currency: 'ILS', date: '', description: 'продукты', store: '', category: 'Продукты', subcategory: 'Супермаркет' },
      { amount: 80, currency: 'ILS', date: '', description: 'бензин', store: '', category: 'Транспорт и автомобиль', subcategory: 'Бензин' },
      { amount: 45, currency: 'ILS', date: '', description: 'аптека', store: '', category: 'Здоровье и аптека', subcategory: 'Аптека' }
    ],
    comment: ''
  })
});
const beforeMulti = rowsCount();
post({ message: msg({ text: '250 продукты, 80 бензин и 45 аптека' }) });
check('записаны все три траты', rowsCount() === beforeMulti + 3, 'добавлено: ' + (rowsCount() - beforeMulti));

const multiMsg = sent[sent.length - 1];
check('в сводке общая сумма', /375/.test(multiMsg.text), multiMsg.text.split('\n')[0]);
check('в сводке пронумерованный список', /1\./.test(multiMsg.text) && /3\./.test(multiMsg.text));
check('кнопки на каждую трату', multiMsg.reply_markup.inline_keyboard.length === 3,
  'рядов: ' + multiMsg.reply_markup.inline_keyboard.length);

const multiRows = expenses().getRange(expenses().getLastRow() - 2, 1, 3, 17).getValues();
check('суммы записаны верно', multiRows.map(r => r[2]).join(',') === '250,80,45',
  multiRows.map(r => r[2]).join(','));
check('категории записаны верно',
  multiRows[1][5] === 'Транспорт и автомобиль' && multiRows[2][5] === 'Здоровье и аптека');
check('у каждой траты свой идентификатор',
  new Set(multiRows.map(r => r[16])).size === 3);

console.log('\n=== Несколько трат, одна без суммы: не пишем ничего ===');
gemini({
  text: () => ({
    isExpense: true,
    expenses: [
      { amount: 250, currency: 'ILS', date: '', description: 'продукты', store: '', category: 'Продукты', subcategory: '' },
      { amount: 0, currency: 'ILS', date: '', description: 'бензин', store: '', category: 'Транспорт и автомобиль', subcategory: '' }
    ],
    comment: 'не названа сумма за бензин'
  })
});
const beforePartial = rowsCount();
post({ message: msg({ text: '250 продукты и ещё бензин' }) });
check('НИЧЕГО не записано, пока не ясны все суммы', rowsCount() === beforePartial,
  'добавлено: ' + (rowsCount() - beforePartial));
const askMsg = sent[sent.length - 1].text;
check('бот показал разобранное', /продукты/.test(askMsg) && /бензин/.test(askMsg));
check('бот пометил, где не хватает суммы', /сумма\?/.test(askMsg), askMsg.split('\n').join(' | '));
check('бот объяснил, почему не записал', /не записываю ничего/i.test(askMsg));
check('бот спросил про бензин', /Сколько потратили на «бензин»/.test(askMsg));

post({ message: msg({ text: '80' }) });
check('после ответа записаны обе траты', rowsCount() === beforePartial + 2,
  'добавлено: ' + (rowsCount() - beforePartial));
const bothRows = expenses().getRange(expenses().getLastRow() - 1, 1, 2, 17).getValues();
check('суммы обеих трат верны', bothRows.map(r => r[2]).join(',') === '250,80',
  bothRows.map(r => r[2]).join(','));

console.log('\n=== Три траты, две без сумм: спрашивает по очереди ===');
gemini({
  text: () => ({
    isExpense: true,
    expenses: [
      { amount: 0, currency: 'ILS', date: '', description: 'кофе', store: '', category: 'Кафе и рестораны', subcategory: '' },
      { amount: 100, currency: 'ILS', date: '', description: 'книги', store: '', category: 'Развлечения', subcategory: '' },
      { amount: 0, currency: 'ILS', date: '', description: 'парковка', store: '', category: 'Транспорт и автомобиль', subcategory: '' }
    ],
    comment: ''
  })
});
const beforeQueue = rowsCount();
post({ message: msg({ text: 'кофе, 100 книги и парковка' }) });
check('спросил про первую трату без суммы', /«кофе»/.test(sent[sent.length - 1].text));
post({ message: msg({ text: '18' }) });
check('ничего не записано после первого ответа', rowsCount() === beforeQueue,
  'добавлено: ' + (rowsCount() - beforeQueue));
check('спросил про вторую трату без суммы', /«парковка»/.test(sent[sent.length - 1].text),
  sent[sent.length - 1].text.split('\n')[0]);
post({ message: msg({ text: '12' }) });
check('после всех ответов записаны все три', rowsCount() === beforeQueue + 3,
  'добавлено: ' + (rowsCount() - beforeQueue));
const queueRows = expenses().getRange(expenses().getLastRow() - 2, 1, 3, 17).getValues();
check('суммы подставлены по порядку', queueRows.map(r => r[2]).join(',') === '18,100,12',
  queueRows.map(r => r[2]).join(','));

console.log('\n=== Сообщение не про траты ===');
gemini({ text: () => ({ isExpense: false, expenses: [], comment: '' }) });
const beforeChat = rowsCount();
post({ message: msg({ text: 'привет, как дела' }) });
check('ничего не записано', rowsCount() === beforeChat);
check('бот подсказал формат', /Не понял, что записать/.test(sent[sent.length - 1].text));

console.log('\n=== Модель недоступна: разбирает сам ===');
gemini({ text: null, category: () => null });
const beforeFallback = rowsCount();
post({ message: msg({ text: '90 бензин' }) });
check('расход всё равно записан', rowsCount() === beforeFallback + 1);
row = lastRow();
check('сумма верна', row[2] === 90, String(row[2]));
check('категория подобрана словарём', row[5] === 'Транспорт и автомобиль', String(row[5]));
check('источник категории «словарь»', row[13] === 'словарь', String(row[13]));
check('переход на свой разбор отмечен в логе',
  ss.getSheetByName('Лог').getDataRange().getValues().some(r => String(r[1]).includes('без модели')));

console.log('\n=== Модель недоступна и суммы нет ===');
const beforeFallbackAsk = rowsCount();
post({ message: msg({ text: 'заправка' }) });
check('запись не создана', rowsCount() === beforeFallbackAsk);
check('бот переспросил', /Сколько потратили/.test(sent[sent.length - 1].text));
post({ message: msg({ text: '200' }) });
check('после ответа записано', rowsCount() === beforeFallbackAsk + 1);
gemini({});   // возвращаем модель в строй

console.log('\n=== Передумал: вместо ответа записал другое ===');
post({ message: msg({ text: 'обед в городе' }) });          // суммы нет → бот переспросил
const beforeSwitch = rowsCount();
post({ message: msg({ text: '120 такси' }) });               // ответ с описанием = новая запись
check('записана новая трата, а не старая', rowsCount() === beforeSwitch + 1);
row = lastRow();
check('описание из нового сообщения', String(row[7]) === 'такси', String(row[7]));
check('категория по новому описанию', row[5] === 'Транспорт и автомобиль', String(row[5]));

console.log('\n=== Отмена незавершённой записи ===');
post({ message: msg({ text: 'что-то без суммы' }) });
const beforeCancel = rowsCount();
post({ message: msg({ text: '/otmena' }) });
check('бот подтвердил отмену', /отменена/i.test(sent[sent.length - 1].text));
post({ message: msg({ text: '70' }) });
row = lastRow();
check('после отмены число — самостоятельная запись', row[2] === 70 && !String(row[7]).includes('что-то'),
  String(row[2]) + ' / ' + String(row[7]));

// --- 4. Голосовое ------------------------------------------------------------
console.log('\n=== Голосовое сообщение ===');
gemini({ voice: () => ({
  transcript: 'двести тридцать шекелей в супермаркете рами леви',
  isExpense: true,
  expenses: [{
    amount: 230, currency: 'ILS', date: '', description: 'продукты в Рами Леви',
    store: 'Рами Леви', category: 'Продукты', subcategory: 'Супермаркет'
  }]
}) });
post({ message: msg({ voice: { file_id: 'voice1', duration: 6 } }) });
row = lastRow();
check('голос записан', row[2] === 230, String(row[2]));
check('способ ввода «голос»', row[11] === 'голос', String(row[11]));
check('расшифровка в таблице', String(row[12]).includes('рами леви'), String(row[12]));
check('ссылка на файл сохранена', String(row[14]) === 'tg:voice1', String(row[14]));
check('расшифровка показана пользователю', /Расслышал/.test(sent[sent.length - 1].text));

console.log('\n=== Голосовое длиннее минуты ===');
const beforeLong = rowsCount();
post({ message: msg({ voice: { file_id: 'voice2', duration: 95 } }) });
check('длинное голосовое не записано', rowsCount() === beforeLong);
check('бот попросил написать текстом', /текстом/i.test(sent[sent.length - 1].text));

console.log('\n=== Модель вернула мусор ===');
gemini({ voice: () => null }); // имитируем сбой Gemini
const beforeBroken = rowsCount();
post({ message: msg({ voice: { file_id: 'voice3', duration: 5 } }) });
check('при сбое модели запись не создана', rowsCount() === beforeBroken);
check('бот сообщил о неудаче', /не разобрал/i.test(sent[sent.length - 1].text));
check('сбой попал в лог', ss.getSheetByName('Лог').getLastRow() > 1);

// --- 5. Чек ------------------------------------------------------------------
console.log('\n=== Фото чека (прочитан) ===');
gemini({ receipt: () => ({ receipts: [{
  total: 187.4, currency: 'ILS', datetime: '2026-08-10 18:22', store: 'שופרסל דיל',
  category: 'Продукты', subcategory: 'Супермаркет',
  items: [{ name: 'לחם', price: 8.9 }, { name: 'חלב', price: 6.5 }],
  tips: 0, readable: true, note: ''
}] }) });
post({ message: msg({ photo: [{ file_id: 'small' }, { file_id: 'big' }], caption: '' }) });
row = lastRow();
check('чек записан', row[2] === 187.4, String(row[2]));
check('способ ввода «фото»', row[11] === 'фото', String(row[11]));
check('магазин записан', String(row[8]).includes('שופרסל'), String(row[8]));
check('позиции записаны одной строкой', String(row[9]).includes('לחם'), String(row[9]));
check('дата взята с чека (10.08.2026)', String(ctx.formatDate_(row[1])) === '10.08.2026',
  String(ctx.formatDate_(row[1])));
check('взят самый большой размер фото', M.httpLog.some(h => JSON.stringify(h.payload).includes('big')));

console.log('\n=== Фото чека (нечитаемый) ===');
gemini({ receipt: () => ({ receipts: [{
  total: 0, currency: 'ILS', datetime: '', store: '', category: 'Без категории',
  items: [], tips: 0, readable: false, note: 'смазано, итог не виден'
}] }) });
const beforeUnreadable = rowsCount();
post({ message: msg({ photo: [{ file_id: 'blurry' }] }) });
check('без подтверждения запись не создана', rowsCount() === beforeUnreadable);
check('бот показал, что смог разобрать', /не полностью/i.test(sent[sent.length - 1].text));
post({ message: msg({ text: '95.50' }) });
check('после ручной суммы запись создана', rowsCount() === beforeUnreadable + 1);
row = lastRow();
check('сумма из ответа пользователя', row[2] === 95.5, String(row[2]));
check('способ ввода остался «фото»', row[11] === 'фото', String(row[11]));

console.log('\n=== Чек с чаевыми и подписью ===');
gemini({ receipt: () => ({ receipts: [{
  total: 240, currency: 'ILS', datetime: '', store: 'Мисада',
  category: 'Кафе и рестораны', subcategory: 'Ресторан',
  items: [], tips: 30, readable: true, note: ''
}] }) });
post({ message: msg({ photo: [{ file_id: 'rest' }], caption: 'ужин с друзьями' }) });
row = lastRow();
check('сумма с чаевыми', row[2] === 240, String(row[2]));
check('подпись стала описанием', String(row[7]).includes('ужин с друзьями'), String(row[7]));
check('чаевые отмечены в описании', /чаев/i.test(String(row[7])), String(row[7]));
check('нет даты с чека → пометка в описании', /дата.*не прочит/i.test(String(row[7])), String(row[7]));

console.log('\n=== Перевод названий с чека ===');
gemini({
  receipt: () => ({
    receipts: [{
      total: 88, currency: 'ILS', datetime: '', store: 'שופרסל דיל', storeRu: 'Шуферсаль Диль',
      category: 'Продукты', subcategory: 'Супермаркет',
      items: [
        { name: 'молоко 3%', original: 'חלב 3%', price: 6.5 },
        { name: 'хлеб', original: 'לחם אחיד', price: 8.9 }
      ],
      tips: 0, readable: true, note: ''
    }]
  })
});
post({ message: msg({ photo: [{ file_id: 'hebrew1' }] }) });
row = lastRow();
check('магазин: оригинал и перевод в скобках',
  String(row[8]) === 'שופרסל דיל (Шуферсаль Диль)', String(row[8]));
check('позиции записаны по-русски',
  String(row[9]).includes('молоко 3%') && String(row[9]).includes('хлеб'), String(row[9]));
check('иврит в позициях не остался', !/[֐-׿]/.test(String(row[9])), String(row[9]));

const dict = ss.getSheetByName('Переводы').getDataRange().getValues();
check('переводы попали в словарь', dict.length > 3, 'строк: ' + dict.length);
check('в словаре есть магазин', dict.some(r => String(r[0]) === 'שופרסל דיל'));
check('в словаре есть позиция', dict.some(r => String(r[0]) === 'חלב 3%'));

// Тот же магазин, но модель предлагает другой перевод — должен победить словарь
gemini({
  receipt: () => ({
    receipts: [{
      total: 45, currency: 'ILS', datetime: '', store: 'שופרסל דיל', storeRu: 'Шупэрсаль Дил',
      category: 'Продукты', subcategory: '',
      items: [{ name: 'молоко трёхпроцентное', original: 'חלב 3%', price: 6.5 }],
      tips: 0, readable: true, note: ''
    }]
  })
});
post({ message: msg({ photo: [{ file_id: 'hebrew2' }] }) });
row = lastRow();
check('магазин переведён так же, как в первый раз',
  String(row[8]) === 'שופרסל דיל (Шуферсаль Диль)', String(row[8]));
check('позиция переведена так же, как в первый раз',
  String(row[9]).includes('молоко 3%'), String(row[9]));
check('словарь не раздулся дублями',
  ss.getSheetByName('Переводы').getDataRange().getValues().length === dict.length,
  'было ' + dict.length + ', стало ' + ss.getSheetByName('Переводы').getDataRange().getValues().length);

// Русское название переводить незачем
gemini({
  receipt: () => ({
    receipts: [{
      total: 30, currency: 'ILS', datetime: '', store: 'Пекарня у дома', storeRu: '',
      category: 'Продукты', subcategory: '',
      items: [{ name: 'булка', original: '', price: 30 }],
      tips: 0, readable: true, note: ''
    }]
  })
});
post({ message: msg({ photo: [{ file_id: 'russian1' }] }) });
row = lastRow();
check('русское название осталось без скобок', String(row[8]) === 'Пекарня у дома', String(row[8]));

console.log('\n=== Два чека на одной фотографии ===');
gemini({
  receipt: () => ({
    receipts: [
      {
        total: 143.2, currency: 'ILS', datetime: '2026-08-14 12:10', store: 'Рами Леви',
        category: 'Продукты', subcategory: 'Супермаркет',
        items: [{ name: 'молоко', price: 6.5 }], tips: 0, readable: true, note: ''
      },
      {
        total: 62, currency: 'ILS', datetime: '2026-08-14 12:40', store: 'Супер Фарм',
        category: 'Здоровье и аптека', subcategory: 'Аптека',
        items: [], tips: 0, readable: true, note: ''
      }
    ]
  })
});
const beforeTwoReceipts = rowsCount();
post({ message: msg({ photo: [{ file_id: 'two_receipts' }] }) });
check('оба чека записаны отдельными строками', rowsCount() === beforeTwoReceipts + 2,
  'добавлено: ' + (rowsCount() - beforeTwoReceipts));
const twoRows = expenses().getRange(expenses().getLastRow() - 1, 1, 2, 17).getValues();
check('суммы обоих чеков', twoRows.map(r => r[2]).join(',') === '143.2,62',
  twoRows.map(r => r[2]).join(','));
check('магазины разные', twoRows[0][8] === 'Рами Леви' && twoRows[1][8] === 'Супер Фарм',
  twoRows.map(r => r[8]).join(' / '));
check('категории разные', twoRows[0][5] === 'Продукты' && twoRows[1][5] === 'Здоровье и аптека');
check('у обоих ссылка на один снимок', twoRows.every(r => r[14] === 'tg:two_receipts'));
check('даты взяты с чеков', ctx.formatDate_(twoRows[0][1]) === '14.08.2026',
  ctx.formatDate_(twoRows[0][1]));
check('в сводке обе траты', /143/.test(sent[sent.length - 1].text) && /62/.test(sent[sent.length - 1].text));

console.log('\n=== Два чека, у одного не читается итог ===');
gemini({
  receipt: () => ({
    receipts: [
      {
        total: 90, currency: 'ILS', datetime: '', store: 'Виктори',
        category: 'Продукты', subcategory: '', items: [], tips: 0, readable: true, note: ''
      },
      {
        total: 0, currency: 'ILS', datetime: '', store: 'Кафе Ландвер',
        category: 'Кафе и рестораны', subcategory: '', items: [], tips: 0,
        readable: false, note: 'итог смазан'
      }
    ]
  })
});
const beforePartialReceipts = rowsCount();
post({ message: msg({ photo: [{ file_id: 'partial_receipts' }] }) });
check('не записано НИЧЕГО, пока не ясны все суммы', rowsCount() === beforePartialReceipts,
  'добавлено: ' + (rowsCount() - beforePartialReceipts));
const receiptAsk = sent[sent.length - 1].text;
check('показал, что нашёл два чека', /2 чека/.test(receiptAsk), receiptAsk.split('\n')[0]);
check('пометил, где не хватает суммы', /сумма\?/.test(receiptAsk));
check('спросил про нужный чек', /Ландвер/.test(receiptAsk));
post({ message: msg({ text: '54' }) });
check('после ответа записаны оба', rowsCount() === beforePartialReceipts + 2,
  'добавлено: ' + (rowsCount() - beforePartialReceipts));
const partialRows = expenses().getRange(expenses().getLastRow() - 1, 1, 2, 17).getValues();
check('суммы верны', partialRows.map(r => r[2]).join(',') === '90,54',
  partialRows.map(r => r[2]).join(','));

console.log('\n=== Чек, присланный файлом ===');
gemini({ receipt: () => ({ receipts: [{
  total: 55, currency: 'ILS', datetime: '', store: 'Аптека',
  category: 'Здоровье и аптека', subcategory: 'Аптека',
  items: [], tips: 0, readable: true, note: ''
}] }) });
post({ message: msg({ document: { file_id: 'doc1', mime_type: 'image/png' } }) });
row = lastRow();
check('изображение-документ обработано как чек', row[2] === 55, String(row[2]));

const beforePdf = rowsCount();
post({ message: msg({ document: { file_id: 'doc2', mime_type: 'application/pdf' } }) });
check('не-изображение не записано', rowsCount() === beforePdf);
check('бот объяснил, что умеет', /изображения/i.test(sent[sent.length - 1].text));

// --- 6. Кнопки ---------------------------------------------------------------
console.log('\n=== Кнопки под записью ===');
const targetId = String(lastRow()[16]);
post({
  callback_query: {
    id: 'cb1', from: HUSBAND, data: 'cat:' + targetId,
    message: { message_id: 10, chat: { id: 555 }, text: 'Категория: Кафе и рестораны' }
  }
});
const kb = edits[edits.length - 1].reply_markup.inline_keyboard;
check('показан список категорий', kb.length > 3, 'рядов: ' + kb.length);

const catBtn = kb.flat().find(b => b.text.includes('Продукты'));
post({
  callback_query: {
    id: 'cb2', from: HUSBAND, data: catBtn.callback_data,
    message: { message_id: 10, chat: { id: 555 }, text: 'Категория: Кафе и рестораны' }
  }
});
const subKb = edits[edits.length - 1].reply_markup.inline_keyboard;
check('предложены подкатегории', subKb.flat().some(b => b.text.includes('Супермаркет')));

const subBtn = subKb.flat().find(b => b.text.includes('Супермаркет'));
post({
  callback_query: {
    id: 'cb3', from: HUSBAND, data: subBtn.callback_data,
    message: { message_id: 10, chat: { id: 555 }, text: 'Категория: Кафе и рестораны' }
  }
});
row = lastRow();
check('категория изменена', row[5] === 'Продукты', String(row[5]));
check('подкатегория изменена', row[6] === 'Супермаркет', String(row[6]));
check('источник категории «вручную»', row[13] === 'вручную', String(row[13]));

console.log('\n=== Кнопки внутри сводки на несколько трат ===');
const groupIds = multiRows.map(r => String(r[16]));
const groupMsg = () => ({
  message_id: 20, chat: { id: 555 },
  text: multiMsg.text.replace(/<[^>]+>/g, ''),
  reply_markup: multiMsg.reply_markup
});

// Удаляем вторую из трёх
post({ callback_query: { id: 'g1', from: HUSBAND, data: 'del:' + groupIds[1], message: groupMsg() } });
const afterGroupDelete = expenses().getDataRange().getValues();
const findById = id => afterGroupDelete.find(r => String(r[16]) === id);
check('вторая трата помечена удалённой', String(findById(groupIds[1])[15]) === 'да');
check('первая трата не тронута', String(findById(groupIds[0])[15]) === '');
check('третья трата не тронута', String(findById(groupIds[2])[15]) === '');

const groupEdit = edits[edits.length - 1];
check('в сводке появилась пометка об удалении', /Удалено/.test(groupEdit.text), groupEdit.text.slice(-60));
check('в пометке видно, что именно удалили', /бензин/.test(groupEdit.text));
check('остальные строки сводки на месте', /продукты/.test(groupEdit.text) && /аптека/.test(groupEdit.text));
check('кнопки удалённой траты убраны', groupEdit.reply_markup.inline_keyboard.length === 2,
  'рядов: ' + groupEdit.reply_markup.inline_keyboard.length);

// Меняем категорию первой из трёх
post({ callback_query: { id: 'g2', from: HUSBAND, data: 'cat:' + groupIds[0], message: groupMsg() } });
const groupCatKb = edits[edits.length - 1].reply_markup.inline_keyboard;
const detiBtn = groupCatKb.flat().find(b => b.text.includes('Дети'));
post({ callback_query: { id: 'g3', from: HUSBAND, data: detiBtn.callback_data, message: groupMsg() } });
const subKbGroup = edits[edits.length - 1].reply_markup.inline_keyboard;
const anySub = subKbGroup.flat().find(b => b.text.includes('Детские товары'));
post({ callback_query: { id: 'g4', from: HUSBAND, data: anySub.callback_data, message: groupMsg() } });

const changed = expenses().getDataRange().getValues().find(r => String(r[16]) === groupIds[0]);
check('категория первой траты изменена', changed[5] === 'Дети', String(changed[5]));
check('подкатегория изменена', changed[6] === 'Детские товары', String(changed[6]));
check('остальные категории не тронуты',
  expenses().getDataRange().getValues().find(r => String(r[16]) === groupIds[2])[5] === 'Здоровье и аптека');

const catEdit = edits[edits.length - 1];
check('в сводке пометка о смене категории', /→ Дети/.test(catEdit.text), catEdit.text.slice(-60));
check('кнопки сводки вернулись, а не схлопнулись в одну пару',
  catEdit.reply_markup.inline_keyboard.length === 3,
  'рядов: ' + catEdit.reply_markup.inline_keyboard.length);

console.log('\n=== Голосом несколько трат ===');
gemini({
  voice: () => ({
    transcript: 'сто двадцать шекелей такси и двести на продукты',
    isExpense: true,
    expenses: [
      { amount: 120, currency: 'ILS', date: '', description: 'такси', store: '', category: 'Транспорт и автомобиль', subcategory: '' },
      { amount: 200, currency: 'ILS', date: '', description: 'продукты', store: '', category: 'Продукты', subcategory: '' }
    ]
  })
});
const beforeVoiceMulti = rowsCount();
post({ message: msg({ voice: { file_id: 'voice_multi', duration: 8 } }) });
check('обе траты из голосового записаны', rowsCount() === beforeVoiceMulti + 2,
  'добавлено: ' + (rowsCount() - beforeVoiceMulti));
check('расшифровка показана', /Расслышал/.test(sent[sent.length - 1].text));
const voiceRows = expenses().getRange(expenses().getLastRow() - 1, 1, 2, 17).getValues();
check('способ ввода «голос» у обеих', voiceRows.every(r => r[11] === 'голос'));
check('ссылка на файл у обеих', voiceRows.every(r => r[14] === 'tg:voice_multi'));

console.log('\n=== Удаление ===');
post({
  callback_query: {
    id: 'cb4', from: HUSBAND, data: 'del:' + targetId,
    message: { message_id: 10, chat: { id: 555 }, text: 'запись' }
  }
});
const deletedRow = expenses().getDataRange().getValues().find(r => String(r[16]) === targetId);
check('строка помечена удалённой', String(deletedRow[15]) === 'да', String(deletedRow[15]));
check('строка физически на месте', !!deletedRow && expenses().getLastRow() > 1);
check('удалённая не попадает в сводки', !call('reportLastTen_').includes('Мисада'));

// --- 7. Посторонний ----------------------------------------------------------
console.log('\n=== Чужой пользователь: бот молчит ===');
const beforeStranger = rowsCount();
const sentBeforeStranger = sent.length;
post({ message: { message_id: 1, chat: { id: 999 }, from: { id: 999, first_name: 'Чужой' }, text: '100 такси' } });
check('чужая запись не создана', rowsCount() === beforeStranger);
check('чужому не отправлено ничего', sent.length === sentBeforeStranger,
  'ушло сообщений: ' + (sent.length - sentBeforeStranger));

post({ message: { message_id: 2, chat: { id: 999 }, from: { id: 999 }, text: '/whoami' } });
check('на /whoami от чужого тоже молчит', sent.length === sentBeforeStranger);

post({ message: { message_id: 3, chat: { id: 999 }, from: { id: 999 }, text: '/start' } });
check('на /start от чужого тоже молчит', sent.length === sentBeforeStranger);

post({
  callback_query: {
    id: 'cbX', from: { id: 999 }, data: 'del:123',
    message: { message_id: 11, chat: { id: 999 }, text: 'x' }
  }
});
check('кнопку чужого не обработал', sent.length === sentBeforeStranger);

const logRows = ss.getSheetByName('Лог').getDataRange().getValues();
check('попытка записана в лог', logRows.some(r => String(r[1]).includes('постороннего')));
check('в логе виден айди чужого — по нему и заполняется белый список',
  logRows.some(r => String(r[2]).includes('999')));

console.log('\n=== /whoami для своих ===');
post({ message: msg({ text: '/whoami' }) });
check('свой айди показан', sent[sent.length - 1].text.includes('111'));
check('айди чата показан', sent[sent.length - 1].text.includes('555'));

// --- 8. Команды и отчёты -----------------------------------------------------
console.log('\n=== Команды ===');
post({ message: msg({ text: '/segodnya' }) });
check('сумма за сегодня отвечает', /Сегодня/i.test(sent[sent.length - 1].text));
post({ message: msg({ text: '/mesyac' }) });
check('месяц по категориям отвечает', /Всего/i.test(sent[sent.length - 1].text));
post({ message: msg({ text: '/poslednie' }) });
check('последние записи отвечают', /Последние записи/i.test(sent[sent.length - 1].text));
post({ message: msg({ text: '/spravka' }) });
check('справка отвечает', /Как записывать расходы/i.test(sent[sent.length - 1].text));
post({ message: msg({ text: '/nesushchestvuyet' }) });
check('неизвестная команда обработана', /Такой команды нет/i.test(sent[sent.length - 1].text));

console.log('\n=== Разные валюты ===');
post({ message: msg({ text: '100 долларов авиабилет' }) });
row = lastRow();
check('валюта USD', row[3] === 'USD', String(row[3]));
check('пересчёт в шекели по курсу 3.7', row[4] === 370, String(row[4]));
check('в ответе показан пересчёт', /базовой валюте/i.test(sent[sent.length - 1].text));

console.log('\n=== Месячный отчёт ===');
call('sendMonthlyReport');
const report = sent[sent.length - 1];
check('отчёт ушёл в чат из настроек', String(report.chat_id) === '-100500', String(report.chat_id));

// Несколько адресатов через запятую: каждый получает свой экземпляр
for (let r = 1; r <= settings.getLastRow(); r++) {
  if (settings.getRange(r, 1).getValues()[0][0] === 'Чат месячного отчёта') {
    settings.getRange(r, 2).setValue('111, 222');
  }
}
ctx.SETTINGS_CACHE_ = null;
const sentBeforeReport = sent.length;
call('sendMonthlyReport');
const twoReports = sent.slice(sentBeforeReport);
check('отчёт разослан обоим', twoReports.length === 2, 'отправлено: ' + twoReports.length);
check('адресаты те, что в настройках',
  twoReports.map(m => String(m.chat_id)).sort().join(',') === '111,222',
  twoReports.map(m => m.chat_id).join(','));
check('оба получили одинаковый текст', twoReports[0].text === twoReports[1].text);
const thisMonthReport = call('buildMonthlyReport_', new Date());
check('в отчёте есть итог', /Всего потрачено/.test(thisMonthReport));
check('в отчёте есть топ-5', /Пять самых крупных/.test(thisMonthReport));
check('в отчёте есть разбивка по категориям', /По категориям/.test(thisMonthReport));

console.log('\n=== Запись второго пользователя и разбивка по авторам ===');
post({ message: { message_id: 90, chat: { id: 555 }, from: WIFE, text: '77 аптека' } });
const twoAuthors = call('buildMonthlyReport_', new Date());
check('в отчёте появилась разбивка по авторам', /Кто сколько записал/.test(twoAuthors));
check('оба автора в отчёте', /Анатолий/.test(twoAuthors) && /Жена/.test(twoAuthors));

// --- 9. Устойчивость ---------------------------------------------------------
console.log('\n=== Устойчивость ===');
const before = rowsCount();
call('doPost', { postData: { contents: 'это не json' } });
check('битый запрос не роняет бота', rowsCount() === before);
call('doPost', {});
check('пустой запрос не роняет бота', rowsCount() === before);

gemini({ text: null, category: () => null });
post({ message: msg({ text: '55 нечто непонятное совсем' }) });
row = lastRow();
check('при сбое модели расход всё равно записан', row[2] === 55, String(row[2]));
check('категория «Без категории»', row[5] === 'Без категории', String(row[5]));

console.log('\n=== Подбор рабочей модели ===');
// Каталог как в жизни: узкоспециальные модели вперемешку с обычными
M.setModelCatalog([
  { name: 'gemini-3.7-flash-video-understanding-eap' },  // ловушка: свежая, но для видео
  { name: 'gemini-3.5-flash-image-preview' },            // ловушка: генерация картинок
  { name: 'gemini-3-flash' },
  { name: 'gemini-3-flash-lite' },
  { name: 'gemini-3-pro' },
  { name: 'gemini-2.5-flash' },
  { name: 'imagen-4.0-generate' },
  { name: 'gemini-embedding-001', methods: ['embedContent'] }
]);
gemini({ probe: () => ({ ok: true }) });

const picked = call('autoSelectModels');
check('видео-модель из early access не выбрана', !/video-understanding/.test(call('modelForMedia_')),
  call('modelForMedia_'));
check('для медиа выбрана обычная flash', call('modelForMedia_') === 'gemini-3-flash',
  call('modelForMedia_'));
check('для текста выбрана дешёвая lite', call('modelForText_') === 'gemini-3-flash-lite',
  call('modelForText_'));
check('обе проверены запросом', /проверены пробным запросом/.test(picked));
check('генераторы картинок и эмбеддинги отсеяны', !/imagen|embedding|image-preview/.test(picked));

console.log('\n=== Подбор, когда лучший кандидат не отвечает ===');
// Первый по рангу отвечает отказом — должен взяться следующий
gemini({
  probe: (payload, url) => url.includes('gemini-3-flash:') ? null : { ok: true }
});
const picked2 = call('autoSelectModels');
check('неотвечающая модель пропущена', call('modelForMedia_') !== 'gemini-3-flash',
  call('modelForMedia_'));
check('взят следующий кандидат', call('modelForMedia_') === 'gemini-3-pro' || call('modelForMedia_') === 'gemini-2.5-flash',
  call('modelForMedia_'));
check('в отчёте сказано, что не подошло', /Не подошли/.test(picked2), picked2.split('\n').slice(-3).join(' | '));

gemini({ probe: () => ({ ok: true }) });
call('autoSelectModels');   // возвращаем нормальный выбор

const listed = call('listGeminiModels');
check('список моделей показывается', /Доступно моделей: 7/.test(listed), listed.split('\n')[0]);

console.log('\n=== Курсы валют из Google ===');
const ratesReport = call('enableAutoRates');
check('формулы проставлены', /USD→ILS/.test(ratesReport), ratesReport.split('\n')[0]);
check('курс доллара взят из Google', call('currencyRate_', 'USD') === 3.72,
  String(call('currencyRate_', 'USD')));
check('курс рубля взят из Google', call('currencyRate_', 'RUB') === 0.041,
  String(call('currencyRate_', 'RUB')));
check('курс базовой валюты к себе — единица', call('currencyRate_', 'ILS') === 1);

gemini({});
post({ message: msg({ text: '100 долларов авиабилет' }) });
row = lastRow();
check('пересчёт по свежему курсу', row[4] === 372, String(row[4]));

// Google перестал отдавать пару — курс не должен превратиться в единицу
M.setFinanceRates({ USDILS: 3.72, EURILS: 4.05 });   // RUB пропал
for (let r = 1; r <= settings.getLastRow(); r++) {
  if (String(settings.getRange(r, 1).getValues()[0][0]).trim() === 'Курс RUB') {
    settings.getRange(r, 2).setFormula('=GOOGLEFINANCE("CURRENCY:RUBILS")');
  }
}
ctx.SETTINGS_CACHE_ = null;
check('при ошибке формулы берётся последний известный курс',
  call('currencyRate_', 'RUB') === 0.041, String(call('currencyRate_', 'RUB')));

// И даже без запомненного значения — не единица, а приблизительный курс
delete M.scriptProps.RATE_RUB;
ctx.SETTINGS_CACHE_ = null;
check('без запомненного берётся приблизительный, а не единица',
  call('currencyRate_', 'RUB') === 0.042, String(call('currencyRate_', 'RUB')));

const shown = call('showRates');
check('показ курсов работает', /1 USD = 3.72 ILS/.test(shown), shown.split('\n')[2]);

// Возврат к ручным курсам
M.setFinanceRates({ USDILS: 3.72, EURILS: 4.05, RUBILS: 0.041 });
const frozen = call('disableAutoRates');
check('курсы можно зафиксировать числами', /USD = 3.72/.test(frozen), frozen.split('\n')[1]);
check('после фиксации курс тот же', call('currencyRate_', 'USD') === 3.72);

console.log('\n=== Свои имена вместо телеграмных ===');
for (let r = 1; r <= settings.getLastRow(); r++) {
  if (settings.getRange(r, 1).getValues()[0][0] === 'Разрешённые телеграм-айди') {
    settings.getRange(r, 2).setValue('111=Толя, 222=Маша');
  }
}
ctx.SETTINGS_CACHE_ = null;

check('доступ по-прежнему у обоих',
  ctx.isAllowedUser_(111) && ctx.isAllowedUser_(222));
check('чужой по-прежнему не пройдёт', !ctx.isAllowedUser_(999));

gemini({});
post({ message: msg({ text: '40 хлеб' }) });
row = lastRow();
check('автор записан заданным именем', row[10] === 'Толя', String(row[10]));

post({ message: { message_id: 91, chat: { id: 555 }, from: WIFE, text: '25 кофе' } });
row = lastRow();
check('у второго тоже своё имя', row[10] === 'Маша', String(row[10]));

check('в отчёте видны заданные имена',
  /Толя/.test(call('buildMonthlyReport_', new Date())) &&
  /Маша/.test(call('buildMonthlyReport_', new Date())));

// Формат без имени должен продолжать работать
for (let r = 1; r <= settings.getLastRow(); r++) {
  if (settings.getRange(r, 1).getValues()[0][0] === 'Разрешённые телеграм-айди') {
    settings.getRange(r, 2).setValue('111, 222');
  }
}
ctx.SETTINGS_CACHE_ = null;
post({ message: msg({ text: '15 вода' }) });
row = lastRow();
check('без имени в настройках берётся имя из телеграма', row[10] === 'Анатолий', String(row[10]));

// Возвращаем имена для остальных проверок
for (let r = 1; r <= settings.getLastRow(); r++) {
  if (settings.getRange(r, 1).getValues()[0][0] === 'Разрешённые телеграм-айди') {
    settings.getRange(r, 2).setValue('111=Толя, 222=Маша');
  }
}
ctx.SETTINGS_CACHE_ = null;

console.log('\n=== Приём сообщений опросом (без вебхука) ===');
// Телеграм отдаёт накопившиеся сообщения пачкой в ответ на getUpdates
let queued = [];
let lastOffset = null;
M.setTelegramResponder((url, payload) => {
  if (url.includes('/sendMessage')) { sent.push(payload); return { ok: true, result: { message_id: sent.length } }; }
  if (url.includes('/editMessageText') || url.includes('/editMessageReplyMarkup')) {
    edits.push(payload); return { ok: true, result: {} };
  }
  if (url.includes('/getUpdates')) {
    lastOffset = payload.offset;
    const batch = queued;
    queued = [];
    return { ok: true, result: batch };
  }
  if (url.includes('/deleteWebhook')) return { ok: true, result: true };
  if (url.includes('/getFile')) return { ok: true, result: { file_path: 'voice/file_1.oga' } };
  if (url.includes('/getMe')) return { ok: true, result: { username: 'test_bot' } };
  if (url.includes('/getWebhookInfo')) return { ok: true, result: { url: '', pending_update_count: 0 } };
  return { ok: true, result: {} };
});

const switched = call('switchToPolling');
check('вебхук снят', /Вебхук снят: да/.test(switched));
check('триггер опроса создан', M.triggers.some(t => t.getHandlerFunction() === 'pollUpdates'));
check('режим определяется', call('pollingEnabled_') === true);

// Кладём в очередь два накопившихся сообщения
gemini({});
const beforePoll = rowsCount();
queued = [
  { update_id: 5001, message: { message_id: 71, chat: { id: 555 }, from: HUSBAND, text: '120 зажигалка' } },
  { update_id: 5002, message: { message_id: 72, chat: { id: 555 }, from: WIFE, text: '60 кофе' } }
];
call('pollUpdates');
check('оба накопившихся сообщения обработаны', rowsCount() === beforePoll + 2,
  'добавлено: ' + (rowsCount() - beforePoll));
const polled = expenses().getRange(expenses().getLastRow() - 1, 1, 2, 17).getValues();
check('суммы записаны', polled.map(r => r[2]).join(',') === '120,60', polled.map(r => r[2]).join(','));
check('авторы разные и с заданными именами',
  polled[0][10] === 'Толя' && polled[1][10] === 'Маша',
  polled.map(r => r[10]).join(' / '));

check('указатель сдвинут за последнее сообщение',
  String(M.scriptProps.TELEGRAM_OFFSET) === '5003', String(M.scriptProps.TELEGRAM_OFFSET));

// Повторный опрос: телеграм присылает пустой список — ничего не дублируется
const beforeEmpty = rowsCount();
call('pollUpdates');
check('пустой опрос ничего не создаёт', rowsCount() === beforeEmpty);
check('следующий запрос идёт с указателем', lastOffset === 5003, String(lastOffset));

// Сообщение, которое роняет обработку, не должно останавливать очередь
const beforeBadUpdate = rowsCount();
queued = [
  { update_id: 5003, message: null, callback_query: null },
  { update_id: 5004, message: { message_id: 73, chat: { id: 555 }, from: HUSBAND, text: '30 хлеб' } }
];
call('pollUpdates');
check('битое сообщение не остановило очередь', rowsCount() === beforeBadUpdate + 1,
  'добавлено: ' + (rowsCount() - beforeBadUpdate));
check('указатель ушёл за оба', String(M.scriptProps.TELEGRAM_OFFSET) === '5005',
  String(M.scriptProps.TELEGRAM_OFFSET));

// --- Чек по ссылке из SMS ----------------------------------------------------
console.log('\n=== Чек по ссылке ===');

// Слепки ответов настоящих сервисов, урезанные до нескольких позиций
const pairzonDoc = {
  id: '11111111-1111-1111-1111-111111111111',
  documentType: 'receipt',
  createdDate: '2026-08-16T13:23:45',
  total: 321.2,
  totalVat: 42.95,
  numberOfItems: 3,
  payments: [{ amount: 321.2, name: 'ישראכרט מגנטי' }],
  store: {
    alias: 'Carrefour',
    address: 'יגאל אלון 31 חיפה',
    currency: 'ILS',
    business: { name: 'קרפור ישראל', englishName: 'YBitan', currency: 'ILS' }
  },
  items: [
    { index: 1, name: 'דגי תנובה נתחי פילה', price: 99.9, total: 74.43, weight: 745 },
    { index: 3, name: 'פיצה מרגריטה קפוא זן', price: 21.9, total: 21.9 },
    { index: 7, name: '12 ביצים L  מ.לסר', price: 14.24, total: 14.24 }
  ]
};

const weezmoDoc = [{
  id: '22222222-2222-2222-2222-222222222222',
  total: 149,
  currency: null,
  receiptType: 'Purchase',
  createdDate: '2026-04-19T12:13:17',
  items: [
    { name: 'דיגניטט כבל לוי', price: 45, quantity: 1, total: 0 },
    { name: 'טריקסיג סט ארגו', price: 25, quantity: 1, total: 0 },
    { name: 'trams סטופטמולן', price: 79, quantity: 1, total: 0 }
  ],
  tBranch: { branchName: 'קריית אתא' },
  tBusiness: { businessName: 'איקאה', businessNameEnglish: 'IKEA' }
}];

// Страница «Рами Леви» несёт данные чека в себе, плоским списком Nuxt:
// внутри объектов вместо значений стоят номера ячеек этого же списка.
// Итог 27.80 = 17.90 + (19.90 − 9.90 по акции) — заодно проверяем скидку.
const ramiNuxt = [
  { data: 1 },                                                              // 0
  { document_type: 2, created_at: 3, items: 4, payments: 11, company: 12, branch: 13, vat_rate: 8 },
  'receipt',                                                                // 2
  '2026-05-19T15:24:11.000000Z',                                            // 3
  [9, 10],                                                                  // 4
  0, 0, 0, 18,                                                              // 5..8 (8 — ставка НДС)
  { name: 14, price: 15, total: 15, quantity: 16, additional_info: 17 },     // 9
  { name: 18, price: 19, total: 19, quantity: 16, additional_info: 20 },     // 10
  { total: 24, total_vat: 25, vat: 8, methods: 26 },                         // 11
  { name: 22, legal_name: 22 },                                             // 12
  { name: 23 },                                                             // 13
  'מגבות נייר כפול 6 יח',                                                    // 14
  17.9, 1, [],                                                              // 15..17
  'אוכמניות 125 גרם',                                                        // 18
  19.9, [21],                                                               // 19..20
  { key: 27, value: 28 },                                                   // 21
  'רמי לוי שיווק השקמה',                                                     // 22
  'עזריאלי חיפה',                                                            // 23
  27.8, 4.24, [29],                                                         // 24..26
  'אוכמניות 2ב20', '-9.90',                                                  // 27..28
  { name: 30, amount: 24 },                                                 // 29
  'ישראכרט'                                                                 // 30
];

// Та же страница текстом: справа налево и с разорванными числами —
// ровно так, как отдаёт настоящий сайт
const ramiHtml = '<html><head><title>DIGI</title></head><body>' +
  '<div>היי לקוח,</div><div>הקבלה הדיגיטלית שלך</div><div>מס׳ 1932</div>' +
  '<div>19/05/2026</div><div>18:24</div><div>3 פריטים</div>' +
  '<div>מגבות נייר כפול 6 יח</div><div>1 יח\'</div><div>‏17 .90 ‏₪</div>' +
  '<div>פילה בורי ארוז טרי</div><div>0.721 ק"ג</div><div>‏71 .38 ‏₪</div>' +
  '<div>קשתית אסאדו ללא עצם</div><div>2.1 ק"ג</div><div>‏167 .79 ‏₪</div>' +
  '<div>‏257 .07 ‏₪</div><div>לתשלום</div>' +
  '<div>‏39 .21 ‏₪</div><div>מע"מ</div>' +
  '<div>סניף עזריאלי חיפה</div><div>רשת חנויות רמי לוי שיווק השקמה 2006 בע״מ</div>' +
  '<div>תודה שרכשת אצלנו! ח.פ 513770669 צלע ההר 17 מודיעין</div>' +
  '</body></html>';

const emptySpaHtml = '<html><head><title>Weezmo</title></head><body>' +
  '<div id="root"></div><script src="/receipt_builder-main.js"></script></body></html>';

const json = (body) => ({ code: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const html = (body) => ({ code: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: body });

const webCalls = [];
M.setWebResponder((url) => {
  webCalls.push(url);

  // Pairzon: короткая ссылка → страница-обёртка → готовый чек таблицей
  if (url === 'https://carrefour.pairzon.com/1185/PrimerCheka12345') {
    return { code: 302, headers: { Location: 'https://carrefour.pairzon.com/aaaa1111.html?id=11111111-1111-1111-1111-111111111111&p=1185' } };
  }
  if (url.indexOf('https://carrefour.pairzon.com/aaaa1111.html') === 0) return html(emptySpaHtml);
  if (url === 'https://carrefour.pairzon.com/v1.0/documents/11111111-1111-1111-1111-111111111111?p=1185') {
    return json(pairzonDoc);
  }

  // Weezmo: wee.ai → receipts.weezmo.com → готовый чек таблицей
  if (url === 'https://wee.ai/r/PrimerCheka67890') {
    return { code: 301, headers: { location: 'https://receipts.weezmo.com/cms.html?q=22222222-2222-2222-2222-222222222222&b=bbbb2222' } };
  }
  if (url === 'https://receipts.weezmo.com/cms.html?q=22222222-2222-2222-2222-222222222222&b=bbbb2222') {
    return { code: 302, headers: { Location: '/cms.html?q=22222222-2222-2222-2222-222222222222&b=bbbb2222&cookie=true' } };
  }
  if (url.indexOf('https://receipts.weezmo.com/cms.html') === 0) return html(emptySpaHtml);
  if (url === 'https://receipts.weezmo.com/api/receipts/22222222-2222-2222-2222-222222222222') {
    return json(weezmoDoc);
  }

  // «Рами Леви»: данные чека вшиты в страницу
  if (url === 'https://digi.rami-levy.co.il/PrimerCheka24680') {
    return html(ramiHtml.replace('</body>',
      '<script type="application/json" id="__NUXT_DATA__">' + JSON.stringify(ramiNuxt) + '</script></body>'));
  }

  // Незнакомый магазин: чек виден на странице, но разобрать его может только модель
  if (url === 'https://shop.example.com/r/9') return html(ramiHtml);

  // Незнакомая ссылка на PDF
  if (url === 'https://schet.example.com/doc/77') {
    return { code: 200, headers: { 'Content-Type': 'application/pdf' }, body: '%PDF-1.4', bytes: [37, 80, 68, 70] };
  }

  // Страница, которая собирается скриптом, и разбирать в ней нечего
  if (url === 'https://tihiy.example.com/r/1') return html(emptySpaHtml);

  return { code: 404, body: 'not found' };
});

// 1. Carrefour через Pairzon
gemini({
  enrich: () => ({
    storeRu: 'Карфур',
    category: 'Продукты',
    subcategory: 'Супермаркет',
    items: [
      { original: 'דגי תנובה נתחי פילה', name: 'филе рыбы «Тнува»' },
      { original: 'פיצה מרגריטה קפוא זן', name: 'пицца маргарита замороженная' },
      { original: '12 ביצים L  מ.לסר', name: 'яйца L, 12 шт.' }
    ]
  })
});

const beforePairzon = rowsCount();
webCalls.length = 0;
post({ message: msg({ text: 'התקבלה קבלה חדשה מקרפור (Carrefour) לצפייה לחץ כאן ' +
  'https://carrefour.pairzon.com/1185/PrimerCheka12345 הקבלה תישמר עבורך ' +
  'בהתאם לתנאי מדיניות הפרטיות https://www.carrefour.co.il/policies' }) });

check('чек по ссылке записан', rowsCount() === beforePairzon + 1, 'добавлено: ' + (rowsCount() - beforePairzon));
row = lastRow();
check('сумма взята точной', row[2] === 321.2, String(row[2]));
check('валюта ILS', row[3] === 'ILS', String(row[3]));
check('дата с чека, а не сегодняшняя', ctx.formatDate_(row[1]) === '16.08.2026', ctx.formatDate_(row[1]));
check('магазин распознан', /Carrefour/.test(String(row[8])), String(row[8]));
check('позиции переведены', /филе рыбы/.test(String(row[9])), String(row[9]).slice(0, 80));
check('способ ввода «ссылка»', row[11] === 'ссылка', String(row[11]));
check('ссылка сохранена в таблице', /pairzon/.test(String(row[14])), String(row[14]));
check('категория «Продукты»', row[5] === 'Продукты', String(row[5]));
check('по ссылке на политику приватности бот не ходил',
  !webCalls.some(u => u.indexOf('policies') !== -1), webCalls.join(' '));
check('в ответе показана сумма', sent[sent.length - 1].text.includes('321'));
check('в ответе список позиций столбиком',
  /Позиции \(3\):\n• филе рыбы/.test(sent[sent.length - 1].text),
  sent[sent.length - 1].text.slice(-200));
check('в списке все позиции чека',
  (sent[sent.length - 1].text.match(/\n• /g) || []).length === 3,
  String((sent[sent.length - 1].text.match(/\n• /g) || []).length));

// Длинный чек не должен упереться в предел телеграма (4096 знаков)
const longItems = [];
for (let i = 1; i <= 200; i++) longItems.push('позиция номер ' + i + ' подлиннее — ' + i + '.90');
const longBlock = ctx.itemsLines_(longItems.join('; '), 300).join('\n');
check('длинный список обрезан по месту', longBlock.length + 300 < 4096, String(longBlock.length + 300));
check('обрезка честно сказана', /и ещё \d+ — полный список в таблице/.test(longBlock),
  longBlock.slice(-80));

// 2. IKEA через Weezmo: короткая ссылка wee.ai и два перенаправления подряд
gemini({
  enrich: () => ({
    storeRu: 'ИКЕА',
    category: 'Дом и быт',
    subcategory: '',
    items: [
      { original: 'דיגניטט כבל לוי', name: 'ДИГНИТЕТ трос' },
      { original: 'טריקסיג סט ארגו', name: 'ТРИКСИГ набор органайзеров' },
      { original: 'trams סטופטמולן', name: 'СТОПТОМУЛЕН trams' }
    ]
  })
});

const beforeWeezmo = rowsCount();
post({ message: msg({ text: 'הגיעה אליך קבלה מאיקאה בהתאם למדיניות הפרטיות https://goo.gl/GNioVJ ' +
  'לצפייה: https://wee.ai/r/PrimerCheka67890 רוצה להתעדכן?' }) });

check('чек IKEA записан', rowsCount() === beforeWeezmo + 1, 'добавлено: ' + (rowsCount() - beforeWeezmo));
row = lastRow();
check('сумма 149', row[2] === 149, String(row[2]));
check('магазин IKEA', /IKEA/.test(String(row[8])), String(row[8]));
check('позиции переведены', /ДИГНИТЕТ/.test(String(row[9])), String(row[9]).slice(0, 80));
check('способ ввода «ссылка»', row[11] === 'ссылка', String(row[11]));

// 3. «Рами Леви»: данные чека вшиты в страницу, числа берём точными
gemini({
  enrich: () => ({
    storeRu: 'Рами Леви',
    category: 'Продукты',
    subcategory: 'Супермаркет',
    items: [
      { original: 'מגבות נייר כפול 6 יח', name: 'бумажные полотенца, 6 шт.' },
      { original: 'אוכמניות 125 גרם', name: 'черника 125 г' }
    ]
  })
});

const beforeRami = rowsCount();
post({ message: msg({ text: 'התקבלה קבלה חדשה מרמי לוי שיווק השקמה לצפייה לחץ כאן\n' +
  'https://digi.rami-levy.co.il/PrimerCheka24680' }) });

check('чек «Рами Леви» записан', rowsCount() === beforeRami + 1, 'добавлено: ' + (rowsCount() - beforeRami));
row = lastRow();
check('итог взят с учётом акции', row[2] === 27.8, String(row[2]));
check('дата переведена в местное время', ctx.formatDate_(row[1]) === '19.05.2026', ctx.formatDate_(row[1]));
check('магазин с филиалом', /רמי לוי/.test(String(row[8])) && /עזריאלי/.test(String(row[8])), String(row[8]));
check('позиции переведены', /черника/.test(String(row[9])), String(row[9]).slice(0, 90));
check('цена позиции уменьшена на скидку', /черника 125 г — 10/.test(String(row[9])), String(row[9]).slice(0, 90));

// 4. Незнакомый магазин: страницу читает модель
let pageTextSeen = '';
gemini({
  pageReceipt: (payload) => {
    pageTextSeen = JSON.stringify(payload);
    return {
      receipts: [{
        total: 257.07,
        currency: 'ILS',
        datetime: '2026-05-19 18:24',
        store: 'חנות',
        storeRu: 'Лавка',
        category: 'Продукты',
        subcategory: 'Супермаркет',
        items: [{ name: 'бумажные полотенца', original: 'מגבות נייר כפול 6 יח', price: 17.9 }],
        tips: 0,
        readable: true,
        note: ''
      }]
    };
  }
});

const beforeShop = rowsCount();
post({ message: msg({ text: 'קבלה חדשה https://shop.example.com/r/9' }) });

check('чек со страницы записан', rowsCount() === beforeShop + 1, 'добавлено: ' + (rowsCount() - beforeShop));
row = lastRow();
check('сумма 257.07', row[2] === 257.07, String(row[2]));
check('дата с чека', ctx.formatDate_(row[1]) === '19.05.2026', ctx.formatDate_(row[1]));
check('модели достался текст чека, а не разметка',
  pageTextSeen.includes('הקבלה הדיגיטלית') && !pageTextSeen.includes('<div>'));
check('разорванные цены собраны обратно',
  pageTextSeen.includes('17.90') && !pageTextSeen.includes('17 .90'));
check('знаки направления письма убраны', pageTextSeen.indexOf('\\u200f') === -1);

// 4. Незнакомая ссылка, за которой лежит PDF
gemini({
  receipt: () => ({
    receipts: [{
      total: 80, currency: 'ILS', datetime: '', store: 'Гараж', storeRu: '',
      category: 'Транспорт и автомобиль', subcategory: '', items: [], tips: 0,
      readable: true, note: ''
    }]
  })
});

const beforeLinkPdf = rowsCount();
post({ message: msg({ text: 'Счёт за мойку https://schet.example.com/doc/77' }) });
check('PDF по ссылке прочитан', rowsCount() === beforeLinkPdf + 1, 'добавлено: ' + (rowsCount() - beforeLinkPdf));
row = lastRow();
check('сумма из PDF', row[2] === 80, String(row[2]));
check('приписка по-русски стала описанием', /мойку/i.test(String(row[7])), String(row[7]));

// 5. Ссылка не открылась, но сумма есть в самой SMS
gemini({});
const beforeBrokenLink = rowsCount();
post({ message: msg({ text: 'Оплата 45.90 шек, чек: https://tihiy.example.com/r/1' }) });
check('без подтверждения ничего не записано', rowsCount() === beforeBrokenLink,
  'добавлено: ' + (rowsCount() - beforeBrokenLink));
check('бот предложил сумму из сообщения', /не смог прочитать чек по ссылке/i.test(sent[sent.length - 1].text),
  sent[sent.length - 1].text.slice(0, 80));
check('предложены кнопки', !!(sent[sent.length - 1].reply_markup));

post({ callback_query: { id: 'cb-link', from: HUSBAND, data: 'ok:111',
  message: { message_id: 900, chat: { id: 555 } } } });
check('после подтверждения запись создана', rowsCount() === beforeBrokenLink + 1,
  'добавлено: ' + (rowsCount() - beforeBrokenLink));
row = lastRow();
check('записана сумма из SMS', row[2] === 45.9, String(row[2]));
check('способ ввода «ссылка»', row[11] === 'ссылка', String(row[11]));

// 6. Ссылка не открылась и суммы в тексте нет
const beforeHopeless = rowsCount();
post({ message: msg({ text: 'קבלה חדשה https://tihiy.example.com/r/1' }) });
check('ничего не записано', rowsCount() === beforeHopeless);
check('бот объяснил, что делать', /скриншот/i.test(sent[sent.length - 1].text),
  sent[sent.length - 1].text.slice(0, 80));

// 7. Обычная ссылка без чека не должна мешать обычному разбору текста
check('служебные ссылки отсеиваются',
  ctx.receiptLinksIn_('чек https://shop.example.com/r/9 и https://example.com/privacy')
    .join(',') === 'https://shop.example.com/r/9');
check('точка в конце фразы не попадает в адрес',
  ctx.findLinks_('чек тут https://example.com/r/9.')[0] === 'https://example.com/r/9');

// --- Доходы ------------------------------------------------------------------
console.log('\n=== Доходы, возвраты и переводы ===');

const incomesSheet = () => ss.getSheetByName('Доходы');
const incomeRows = () => Math.max(0, incomesSheet().getLastRow() - 1);
const lastIncome = () => incomesSheet().getRange(incomesSheet().getLastRow(), 1, 1, 17).getValues()[0];

check('лист «Доходы» создан', !!incomesSheet());
check('справочник доходных категорий заполнен',
  ss.getSheetByName('Категории доходов').getLastRow() > 3,
  'строк: ' + ss.getSheetByName('Категории доходов').getLastRow());

// В таблице, заведённой до появления доходов, справочника нет — он должен
// создаться сам, без повторного запуска первичной настройки
const incomeCatSheet = ss.getSheetByName('Категории доходов');
incomeCatSheet.data = [incomeCatSheet.data[0]];
ctx.INCOME_CATEGORIES_CACHE_ = null;
check('пустой справочник наполняется сам', ctx.incomeCategoryNames_().length > 3,
  'категорий: ' + ctx.incomeCategoryNames_().length);

// Модель размечает вид операции; проверяем весь путь от текста до листа
gemini({
  text: (payload) => {
    const prompt = JSON.stringify(payload);
    const m = prompt.match(/Сообщение: «(.*?)»\\n\\n/);
    const text = m ? m[1] : '';
    const kind = ctx.detectOperationKind_(text);
    const p = ctx.parseExpenseText_(text.replace(/\+/g, ''));
    return {
      isExpense: true,
      expenses: [{
        amount: p.amount || 0,
        currency: p.currency,
        date: '',
        description: p.description,
        store: '',
        kind: kind,
        category: kind === 'доход' ? 'Зарплата' : ctx.categorize_(p.description, '').category,
        subcategory: ''
      }],
      comment: ''
    };
  }
});

// 1. Доход с плюсом
const beforeIncome = incomeRows();
const beforeExpenseRows = rowsCount();
post({ message: msg({ text: '+12000 зарплата' }) });
check('доход записан в лист «Доходы»', incomeRows() === beforeIncome + 1,
  'добавлено: ' + (incomeRows() - beforeIncome));
check('в расходы ничего не попало', rowsCount() === beforeExpenseRows);
let incomeRow = lastIncome();
check('сумма 12000', incomeRow[2] === 12000, String(incomeRow[2]));
check('категория из доходного справочника', incomeRow[5] === 'Зарплата', String(incomeRow[5]));
check('бот назвал это доходом', /Записал доход/.test(sent[sent.length - 1].text),
  sent[sent.length - 1].text.slice(0, 60));
check('есть кнопка переноса в расходы',
  JSON.stringify(sent[sent.length - 1].reply_markup).includes('toexp:'),
  JSON.stringify(sent[sent.length - 1].reply_markup).slice(0, 120));

// 2. Кнопка «Это расход» переносит запись обратно
const incomeId = String(incomeRow[16]);
const beforeMove = rowsCount();
post({ callback_query: { id: 'mv1', from: HUSBAND, data: 'toexp:' + incomeId,
  message: { message_id: 300, chat: { id: 555 }, text: 'Записал доход: 12 000 ₪' } } });
check('запись появилась в расходах', rowsCount() === beforeMove + 1,
  'добавлено: ' + (rowsCount() - beforeMove));
check('сумма перенесена', lastRow()[2] === 12000, String(lastRow()[2]));
check('прежняя строка в доходах помечена удалённой',
  String(incomesSheet().getRange(incomesSheet().getLastRow(), 16).getValues()[0][0]) === 'да');
check('бот отчитался о переносе', /Перенёс в расходы/.test(edits[edits.length - 1].text),
  edits[edits.length - 1].text.slice(0, 60));

// 3. Доход по слову, без плюса
const beforeSalary = incomeRows();
post({ message: msg({ text: 'аванс 3000' }) });
check('слово-маркер тоже даёт доход', incomeRows() === beforeSalary + 1,
  'добавлено: ' + (incomeRows() - beforeSalary));

// 4. Возврат — минусом в расходы, не в доходы
const beforeRefund = rowsCount();
const incomesBeforeRefund = incomeRows();
post({ message: msg({ text: 'вернули 200 за чайник' }) });
check('возврат записан в расходы', rowsCount() === beforeRefund + 1,
  'добавлено: ' + (rowsCount() - beforeRefund));
check('в доходы возврат не попал', incomeRows() === incomesBeforeRefund);
check('сумма отрицательная', lastRow()[2] === -200, String(lastRow()[2]));
check('бот назвал это возвратом', /Записал возврат/.test(sent[sent.length - 1].text),
  sent[sent.length - 1].text.slice(0, 60));

// 5. Снятие наличных не записывается вовсе
const beforeTransfer = rowsCount();
const incomesBeforeTransfer = incomeRows();
post({ message: msg({ text: 'снял 1000 в банкомате' }) });
check('перевод не записан ни в расходы', rowsCount() === beforeTransfer);
check('перевод не записан ни в доходы', incomeRows() === incomesBeforeTransfer);
check('бот объяснил почему', /перемещение денег/.test(sent[sent.length - 1].text),
  sent[sent.length - 1].text.slice(0, 80));

// 6. Отчёты видят доходы
const incomeReport = call('reportIncomes_');
check('в отчёте по доходам есть сумма', /3 000|3000/.test(incomeReport), incomeReport.slice(0, 120));
check('в отчёте по доходам есть остаток', /Осталось|Перерасход/.test(incomeReport),
  incomeReport.slice(-120));
const monthReport = call('reportCurrentMonth_');
check('в месячной сводке появились доходы', /Доходы:/.test(monthReport), monthReport.slice(-160));

// 7. Без модели: тот же разбор локальным парсером
gemini({ text: null });
const beforeLocal = incomeRows();
post({ message: msg({ text: '+450 премия' }) });
check('без модели доход тоже уходит в «Доходы»', incomeRows() === beforeLocal + 1,
  'добавлено: ' + (incomeRows() - beforeLocal));
check('сумма без плюса в самой записи', lastIncome()[2] === 450, String(lastIncome()[2]));

const beforeLocalTransfer = rowsCount();
post({ message: msg({ text: 'снял 500 наличными в банкомате' }) });
check('без модели перевод тоже не пишется', rowsCount() === beforeLocalTransfer);

// 8. Чек на возврат по ссылке: минус в расходы, не доход
gemini({
  enrich: () => ({ storeRu: 'Карфур', category: 'Продукты', subcategory: '', items: [] })
});
M.setWebResponder((url) => {
  if (url === 'https://carrefour.pairzon.com/back/1') {
    return { code: 302, headers: { Location: 'https://carrefour.pairzon.com/x.html?id=refund-1&p=1185' } };
  }
  if (url.indexOf('https://carrefour.pairzon.com/x.html') === 0) {
    return { code: 200, headers: { 'Content-Type': 'text/html' }, body: '<html><body><div id="root"></div></body></html>' };
  }
  if (url === 'https://carrefour.pairzon.com/v1.0/documents/refund-1?p=1185') {
    return {
      code: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'refund-1', documentType: 'refund', total: 74.9,
        createdDate: '2026-08-16T10:00:00',
        store: { alias: 'Carrefour', currency: 'ILS', business: { name: 'קרפור', currency: 'ILS' } },
        items: [{ name: 'טוסטר', price: 74.9, total: 74.9 }]
      })
    };
  }
  return { code: 404, body: '' };
});

const beforeRefundLink = rowsCount();
const incomesBeforeRefundLink = incomeRows();
post({ message: msg({ text: 'קבלת זיכוי https://carrefour.pairzon.com/back/1' }) });
check('возврат по чеку записан в расходы', rowsCount() === beforeRefundLink + 1,
  'добавлено: ' + (rowsCount() - beforeRefundLink));
check('в доходы не попал', incomeRows() === incomesBeforeRefundLink);
check('сумма отрицательная', lastRow()[2] === -74.9, String(lastRow()[2]));
check('бот назвал это возвратом', /Записал возврат/.test(sent[sent.length - 1].text),
  sent[sent.length - 1].text.slice(0, 60));

// --- Адрес мини-приложения ---------------------------------------------------
console.log('\n=== Настройка мини-приложения ===');

post({ message: msg({ text: '/miniapp' }) });
check('без адреса бот объясняет, что прислать',
  /не задан/i.test(sent[sent.length - 1].text), sent[sent.length - 1].text.slice(0, 70));

post({ message: msg({ text: '/miniapp просто-текст' }) });
check('мусор вместо адреса отклонён', /не похоже на адрес/i.test(sent[sent.length - 1].text),
  sent[sent.length - 1].text.slice(0, 60));
check('свойство не записано мусором', !M.scriptProps.MINIAPP_URL);

post({ message: msg({ text: '/miniapp https://primer.vercel.app/' }) });
check('адрес сохранён в свойствах скрипта',
  M.scriptProps.MINIAPP_URL === 'https://primer.vercel.app/', String(M.scriptProps.MINIAPP_URL));
check('бот подтвердил', /сохранён/i.test(sent[sent.length - 1].text),
  sent[sent.length - 1].text.slice(0, 60));

post({ message: msg({ text: '/miniapp' }) });
check('теперь команда показывает текущий адрес',
  sent[sent.length - 1].text.includes('primer.vercel.app'), sent[sent.length - 1].text.slice(0, 70));

// --- Идентификаторы записей --------------------------------------------------
console.log('\n=== Идентификаторы записей ===');

// Траты из одного сообщения пишутся в одну секунду: если идентификаторы
// совпадут, кнопки будут править чужую строку
const madeIds = {};
let collisions = 0;
for (let i = 0; i < 2000; i++) {
  const id = ctx.newRecordId_();
  if (madeIds[id]) collisions++;
  madeIds[id] = true;
}
check('2000 идентификаторов подряд — все разные', collisions === 0, 'совпадений: ' + collisions);

const allIds = expenses().getRange(2, 17, rowsCount(), 1).getValues()
  .map(r => String(r[0])).filter(id => id);
check('в таблице нет двух записей с одним идентификатором',
  new Set(allIds).size === allIds.length,
  'записей ' + allIds.length + ', разных ' + new Set(allIds).size);

// --- Имя автора --------------------------------------------------------------
console.log('\n=== Как подписывать автора ===');

// Записываем трату от человека, которого в настройках нет: подпишется телеграмом
gemini({});
const STRANGER = { id: 111, first_name: 'Anatoly', last_name: 'Bezrukov', username: 'ambezrukov' };
for (let r = 1; r <= settings.getLastRow(); r++) {
  if (settings.getRange(r, 1).getValues()[0][0] === 'Разрешённые телеграм-айди') {
    settings.getRange(r, 2).setValue('111, 222');
  }
}
ctx.SETTINGS_CACHE_ = null;

post({ message: msg({ from: STRANGER, text: '70 кофе' }) });
check('без настройки подпись телеграмная', lastRow()[10] === 'Anatoly Bezrukov', String(lastRow()[10]));

const beforeRename = rowsCount();
post({ message: msg({ from: STRANGER, text: '/imya Толя' }) });
check('бот подтвердил имя', /Теперь подписываю вас так: <b>Толя<\/b>/.test(sent[sent.length - 1].text),
  sent[sent.length - 1].text.slice(0, 80));
check('прошлые записи переподписаны', /переподписал/.test(sent[sent.length - 1].text),
  sent[sent.length - 1].text.slice(0, 200));
check('в таблице больше нет телеграмного имени',
  !expenses().getRange(2, 11, rowsCount(), 1).getValues().some(r => r[0] === 'Anatoly Bezrukov'));
check('команда не создала запись расхода', rowsCount() === beforeRename);

post({ message: msg({ from: STRANGER, text: '30 булка' }) });
check('новые записи идут под новым именем', lastRow()[10] === 'Толя', String(lastRow()[10]));
check('имя сохранено в настройках',
  /111=Толя/.test(String(ctx.setting_('Разрешённые телеграм-айди', ''))),
  String(ctx.setting_('Разрешённые телеграм-айди', '')));
check('второй пользователь не пострадал',
  /222/.test(String(ctx.setting_('Разрешённые телеграм-айди', ''))),
  String(ctx.setting_('Разрешённые телеграм-айди', '')));

post({ message: msg({ from: STRANGER, text: '/imya' }) });
check('без имени команда показывает текущее',
  /Сейчас я подписываю вас так: <b>Толя<\/b>/.test(sent[sent.length - 1].text),
  sent[sent.length - 1].text.slice(0, 80));

post({ message: msg({ from: STRANGER, text: '/imya Толя=Маша, я' }) });
check('имя со служебными знаками отклонено', /должно быть коротким/.test(sent[sent.length - 1].text),
  sent[sent.length - 1].text.slice(0, 60));

// Записи, сделанные до настройки имён, остаются под телеграмным именем:
// подделываем такую строку и сводим её кнопкой
console.log('\n=== Свести имена в таблице ===');
const rowsForAuthor = expenses().getLastRow();
expenses().getRange(rowsForAuthor, 11).setValue('Sizif');

post({ message: msg({ from: STRANGER, text: '/avtory' }) });
const authorsMsg = sent[sent.length - 1];
check('в списке видно чужое на вид имя', /Sizif/.test(authorsMsg.text), authorsMsg.text.slice(0, 120));
check('своё имя помечено', /так я подписываю вас сейчас/.test(authorsMsg.text),
  authorsMsg.text.slice(0, 160));
check('есть кнопка «это я»',
  JSON.stringify(authorsMsg.reply_markup || {}).includes('author:'),
  JSON.stringify(authorsMsg.reply_markup || {}).slice(0, 120));

const authorBtn = authorsMsg.reply_markup.inline_keyboard
  .flat().find(b => b.text.includes('Sizif'));
post({ callback_query: { id: 'au1', from: STRANGER, data: authorBtn.callback_data,
  message: { message_id: 400, chat: { id: 555 }, text: 'Кто как подписан' } } });
check('запись переподписана', expenses().getRange(rowsForAuthor, 11).getValues()[0][0] === 'Толя',
  String(expenses().getRange(rowsForAuthor, 11).getValues()[0][0]));
check('бот отчитался', /теперь подписаны как/.test(edits[edits.length - 1].text),
  edits[edits.length - 1].text.slice(0, 80));

// Второй способ — переименование за другого, текстом
expenses().getRange(rowsForAuthor, 11).setValue('Мария Безрукова');
post({ message: msg({ from: STRANGER, text: '/avtory Мария Безрукова = Маша' }) });
check('переименование текстом сработало',
  expenses().getRange(rowsForAuthor, 11).getValues()[0][0] === 'Маша',
  String(expenses().getRange(rowsForAuthor, 11).getValues()[0][0]));

post({ message: msg({ from: STRANGER, text: '/avtory Кого-то = ' }) });
check('половинчатая команда отклонена', /через знак равенства/.test(sent[sent.length - 1].text),
  sent[sent.length - 1].text.slice(0, 60));

// Пока имя человека не задано, кнопка «это я» переписала бы правильные записи
// на телеграмное имя — её быть не должно
const NONAME = { id: 222, first_name: 'Мария', last_name: 'Безрукова' };
post({ message: msg({ from: NONAME, text: '/avtory' }) });
const noNameMsg = sent[sent.length - 1];
check('без заданного имени кнопок нет', !noNameMsg.reply_markup,
  JSON.stringify(noNameMsg.reply_markup || {}).slice(0, 80));
check('бот объясняет, что делать', /Скажите, как вас записывать/.test(noNameMsg.text),
  noNameMsg.text.slice(0, 120));

// Имя можно задать и за другого — по его телеграм-айди
post({ message: msg({ from: STRANGER, text: '/imya 222 = Маша' }) });
check('имя другого сохранено',
  /222=Маша/.test(String(ctx.setting_('Разрешённые телеграм-айди', ''))),
  String(ctx.setting_('Разрешённые телеграм-айди', '')));
check('бот подтвердил', /подписываю как <b>Маша<\/b>/.test(sent[sent.length - 1].text),
  sent[sent.length - 1].text.slice(0, 90));

post({ message: msg({ from: STRANGER, text: '/imya 999999 = Кто-то' }) });
check('чужой айди отклонён', /не в списке разрешённых/.test(sent[sent.length - 1].text),
  sent[sent.length - 1].text.slice(0, 60));

// Теперь у второго человека имя есть — записи пойдут под ним
post({ message: msg({ from: NONAME, text: '55 мороженое' }) });
check('запись второго человека подписана заданным именем', lastRow()[10] === 'Маша',
  String(lastRow()[10]));

// --- Данные для мини-приложения ----------------------------------------------
console.log('\n=== Мини-приложение ===');

const payload = call('miniAppPayload_', '');
check('доходы за месяц посчитаны', payload.incomeTotal > 0, String(payload.incomeTotal));
check('расходы за месяц посчитаны', payload.total > 0, String(payload.total));
check('остаток = доходы минус расходы',
  Math.abs(payload.balance - (payload.incomeTotal - payload.total)) < 0.01,
  payload.balance + ' vs ' + (payload.incomeTotal - payload.total));
check('категории доходов отдельным списком',
  payload.incomeCategories.length > 0 &&
  payload.incomeCategories.every(c => c.name && c.sum > 0),
  JSON.stringify(payload.incomeCategories).slice(0, 100));
check('доходы не попали в расходные категории',
  !payload.categories.some(c => c.name === 'Зарплата'),
  JSON.stringify(payload.categories.map(c => c.name)).slice(0, 120));
check('записи доходов отдаются списком',
  payload.incomes.length > 0 && payload.incomes.every(i => i.id && i.amount),
  'записей: ' + payload.incomes.length);
check('у записи дохода есть автор и дата',
  !!(payload.incomes[0].author && payload.incomes[0].date), JSON.stringify(payload.incomes[0]));

// Месяц, где были только доходы, тоже должен попасть в переключатель
check('месяцы собраны из обоих листов', payload.months.length > 0,
  payload.months.join(','));

// Пока доходов нет, остаток не показывается: минус во весь экран пугал бы зря
const emptyMonth = call('miniAppPayload_', '2019-01');
check('в пустом месяце остатка нет', emptyMonth.balance === null, String(emptyMonth.balance));
check('в пустом месяце доход нулевой', emptyMonth.incomeTotal === 0, String(emptyMonth.incomeTotal));

// Удаление дохода из мини-приложения — тем же путём, что и расхода
const incomeToDelete = payload.incomes[0].id;
const deleteAnswer = call('handleMiniAppDelete_', { initData: '', id: incomeToDelete });
check('без подписи телеграма удалить нельзя', deleteAnswer.ok === false, JSON.stringify(deleteAnswer));
check('запись дохода находится по идентификатору',
  !!ctx.locateRecord_(incomeToDelete), String(incomeToDelete));

// --- Обновления --------------------------------------------------------------
console.log('\n=== Обновление бота ===');

check('версия сравнивается по числам, а не по строкам',
  ctx.compareVersions_('1.10.0', '1.9.0') === 1 &&
  ctx.compareVersions_('1.5.0', '1.5.0') === 0 &&
  ctx.compareVersions_('1.4.9', '1.5.0') === -1);

const freshCode = 'var BOT_VERSION = \'9.9.9\';\n' +
  'function doPost(e) { return null; }\n' + 'x'.repeat(60000);

const updateWeb = (url) => {
  if (url.indexOf('/dist/version.json') !== -1) {
    return { code: 200, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: '9.9.9', date: '01.01.2027',
        changes: ['новая штука', 'ещё одна'] }) };
  }
  if (url.indexOf('/dist/Код.gs') !== -1) return { code: 200, body: freshCode };
  return { code: 404, body: '' };
};
M.setWebResponder(updateWeb);

// Уведомление идёт одному человеку: заменить код может только тот, у кого
// есть доступ к редактору
const beforeUpdateMsgs = sent.length;
const found = call('checkForUpdates', true);
check('обновление замечено', found && found.version === '9.9.9', JSON.stringify(found));
check('уведомление ушло одному, а не всем', sent.length === beforeUpdateMsgs + 1,
  'сообщений: ' + (sent.length - beforeUpdateMsgs));
const updateMsg = sent[sent.length - 1];
check('получатель — первый из разрешённых', String(updateMsg.chat_id) === '111',
  String(updateMsg.chat_id));
check('в сообщении список изменений', /новая штука/.test(updateMsg.text), updateMsg.text.slice(0, 120));
check('есть кнопка «как обновиться»',
  JSON.stringify(updateMsg.reply_markup || {}).includes('update:9.9.9'),
  JSON.stringify(updateMsg.reply_markup || {}).slice(0, 120));

const afterFirst = sent.length;
call('checkForUpdates', true);
check('о той же версии второй раз не напоминает', sent.length === afterFirst,
  'добавилось: ' + (sent.length - afterFirst));

// Ответственного можно назначить руками
for (let r = 1; r <= settings.getLastRow(); r++) {
  if (settings.getRange(r, 1).getValues()[0][0] === 'Кто обновляет бота') {
    settings.getRange(r, 2).setValue('222');
  }
}
ctx.SETTINGS_CACHE_ = null;
check('назначенный ответственный перебивает умолчание',
  ctx.updateManagerId_() === '222', ctx.updateManagerId_());
for (let r = 1; r <= settings.getLastRow(); r++) {
  if (settings.getRange(r, 1).getValues()[0][0] === 'Кто обновляет бота') {
    settings.getRange(r, 2).setValue('');
  }
}
ctx.SETTINGS_CACHE_ = null;

// Кнопка присылает файл с кодом и указания
const documents = [];
M.setTelegramResponder((url, payload) => {
  if (url.includes('/sendDocument')) { documents.push(payload); return { ok: true, result: {} }; }
  if (url.includes('/sendMessage')) { sent.push(payload); return { ok: true, result: { message_id: sent.length } }; }
  if (url.includes('/editMessageText')) { edits.push(payload); return { ok: true, result: {} }; }
  if (url.includes('/editMessageReplyMarkup')) { edits.push(payload); return { ok: true, result: {} }; }
  if (url.includes('/getFile')) return { ok: true, result: { file_path: 'voice/file_1.oga' } };
  if (url.includes('/getMe')) return { ok: true, result: { username: 'test_bot' } };
  return { ok: true, result: {} };
});

post({ callback_query: { id: 'up1', from: HUSBAND, data: 'update:9.9.9',
  message: { message_id: 500, chat: { id: 555 }, text: 'Вышло обновление' } } });
check('код прислан файлом', documents.length === 1, 'файлов: ' + documents.length);
check('в подписи указана версия', /9\.9\.9/.test(documents[0].caption || ''), documents[0].caption);
check('объяснено, что делать с файлом',
  /Расширения → Apps Script/.test(sent[sent.length - 1].text),
  sent[sent.length - 1].text.slice(0, 120));
check('предупреждение про развёртывание есть',
  /развёртывани/i.test(sent[sent.length - 1].text));

check('в указаниях учтён проект из нескольких файлов',
  /00_Config/.test(sent[sent.length - 1].text), sent[sent.length - 1].text.slice(-200));

// «/versiya» сразу говорит, отстал ли человек от свежей версии
post({ message: msg({ text: '/versiya' }) });
check('версия показана', new RegExp(ctx.BOT_VERSION).test(sent[sent.length - 1].text),
  sent[sent.length - 1].text.slice(0, 80));
check('сказано, что есть новее', /Вышла новее/.test(sent[sent.length - 1].text),
  sent[sent.length - 1].text.slice(0, 120));

// Обрывок вместо кода отправлять нельзя — человек вставит мусор в редактор
M.setWebResponder((url) => {
  if (url.indexOf('/dist/version.json') !== -1) {
    return { code: 200, body: JSON.stringify({ version: '9.9.9', changes: [] }) };
  }
  if (url.indexOf('/dist/Код.gs') !== -1) return { code: 200, body: '<html>404</html>' };
  return { code: 404, body: '' };
});
const beforeBrokenCode = documents.length;
const brokenSent = call('sendUpdateInstructions_', 555);
check('обрывок вместо кода не отправляется', brokenSent === false && documents.length === beforeBrokenCode,
  'файлов: ' + (documents.length - beforeBrokenCode));
check('дан запасной адрес', /dist\/Код\.gs/.test(sent[sent.length - 1].text),
  sent[sent.length - 1].text.slice(0, 120));

// После обновления бот сам рассказывает всем, что появилось нового
M.setWebResponder(updateWeb);
M.scriptProps.RUNNING_VERSION = '0.0.1';
const beforeAnnounce = sent.length;
call('announceVersionChange_');
check('о смене версии узнали оба', sent.length === beforeAnnounce + 2,
  'сообщений: ' + (sent.length - beforeAnnounce));
check('сказано, какая версия', new RegExp(ctx.BOT_VERSION).test(sent[sent.length - 1].text),
  sent[sent.length - 1].text.slice(0, 80));

const afterAnnounce = sent.length;
call('announceVersionChange_');
check('дважды не объявляет', sent.length === afterAnnounce);

delete M.scriptProps.RUNNING_VERSION;
call('announceVersionChange_');
check('в свежей установке молчит, только запоминает версию',
  M.scriptProps.RUNNING_VERSION === ctx.BOT_VERSION && sent.length === afterAnnounce,
  M.scriptProps.RUNNING_VERSION);


console.log('\n=== Самопроверка ===');
const selfCheckText = call('selfCheck');
check('самопроверка отработала', selfCheckText.includes('Проверка настройки'));

console.log('\nВсего записей в таблице: ' + rowsCount());
console.log('Строк в логе: ' + (ss.getSheetByName('Лог').getLastRow() - 1));
console.log('\nПровалов: ' + fails);
process.exit(fails ? 1 : 0);

// Бюджет собирается из двух листов сразу: ручные записи плюс траты из
// выписок. Проверяем, что ничего не считается дважды и ничего не теряется.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const M = require('./mocks');

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

M.scriptProps.TELEGRAM_TOKEN = '123:TEST';
M.scriptProps.SPREADSHEET_ID = 'TEST';
M.scriptProps.GEMINI_API_KEY = 'test-key';
call('setupSpreadsheet');

// Реестр карт: по нему у трат появляется владелец
call('handleDirectoryUpload_', { chat: { id: 1 }, from: { id: 1 } }, [
  '/spravochnik карты',
  '9926 | ויזה | Cal | Мария | продукты | 2 | активна',
  '8322 | מסטרקארד | Isracard | Анатолий | подписки | 15 | активна'
].join('\n'));

console.log('\n=== Что попадает в бюджет ===');

// Ручная запись: наличные, которых нет ни в одной выписке
call('appendExpense_', {
  date: new Date(2026, 7, 18), amount: 200, currency: 'ILS',
  category: 'Продукты', subcategory: '', description: 'рынок наличными',
  author: 'Толя', sourceType: 'текст', rawText: '200 рынок'
});

call('importStatementRows_', [
  ['תאריך', 'הפעולה', 'פרטים', 'אסמכתא', 'חובה', 'זכות', "יתרה בש''ח", 'תאריך ערך'],
  // покупка — считается
  ['2026-08-19', 'סופר', '', '111', '150', '', '1', '2026-08-19'],
  // оплата счёта карты — не считается: покупки придут от эмитента
  ['2026-08-16', 'מסטרקרד', '', '8322', '2585.93', '', '1', '2026-08-16'],
  // приход — не расход
  ['2026-08-18', 'העברה-נייד', 'החזר', '222', '', '7200', '1', '2026-08-18']
], 'банк.csv', 'ключ-банк');

const august = { from: new Date(2026, 7, 1), to: new Date(2026, 7, 31, 23, 59, 59) };
const budget = call('budgetExpenses_', august);
const total = budget.reduce((sum, item) => sum + (item.baseAmount || item.amount), 0);

check('в бюджет вошли обе траты', budget.length === 2, String(budget.length));
check('итог = 200 + 150', Math.abs(total - 350) < 0.01, String(total));
check('оплата счёта карты не в бюджете',
  !budget.some(item => Math.abs(item.amount - 2585.93) < 0.01));
check('приход не в бюджете', !budget.some(item => item.amount === 7200));

console.log('\n=== Склеенная покупка считается один раз ===');

// Чек, внесённый руками, и он же в выписке карты
call('appendExpense_', {
  date: new Date(2026, 7, 20), amount: 321.2, currency: 'ILS',
  category: 'Продукты', subcategory: 'Супермаркет', description: 'Carrefour по чеку',
  author: 'Толя', sourceType: 'фото', rawText: ''
});
call('importStatementRows_', [
  ['תאריך רכישה', 'שם בית עסק', 'סכום חיוב', "מס' שובר", 'פירוט נוסף'],
  ['20.08.26', 'CARREFOUR', '321.2', '999111', '']
], 'isracard.xlsx', 'ключ-isr');

const beforeMerge = call('budgetExpenses_', august).length;
check('пока не склеено — две строки', beforeMerge === 4, String(beforeMerge));

const pair = call('findMergeCandidates_')[0];
check('пара найдена', !!pair, pair ? 'ок' : 'нет пары');
if (pair) {
  call('mergeOperationWithRecord_', pair.operation.id, pair.record.id);
  const afterMerge = call('budgetExpenses_', august);
  check('после склейки трата одна', afterMerge.length === 3, String(afterMerge.length));
  const carrefour = afterMerge.filter(i => Math.abs(i.amount - 321.2) < 0.01);
  check('осталась именно ручная запись, с категорией',
    carrefour.length === 1 && carrefour[0].subcategory === 'Супермаркет',
    JSON.stringify(carrefour.map(i => i.subcategory)));
}

console.log('\n=== Владелец карты и способ ввода ===');

call('importStatementRows_', [
  ['תאריך עסקה', 'שם בית העסק', 'סכום בש"ח', 'כרטיס', 'סוג עסקה', 'הערות'],
  ['21-08-2026', 'מסעדת סאלה', '66', 'ויזה 9926', 'רגילה', '']
], 'cal.xlsx', 'ключ-cal');

const withOwner = call('budgetExpenses_', august).filter(i => i.amount === 66)[0];
check('автор взят из реестра карт', withOwner && withOwner.author === 'Мария',
  withOwner ? withOwner.author : 'строка не найдена');
check('видно, откуда трата', withOwner && /Cal · 9926/.test(withOwner.sourceType),
  withOwner ? withOwner.sourceType : '');

console.log('\n=== Разбор магазинов пачкой ===');

const unknown = call('unknownStores_');
check('незнакомые магазины собраны', unknown.length >= 1, JSON.stringify(unknown));

// Ответ модели подменяем: проверяем не её, а то, что бот с ответом делает
M.setGeminiResponder((payload) => {
  const prompt = JSON.stringify(payload);
  if (prompt.includes('список названий магазинов')) {
    return { stores: [
      { store: 'מסעדת סאלה', name: 'Ресторан Сала', category: 'Кафе и рестораны', subcategory: 'Ресторан' },
      { store: 'סופר', name: 'Супермаркет', category: 'Продукты', subcategory: 'Супермаркет' }
    ] };
  }
  return null;
});

const result = call('categorizeOperations_');
check('магазины разобраны', result.ok && result.stores === 2,
  JSON.stringify(result));
// «סופר» словарь знал и раньше, поэтому обновилась одна строка — ресторана
check('категория проставлена в строках', result.rows >= 1, String(result.rows));

const categorized = call('budgetExpenses_', august).filter(i => i.amount === 66)[0];
check('трата получила категорию', categorized.category === 'Кафе и рестораны',
  categorized.category);

// Название магазина ушло в словарь: следующий импорт узнает его без модели
check('магазин запомнен в справочнике',
  call('categorizeByDictionary_', 'מסעדת סאלה'.toLowerCase()) !== null,
  JSON.stringify(call('categorizeByDictionary_', 'מסעדת סאלה'.toLowerCase())));
// Про разобранные магазины бот больше не спрашивает; остаётся только то,
// чего в ответе модели не было
check('разобранные магазины больше не в очереди',
  call('unknownStores_').indexOf('מסעדת סאלה') === -1,
  JSON.stringify(call('unknownStores_')));

console.log('\n=== Отчёт за месяц ===');

const report = call('reportCurrentMonth_');
check('месячный отчёт строится', report && report.text.length > 0 && report.groups.length > 0,
  report ? String(report.groups.length) : 'пусто');
check('в отчёте есть полоски категорий', /▇/.test(report.text));

const week = call('reportWeek_');
check('недельный отчёт строится', week && week.text.length > 0, week ? 'ок' : 'пусто');
check('в неделе виден средний расход в день', /В среднем в день/.test(week.text));

console.log('\n=== Диаграмма ===');

// Полоски рисуются всегда: они не зависят ни от картинок, ни от сети
const bars = call('categoryLines_', [
  { key: 'Продукты', sum: 1000, count: 3 },
  { key: 'Транспорт', sum: 250, count: 2 }
], 1250);
check('полоски построены', bars.length === 2 && /▇/.test(bars[0]), JSON.stringify(bars[0]));
check('у крупной категории полоска длиннее',
  (bars[0].match(/▇/g) || []).length > (bars[1].match(/▇/g) || []).length,
  (bars[0].match(/▇/g) || []).length + ' vs ' + (bars[1].match(/▇/g) || []).length);
check('доля посчитана', /80%/.test(bars[0]), bars[0]);


console.log(fails ? '\nПровалов: ' + fails : '\nПровалов: 0');
process.exit(fails ? 1 : 0);

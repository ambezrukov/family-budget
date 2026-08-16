// Локальная проверка парсера и категоризатора: подгружаем .gs как обычный JS
// и подменяем только то, что живёт в Apps Script (настройки, таблица, лог).
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

let code = '';
for (const f of ['04_TextParser.gs', '05_Categorizer.gs', '06_Reports.gs']) {
  code += fs.readFileSync(path.join(SRC, f), 'utf8') + '\n';
}

// Заглушки среды Apps Script
const stub = `
function baseCurrency_() { return 'ILS'; }
function tz_() { return 'Asia/Jerusalem'; }
function formatDate_(d) {
  const p = n => String(n).padStart(2, '0');
  return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear();
}
function logEvent_() {}
function geminiPickCategory_() { return null; }
function categoryNames_() { return CATEGORIES_TEST.map(c => c[0]).filter((v,i,a)=>a.indexOf(v)===i); }
function addCategoryIfMissing_() {}
function readCategories_() {
  return CATEGORIES_TEST.map(row => ({
    category: row[0],
    subcategory: row[1],
    keywords: String(row[2]).split(/[,;]+/).map(s => s.trim().toLowerCase()).filter(s => s.length > 1)
  }));
}
`;

// Стартовый справочник берём прямо из 10_Setup.gs
const setup = fs.readFileSync(path.join(SRC, '10_Setup.gs'), 'utf8');
const starter = setup.match(/function starterCategories_\(\)[\s\S]*?\n}/)[0];

const sandbox = `${stub}\n${starter}\nconst CATEGORIES_TEST = starterCategories_();\n${code}\nmodule.exports = { parseExpenseText_, categorize_, formatMoney_, detectAmount_, detectDate_, detectCurrency_, parseIsoDate_ };`;

const tmp = path.join(__dirname, '_sandbox.js');
fs.writeFileSync(tmp, sandbox, 'utf8');
const api = require(tmp);

const today = new Date();
const d = n => {
  const x = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  x.setDate(x.getDate() - n);
  const p = v => String(v).padStart(2, '0');
  return p(x.getDate()) + '.' + p(x.getMonth() + 1) + '.' + x.getFullYear();
};
const fmt = dt => {
  const p = v => String(v).padStart(2, '0');
  return p(dt.getDate()) + '.' + p(dt.getMonth() + 1) + '.' + dt.getFullYear();
};

// [текст, ожидаемая сумма, валюта, дата, ожидаемое описание (подстрока)]
const cases = [
  ['360 шек отправка машины', 360, 'ILS', d(0), 'отправка машины'],
  ['45 продукты', 45, 'ILS', d(0), 'продукты'],
  ['вчера 1200 гараж', 1200, 'ILS', d(1), 'гараж'],
  ['позавчера 89 аптека', 89, 'ILS', d(2), 'аптека'],
  ['12.05 200 руб такси', 200, 'RUB', '12.05.' + (new Date(today.getFullYear(),4,12) > today ? today.getFullYear()-1 : today.getFullYear()), 'такси'],
  ['$45 подписка нетфликс', 45, 'USD', d(0), 'подписка нетфликс'],
  ['1 250,50 шекелей ремонт машины', 1250.5, 'ILS', d(0), 'ремонт машины'],
  ['12.50 кофе', 12.5, 'ILS', d(0), 'кофе'],
  ['сегодня 300 евро отель', 300, 'EUR', d(0), 'отель'],
  ['5 января 900 подарок', 900, 'ILS', null, 'подарок'],
  ['кофе с коллегой', null, 'ILS', d(0), 'кофе с коллегой'],
  ['1200₪ страховка машины', 1200, 'ILS', d(0), 'страховка машины'],
  ['89.90 супер фарм', 89.9, 'ILS', d(0), 'супер фарм'],
];

let fails = 0;
console.log('=== Разбор текста ===');
for (const [text, amount, currency, date, descPart] of cases) {
  const r = api.parseExpenseText_(text);
  const gotDate = fmt(r.date);
  const okAmount = (r.amount === amount) || (amount === null && !r.amount);
  const okCur = r.currency === currency;
  const okDate = date === null ? true : gotDate === date;
  const okDesc = descPart === null ? true : r.description.toLowerCase().includes(descPart.toLowerCase());
  const ok = okAmount && okCur && okDate && okDesc;
  if (!ok) fails++;
  console.log(
    (ok ? '  OK  ' : '  ОШИБКА  ') + '«' + text + '» → сумма=' + r.amount +
    ' валюта=' + r.currency + ' дата=' + gotDate + ' описание=«' + r.description + '»' +
    (ok ? '' : `  [ждали: ${amount} ${currency} ${date} ~"${descPart}"]`)
  );
}

console.log('\n=== Категоризация по словарю ===');
const catCases = [
  ['продукты', '', 'Продукты'],
  ['гараж', '', 'Транспорт и автомобиль'],
  ['аптека', '', 'Здоровье и аптека'],
  ['супер фарм', '', 'Здоровье и аптека'],
  ['такси', '', 'Транспорт и автомобиль'],
  ['кофе с коллегой', '', 'Кафе и рестораны'],
  ['арнона', '', 'Жильё и коммунальные'],
  ['подписка нетфликс', '', 'Связь и подписки'],
  ['отправка машины', '', 'Транспорт и автомобиль'],
  ['подгузники', '', 'Дети'],
  ['покупка в магазине игрушек', '', 'Дети'],
  ['рами леви', '', 'Продукты'],
  ['непонятная трата', '', 'Без категории'],
];
for (const [desc, store, expected] of catCases) {
  const r = api.categorize_(desc, store);
  const ok = r.category === expected;
  if (!ok) fails++;
  console.log((ok ? '  OK  ' : '  ОШИБКА  ') + '«' + desc + '» → ' + r.category +
    (r.subcategory ? ' / ' + r.subcategory : '') + ' (' + r.source + ')' +
    (ok ? '' : '  [ждали: ' + expected + ']'));
}

console.log('\n=== Деньги и даты от модели ===');
console.log('  ' + api.formatMoney_(1250.5, 'ILS'));
console.log('  ' + api.formatMoney_(45, 'USD'));
console.log('  ' + api.formatMoney_(1234567.89, 'ILS'));
console.log('  parseIsoDate_("2026-08-14 19:30") → ' + api.parseIsoDate_('2026-08-14 19:30'));
console.log('  parseIsoDate_("") → ' + api.parseIsoDate_(''));
console.log('  parseIsoDate_("1970-01-01") → ' + api.parseIsoDate_('1970-01-01'));

console.log('\nПровалов: ' + fails);
process.exit(fails ? 1 : 0);

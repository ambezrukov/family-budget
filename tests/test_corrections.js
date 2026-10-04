// Правки файлом (/pravki): категория, «не трата», склейка, удаление, слово
// в справочник. Строки и суммы — из сверки 04.10.2026, имена убраны.
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
call('setupSpreadsheet');

const bank = [
  ['תאריך', 'הפעולה', 'פרטים', 'אסמכתא', 'חובה', 'זכות', "יתרה בש''ח", 'תאריך ערך', 'לטובת', 'עבור'],
  ['2026-09-30', 'העב\' לאחר-נייד', 'לטובת: адвокат', '484679129', '590', '', '1000', '2026-09-30', '', ''],
  ['2026-09-23', 'סופרפארם איינשטיין ח', '', '111', '55.15', '', '1000', '2026-09-23', '', '']
];
call('importStatementRows_', bank, 'банк.csv', 'файл-правки');

const sheet = M.spreadsheet.getSheetByName('Операции');
const opRows = () => sheet.getDataRange().getValues().slice(1);
const byMerchant = text => opRows().filter(r => String(r[10]).indexOf(text) !== -1)[0];

const lawyerId = byMerchant('לאחר')[19];
const pharmId = byMerchant('סופרפארם')[19];

const manual = call('appendExpense_', {
  date: new Date(2026, 8, 30), amount: 590, currency: 'ILS', kind: 'расход',
  category: 'Прочее', description: 'консультация', sourceType: 'текст'
});
const income = call('appendExpense_', {
  date: new Date(2026, 8, 27), amount: 6000, currency: 'ILS', kind: 'доход',
  category: 'Прочие доходы', description: 'взнос наличных', sourceType: 'выписка'
});

console.log('\n=== Разбор файла ===');

check('файл правок узнаётся по имени', call('isCorrectionsFile_', 'правки 04.10.csv') &&
  !call('isCorrectionsFile_', 'банк 701-502886 - 04.10.csv'));

const parsed = call('parseCorrections_', [
  ['ID', 'Действие', 'Значение', 'Пояснение'],
  ['', '', '', ''],
  [lawyerId, 'Категория', 'Прочее / Юристы и документы', 'адвокат']
]);
check('шапка и пустые строки пропущены', parsed.length === 1, String(parsed.length));
check('действие приведено к нижнему регистру', parsed[0].action === 'категория', parsed[0].action);
check('номер строки файла сохранён', parsed[0].line === 3, String(parsed[0].line));

const corrections = call('parseCorrections_', [
  ['ID', 'Действие', 'Значение', 'Пояснение'],
  [lawyerId, 'категория', 'Прочее / Юристы и документы', 'адвокат'],
  [lawyerId, 'связь', manual.id, ''],
  [pharmId, 'не трата', 'да', ''],
  [income.id, 'удалить', '', 'это взнос наличных'],
  ['סופרפארם', 'слово', 'Здоровье и аптека / Аптека', ''],
  ['несуществующий-id', 'категория', 'Продукты / Супермаркет', ''],
  [pharmId, 'категория', 'Космос', ''],
  [pharmId, 'связь', 'нет-такой-записи', ''],
  [pharmId, 'перекрасить', 'синий', '']
]);

console.log('\n=== Проверка без изменений ===');

const dry = call('applyCorrections_', corrections, true);
check('проверка видит пять годных правок', dry.applied === 5, String(dry.applied));
check('и четыре ошибки', dry.failed.length === 4, JSON.stringify(dry.failed));
check('категория не тронута', byMerchant('לאחר')[11] === '', byMerchant('לאחר')[11]);
check('доход не удалён', call('readExpenseById_', income.id) &&
  !M.spreadsheet.getSheetByName('Доходы').getDataRange().getValues()
    .filter(r => r[16] === income.id)[0][15]);

console.log('\n=== Применение ===');

const result = call('applyCorrections_', corrections, false);
check('применено пять', result.applied === 5, String(result.applied));
check('ошибки названы по строкам файла', result.failed.map(f => f.line).join(',') === '7,8,9,10',
  result.failed.map(f => f.line).join(','));

const lawyer = byMerchant('לאחר');
check('категория проставлена', lawyer[11] === 'Прочее' && lawyer[12] === 'Юристы и документы',
  lawyer[11] + ' / ' + lawyer[12]);
check('строка помечена «вручную»', lawyer[20] === 'вручную', lawyer[20]);
check('шапка новой колонки появилась', sheet.getRange(1, 21).getValues()[0][0] === 'Правка');
check('новая подкатегория заведена', call('subcategoriesOf_', 'Прочее').indexOf('Юристы и документы') !== -1);
check('склейка проставлена', lawyer[16] === manual.id, lawyer[16]);
check('«не трата» проставлена', byMerchant('סופרפארם')[14] === 'да', byMerchant('סופרפארם')[14]);
check('доход удалён мягко', M.spreadsheet.getSheetByName('Доходы').getDataRange().getValues()
  .filter(r => r[16] === income.id)[0][15] === 'да');

const guess = call('categorizeByDictionary_', 'סופרפארם איינשטיין ח');
check('слово в справочнике перебивает «סופר»', guess && guess.subcategory === 'Аптека',
  guess && guess.category + ' / ' + guess.subcategory);

console.log('\n=== Ручная категория переживает пересчёт ===');

call('rememberStoreCategory_', 'העב\' לאחר-נייד', 'Подарки', 'Подарки');
call('recategorizeOperations_');
check('«/kategorii заново» не перекладывает поправленную строку',
  byMerchant('לאחר')[11] === 'Прочее', byMerchant('לאחר')[11]);

console.log('\n=== Отчёт ===');

const report = call('correctionsReportText_', 'правки 04.10.csv', corrections.length, result, false);
check('в отчёте число применённых', report.indexOf('Применено: <b>5</b> из 9') !== -1, report);
check('в отчёте номер строки с ошибкой', report.indexOf('строка 8') !== -1, report);

console.log('\n=== Перестройка категорий ===');

// 04.10.2026 «Дети» и «Образование» разошлись на три категории: кружки
// и репетиторы — отдельно, школа — в «Образование»
const kid = call('appendExpense_', {
  date: new Date(2026, 8, 5), amount: 200, currency: 'ILS', kind: 'расход',
  category: 'Образование', subcategory: 'Репетиторы', description: 'математика', sourceType: 'текст'
});
const dictRows = () => M.spreadsheet.getSheetByName('Категории').getDataRange().getValues().slice(1);
const pairRow = (c, sc) => dictRows().filter(r => r[0] === c && String(r[1] || '') === sc);

const restructure = call('parseCorrections_', [
  ['ID', 'Действие', 'Значение', 'Пояснение'],
  ['Образование / Репетиторы', 'переименовать', 'Детские доп. занятия / Репетиторы и языки', ''],
  ['Дети / Кружки и секции', 'переименовать', 'Детские доп. занятия / Секции и кружки', ''],
  ['иврит', 'слово', 'Детские доп. занятия / Репетиторы и языки', ''],
  [lawyerId, 'категория', 'Детские доп. занятия / Секции и кружки', ''],
  ['Нет / Такой', 'переименовать', 'Где-то / Ещё', '']
]);

const restructureDry = call('applyCorrections_', restructure, true);
check('проверка видит новую категорию из переименования', restructureDry.applied === 4,
  JSON.stringify(restructureDry.failed));
check('проверка ничего не перенесла', pairRow('Образование', 'Репетиторы').length === 1);

const moved = call('applyCorrections_', restructure, false);
check('перестройка применена', moved.applied === 4, JSON.stringify(moved.failed));
check('строка справочника переехала', pairRow('Образование', 'Репетиторы').length === 0 &&
  pairRow('Детские доп. занятия', 'Репетиторы и языки').length === 1);
check('ключевые слова переехали вместе с ней',
  String(pairRow('Детские доп. занятия', 'Репетиторы и языки')[0][2]).indexOf('репетитор') !== -1);
check('запись «Расходов» переложена', call('readExpenseById_', kid.id).category === 'Детские доп. занятия');
check('новое слово работает', (call('categorizeByDictionary_', 'майя иврит') || {}).category === 'Детские доп. занятия');
check('несуществующая пара названа ошибкой', moved.failed.length === 1 && moved.failed[0].line === 6,
  JSON.stringify(moved.failed));

// Перенос в уже существующую пару сливает слова, а старую строку убирает
const merge = call('applyCorrections_', call('parseCorrections_', [
  ['Дети / Сад и школа', 'переименовать', 'Детские доп. занятия / Секции и кружки', '']
]), false);
check('слияние с существующей парой', merge.applied === 1 &&
  pairRow('Дети', 'Сад и школа').length === 0 &&
  pairRow('Детские доп. занятия', 'Секции и кружки').length === 1 &&
  String(pairRow('Детские доп. занятия', 'Секции и кружки')[0][2]).indexOf('школ') !== -1,
  JSON.stringify(merge));

console.log('\n=== Короткое слово внутри длинного ===');

// Слово «דמי כרטיס» входило в уже записанное «דמי כרטיס בנק הפועלים מסטר»
// и потому считалось известным — в справочник не попадало
call('rememberStoreCategory_', 'דמי כרטיס בנק הפועלים מסטר', 'Прочее', '');
call('applyCorrections_', call('parseCorrections_', [['דמי כרטיס', 'слово', 'Прочее', '']]), false);
check('короткое слово дописано отдельно', (call('categorizeByDictionary_', 'דמי כרטיס') || {}).category === 'Прочее',
  JSON.stringify(call('categorizeByDictionary_', 'דמי כרטיס')));

console.log(fails ? '\nПровалов: ' + fails : '\nПровалов: 0');
process.exit(fails ? 1 : 0);

// Разбор выписок: проверяем на кусках настоящих выгрузок четырёх источников.
// Суммы и названия магазинов оставлены как есть — на них и держится проверка;
// имена, номера счетов и остаток из образцов убраны.
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

// --- Образцы -----------------------------------------------------------------

const bankExcel = [
  ['', '', '', '', '', '', '', '', '', ''],
  ['תנועות בחשבון', '', '', '', '', '', '', '', '', ''],
  ['מספר חשבון', '', '', '', '', '', '', '', '', ''],
  ['תאריך', 'הפעולה', 'פרטים', 'אסמכתא', 'חובה', 'זכות', "יתרה בש''ח", 'תאריך ערך', 'לטובת', 'עבור'],
  ['2026-08-16', 'מסטרקרד', '', '8322', '2585.93', '', '16560.66', '2026-08-16', '', ''],
  ['2026-08-16', 'דירקט', '', '9189', '74.9', '', '19146.59', '2026-08-16', '', ''],
  ['2026-08-18', 'העב\' לאחר-נייד', 'לטובת: ועד בית', '350833498', '1060', '', '18086.59', '2026-08-18', '', ''],
  ['2026-08-19', 'זיכוי מלאומי', 'העברה', '99010330', '', '2700', '20786.59', '2026-08-19', '', '']
];

const isracard = [
  ['פירוט עסקאות', '', 'יולי 2026', '', '', '', '', '', ''],
  ['מסטרקארד - 8322', '', '', '', '', '', '', '₪ 2,826.47', ''],
  ['לחיוב ב-15.07', '', '', '', '', '', '', '', ''],
  ['תאריך רכישה', 'שם בית עסק', 'סכום עסקה', 'מטבע עסקה', 'סכום חיוב', 'מטבע חיוב', "מס' שובר", 'פירוט נוסף', ''],
  ['11.07.26', 'פז YELLOW קיט ונופש', '20.9', '₪', '20.9', '₪', '711773417', '', ''],
  ['09.07.26', 'אלונית פרויד', '21.8', '₪', '21.8', '₪', '704037525', '', ''],
  ['סה"כ', '', '', '', '', '', '', '', '']
];

const max = [
  ['כל המשתמשים (2)', '', '', '', '', '', '', '', '', '', '', ''],
  ['06/2026', '', '', '', '', '', '', '', '', '', '', ''],
  ['תאריך עסקה', 'שם בית העסק', 'קטגוריה', '4 ספרות אחרונות של כרטיס', 'סוג עסקה',
   'סכום חיוב', 'מטבע חיוב', 'סכום עסקה מקורי', 'מטבע עסקה מקורי', 'תאריך חיוב', 'הערות', 'תיוגים'],
  ['04-03-2024', 'קיה', 'מוצרי אשראי', '6528', 'תשלום חודשי', '1537.1', '₪', '78242', '₪', '15-06-2026', 'תשלום 27 מתוך 60', ''],
  ['12-06-2026', 'סופר פארם', 'בריאות', '2913', 'רגילה', '64.9', '₪', '64.9', '₪', '15-06-2026', '', '']
];

console.log('\n=== Кто прислал выписку ===');

const bank = call('parseStatement_', bankExcel, 'банк.xlsx');
check('банковская выписка узнана', bank.ok && bank.source === 'Банк', bank.error || bank.source);
check('строки прочитаны', bank.operations.length === 4, String(bank.operations.length));

const isra = call('parseStatement_', isracard, 'isracard.xlsx');
check('Isracard узнан', isra.ok && isra.source === 'Isracard', isra.error || isra.source);
check('итоговая строка не считается тратой', isra.operations.length === 2,
  String(isra.operations.length));

const maxParsed = call('parseStatement_', max, 'max.xlsx');
check('Max узнан', maxParsed.ok && maxParsed.source === 'Max', maxParsed.error || maxParsed.source);

console.log('\n=== Что получилось из строк ===');

const settlement = bank.operations[0];
check('общее списание по карте помечено «не трата»', settlement.notTrackable === 'да',
  settlement.notTrackable);
check('у списания видна карта', settlement.card === '8322', settlement.card);
check('перевод соседям остался тратой', bank.operations[2].notTrackable === '',
  bank.operations[2].notTrackable);
check('поступление не идёт в расходы', bank.operations[3].kind === 'поступление',
  bank.operations[3].kind);

check('у Isracard карта взята из шапки, а не год', isra.operations[0].card === '8322',
  isra.operations[0].card);
check('дата покупки разобрана', call('formatDate_', isra.operations[0].date) === '11.07.2026',
  call('formatDate_', isra.operations[0].date));
check('ключ строки — номер ваучера', isra.operations[0].key === 'isracard:711773417',
  isra.operations[0].key);

check('рассрочка отмечена как рассрочка', maxParsed.operations[0].kind === 'рассрочка',
  maxParsed.operations[0].kind);
check('обычная покупка отмечена покупкой', maxParsed.operations[1].kind === 'покупка',
  maxParsed.operations[1].kind);
check('дата списания прочитана', call('formatDate_', maxParsed.operations[1].chargeDate) === '15.06.2026',
  call('formatDate_', maxParsed.operations[1].chargeDate));

console.log('\n=== Выписка Cal ===');

// Cal устроен иначе всех: заголовки с переносом строки внутри ячейки, номер
// карты только в шапке и в имени файла, а заголовок растянут на все колонки
// и затекает в графу «примечание» каждой строки
const NL = String.fromCharCode(10);
const cal = [
  ['פירוט עסקאות לחשבון הפועלים 701-502886 לכרטיס ויזה פלטינום המסתיים ב-5430', '', '', '', '', '', ''],
  ['עסקאות לחיוב ב-10/09/2026: 842.49 ₪', '', '', '', '', '', ''],
  ['תאריך' + NL + 'עסקה', 'שם בית עסק', 'סכום' + NL + 'עסקה', 'סכום' + NL + 'חיוב',
   'סוג' + NL + 'עסקה', 'ענף', 'הערות'],
  [46249, 'סונול דניה', 367.62, 367.62, 'רגילה', 'אנרגיה',
   'פירוט עסקאות לחשבון הפועלים 701-502886 לכרטיס ויזה פלטינום המסתיים ב-5430'],
  [46237, 'מנהרות הכרמל-הו"ק', 11.97, 11.97, 'הוראת קבע', 'מוסדות', ''],
  [46188, 'מועדון כדורגל כרמל חיפה', 5400, 450, 'תשלומים', 'פנאי בילוי', 'תשלום 3 מתוך 12']
];

const calParsed = call('parseStatement_', cal, 'פירוט חיובים לכרטיס ויזה 5430 - 22.08.26.xlsx');
check('Cal узнан', calParsed.ok && calParsed.source === 'Cal', calParsed.error || calParsed.source);
check('строки прочитаны', calParsed.operations.length === 3,
  String(calParsed.operations && calParsed.operations.length));
check('номер карты взят из имени файла', calParsed.operations[0].card === '5430',
  calParsed.operations[0].card);
check('дата списания взята из шапки',
  call('formatDate_', calParsed.operations[0].chargeDate) === '10.09.2026',
  call('formatDate_', calParsed.operations[0].chargeDate));
check('заголовок не попал в заметку', calParsed.operations[0].note === '',
  calParsed.operations[0].note.slice(0, 30));
check('постоянное поручение распознано', calParsed.operations[1].kind === 'постоянное поручение',
  calParsed.operations[1].kind);
check('у рассрочки списывается платёж, а не вся сумма',
  calParsed.operations[2].amount === 450, String(calParsed.operations[2].amount));
check('номер платежа входит в ключ',
  calParsed.operations[2].key.indexOf('3 מתוך 12') !== -1, calParsed.operations[2].key);

console.log('\n=== Повторная загрузка того же файла ===');

const first = call('importStatementRows_', isracard, 'isracard.xlsx', 'файл-1');
check('первый импорт записал строки', first.ok && first.stats.added === 2,
  JSON.stringify(first.stats || first.error));

const again = call('importStatementRows_', isracard, 'isracard.xlsx', 'файл-1');
check('повтор ничего не добавил', again.stats.added === 0, String(again.stats.added));
check('повторы посчитаны', again.stats.dupes === 2, String(again.stats.dupes));

console.log('\n=== Импорт не дёргает модель ===');

// В банковской выписке полторы сотни строк. Если на каждую спрашивать
// категорию у Gemini, бесплатный лимит кончается на середине файла и импорт
// умирает молча — именно это случилось 22.08.2026 на первой же выписке.
const askedBefore = M.httpLog.filter(r => String(r.url).indexOf('generativelanguage') !== -1).length;
call('importStatementRows_', bankExcel, 'банк-повтор.xlsx', 'файл-модель');
const askedAfter = M.httpLog.filter(r => String(r.url).indexOf('generativelanguage') !== -1).length;
check('к модели не обращались', askedAfter === askedBefore,
  'запросов: ' + (askedAfter - askedBefore));

console.log('\n=== Учёт ведём не с начала времён ===');

call('updateSetting_', 'Учёт с', '01.06.2026');
const old = call('importStatementRows_', max, 'max.xlsx', 'файл-2');
check('строка 2024 года пропущена', old.stats.skipped === 1, String(old.stats.skipped));
check('свежая строка записана', old.stats.added === 1, String(old.stats.added));

console.log('\n=== Склейка с ручной записью ===');

call('updateSetting_', 'Учёт с', '');
// Ручная запись: те же 64.90 в тот же день, что и покупка в «Супер-фарм»
call('appendExpense_', {
  date: new Date(2026, 5, 12), amount: 64.9, currency: 'ILS',
  category: 'Здоровье и аптека', subcategory: 'Аптека', description: 'аптека',
  author: 'Толя', sourceType: 'текст', rawText: '64.9 аптека'
});

const pairs = call('findMergeCandidates_');
check('пара найдена', pairs.length === 1, String(pairs.length));
if (pairs.length) {
  check('в паре та самая сумма', Math.abs(pairs[0].operation.amount - 64.9) < 0.01,
    String(pairs[0].operation.amount));
  const merged = call('mergeOperationWithRecord_', pairs[0].operation.id, pairs[0].record.id);
  check('склейка записалась', merged === true, String(merged));
  check('после склейки пара не предлагается снова', call('findMergeCandidates_').length === 0);
}

console.log('\n=== CSV с кавычкой посреди слова ===');

// В выписке Hapoalim встречается «אורגד ש.נ בע"מ»: двойная кавычка стоит
// посреди незакавыченного поля. Строгий разборщик считает её началом текста
// в кавычках и склеивает строки — 22.08.2026 так потерялась ровно половина
// выписки, причём именно свежая
const csvText = [
  'תאריך,תיאור הפעולה,פרטים,אסמכתא,חובה,זכות',
  '2026-08-16,מסטרקרד,,8322,2585.93,',
  '2026-08-09, אורגד ש.נ בע"מ , עבור: перевод,77350,,1847.37',
  '2026-08-20,סופר,,111,48,',
  ''
].join(String.fromCharCode(10));

const csvRows = call('parseCsvRows_', csvText);
check('прочитаны все строки', csvRows.length === 4, String(csvRows.length));
check('кавычка осталась внутри названия',
  String(csvRows[2][1]).indexOf('בע"מ') !== -1, String(csvRows[2][1]));
check('строка после кавычки не потерялась',
  String(csvRows[3][1]) === 'סופר', String(csvRows[3][1]));

console.log('\n=== Excel читаем сами, без Google Диска ===');

// Кусок настоящего файла банка: даты лежат числами, текст — в отдельном
// словаре, на который ячейки ссылаются номерами
const sheetPlain = '<worksheet><sheetData>' +
  '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
  '<row r="2"><c r="A2"><v>46250</v></c><c r="B2" t="s"><v>2</v></c>' +
  '<c r="D2"><v>2585.93</v></c></row>' +
  '</sheetData></worksheet>';
const sharedPlain = '<sst><si><t>תאריך</t></si><si><t>הפעולה</t></si>' +
  '<si><t>מסטרקרד</t></si></sst>';

const plainRows = call('xlsxRowsFromParts_', sheetPlain, sharedPlain);
check('строки прочитаны', plainRows.length === 2, String(plainRows.length));
check('слова подставлены из словаря', plainRows[0][0] === 'תאריך', String(plainRows[0][0]));
check('пропущенная ячейка не сдвигает столбцы', plainRows[1][3] === 2585.93,
  JSON.stringify(plainRows[1]));
check('дата-число превращается в дату',
  call('formatDate_', call('parseStatementDate_', 46250)) === '16.08.2026',
  call('formatDate_', call('parseStatementDate_', 46250)));

// Isracard выгружает XML с приставками пространства имён — «<x:row>»
const sheetNs = '<x:worksheet xmlns:x="..."><x:sheetData>' +
  '<x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c></x:row>' +
  '</x:sheetData></x:worksheet>';
const sharedNs = '<x:sst><x:si><x:t>תאריך רכישה</x:t></x:si></x:sst>';
const nsRows = call('xlsxRowsFromParts_', sheetNs, sharedNs);
check('файл с приставками тоже читается',
  nsRows.length === 1 && nsRows[0][0] === 'תאריך רכישה', JSON.stringify(nsRows));

console.log('\n=== Справочники из чата ===');

const cardsMessage = [
  '/spravochnik карты',
  '9926 | ויזה שופרסל | Cal | Мария | продукты и рестораны | 2 | активна',
  '8322 | מסטרקארד | Isracard | Анатолий | подписки | 15 | активна'
].join('\n');

call('handleDirectoryUpload_', { chat: { id: 1 }, from: { id: 1 } }, cardsMessage);
const cards = call('readCards_');
check('карты записаны', Object.keys(cards).length === 2, JSON.stringify(Object.keys(cards)));
check('владелец на месте', cards['9926'] && cards['9926'].owner === 'Мария',
  cards['9926'] && cards['9926'].owner);

// Повторная присылка заменяет справочник целиком, а не копит дубли
call('handleDirectoryUpload_', { chat: { id: 1 }, from: { id: 1 } }, cardsMessage);
check('повтор не задвоил записи', Object.keys(call('readCards_')).length === 2,
  String(Object.keys(call('readCards_')).length));

call('handleDirectoryUpload_', { chat: { id: 1 }, from: { id: 1 } }, [
  '/spravochnik источники',
  'Isracard | https://web.isracard.co.il | 9189, 8322 | Выгрузить Excel по каждой карте | Excel | еженедельно | 2'
].join('\n'));
const sources = call('miniAppSources_');
check('источник виден странице', sources.length === 1 && sources[0].name === 'Isracard',
  JSON.stringify(sources.map(s => s.name)));
check('карты источника связаны с реестром',
  sources[0].cards.length === 2 && sources[0].cards[1].owner === 'Анатолий',
  JSON.stringify(sources[0].cards));

console.log('\n=== Отсечка работает и когда дата хранится датой ===');

// Таблица распознаёт «15.08.2026» как дату и хранит объектом. На таком
// значении строковый разбор молчал, и 22.08.2026 в бюджет уехали июльские
// строки банковской выписки
call('updateSetting_', 'Учёт с', new Date(2026, 7, 15));
const parsedStart = call('accountingStartDate_');
check('дата-объект понята', parsedStart && call('formatDate_', parsedStart) === '15.08.2026',
  parsedStart ? call('formatDate_', parsedStart) : 'null');

const julyRows = [
  ['תאריך', 'הפעולה', 'פרטים', 'אסמכתא', 'חובה', 'זכות', "יתרה בש''ח", 'תאריך ערך'],
  ['2026-07-27', 'דירקט- מצטבר', '', '9189', '353.30', '', '1', '2026-07-27'],
  ['2026-08-20', 'סופר', '', '111', '48', '', '1', '2026-08-20']
];
const cut = call('importStatementRows_', julyRows, 'банк-июль.csv', 'файл-июль');
check('июльская строка отсечена', cut.stats.skipped === 1, String(cut.stats.skipped));
check('августовская записана', cut.stats.added === 1, String(cut.stats.added));

console.log('\n=== Списания карточным компаниям ===');

const issuerRows = [
  ['תאריך', 'הפעולה', 'פרטים', 'אסמכתא', 'חובה', 'זכות', "יתרה בש''ח", 'תאריך ערך'],
  ['2026-08-16', 'כרטיסי אשראי ל', '', '', '7215.37', '', '1', '2026-08-16'],
  ['2026-08-16', 'מקס איט פיננסי', '', '', '125', '', '1', '2026-08-16'],
  ['2026-08-16', 'שיק', '', '77', '7000', '', '1', '2026-08-16']
];
const issuers = call('parseStatement_', issuerRows, 'банк-эмитенты.csv');
check('«כרטיסי אשראי» — не трата', issuers.operations[0].notTrackable === 'да',
  issuers.operations[0].notTrackable + '/' + issuers.operations[0].kind);
check('«מקס איט פיננסי» — не трата', issuers.operations[1].notTrackable === 'да',
  issuers.operations[1].notTrackable + '/' + issuers.operations[1].kind);
check('выписанный чек остался тратой', issuers.operations[2].notTrackable === '',
  issuers.operations[2].notTrackable);

console.log('\n=== Уборка строк раньше отсечки ===');

const cleaned = call('dropOperationsBefore_', new Date(2026, 7, 15));
check('лишние строки удалены', cleaned >= 1, String(cleaned));
check('после уборки старых не осталось',
  call('countOperationsBefore_', new Date(2026, 7, 15)) === 0,
  String(call('countOperationsBefore_', new Date(2026, 7, 15))));

console.log('\n=== Поступления: доход или перевод ===');

// Приход денег на счёт и доход — не одно и то же: зарплата доход, а возврат
// долга или перевод с собственного вклада — нет. Поэтому решает человек.
const incomeRows = [
  ['תאריך', 'הפעולה', 'פרטים', 'אסמכתא', 'חובה', 'זכות', "יתרה בש''ח", 'תאריך ערך'],
  ['2026-08-20', 'משכורת', 'зарплата за июль', '900', '', '12000', '1', '2026-08-20'],
  ['2026-08-21', 'העברה-נייד', 'от Маши', '901', '', '500', '1', '2026-08-21']
];
const pendingBefore = call('pendingIncomeOperations_').length;
call('importStatementRows_', incomeRows, 'банк-доходы.csv', 'файл-доходы');

const pending = call('pendingIncomeOperations_');
check('поступления ждут решения', pending.length === pendingBefore + 2,
  pendingBefore + ' → ' + pending.length);

const incomesSheet = call('ensureSheet_', 'Доходы', []);
const incomesBefore = incomesSheet.getLastRow();

const salary = pending.filter(op => op.amount === 12000)[0];
const answer = call('incomeFromOperation_', salary.id);
check('доход записан в лист «Доходы»', incomesSheet.getLastRow() === incomesBefore + 1,
  incomesBefore + ' → ' + incomesSheet.getLastRow());
check('категория подобрана по словарю доходов', answer.category === 'Зарплата',
  answer.category);

const transfer = pending.filter(op => op.amount === 500)[0];
call('markOperationNotIncome_', transfer.id);
check('после ответа повторно не спрашивают',
  call('pendingIncomeOperations_').length === pendingBefore,
  pendingBefore + ' vs ' + call('pendingIncomeOperations_').length);

console.log('\n=== Обменные операции ===');

// Деньги, пришедшие в Израиле взамен рублей, переведённых в России. В
// назначении платежа человек пишет «возврат долга», но для израильского
// контура это приход — и у него своя статья
call('addMissingIncomeCategories_');
check('категория заведена',
  call('incomeCategoryNames_').indexOf('Обменные операции') !== -1,
  JSON.stringify(call('incomeCategoryNames_')));
check('повторный проход не дублирует',
  call('addMissingIncomeCategories_') === 0, 'добавлено снова');
check('«возврат долга» попадает в обменные операции',
  call('resolveIncomeCategory_', '', 'העברה-נייד עבור: החזר חוב').category === 'Обменные операции',
  call('resolveIncomeCategory_', '', 'העברה-נייד עבור: החזר חוב').category);
check('зарплата осталась зарплатой',
  call('resolveIncomeCategory_', '', 'משכורת').category === 'Зарплата',
  call('resolveIncomeCategory_', '', 'משכורת').category);

console.log('\n=== Иврит с переводом ===');

check('перевод через приложение', call('withRussianHint_', 'העברה-נייד') ===
  'העברה-נייד (перевод через приложение)', call('withRussianHint_', 'העברה-נייד'));
check('зачисление из «Леуми»', call('withRussianHint_', 'זיכוי מלאומי').indexOf('Леуми') !== -1,
  call('withRussianHint_', 'זיכוי מלאומי'));
check('возврат долга виден в примечании',
  call('withRussianHint_', 'עבור: החזר חוב').indexOf('возврат долга') !== -1,
  call('withRussianHint_', 'עבור: החזר חוב'));
check('незнакомое название остаётся как есть',
  call('withRussianHint_', 'מכולת של יוסי') === 'מכולת של יוסי',
  call('withRussianHint_', 'מכולת של יוסי'));

// Запись дохода получает и оригинал, и пояснение
const withHint = call('importStatementRows_', [
  ['תאריך', 'הפעולה', 'פרטים', 'אסמכתא', 'חובה', 'זכות', "יתרה בש''ח", 'תאריך ערך'],
  ['2026-08-22', 'משכורת', '', '950', '', '9000', '1', '2026-08-22']
], 'банк-зарплата.csv', 'файл-зарплата');
check('строка записана', withHint.stats.added === 1, String(withHint.stats.added));

const salaryOp = call('pendingIncomeOperations_').filter(op => op.amount === 9000)[0];
const salaryIncome = call('incomeFromOperation_', salaryOp.id);
check('в описании дохода есть и иврит, и русский',
  /משכורת/.test(salaryIncome.record.description) &&
  /зарплата/.test(salaryIncome.record.description),
  salaryIncome.record.description);

console.log('\n=== Дата начала учёта командой ===');

call('updateSetting_', 'Учёт с', '');
call('handleAccountingStart_', { chat: { id: 1 }, from: { id: 1 } }, '/uchet 15.08.2026');
check('дата записана в настройки', String(call('setting_', 'Учёт с', '')) === '15.08.2026',
  String(call('setting_', 'Учёт с', '')));

call('handleAccountingStart_', { chat: { id: 1 }, from: { id: 1 } }, '/uchet сброс');
check('сброс убирает отсечку', String(call('setting_', 'Учёт с', '')) === '',
  String(call('setting_', 'Учёт с', '')));

// Настройка, появившаяся в новой версии, дописывается в существующий лист
const settingsSheet = call('ensureSheet_', 'Настройки', ['Параметр', 'Значение', 'Пояснение']);
const beforeAdd = settingsSheet.getLastRow();
call('addMissingSettings_', settingsSheet);
check('повторный проход ничего не дублирует', settingsSheet.getLastRow() === beforeAdd,
  beforeAdd + ' → ' + settingsSheet.getLastRow());

console.log(fails ? '\nПровалов: ' + fails : '\nПровалов: 0');
process.exit(fails ? 1 : 0);

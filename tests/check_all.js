// Проверка всего проекта: синтаксис каждого файла + вызовы функций,
// которых нигде не объявлено (в Apps Script такое падает только во время работы).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');
const files = fs.readdirSync(SRC).filter(f => f.endsWith('.gs')).sort();

let all = '';
let syntaxErrors = 0;

for (const f of files) {
  const code = fs.readFileSync(path.join(SRC, f), 'utf8');
  all += code + '\n';
  try {
    new vm.Script(code, { filename: f });
    console.log('  синтаксис OK   ' + f);
  } catch (e) {
    syntaxErrors++;
    console.log('  СИНТАКСИС !!   ' + f + ' — ' + e.message);
  }
}

// Объявленные функции
const declared = new Set([...all.matchAll(/function\s+([A-Za-z0-9_$]+)\s*\(/g)].map(m => m[1]));

// Вызовы
const called = new Map();
for (const m of all.matchAll(/(?<![.\w$])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) {
  const name = m[1];
  called.set(name, (called.get(name) || 0) + 1);
}

// Глобалы среды Apps Script и языка, которые объявлять не нужно
const known = new Set([
  'function', 'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new',
  'String', 'Number', 'Boolean', 'Array', 'Object', 'Date', 'JSON', 'Math', 'RegExp',
  'parseInt', 'parseFloat', 'isNaN', 'Error', 'require', 'console', 'Set', 'Map',
  'encodeURIComponent', 'decodeURIComponent',
  'SpreadsheetApp', 'PropertiesService', 'CacheService', 'UrlFetchApp', 'Utilities',
  'ContentService', 'ScriptApp', 'Session', 'LockService', 'DriveApp', 'MailApp',
  'forEach', 'map', 'filter', 'push', 'join', 'split', 'replace', 'match', 'trim',
  'indexOf', 'substring', 'toLowerCase', 'toUpperCase', 'some', 'every', 'reduce',
  'sort', 'slice', 'reverse', 'keys', 'toFixed', 'test', 'exec', 'concat', 'includes'
]);

const unknown = [...called.keys()].filter(n => !declared.has(n) && !known.has(n));

console.log('\nОбъявлено функций: ' + declared.size);
if (unknown.length) {
  console.log('Вызовы без объявления (проверить вручную):');
  unknown.forEach(n => console.log('   • ' + n + '  ×' + called.get(n)));
} else {
  console.log('Вызовов несуществующих функций не найдено.');
}

// Функции, объявленные и ни разу не вызванные (кроме точек входа)
const entryPoints = new Set(['doPost', 'doGet', 'setupSpreadsheet', 'createMonthlyTrigger',
  'selfCheck', 'testParser', 'setWebhook', 'deleteWebhook', 'getWebhookInfo',
  'setBotCommands', 'sendMonthlyReport']);
const unused = [...declared].filter(n => !entryPoints.has(n) && (called.get(n) || 0) < 2);
console.log('\nНигде не используются (кроме объявления): ' + (unused.length ? unused.join(', ') : 'нет'));

process.exit(syntaxErrors || unknown.length ? 1 : 0);

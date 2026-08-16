// Склеивает все файлы из src/ в один — чтобы при установке не создавать
// одиннадцать файлов вручную, а вставить один.
// Запуск: node tools/build.js
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const DIST = path.join(__dirname, '..', 'dist');

if (!fs.existsSync(DIST)) fs.mkdirSync(DIST);

const files = fs.readdirSync(SRC).filter(f => f.endsWith('.gs')).sort();

const header = [
  '/**',
  ' * Бот учёта семейных расходов — весь код одним файлом.',
  ' *',
  ' * Собран автоматически из папки src/ (node tools/build.js).',
  ' * Править удобнее там, по отдельным файлам, а сюда — только пересобирать.',
  ' *',
  ' * Порядок частей:',
  ...files.map(f => ' *   ' + f.replace('.gs', '')),
  ' */',
  ''
].join('\n');

const body = files.map(f => {
  const code = fs.readFileSync(path.join(SRC, f), 'utf8').trim();
  const title = f.replace('.gs', '');
  return [
    '',
    '// ===========================================================================',
    '// ' + title,
    '// ===========================================================================',
    '',
    code,
    ''
  ].join('\n');
}).join('\n');

const bundle = header + body;
fs.writeFileSync(path.join(DIST, 'Код.gs'), bundle, 'utf8');
fs.copyFileSync(path.join(SRC, 'appsscript.json'), path.join(DIST, 'appsscript.json'));

// Сразу проверяем, что склеенное вообще разбирается как JavaScript
const vm = require('vm');
try {
  new vm.Script(bundle, { filename: 'Код.gs' });
} catch (err) {
  console.error('Сборка не разбирается как JavaScript: ' + err.message);
  process.exit(1);
}

const lines = bundle.split('\n').length;
console.log('Собрано: dist/Код.gs (' + lines + ' строк, ' + files.length + ' частей)');
console.log('Скопировано: dist/appsscript.json');

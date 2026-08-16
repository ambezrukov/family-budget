// Прогон всех проверок разом: node tests/run_all.js
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Последним прогоняем тот же интеграционный набор, но против собранного
// dist/Код.gs — именно этот файл вставляется в Apps Script.
const suites = ['check_all.js', 'test_parser.js', 'test_integration.js', 'BUNDLE:test_integration.js'];
let failed = 0;

for (const entry of suites) {
  const bundled = entry.startsWith('BUNDLE:');
  const suite = bundled ? entry.slice(7) : entry;
  console.log('\n' + '='.repeat(70));
  console.log('  ' + suite + (bundled ? '  (против dist/Код.gs)' : ''));
  console.log('='.repeat(70));
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, suite)], {
      encoding: 'utf8',
      env: bundled ? { ...process.env, BUNDLE: '1' } : process.env
    });
    process.stdout.write(out);
  } catch (err) {
    if (err.stdout) process.stdout.write(err.stdout);
    if (err.stderr) process.stderr.write(err.stderr);
    // check_all.js возвращает ненулевой код из-за слов из комментариев — это не провал
    if (suite !== 'check_all.js') failed++;
  }
}

// Подчищаем временный файл, который создаёт test_parser.js
const sandbox = path.join(__dirname, '_sandbox.js');
if (fs.existsSync(sandbox)) fs.unlinkSync(sandbox);

console.log('\n' + '='.repeat(70));
console.log(failed ? '  ЕСТЬ ПРОВАЛЫ: ' + failed + ' набор(а)' : '  ВСЁ ЗЕЛЁНОЕ');
console.log('='.repeat(70));
process.exit(failed ? 1 : 0);

// Выкатка изменений в Apps Script одной командой:
//   node tools/deploy.js
//
// Порядок важен. Просто залить код мало: вебхук исполняет РАЗВЁРНУТУЮ версию,
// поэтому после заливки нужно создать версию и обновить развёртывание —
// иначе бот продолжит работать по старому коду.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

// Настройки выкатки лежат рядом, в .deploy.json, и в репозиторий не попадают:
// идентификатор развёртывания у каждой установки свой. Образец —
// .deploy.json.example.
const settings = readDeploySettings();

function readDeploySettings() {
  const file = path.join(root, '.deploy.json');
  if (!fs.existsSync(file)) {
    console.error('Нет файла .deploy.json — не знаю, какое развёртывание обновлять.\n' +
      'Скопируйте .deploy.json.example в .deploy.json и впишите идентификатор\n' +
      'своего развёртывания (clasp deployments покажет список).');
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error('Файл .deploy.json не читается: ' + err.message);
    process.exit(1);
  }
}

// Развёртывание, на которое смотрит посредник: его адрес прописан
// в переменной APPS_SCRIPT_URL проекта proxy, поэтому обновляем именно его,
// а не создаём новое.
const DEPLOYMENT_ID = settings.deploymentId;

// Резервную копию на GitHub делаем, только если репозиторий заведён
const BACKUP = settings.backup !== false;

const isWindows = process.platform === 'win32';

// Через оболочку запускаем только clasp: на Windows это .cmd, напрямую он не
// стартует. Node зовём без оболочки — иначе ломается путь с пробелом
// в «C:\Program Files».
function run(command, args, useShell = false) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    shell: useShell && isWindows
  });
}

function clasp(args) {
  return run('clasp', args, true);
}

function step(number, title) {
  console.log(`\n[${number}/5] ${title}`);
}

// Первая строка вывода команды — для короткого отчёта
function firstLine(text) {
  return String(text || '').trim().split('\n')[0];
}

try {
  // Сборка идёт первой: один из наборов проверок гоняет код против собранного
  // dist/Код.gs, и на старой сборке он покажет несуществующие провалы.
  step(1, 'Сборка единого файла (для ручной установки)');
  console.log('   ' + firstLine(run(process.execPath, [path.join(root, 'tools', 'build.js')])));

  step(2, 'Проверки');
  const tests = run(process.execPath, [path.join(root, 'tests', 'run_all.js')]);
  const verdict = tests.split('\n').filter(line => /Провалов|ЗЕЛЁНОЕ|ПРОВАЛЫ/.test(line));
  verdict.forEach(line => console.log('   ' + line.trim()));
  if (/ЕСТЬ ПРОВАЛЫ/.test(tests)) {
    console.error('\nТесты не прошли — выкатка отменена.');
    process.exit(1);
  }

  step(3, 'Заливка кода');
  console.log('   ' + firstLine(clasp(['push', '--force'])));

  step(4, 'Новая версия и обновление развёртывания');
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  console.log('   ' + firstLine(clasp(['create-version', `"выкатка ${stamp}"`])));
  console.log('   ' + firstLine(clasp(['update-deployment', DEPLOYMENT_ID])));

  // Резервная копия делается последней и намеренно не может сорвать выкатку:
  // код к этому моменту уже работает в облаке. Если гитхаб недоступен, скажем
  // об этом и подскажем, чем догнать, — но выходить с ошибкой не станем.
  step(5, 'Резервная копия на GitHub');
  if (!BACKUP) {
    console.log('   Отключена в .deploy.json.');
    console.log('\nГотово. Код обновлён и развёрнут.');
    process.exit(0);
  }
  try {
    // safecrlf=false — чтобы git не сыпал предупреждениями про переводы строк:
    // на Windows он их подменяет, и на каждый файл выходит по строке ворчания
    run('git', ['-c', 'core.safecrlf=false', 'add', '-A']);
    const pending = run('git', ['status', '--porcelain']).trim();

    if (!pending) {
      console.log('   Изменений нет — копия и так актуальна.');
    } else {
      run('git', ['commit', '--quiet', '-m', `выкатка ${stamp}`]);
      run('git', ['push', '--quiet']);
      console.log(`   Сохранено файлов: ${pending.split('\n').length}. Копия отправлена в GitHub.`);
    }
  } catch (err) {
    console.error('   Копия не ушла: ' + firstLine(err.stdout || err.message));
    console.error('   На работу бота это не влияет — код уже развёрнут.');
    console.error('   Догнать копию позже: git push');
  }

  console.log('\nГотово. Код обновлён и развёрнут.');
} catch (err) {
  console.error('\nВыкатка прервалась: ' + (err.stdout || err.message));
  process.exit(1);
}

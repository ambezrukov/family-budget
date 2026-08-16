// Мини-эмуляция среды Google Apps Script: таблица, свойства, кэш, HTTP.
// Нужна, чтобы прогнать реальный код бота целиком, не разворачивая проект.

// Что «Google» отдаёт на GOOGLEFINANCE. Пустая строка = ошибка формулы,
// как при недоступной валютной паре.
let financeRates = { USDILS: 3.72, EURILS: 4.05, RUBILS: 0.041 };

function evaluateFormula(formula) {
  const m = String(formula).match(/GOOGLEFINANCE\("CURRENCY:([A-Z]{6})"\)/);
  if (!m) return '';
  const value = financeRates[m[1]];
  return value === undefined ? '#N/A' : value;
}

class Range {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const line = [];
      for (let c = 0; c < this.numCols; c++) {
        const rowData = this.sheet.data[this.row - 1 + r] || [];
        const v = rowData[this.col - 1 + c];
        line.push(v === undefined ? '' : v);
      }
      out.push(line);
    }
    return out;
  }
  setValues(values) {
    values.forEach((line, r) => {
      const target = this.row - 1 + r;
      if (!this.sheet.data[target]) this.sheet.data[target] = [];
      line.forEach((v, c) => { this.sheet.data[target][this.col - 1 + c] = v; });
    });
    return this;
  }
  setValue(v) {
    if (!this.sheet.data[this.row - 1]) this.sheet.data[this.row - 1] = [];
    this.sheet.data[this.row - 1][this.col - 1] = v;
    delete this.sheet.formulas[this.row + ':' + this.col];
    return this;
  }
  // Формулы: храним отдельно, а в ячейку кладём «посчитанное» значение —
  // так же ведёт себя настоящая таблица с точки зрения скрипта
  setFormula(formula) {
    this.sheet.formulas[this.row + ':' + this.col] = formula;
    if (!this.sheet.data[this.row - 1]) this.sheet.data[this.row - 1] = [];
    this.sheet.data[this.row - 1][this.col - 1] = evaluateFormula(formula);
    return this;
  }
  getFormula() {
    return this.sheet.formulas[this.row + ':' + this.col] || '';
  }
  setFontWeight() { return this; }
  setNumberFormat() { return this; }
}

class Sheet {
  constructor(name) { this.name = name; this.data = []; this.formulas = {}; }
  getName() { return this.name; }
  getLastRow() {
    let last = 0;
    this.data.forEach((row, i) => {
      if (row && row.some(v => v !== '' && v !== undefined && v !== null)) last = i + 1;
    });
    return last;
  }
  getMaxRows() { return Math.max(1000, this.getLastRow() + 10); }
  getRange(row, col, numRows = 1, numCols = 1) { return new Range(this, row, col, numRows, numCols); }
  getDataRange() {
    const rows = this.getLastRow();
    const cols = this.data.reduce((m, r) => Math.max(m, r ? r.length : 0), 1);
    return new Range(this, 1, 1, Math.max(rows, 1), cols);
  }
  appendRow(values) { this.data[this.getLastRow()] = values.slice(); return this; }
  setColumnWidth() { return this; }
  setFrozenRows() { return this; }
}

class Spreadsheet {
  constructor() { this.sheets = {}; }
  getSheetByName(name) { return this.sheets[name] || null; }
  insertSheet(name) { this.sheets[name] = new Sheet(name); return this.sheets[name]; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/TEST'; }
  getName() { return 'Семейный бюджет (тест)'; }
}

const spreadsheet = new Spreadsheet();
const scriptProps = {};
const cache = {};
const triggers = [];

// HTTP: перехватываем вызовы к телеграму, Gemini и любым сайтам
const httpLog = [];
let geminiResponder = () => null;   // подменяется в тестах
let telegramResponder = () => ({ ok: true, result: {} });
let webResponder = () => ({ code: 404, body: '' });

// Ответ в том виде, в каком его отдаёт UrlFetchApp
function makeResponse(code, body, headers, bytes) {
  const contentType = headers && (headers['Content-Type'] || headers['content-type']) || 'text/html';
  return {
    getResponseCode: () => code,
    getContentText: () => body,
    getHeaders: () => headers || {},
    getBlob: () => ({
      getBytes: () => bytes || [1, 2, 3],
      getContentType: () => String(contentType).split(';')[0]
    })
  };
}

// Что «Google» отвечает на запрос списка моделей
let modelCatalog = [
  { name: 'gemini-2.5-flash' },
  { name: 'gemini-2.5-pro' },
  { name: 'text-embedding-004', methods: ['embedContent'] }
];

const env = {
  console,
  SpreadsheetApp: {
    openById: () => spreadsheet,
    getActiveSpreadsheet: () => spreadsheet,
    flush: () => {}
  },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: k => (k in scriptProps ? scriptProps[k] : null),
      setProperty: (k, v) => { scriptProps[k] = v; },
      deleteProperty: k => { delete scriptProps[k]; }
    })
  },
  CacheService: {
    getScriptCache: () => ({
      get: k => (k in cache ? cache[k] : null),
      put: (k, v) => { cache[k] = v; }
    })
  },
  UrlFetchApp: {
    fetch: (url, params) => {
      const payload = params && params.payload ? JSON.parse(params.payload) : {};
      httpLog.push({ url, payload, params });
      let body, code = 200;
      if (url.indexOf('generativelanguage') !== -1 && url.indexOf(':generateContent') === -1) {
        // Запрос списка моделей
        body = JSON.stringify({
          models: modelCatalog.map(m => ({
            name: 'models/' + m.name,
            supportedGenerationMethods: m.methods || ['generateContent']
          }))
        });
      } else if (url.indexOf('generativelanguage') !== -1) {
        const answer = geminiResponder(payload, url);
        if (answer === null) { code = 500; body = '{"error":"mocked failure"}'; }
        else body = JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] });
      } else if (url.indexOf('api.telegram.org') !== -1) {
        body = JSON.stringify(telegramResponder(url, payload));
      } else {
        // Любой посторонний сайт — например, чек по ссылке из SMS
        const answer = webResponder(url, params) || { code: 404, body: '' };
        return makeResponse(
          answer.code === undefined ? 200 : answer.code,
          answer.body === undefined ? '' : answer.body,
          answer.headers || {},
          answer.bytes
        );
      }
      return makeResponse(code, body, { 'Content-Type': 'application/json' });
    }
  },
  Utilities: {
    formatDate: (date, tz, fmt) => {
      const p = (n, w = 2) => String(n).padStart(w, '0');
      return fmt
        .replace('yyyy', date.getFullYear())
        .replace('yy', String(date.getFullYear()).slice(-2))
        .replace('MM', p(date.getMonth() + 1))
        .replace('dd', p(date.getDate()))
        .replace('HH', p(date.getHours()))
        .replace('mm', p(date.getMinutes()))
        .replace('ss', p(date.getSeconds()));
    },
    base64Encode: bytes => Buffer.from(bytes).toString('base64'),
    // Как настоящий UUID: восемь групп hex через дефисы. Форма важна —
    // код берёт из него хвост для идентификатора записи
    getUuid: () => {
      const hex = n => Array.from({ length: n }, () =>
        Math.floor(Math.random() * 16).toString(16)).join('');
      return [hex(8), hex(4), hex(4), hex(4), hex(12)].join('-');
    },
    sleep: () => {}
  },
  Session: { getScriptTimeZone: () => 'Asia/Jerusalem' },
  ContentService: { createTextOutput: t => ({ text: t }) },
  LockService: {
    getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} })
  },
  ScriptApp: {
    getProjectTriggers: () => triggers.slice(),
    newTrigger: (handler) => ({
      timeBased: function () { return this; },
      onMonthDay: function () { return this; },
      atHour: function () { return this; },
      everyMinutes: function () { return this; },
      create: function () {
        triggers.push({ getHandlerFunction: () => handler });
        return this;
      }
    }),
    deleteTrigger: (trigger) => {
      const i = triggers.indexOf(trigger);
      if (i !== -1) triggers.splice(i, 1);
    }
  }
};

module.exports = {
  env, spreadsheet, scriptProps, cache, httpLog, triggers,
  setGeminiResponder: fn => { geminiResponder = fn; },
  setTelegramResponder: fn => { telegramResponder = fn; },
  setWebResponder: fn => { webResponder = fn; },
  setModelCatalog: list => { modelCatalog = list; },
  setFinanceRates: rates => { financeRates = rates; },
  Sheet
};

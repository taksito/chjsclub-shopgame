/**
 * 紅茶搶購練習網站 — Google Apps Script 後端
 * --------------------------------------------------
 * 資料庫：本程式綁定的 Google Spreadsheet
 * 工作表：Users / Rounds / Orders / Logs（執行 initAll() 自動建立）
 *
 * 老師常用（在 Apps Script 編輯器上方選函式後按「執行」）：
 *   initAll()     第一次使用：建立工作表 + 建立 CLASS_DATE 當天的 4 個場次
 *   resetSales()  清空訂單與紀錄、場次回到原定設定（保留學生帳號），可重新上課
 *   resetUsers()  連學生帳號一起清空（換一班時用）
 */

// ======== 設定區 ========
// 試算表 ID：試算表網址 https://docs.google.com/spreadsheets/d/【這一段】/edit
// 如果 Apps Script 是從試算表「擴充功能 → Apps Script」打開的，可以留空
const SHEET_ID = '';
const CLASS_DATE = '';                 // 上課日期 'YYYY-MM-DD'，留空 = 執行 initAll() 當天
const TEACHER_PASSWORD = 'teacher1234'; // ★ 教師介面密碼，請一定要改掉
const AUTO_SCHEDULE = true;            // true = 依下面時間自動開賣；false = 只能由老師在教師介面按「立即開放」
const ROUND_TIMES = ['13:30', '13:50', '14:20', '14:40'];
const STOCK_PER_ROUND = 2;             // 每場 2 罐
const PRICE = 10;                      // 紅茶單價
const PRODUCT_NAME = '古早味紅茶（罐裝）';
const TOKEN_SECONDS = 6 * 60 * 60;     // 登入有效 6 小時
const BUY_RATE_LIMIT_SECONDS = 1;      // 同一帳號購買請求最少間隔 1 秒
const TZ = 'Asia/Taipei';
// ========================

const SHEETS = {
  Users:  ['帳號', 'Email', '密碼雜湊', 'salt', '註冊時間', '姓名', '地址'],
  Rounds: ['場次', '開賣時間', 'startMs', '庫存', '已售出'],
  Orders: ['訂單編號', '場次', '帳號', '數量', '金額', '付款方式', '收件人', '地址', '成立時間', 'serverMs', '開賣後毫秒'],
  Logs:   ['時間', 'serverMs', '帳號', '動作', '結果', '說明'],
};

// ---------- 老師用函式 ----------

function initAll() {
  const ss = ss_();
  Object.keys(SHEETS).forEach(function (name) {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), SHEETS[name].length)).clearContent();
    sh.getRange(1, 1, 1, SHEETS[name].length).setValues([SHEETS[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
  createRounds_(CLASS_DATE || today_());
}

function resetSales() {
  clearBody_('Orders');
  clearBody_('Logs');
  createRounds_(CLASS_DATE || today_());
  PropertiesService.getScriptProperties().deleteProperty('pausedAt');
}

function resetUsers() {
  clearBody_('Users');
  resetSales();
}

function createRounds_(dateStr) {
  clearBody_('Rounds');
  const rows = ROUND_TIMES.map(function (t, i) {
    if (!AUTO_SCHEDULE) return ['R' + (i + 1), '等待老師開放', '', STOCK_PER_ROUND, 0];
    const ms = new Date(dateStr + 'T' + t + ':00+08:00').getTime();
    return ['R' + (i + 1), dateStr + ' ' + t + ':00', ms, STOCK_PER_ROUND, 0];
  });
  const sh = sheet_('Rounds');
  sh.getRange(2, 2, rows.length, 1).setNumberFormat('@'); // 開賣時間存成文字
  sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}

// ---------- HTTP 入口 ----------

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'status';
  if (action === 'status') return out_(handleStatus_());
  if (action === 'results') return out_(handleResults_());
  return out_(fail_('UNKNOWN_ACTION', 'GET 只支援 status、results'));
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return out_(fail_('BAD_JSON', '請送出 JSON 格式的資料'));
  }
  try {
    switch (body.action) {
      case 'register': return out_(handleRegister_(body));
      case 'login':    return out_(handleLogin_(body));
      case 'status':   return out_(handleStatus_());
      case 'buy':      return out_(handleBuy_(body));
      case 'myOrders': return out_(handleMyOrders_(body));
      case 'results':  return out_(handleResults_());
      case 'admin_overview': return out_(adminGuard_(body, adminOverview_));
      case 'admin_open':     return out_(adminGuard_(body, adminOpen_));
      case 'admin_pause':    return out_(adminGuard_(body, adminPause_));
      case 'admin_reset':    return out_(adminGuard_(body, adminReset_));
      case 'admin_addRound': return out_(adminGuard_(body, adminAddRound_));
      case 'admin_deleteRound': return out_(adminGuard_(body, adminDeleteRound_));
      default:         return out_(fail_('UNKNOWN_ACTION', '不認識的 action：' + body.action));
    }
  } catch (err) {
    return out_(fail_('SERVER_ERROR', String(err && err.message || err)));
  }
}

// ---------- 各功能 ----------

function handleRegister_(b) {
  const username = String(b.username || '').trim();
  const password = String(b.password || '');
  const email = String(b.email || '').trim();
  const name = String(b.name || '').trim();
  const address = String(b.address || '').trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return fail_('BAD_USERNAME', '帳號需為 3～20 個英文字母、數字或底線');
  if (password.length < 4 || password.length > 30) return fail_('BAD_PASSWORD', '密碼長度需為 4～30 個字元');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail_('BAD_EMAIL', 'Email 格式不正確');
  if (!name || name.length > 30) return fail_('BAD_NAME', '請填寫姓名（30 字以內）');
  if (!address || address.length > 100) return fail_('BAD_ADDRESS', '請填寫地址（100 字以內）');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return fail_('BUSY', '伺服器忙碌中，請稍後再試');
  try {
    if (findUser_(username)) return fail_('USERNAME_TAKEN', '這個帳號已經有人註冊了');
    const salt = Utilities.getUuid();
    sheet_('Users').appendRow([username, email, hash_(salt, password), salt, fmt_(new Date()), name, address]);
  } finally {
    lock.releaseLock();
  }
  log_(username, 'register', 'OK', '');
  return ok_({ message: '註冊成功，請登入' });
}

function handleLogin_(b) {
  const username = String(b.username || '').trim();
  const user = findUser_(username);
  if (!user || hash_(user.salt, String(b.password || '')) !== user.hash) {
    log_(username, 'login', 'FAIL', '帳號或密碼錯誤');
    return fail_('LOGIN_FAILED', '帳號或密碼錯誤');
  }
  const token = Utilities.getUuid();
  CacheService.getScriptCache().put('tok_' + token, username, TOKEN_SECONDS);
  log_(username, 'login', 'OK', '');
  return ok_({ token: token, username: username, name: user.name, address: user.address, expiresInSeconds: TOKEN_SECONDS });
}

function handleStatus_() {
  const now = Date.now();
  const rounds = getRounds_();
  const cur = currentRound_(rounds, now);
  const next = nextRound_(rounds, now);
  const paused = isPaused_(cur);
  return ok_({
    paused: paused,
    product: { name: PRODUCT_NAME, price: PRICE, payment: ['COD'], maxPerUser: 1 },
    rounds: rounds.map(publicRound_),
    currentRound: cur && !paused ? publicRound_(cur) : null,
    nextRound: next ? publicRound_(next) : null,
  });
}

function handleBuy_(b) {
  const now = Date.now();
  const username = CacheService.getScriptCache().get('tok_' + String(b.token || ''));
  if (!username) return fail_('INVALID_TOKEN', '尚未登入或登入已過期，請重新登入');

  // 頻率限制：同一帳號 1 秒內只能送 1 次購買
  const cache = CacheService.getScriptCache();
  if (cache.get('rl_' + username)) {
    log_(username, 'buy', 'RATE_LIMITED', '');
    return fail_('RATE_LIMITED', '送出太頻繁，請間隔 ' + BUY_RATE_LIMIT_SECONDS + ' 秒以上');
  }
  cache.put('rl_' + username, '1', BUY_RATE_LIMIT_SECONDS);

  // 購買時再次確認密碼
  const user = findUser_(username);
  if (!user || hash_(user.salt, String(b.password || '')) !== user.hash) {
    log_(username, 'buy', 'WRONG_PASSWORD', '');
    return fail_('WRONG_PASSWORD', '確認密碼錯誤');
  }

  // 收件人與地址用註冊時填的資料；只接受貨到付款、每人 1 罐
  // 進入臨界區：同一時間只有一個請求能修改庫存
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) return logFail_(username, 'BUSY', '太多人同時搶購，伺服器忙碌，請再試一次');
  let result;
  try {
    const t = Date.now(); // 取得鎖之後的時間，才是真正的判定時間
    const ordersSh = sheet_('Orders');
    // 這個帳號的訂單在哪些場次（欄 B 場次、欄 C 帳號）
    const myRounds = ordersSh.getLastRow() > 1
      ? ordersSh.getRange(2, 2, ordersSh.getLastRow() - 1, 2).getValues()
          .filter(function (r) { return r[1] === username; }).map(function (r) { return String(r[0]); })
      : [];
    {
      const rounds = getRounds_();
      const cur = currentRound_(rounds, t);
      const next = nextRound_(rounds, t);
      if (!cur) {
        result = fail_('NOT_STARTED', '尚未開賣', { nextRound: next ? publicRound_(next) : null });
      } else if (isPaused_(cur)) {
        result = fail_('PAUSED', '老師已暫停販售', { nextRound: next ? publicRound_(next) : null });
      } else if (isPre_(cur.id) && myRounds.indexOf(cur.id) >= 0) {
        // pre 測試場：每場每人 1 罐，可以參加很多場 pre
        result = fail_('ALREADY_BOUGHT', '這一場測試（' + cur.id + '）你已經買過了，等下一場吧');
      } else if (!isPre_(cur.id) && myRounds.some(function (id) { return !isPre_(id); })) {
        // 正式場：全部正式場合計每人 1 罐（pre 買過的不算）
        result = fail_('ALREADY_BOUGHT', '你已經在正式場次搶到過了，正式場每人限購 1 罐');
      } else if (cur.sold >= cur.stock) {
        result = fail_('SOLD_OUT', '本場已售完', { nextRound: next ? publicRound_(next) : null });
      } else {
        const orderId = 'T' + t;
        const elapsed = t - cur.startMs;
        ordersSh.appendRow([orderId, cur.id, username, 1, PRICE, '貨到付款', user.name, user.address, fmt_(new Date(t)), t, elapsed]);
        sheet_('Rounds').getRange(cur.row, 5).setValue(cur.sold + 1);
        SpreadsheetApp.flush();
        result = ok_({
          message: '搶購成功！',
          order: { orderId: orderId, round: cur.id, qty: 1, amount: PRICE, payment: 'COD', receiver: user.name, address: user.address, msAfterOpen: elapsed },
        });
      }
    }
  } finally {
    lock.releaseLock();
  }
  log_(username, 'buy', result.ok ? 'OK' : result.code, result.ok ? result.order.round : '');
  return result;
}

function handleMyOrders_(b) {
  const username = CacheService.getScriptCache().get('tok_' + String(b.token || ''));
  if (!username) return fail_('INVALID_TOKEN', '尚未登入或登入已過期，請重新登入');
  const orders = readRows_('Orders').filter(function (r) { return r[2] === username; }).map(function (r) {
    return { orderId: r[0], round: r[1], qty: r[3], amount: r[4], payment: r[5], receiver: r[6], address: r[7], time: r[8] };
  });
  return ok_({ username: username, orders: orders });
}

function handleResults_() {
  const rounds = getRounds_();
  const orders = readRows_('Orders');
  return ok_({
    rounds: rounds.map(function (rd) {
      const winners = orders.filter(function (o) { return o[1] === rd.id; }).map(function (o) {
        return { username: o[2], time: o[8], msAfterOpen: o[10] };
      });
      return Object.assign(publicRound_(rd), { winners: winners });
    }),
  });
}

// ---------- 教師介面 ----------

// 暫停：記錄暫停時間；只要目前場次是在暫停之前開始的，就視為暫停中。
// 老師按「立即開放」或下一場時間到，場次開始時間就會晚於暫停時間，自動恢復。
// pre# 是老師新增的測試場次；R# 是正式場次（決勝負）
function isPre_(id) { return /^pre\d+$/.test(String(id)); }

function isPaused_(cur) {
  if (!cur) return false;
  const p = Number(PropertiesService.getScriptProperties().getProperty('pausedAt') || 0);
  return p >= cur.startMs;
}

function adminGuard_(b, fn) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('admin_fail') || 0);
  if (fails >= 10) return fail_('ADMIN_LOCKED', '教師密碼錯誤太多次，請 10 分鐘後再試');
  if (String(b.adminPassword || '') !== TEACHER_PASSWORD) {
    cache.put('admin_fail', String(fails + 1), 600);
    log_('(teacher)', 'admin', 'FAIL', '教師密碼錯誤');
    return fail_('ADMIN_WRONG_PASSWORD', '教師密碼錯誤');
  }
  return fn(b);
}

function adminOverview_() {
  const now = Date.now();
  const rounds = getRounds_();
  const cur = currentRound_(rounds, now);
  const paused = isPaused_(cur);
  const orders = readRows_('Orders').map(function (o) {
    return { orderId: o[0], round: o[1], username: o[2], amount: o[4], payment: o[5], receiver: o[6], address: o[7], time: o[8], msAfterOpen: o[10] };
  });
  const emails = {};
  readRows_('Users').forEach(function (u) { emails[u[0]] = u[1]; });
  // 每個學生的購買嘗試統計
  const stats = {};
  readRows_('Logs').forEach(function (l) {
    if (l[3] !== 'buy') return;
    const s = stats[l[2]] || (stats[l[2]] = { username: l[2], attempts: 0, first: null, codes: {} });
    s.attempts++;
    if (!s.first) s.first = l[0];
    s.codes[l[4]] = (s.codes[l[4]] || 0) + 1;
  });
  return ok_({
    paused: paused,
    currentRoundId: cur && !paused ? cur.id : null,
    userCount: Object.keys(emails).length,
    rounds: rounds.map(publicRound_),
    orders: orders.map(function (o) { return Object.assign(o, { email: emails[o.username] || '' }); }),
    attempts: Object.keys(stats).map(function (k) { return stats[k]; }).sort(function (a, b) { return b.attempts - a.attempts; }),
  });
}

// 立即開放某一組：把該組開始時間設為現在，它就成為唯一販售中的場次（前一組自動結束）
function adminOpen_(b) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) return fail_('BUSY', '伺服器忙碌，請再按一次');
  try {
    const now = Date.now();
    const r = getRounds_().filter(function (x) { return x.id === b.roundId; })[0];
    if (!r) return fail_('NO_ROUND', '找不到場次 ' + b.roundId);
    if (r.sold >= r.stock) return fail_('ROUND_SOLD_OUT', r.id + ' 已經賣完了');
    const sh = sheet_('Rounds');
    sh.getRange(r.row, 2).setValue('老師開放 ' + Utilities.formatDate(new Date(now), TZ, 'HH:mm:ss'));
    sh.getRange(r.row, 3).setValue(now);
    PropertiesService.getScriptProperties().deleteProperty('pausedAt');
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  log_('(teacher)', 'admin', 'OPEN', b.roundId);
  return adminOverview_();
}

// 新增一組：time 填 'HH:MM' 就在當天該時間自動開賣；不填就等老師按「立即開放」
function adminAddRound_(b) {
  const time = String(b.time || '').trim();
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return fail_('BAD_TIME', '時間格式請用 HH:MM，例如 15:10');
  const stock = Number(b.stock || STOCK_PER_ROUND);
  if (!(stock >= 1 && stock <= 20 && Math.floor(stock) === stock)) return fail_('BAD_STOCK', '數量請填 1～20');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) return fail_('BUSY', '伺服器忙碌，請再按一次');
  let id;
  try {
    const rounds = getRounds_();
    // 老師新增的場次命名為 pre1、pre2…
    const maxNo = rounds.reduce(function (m, r) {
      const mt = /^pre(\d+)$/.exec(String(r.id));
      return mt ? Math.max(m, Number(mt[1])) : m;
    }, 0);
    id = 'pre' + (maxNo + 1);
    const dateStr = CLASS_DATE || today_();
    const sh = sheet_('Rounds');
    const row = sh.getLastRow() + 1;
    sh.getRange(row, 2).setNumberFormat('@');
    sh.getRange(row, 1, 1, 5).setValues([[
      id,
      time ? dateStr + ' ' + time + ':00' : '等待老師開放',
      time ? new Date(dateStr + 'T' + time + ':00+08:00').getTime() : '',
      stock, 0,
    ]]);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  log_('(teacher)', 'admin', 'ADD_ROUND', id + (time ? ' ' + time : ''));
  return adminOverview_();
}

// 刪除老師新增的場次 pre#（原定的 R1～R4 不能刪；有人買到或正在販售中也不能刪）
function adminDeleteRound_(b) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) return fail_('BUSY', '伺服器忙碌，請再按一次');
  try {
    const now = Date.now();
    const rounds = getRounds_();
    const r = rounds.filter(function (x) { return x.id === b.roundId; })[0];
    if (!r) return fail_('NO_ROUND', '找不到場次 ' + b.roundId);
    if (!/^pre\d+$/.test(String(r.id))) return fail_('CANNOT_DELETE', '原定場次不能刪除，只能刪除老師新增的 pre 場次');
    if (r.sold > 0) return fail_('CANNOT_DELETE', r.id + ' 已經有人買到，不能刪除');
    const cur = currentRound_(rounds, now);
    if (cur && cur.id === r.id && !isPaused_(cur)) return fail_('CANNOT_DELETE', r.id + ' 正在販售中，請先按「暫停販售」再刪除');
    sheet_('Rounds').deleteRow(r.row);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  log_('(teacher)', 'admin', 'DELETE_ROUND', b.roundId);
  return adminOverview_();
}

function adminPause_() {
  PropertiesService.getScriptProperties().setProperty('pausedAt', String(Date.now()));
  log_('(teacher)', 'admin', 'PAUSE', '');
  return adminOverview_();
}

function adminReset_(b) {
  if (b.confirm !== 'RESET') return fail_('NEED_CONFIRM', '請確認後再重設');
  resetSales();
  return adminOverview_();
}

// ---------- 小工具 ----------

function getRounds_() {
  return readRows_('Rounds').map(function (r, i) {
    return { row: i + 2, id: r[0], display: String(r[1]), startMs: r[2] === '' ? null : Number(r[2]), stock: Number(r[3]), sold: Number(r[4]) };
  }).sort(function (a, b) {
    // 尚未排定時間（等待老師開放）的排在最後
    if (a.startMs === null || b.startMs === null) return (a.startMs === null) - (b.startMs === null);
    return a.startMs - b.startMs;
  });
}

// 目前場次 = 最近一個已經開始的場次（下一場開始後，上一場就結束）
function currentRound_(rounds, now) {
  let cur = null;
  rounds.forEach(function (r) { if (r.startMs !== null && r.startMs <= now) cur = r; });
  return cur;
}

function nextRound_(rounds, now) {
  for (let i = 0; i < rounds.length; i++) if (rounds[i].startMs !== null && rounds[i].startMs > now) return rounds[i];
  return null;
}

function publicRound_(r) {
  return { id: r.id, type: isPre_(r.id) ? 'test' : 'official', startTime: r.display, startMs: r.startMs, stock: r.stock, sold: r.sold, remaining: Math.max(0, r.stock - r.sold) };
}

function findUser_(username) {
  if (!username) return null;
  const rows = readRows_('Users');
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === username) return { username: rows[i][0], email: rows[i][1], hash: rows[i][2], salt: rows[i][3], name: String(rows[i][5] || ''), address: String(rows[i][6] || '') };
  }
  return null;
}

function hash_(salt, password) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + password, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ((b + 256) % 256).toString(16).padStart(2, '0'); }).join('');
}

function ss_() {
  if (SHEET_ID) return SpreadsheetApp.openById(SHEET_ID);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('找不到試算表：請在程式最上面的 SHEET_ID 填入試算表 ID');
  return ss;
}

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('找不到工作表 ' + name + '，請先執行 initAll()');
  return sh;
}

function readRows_(name) {
  const sh = sheet_(name);
  const n = sh.getLastRow() - 1;
  if (n <= 0) return [];
  return sh.getRange(2, 1, n, SHEETS[name].length).getValues();
}

function clearBody_(name) {
  const sh = sheet_(name);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).clearContent();
}

function log_(username, action, result, note) {
  try {
    sheet_('Logs').appendRow([fmt_(new Date()), Date.now(), username, action, result, note]);
  } catch (err) { /* 紀錄失敗不影響主流程 */ }
}

function logFail_(username, code, message) {
  log_(username, 'buy', code, '');
  return fail_(code, message);
}

function today_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function fmt_(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd HH:mm:ss.SSS'); }

function ok_(data) { return Object.assign({ ok: true, serverTime: Date.now() }, data); }
function fail_(code, message, extra) { return Object.assign({ ok: false, code: code, message: message, serverTime: Date.now() }, extra || {}); }
function out_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

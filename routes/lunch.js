var express = require('express');
var fs = require('fs');
var path = require('path');
var router = express.Router();

var BASE_URL = process.env.WARUNA_BASE_URL || 'https://api2.waruna.id';
var NIK = process.env.WARUNA_NIK;
var USERNAME = process.env.WARUNA_USERNAME;
var PASSWORD = process.env.WARUNA_PASSWORD;

var RESULT_DIR = path.join(__dirname, '..', 'result');

var MEAL_TYPE_MAP = {
  NonHalal: 'Non Halal',
  Halal: 'Halal'
};

function createLogger() {
  var filePath = null;
  try {
    if (!fs.existsSync(RESULT_DIR)) {
      fs.mkdirSync(RESULT_DIR, { recursive: true });
    }
    var fileName = new Date().toISOString().replace(/[:.]/g, '-') + '.txt';
    filePath = path.join(RESULT_DIR, fileName);
  } catch (err) {
    console.error('[lunch] Unable to create log file, falling back to console only:', err.message);
  }

  return function log(label, data) {
    var entry = '=== ' + label + ' (' + new Date().toISOString() + ') ===\n' +
      JSON.stringify(data, null, 2) + '\n\n';
    if (filePath) {
      try {
        fs.appendFileSync(filePath, entry);
      } catch (err) {
        console.error('[lunch] Unable to write log file:', err.message);
      }
    }
    console.log('[lunch] ' + label + ':', JSON.stringify(data));
  };
}

async function callApi(path, options, log, label) {
  var res = await fetch(BASE_URL + path, options);
  var body = await res.json().catch(function () { return null; });
  if (log) {
    log(label, { request: { url: BASE_URL + path, method: (options && options.method) || 'GET' }, status: res.status, response: body });
  }
  if (!res.ok) {
    var err = new Error('Request to ' + path + ' failed with status ' + res.status);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function stop(reason, detail) {
  return { status: 200, body: { ok: false, reason: reason, detail: detail || null } };
}

async function runLunchOrder() {
  var log = createLogger();
  try {
    if (!NIK || !USERNAME || !PASSWORD) {
      return { status: 500, body: {
        ok: false,
        reason: 'MISSING_CREDENTIALS',
        detail: 'Set WARUNA_NIK, WARUNA_USERNAME and WARUNA_PASSWORD in .env'
      } };
    }

    var serverTimeResp = await callApi('/api/v2/Util/ServerTime', { method: 'GET' }, log, 'ServerTime');
    var serverDateTime = serverTimeResp.serverTime;
    var today = serverDateTime.slice(0, 10);
    var currentTime = serverDateTime.slice(11, 16);

    var loginResp = await callApi('/api/Auth/login-lunch-v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Username: USERNAME, Password: PASSWORD })
    }, log, 'Login');
    var token = loginResp.AccessToken;
    if (!token) {
      return stop('LOGIN_FAILED', loginResp);
    }
    var authHeaders = { Authorization: 'Bearer ' + token };

    var startCfg = await callApi(
      '/api/v1/Config?$filter=' + encodeURIComponent("Key eq 'LUNCH.TIME.START'"),
      { headers: authHeaders }, log, 'Config-Start'
    );
    var endCfg = await callApi(
      '/api/v1/Config?$filter=' + encodeURIComponent("Key eq 'LUNCH.TIME.END'"),
      { headers: authHeaders }, log, 'Config-End'
    );
    var startTime = startCfg.value && startCfg.value[0] && startCfg.value[0].ValueString;
    var endTime = endCfg.value && endCfg.value[0] && endCfg.value[0].ValueString;
    if (!startTime || !endTime || currentTime < startTime || currentTime > endTime) {
      return stop('OUTSIDE_RESERVATION_WINDOW', { currentTime: currentTime, startTime: startTime, endTime: endTime });
    }

    var participantFilter = "ReserveTime eq " + today + " and NIK eq '" + NIK + "'";
    var participantResp = await callApi(
      '/api/v1/LunchParticipant?$filter=' + encodeURIComponent(participantFilter) + '&expand=' + encodeURIComponent('FoodMenu($expand=MenuLists)'),
      { headers: authHeaders }, log, 'LunchParticipant'
    );
    if (participantResp.value && participantResp.value.length > 0) {
      return stop('ALREADY_RESERVED', participantResp.value[0]);
    }

    var hrisResp = await callApi('/api/v2/HRISUser2/' + encodeURIComponent(NIK), { headers: authHeaders }, log, 'HRISUser2');
    var user = hrisResp.value && hrisResp.value[0];
    if (!user || !user.Meal) {
      return stop('USER_MEAL_NOT_FOUND', hrisResp);
    }
    var mealType = MEAL_TYPE_MAP[user.Meal] || user.Meal;

    var menuFilter = 'Date eq ' + today + ' and Publish eq true';
    var menuResp = await callApi(
      '/api/v1/FoodMenu?$filter=' + encodeURIComponent(menuFilter) + '&$expand=MenuLists',
      { headers: authHeaders }, log, 'FoodMenu'
    );
    var menu = (menuResp.value || []).find(function (m) { return m.Type === mealType; });
    if (!menu) {
      return stop('MENU_NOT_FOUND', { date: today, mealType: mealType });
    }

    var usedFallback = false;
    if (menu.Status === 'CLOSED') {
      var fallbackMenu = (menuResp.value || []).find(function (m) {
        return m.Type !== mealType && m.Status !== 'CLOSED';
      });
      if (!fallbackMenu) {
        return stop('MENU_CLOSED', menu);
      }
      menu = fallbackMenu;
      usedFallback = true;
    }

    var reserveResp = await callApi('/api/V2/LunchParticipant/Reserve', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
      body: JSON.stringify({ FoodMenuID: menu.ID, NIK: NIK })
    }, log, 'Reserve');

    return { status: 200, body: {
      ok: true,
      reason: usedFallback ? 'RESERVED_FALLBACK' : 'RESERVED',
      foodMenuId: menu.ID,
      mealType: menu.Type,
      requestedMealType: mealType,
      detail: reserveResp
    } };
  } catch (err) {
    log('Error', { message: err.message, body: err.body || null });
    return { status: 502, body: { ok: false, reason: 'UPSTREAM_ERROR', detail: err.body || err.message } };
  }
}

router.get('/order', async function (req, res) {
  var result = await runLunchOrder();
  res.status(result.status).json(result.body);
});

function parseRunDates(value) {
  return new Set((value || '').split(',').map(function (date) { return date.trim(); }).filter(Boolean));
}

function localDate(timezone) {
  var parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  function value(type) {
    return parts.find(function (part) { return part.type === type; }).value;
  }
  return value('year') + '-' + value('month') + '-' + value('day');
}

async function runScheduledLunchOrder() {
  var runDates = parseRunDates(process.env.LUNCH_RUN_DATES);
  var timezone = process.env.LUNCH_TIMEZONE || 'Asia/Jakarta';
  var today = localDate(timezone);
  if (!runDates.has(today)) {
    return { status: 200, body: { ok: false, reason: 'NOT_A_RUN_DATE', detail: { today: today } } };
  }

  return runLunchOrder();
}

router.get('/cron', async function (req, res) {
  var secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== 'Bearer ' + secret) {
    return res.status(401).json({ ok: false, reason: 'UNAUTHORIZED' });
  }

  var result = await runScheduledLunchOrder();
  console.log('[cron] Result:', JSON.stringify(result.body));
  res.status(result.status).json(result.body);
});

module.exports = { router: router, runLunchOrder: runLunchOrder, runScheduledLunchOrder: runScheduledLunchOrder };

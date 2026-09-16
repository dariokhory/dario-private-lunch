var express = require('express');
var router = express.Router();

var BASE_URL = process.env.WARUNA_BASE_URL || 'https://api2.waruna.id';
var NIK = process.env.WARUNA_NIK;
var USERNAME = process.env.WARUNA_USERNAME;
var PASSWORD = process.env.WARUNA_PASSWORD;

var MEAL_TYPE_MAP = {
  NonHalal: 'Non Halal',
  Halal: 'Halal'
};

async function callApi(path, options) {
  var res = await fetch(BASE_URL + path, options);
  var body = await res.json().catch(function () { return null; });
  if (!res.ok) {
    var err = new Error('Request to ' + path + ' failed with status ' + res.status);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function stop(res, reason, detail) {
  res.status(200).json({ ok: false, reason: reason, detail: detail || null });
}

router.get('/order', async function (req, res) {
  try {
    if (!NIK || !USERNAME || !PASSWORD) {
      return res.status(500).json({
        ok: false,
        reason: 'MISSING_CREDENTIALS',
        detail: 'Set WARUNA_NIK, WARUNA_USERNAME and WARUNA_PASSWORD in .env'
      });
    }

    var serverTimeResp = await callApi('/api/v2/Util/ServerTime', { method: 'GET' });
    var serverDateTime = serverTimeResp.serverTime;
    var today = serverDateTime.slice(0, 10);
    var currentTime = serverDateTime.slice(11, 16);

    var loginResp = await callApi('/api/Auth/login-lunch-v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Username: USERNAME, Password: PASSWORD })
    });
    var token = loginResp.token || loginResp.Token || loginResp.accessToken || loginResp.access_token;
    if (!token) {
      return stop(res, 'LOGIN_FAILED', loginResp);
    }
    var authHeaders = { Authorization: 'Bearer ' + token };

    var startCfg = await callApi(
      '/api/v1/Config?$filter=' + encodeURIComponent("Key eq 'LUNCH.TIME.START'"),
      { headers: authHeaders }
    );
    var endCfg = await callApi(
      '/api/v1/Config?$filter=' + encodeURIComponent("Key eq 'LUNCH.TIME.END'"),
      { headers: authHeaders }
    );
    var startTime = startCfg.value && startCfg.value[0] && startCfg.value[0].ValueString;
    var endTime = endCfg.value && endCfg.value[0] && endCfg.value[0].ValueString;
    if (!startTime || !endTime || currentTime < startTime || currentTime > endTime) {
      return stop(res, 'OUTSIDE_RESERVATION_WINDOW', { currentTime: currentTime, startTime: startTime, endTime: endTime });
    }

    var participantFilter = "ReserveTime eq " + today + " and NIK eq '" + NIK + "'";
    var participantResp = await callApi(
      '/api/v1/LunchParticipant?$filter=' + encodeURIComponent(participantFilter) + '&expand=' + encodeURIComponent('FoodMenu($expand=MenuLists)'),
      { headers: authHeaders }
    );
    if (participantResp.value && participantResp.value.length > 0) {
      return stop(res, 'ALREADY_RESERVED', participantResp.value[0]);
    }

    var hrisResp = await callApi('/api/v2/HRISUser2/' + encodeURIComponent(NIK), { headers: authHeaders });
    var user = hrisResp.value && hrisResp.value[0];
    if (!user || !user.Meal) {
      return stop(res, 'USER_MEAL_NOT_FOUND', hrisResp);
    }
    var mealType = MEAL_TYPE_MAP[user.Meal] || user.Meal;

    var menuFilter = 'Date eq ' + today + ' and Publish eq true';
    var menuResp = await callApi(
      '/api/v1/FoodMenu?$filter=' + encodeURIComponent(menuFilter) + '&$expand=MenuLists',
      { headers: authHeaders }
    );
    var menu = (menuResp.value || []).find(function (m) { return m.Type === mealType; });
    if (!menu) {
      return stop(res, 'MENU_NOT_FOUND', { date: today, mealType: mealType });
    }
    if (menu.Status === 'CLOSED') {
      return stop(res, 'MENU_CLOSED', menu);
    }

    var reserveResp = await callApi('/api/V2/LunchParticipant/Reserve', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
      body: JSON.stringify({ FoodMenuID: menu.ID, NIK: NIK })
    });

    res.json({ ok: true, reason: 'RESERVED', foodMenuId: menu.ID, mealType: mealType, detail: reserveResp });
  } catch (err) {
    res.status(502).json({ ok: false, reason: 'UPSTREAM_ERROR', detail: err.body || err.message });
  }
});

module.exports = router;

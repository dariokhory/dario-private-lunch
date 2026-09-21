var fs = require('fs');
var path = require('path');
var cron = require('node-cron');
var runLunchOrder = require('./routes/lunch').runLunchOrder;

var RESULT_DIR = path.join(__dirname, 'result');

function parseRunDates(value) {
  var dates = (value || '').split(',').map(function (date) { return date.trim(); }).filter(Boolean);
  dates.forEach(function (date) {
    var parsed = new Date(date + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
      throw new Error('Invalid LUNCH_RUN_DATES date: ' + date + ' (expected YYYY-MM-DD)');
    }
  });
  return new Set(dates);
}

function localDate(timezone, now) {
  var parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now || new Date());
  function value(type) {
    return parts.find(function (part) { return part.type === type; }).value;
  }
  return value('year') + '-' + value('month') + '-' + value('day');
}

function claimDate(date) {
  fs.mkdirSync(RESULT_DIR, { recursive: true });
  var lockPath = path.join(RESULT_DIR, 'lunch-cron-' + date + '.lock');
  try {
    var fd = fs.openSync(lockPath, 'wx');
    try {
      fs.writeSync(fd, 'Claimed at ' + new Date().toISOString() + '\n');
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

function startLunchScheduler() {
  var dates = parseRunDates(process.env.LUNCH_RUN_DATES);
  if (dates.size === 0) return null;

  var expression = process.env.LUNCH_CRON;
  var timezone = process.env.LUNCH_TIMEZONE || 'Asia/Jakarta';
  if (!expression || !cron.validate(expression)) {
    throw new Error('LUNCH_CRON must contain a valid cron expression');
  }
  localDate(timezone); // Validate the configured timezone at startup.

  console.log('Lunch scheduler active:', expression, timezone, Array.from(dates).join(', '));
  return cron.schedule(expression, async function () {
    var date = localDate(timezone);
    if (!dates.has(date) || !claimDate(date)) return;

    try {
      var result = await runLunchOrder();
      console.log('Lunch scheduler result:', date, result.body.reason);
    } catch (err) {
      console.error('Lunch scheduler failed:', date, err);
    }
  }, { timezone: timezone, noOverlap: true });
}

module.exports = { startLunchScheduler: startLunchScheduler, parseRunDates: parseRunDates, localDate: localDate };

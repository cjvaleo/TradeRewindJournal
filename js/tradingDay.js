/* tradingDay.js — Trading Day Foundation (Workstream 1)
 * Canonical timezone: America/New_York. Uses ONLY Intl.DateTimeFormat.
 * Never hardcodes a UTC offset (handles DST automatically).
 *
 * window.TradingDay = {
 *   getTradingDay(utcMs),     // -> 'YYYY-MM-DD' | null (market closed)
 *   getSession(utcMs),        // -> session label string
 *   isMarketOpen(utcMs),      // -> boolean
 *   getNextOpen(utcMs),       // -> {label, msUntil}
 *   formatET(utcMs),          // -> 'HH:MM'
 *   getTodayTradingDay(),     // -> getTradingDay(Date.now())
 * }
 */
(function () {
  'use strict';

  var TZ = 'America/New_York';

  // --- Internal: normalize input to a Date ---
  function toDate(utcMs) {
    if (utcMs instanceof Date) return utcMs;
    if (utcMs == null) return new Date();
    return new Date(utcMs);
  }

  // --- Internal: extract ET calendar/clock parts for a given instant ---
  // Returns {year, month(1-12), day, hour(0-23), minute, weekday(0=Sun..6=Sat)}
  var _partsFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short'
  });

  var WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  function getETParts(utcMs) {
    var d = toDate(utcMs);
    var parts = _partsFmt.formatToParts(d);
    var out = {};
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p.type === 'year') out.year = parseInt(p.value, 10);
      else if (p.type === 'month') out.month = parseInt(p.value, 10);
      else if (p.type === 'day') out.day = parseInt(p.value, 10);
      else if (p.type === 'hour') out.hour = parseInt(p.value, 10);
      else if (p.type === 'minute') out.minute = parseInt(p.value, 10);
      else if (p.type === 'weekday') out.weekday = WEEKDAY_INDEX[p.value];
    }
    // Intl can emit hour '24' at midnight in some engines; normalize to 0.
    if (out.hour === 24) out.hour = 0;
    return out;
  }

  // --- Internal: zero-padded 'YYYY-MM-DD' from numeric parts ---
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function dateStr(year, month, day) {
    return year + '-' + pad2(month) + '-' + pad2(day);
  }

  // --- Internal: add N calendar days to ET-date parts, with month/year wrap ---
  // Uses a UTC Date purely as a calendar-arithmetic vehicle (no TZ involved).
  function addDaysToParts(year, month, day, n) {
    var d = new Date(Date.UTC(year, month - 1, day));
    d.setUTCDate(d.getUTCDate() + n);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate()
    };
  }

  function nextDayStr(p) {
    var n = addDaysToParts(p.year, p.month, p.day, 1);
    return dateStr(n.year, n.month, n.day);
  }
  function sameDayStr(p) {
    return dateStr(p.year, p.month, p.day);
  }

  // --- getTradingDay ---
  function getTradingDay(utcMs) {
    var p = getETParts(utcMs);
    var dow = p.weekday; // 0=Sun..6=Sat
    var hour = p.hour;

    // Reset attribution flag each call; set true only on 17:00-17:59 ET.
    TradingDay._attributionFlag = false;

    // Saturday: market closed all day.
    if (dow === 6) return null;

    // Sunday: closed before 18:00 ET; opens at 18:00 -> attributes to Monday.
    if (dow === 0) {
      if (hour < 18) return null;
      return nextDayStr(p); // Sunday 18:00+ -> Monday
    }

    // Friday: closed from 17:00 ET onward (until Sunday 18:00).
    if (dow === 5 && hour >= 17) return null;

    // Weekday cutover logic (Mon-Fri before Fri 17:00):
    // hour < 17  -> that ET date
    // hour == 17 -> next date + attribution flag
    // hour >= 18 -> next date
    if (hour < 17) return sameDayStr(p);
    if (hour === 17) {
      TradingDay._attributionFlag = true;
      return nextDayStr(p);
    }
    return nextDayStr(p); // hour >= 18
  }

  // --- getSession ---
  function getSession(utcMs) {
    var p = getETParts(utcMs);
    var mins = p.hour * 60 + p.minute;

    var H = function (h, m) { return h * 60 + (m || 0); };

    // ASIA 20:00-01:59 (wraps midnight)
    if (mins >= H(20, 0) || mins < H(2, 0)) return 'ASIA';
    // LONDON 02:00-09:29
    if (mins >= H(2, 0) && mins < H(9, 30)) return 'LONDON';
    // NY AM 09:30-11:59
    if (mins >= H(9, 30) && mins < H(12, 0)) return 'NY AM';
    // LUNCH 12:00-13:29
    if (mins >= H(12, 0) && mins < H(13, 30)) return 'LUNCH';
    // NY PM 13:30-15:59
    if (mins >= H(13, 30) && mins < H(16, 0)) return 'NY PM';
    // CLOSE 16:00-16:59
    if (mins >= H(16, 0) && mins < H(17, 0)) return 'CLOSE';
    // Otherwise (17:00-19:59) -> AFTER HOURS
    return 'AFTER HOURS';
  }

  // --- isMarketOpen ---
  // Market is open from Sunday 18:00 ET through Friday 17:00 ET, closing
  // daily from 17:00-17:59 ET (the maintenance break), reopening 18:00 ET.
  function isMarketOpen(utcMs) {
    var p = getETParts(utcMs);
    var dow = p.weekday;
    var hour = p.hour;

    // Weekend closures.
    if (dow === 6) return false;                 // Saturday
    if (dow === 0 && hour < 18) return false;     // Sunday before 18:00
    if (dow === 5 && hour >= 17) return false;     // Friday 17:00 onward

    // Daily maintenance break 17:00-17:59 ET (Mon-Thu; Sun has no 17:00 break
    // because it's already closed before 18:00, handled above).
    if (hour === 17) return false;

    return true;
  }

  // --- getNextOpen ---
  // Returns {label, msUntil} describing the next market open instant.
  // If the market is currently open, msUntil is 0.
  function getNextOpen(utcMs) {
    var nowMs = toDate(utcMs).getTime();

    if (isMarketOpen(nowMs)) {
      return { label: 'OPEN', msUntil: 0 };
    }

    // Scan forward minute-by-minute to the next open instant. Bounded to
    // ~4 days (covers the longest closure: Fri 17:00 -> Sun 18:00 ~ 49h,
    // plus margin). Step in 60s increments.
    var STEP = 60 * 1000;
    var MAX_STEPS = 4 * 24 * 60 + 120; // ~4 days + buffer
    var t = nowMs;
    for (var i = 0; i < MAX_STEPS; i++) {
      t += STEP;
      if (isMarketOpen(t)) {
        // Refine to the exact minute boundary already aligned by step.
        var p = getETParts(t);
        var label;
        var dow = p.weekday;
        if (dow === 0) label = 'Sunday open';
        else if (dow === 1) label = 'Monday open';
        else label = 'Market open';
        return { label: label, msUntil: t - nowMs };
      }
    }
    return { label: 'Market open', msUntil: -1 };
  }

  // --- formatET ---
  var _timeFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  function formatET(utcMs) {
    var parts = _timeFmt.formatToParts(toDate(utcMs));
    var hh = '00', mm = '00';
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].type === 'hour') hh = parts[i].value;
      else if (parts[i].type === 'minute') mm = parts[i].value;
    }
    if (hh === '24') hh = '00';
    return hh + ':' + mm;
  }

  // --- getTodayTradingDay ---
  function getTodayTradingDay() {
    return getTradingDay(Date.now());
  }

  var TradingDay = {
    _attributionFlag: false,
    getTradingDay: getTradingDay,
    getSession: getSession,
    isMarketOpen: isMarketOpen,
    getNextOpen: getNextOpen,
    formatET: formatET,
    getTodayTradingDay: getTodayTradingDay
  };

  window.TradingDay = TradingDay;

  // --- display_tz support (affects clock display only, never grouping) ---
  // User-controlled display timezone (affects clock display only, never grouping)
  window.TradingDay.displayTz = 'America/New_York'; // default
  window.TradingDay.setDisplayTz = function(tz) {
    window.TradingDay.displayTz = tz || 'America/New_York';
    try { localStorage.setItem('tr1_display_tz', tz); } catch(e) {}
  };
  window.TradingDay.getDisplayTz = function() { return window.TradingDay.displayTz; };
  // Format a UTC timestamp for display in the user's display timezone
  window.TradingDay.formatDisplay = function(utcMs, opts) {
    return new Intl.DateTimeFormat('en-US', Object.assign(
      {timeZone: window.TradingDay.displayTz || 'America/New_York'},
      opts || {hour:'2-digit', minute:'2-digit', hour12: true}
    )).format(new Date(utcMs));
  };
  // Returns 'ET' badge when displayTz is America/New_York, else the tz abbreviation
  window.TradingDay.displayTzBadge = function() {
    var tz = window.TradingDay.displayTz || 'America/New_York';
    if (tz === 'America/New_York') return 'ET';
    try {
      return new Intl.DateTimeFormat('en-US',{timeZone:tz,timeZoneName:'short'}).formatToParts(Date.now())
        .find(function(p){return p.type==='timeZoneName';}).value;
    } catch(e) { return tz; }
  };
  // Common timezone options for the Settings dropdown
  window.TradingDay.TZ_OPTIONS = [
    {value:'America/New_York',    label:'New York (ET)'},
    {value:'America/Chicago',     label:'Chicago (CT)'},
    {value:'America/Denver',      label:'Denver (MT)'},
    {value:'America/Los_Angeles', label:'Los Angeles (PT)'},
    {value:'America/Toronto',     label:'Toronto (ET)'},
    {value:'Europe/London',       label:'London (GMT/BST)'},
    {value:'Europe/Berlin',       label:'Frankfurt/Berlin (CET)'},
    {value:'Asia/Singapore',      label:'Singapore (SGT)'},
    {value:'Asia/Tokyo',          label:'Tokyo (JST)'},
    {value:'Australia/Sydney',    label:'Sydney (AEDT)'},
    {value:'device',              label:'Device local time'},
  ];
})();

// Restore saved display_tz on initialization
(function(){
  try {
    var saved = localStorage.getItem('tr1_display_tz');
    if(saved) window.TradingDay.displayTz = saved;
  } catch(e) {}
})();

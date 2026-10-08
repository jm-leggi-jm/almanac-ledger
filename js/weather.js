// Open-Meteo access: geocoding, observed history (for actuals + normals), and the 16-day forecast.
const Weather = (() => {
  const GEO = 'https://geocoding-api.open-meteo.com/v1/search';
  const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
  const FORECAST = 'https://api.open-meteo.com/v1/forecast';
  const DAILY = 'temperature_2m_max,temperature_2m_min,precipitation_sum,snowfall_sum';
  const UNITS = 'temperature_unit=fahrenheit&precipitation_unit=inch&timezone=auto';
  const HISTORY_YEARS = 12;   // 10 years of normals plus room for windows that end next year

  async function getJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
    return res.json();
  }

  async function geocode(query) {
    const data = await getJSON(`${GEO}?name=${encodeURIComponent(query)}&count=6&language=en&format=json`);
    return (data.results || []).map((r) => ({
      name: [r.name, r.admin1, r.country_code].filter(Boolean).join(', '),
      lat: r.latitude,
      lon: r.longitude,
    }));
  }

  // Open-Meteo daily arrays -> { 'YYYY-MM-DD': { tmax, tmin, precip, snow } }
  function toDayMap(daily) {
    const map = {};
    daily.time.forEach((date, i) => {
      const tmax = daily.temperature_2m_max[i];
      const tmin = daily.temperature_2m_min[i];
      if (tmax == null || tmin == null) return;
      map[date] = {
        tmax, tmin,
        precip: daily.precipitation_sum[i] ?? 0,       // rain + melted snow
        snow: daily.snowfall_sum[i] ?? 0,              // snow depth
        rain: daily.rain_sum ? daily.rain_sum[i] ?? 0 : null,                      // forecast only
        pop: daily.precipitation_probability_max ? daily.precipitation_probability_max[i] ?? null : null,
      };
    });
    return map;
  }

  const historyCache = new Map();

  // The archive's newest allowed day moves. Ask through the viewer's today, and if that's past
  // the published range, retry through the date named in the error instead of failing the load.
  async function archiveJSON(loc, start, end) {
    const urlFor = (endDate) =>
      `${ARCHIVE}?latitude=${loc.lat}&longitude=${loc.lon}&start_date=${start}&end_date=${endDate}&daily=${DAILY}&${UNITS}`;
    let res = await fetch(urlFor(end));
    if (res.status === 400) {
      let reason = '';
      try { reason = (await res.json()).reason || ''; } catch { /* body wasn't JSON */ }
      const allowed = /to (\d{4}-\d{2}-\d{2})/.exec(reason)?.[1];
      if (allowed && allowed >= start && allowed < end) res = await fetch(urlFor(allowed));
    }
    if (!res.ok) throw new Error(`${res.status} from ${new URL(ARCHIVE).host}`);
    return res.json();
  }

  // Drop the location's current day — its high and total aren't final yet.
  function completeDays(data) {
    const today = Dates.todayAt(data.utc_offset_seconds);
    const days = toDayMap(data.daily);
    for (const date of Object.keys(days)) if (date >= today) delete days[date];
    return { days, today };
  }

  async function history(loc) {
    const key = `${loc.lat.toFixed(3)},${loc.lon.toFixed(3)}`;
    if (!historyCache.has(key)) {
      const browserToday = Dates.today();
      const start = Dates.shiftYears(browserToday, HISTORY_YEARS);
      const promise = archiveJSON(loc, start, browserToday).then((data) => {
        const { days, today } = completeDays(data);
        const dates = Object.keys(days).sort();
        if (!dates.length) throw new Error('no observed days');
        return { days, lastDate: dates[dates.length - 1], today };
      });
      promise.catch(() => historyCache.delete(key));
      historyCache.set(key, promise);
    }
    return historyCache.get(key);
  }

  // Observed days from `start` through the last complete local day — a light fetch for the wall display.
  async function recent(loc, start) {
    const data = await archiveJSON(loc, start, Dates.today());
    return completeDays(data);
  }

  // past_days covers recent days the archive hasn't published yet, for in-progress ledger windows.
  async function forecast(loc) {
    const data = await getJSON(`${FORECAST}?latitude=${loc.lat}&longitude=${loc.lon}&daily=${DAILY},rain_sum,precipitation_probability_max&past_days=7&forecast_days=16&${UNITS}`);
    return { days: toDayMap(data.daily), today: Dates.todayAt(data.utc_offset_seconds) };
  }

  return { geocode, history, recent, forecast };
})();

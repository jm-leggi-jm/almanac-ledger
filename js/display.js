// Wall-display view (DAKboard Website/iframe block and similar): hands-off, sized to its frame,
// configured by URL parameters, and refreshes its own data on a schedule. Two panels: the looping
// radar, and forecast vs. actual for the last 30 days.
(() => {
  const DAYS = 30;
  const DATA_REFRESH_MS = 30 * 60 * 1000;
  const RELOAD_HOUR = 3;      // reload the whole page daily around 3 a.m. to pick up app updates

  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // ---------- Settings from the URL (untrusted: every value is range-checked) ----------
  // Older addresses may also carry `panels` and `days`; those are ignored now.

  const q = new URLSearchParams(location.search);
  const number = (key, fallback) => {
    const v = parseFloat(q.get(key));
    return Number.isFinite(v) ? v : fallback;
  };
  const loc = {
    lat: clamp(number('lat', 44.1004), -85, 85),
    lon: clamp(number('lon', -70.2148), -180, 180),
    name: (q.get('name') || 'Lewiston, Maine').slice(0, 60),
  };
  const theme = ['dark', 'light', 'transparent'].includes(q.get('theme')) ? q.get('theme') : 'auto';
  const lead = clamp(Math.round(number('lead', 1)), 1, 7);
  const zoom = clamp(Math.round(number('zoom', 6)), 3, 7);

  if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
  if (theme === 'transparent') {
    document.documentElement.dataset.theme = 'dark';
    document.body.classList.add('transparent');
  }

  // ---------- Layout ----------

  const ahead = `${lead} day${lead === 1 ? '' : 's'} ahead`;
  $('board').innerHTML = `
    <section class="panel" data-panel="radar">
      <h2 class="panel-title">Radar</h2>
      <div class="panel-body" id="body-radar"></div>
    </section>
    <section class="panel" data-panel="actual">
      <h2 class="panel-title">Forecast vs. actual<span class="panel-sub"> · last ${DAYS} days, forecasts made ${ahead}</span></h2>
      <div class="panel-body" id="body-actual"><p class="panel-wait">Loading…</p></div>
    </section>`;
  $('d-place').textContent = loc.name;

  Radar.mount($('body-radar'), { kiosk: true, zoom });
  Radar.setLocation(loc);

  // ---------- Data ----------

  let fc = null;              // forecast incl. the last 7 days (fills in the most recent actuals)
  let recent = null;          // observed days covering the window
  let pastFc = null;          // what forecasts said 1–7 days ahead
  let lastOk = null;

  async function load() {
    const today = Dates.today();
    const from = Dates.addDays(today, -DAYS);
    const results = await Promise.allSettled([
      Weather.forecast(loc).then((d) => { fc = d; }),
      Weather.recent(loc, Dates.addDays(from, -1)).then((d) => { recent = d; }),
      Verify.forecasts(loc, today, from).then((d) => { pastFc = d; }),
    ]);
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed < results.length) lastOk = new Date();
    setStatus(failed);
    render();
  }

  function setStatus(failed) {
    const time = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const el = $('d-status');
    if (!lastOk) el.textContent = failed ? 'Weather data unavailable — retrying' : 'Loading…';
    else el.textContent = `${failed ? 'Some data unavailable · last good ' : 'Updated '}${time(lastOk)}`;
    el.classList.toggle('warn', !!failed);
  }

  // ---------- Forecast vs. actual ----------

  const series = [
    { key: 'ahi', label: 'Actual high', color: 'var(--warm)' },
    { key: 'fhi', label: 'Forecast high', color: 'var(--warm)', dashed: true },
    { key: 'alo', label: 'Actual low', color: 'var(--cool)' },
    { key: 'flo', label: 'Forecast low', color: 'var(--cool)', dashed: true },
  ];

  function render() {
    const body = $('body-actual');
    if (!pastFc || !recent || !fc) return;
    const today = Dates.today();
    const pairs = Verify.pairs(pastFc, { ...fc, ...recent }, lead, Dates.addDays(today, -DAYS), Dates.addDays(today, -1));
    const s = Verify.summarize(pairs);
    const pct = (a) => `${Math.round((a / s.n) * 100)}%`;
    const rows = pairs.map((r) => ({
      date: r.date,
      ahi: r.actual ? r.actual.tmax : null, alo: r.actual ? r.actual.tmin : null,
      fhi: r.forecast ? r.forecast.tmax : null, flo: r.forecast ? r.forecast.tmin : null,
    }));
    body.innerHTML = `
      ${s ? `<div class="d-stats" aria-label="Average forecast miss, last ${DAYS} days">
        <div><span>Highs off by</span><strong>±${s.highMiss.toFixed(1)}°</strong></div>
        <div><span>Lows off by</span><strong>±${s.lowMiss.toFixed(1)}°</strong></div>
        <div><span>Within 3°</span><strong>${pct(s.within3)}</strong></div>
        <div><span>Rain called right</span><strong>${pct(s.rainRight)}</strong></div>
      </div>` : ''}
      <div class="legend d-legend"></div>
      <div class="chart d-chart"></div>`;
    Chart.legend(body.querySelector('.d-legend'), series);
    const chartEl = body.querySelector('.d-chart');
    Chart.render(chartEl, rows, {
      series, tooltip: $('tooltip'), height: chartEl.clientHeight,
      tip: (r) => `<strong>${Dates.short(r.date)}</strong><div>High ${r.ahi == null ? '—' : Math.round(r.ahi) + '°'} · forecast ${r.fhi == null ? '—' : Math.round(r.fhi) + '°'}</div><div>Low ${r.alo == null ? '—' : Math.round(r.alo) + '°'} · forecast ${r.flo == null ? '—' : Math.round(r.flo) + '°'}</div>`,
      xLabel: (r) => Dates.short(r.date),
      ariaLabel: `Actual daily highs and lows against the forecast made ${ahead}, last ${DAYS} days`,
    });
  }

  // ---------- Schedule ----------

  let resizeTimer;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 200);
  }).observe($('board'));

  setInterval(load, DATA_REFRESH_MS);

  // Reload the page once a day (default: next 3 a.m.) so the display picks up app updates and starts fresh.
  const next = new Date();
  next.setHours(RELOAD_HOUR, 0, 0, 0);
  if (next <= new Date()) next.setDate(next.getDate() + 1);
  setTimeout(() => location.reload(), next - new Date());

  setStatus(0);
  load();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* fine without offline support */ });
  }
})();

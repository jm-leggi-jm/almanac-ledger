// Wall-display view (DAKboard Website/iframe block and similar): hands-off, sized to its frame,
// configured by URL parameters, and refreshes its own data on a schedule. Two panels: the looping
// radar, and forecast accuracy for the last 30 days.
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
    <section class="panel" data-panel="accuracy">
      <h2 class="panel-title">Forecast accuracy<span class="panel-sub"> · last ${DAYS} days</span></h2>
      <div class="panel-body" id="body-accuracy"><p class="panel-wait">Loading…</p></div>
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

  // ---------- Forecast accuracy ----------

  // Headline numbers for forecasts made `lead` days ahead, then the average miss for every lead
  // time (1–7 days ahead), so you can see accuracy fall off the further out a forecast is.
  function render() {
    const body = $('body-accuracy');
    if (!pastFc || !recent || !fc) return;
    const today = Dates.today();
    const actual = { ...fc, ...recent };
    const rowsFor = (k) => Verify.pairs(pastFc, actual, k, Dates.addDays(today, -DAYS), Dates.addDays(today, -1));
    const s = Verify.summarize(rowsFor(lead));
    if (!s) { body.innerHTML = '<p class="panel-wait">No data yet</p>'; return; }
    const pct = (a) => `${Math.round((a / s.n) * 100)}%`;
    const byLead = Verify.LEADS.map((k) => ({ k, s: Verify.summarize(rowsFor(k)) })).filter((x) => x.s);
    const worst = Math.max(...byLead.map((x) => x.s.tempMiss), 0.1);
    body.innerHTML = `
      <p class="acc-caption">Forecasts made ${ahead}</p>
      <div class="d-stats">
        <div><span>Highs</span><strong>±${s.highMiss.toFixed(1)}°</strong></div>
        <div><span>Lows</span><strong>±${s.lowMiss.toFixed(1)}°</strong></div>
        <div><span>Within 3°</span><strong>${pct(s.within3)}</strong></div>
        <div><span>Rain right</span><strong>${pct(s.rainRight)}</strong></div>
      </div>
      <div class="d-leads" aria-label="Average miss by how many days ahead the forecast was made">
        ${byLead.map(({ k, s: x }) => `
          <div class="d-lead${k === lead ? ' on' : ''}">
            <span>${k}d</span><span class="lead-bar"><i style="width:${(x.tempMiss / worst) * 100}%"></i></span><b>±${x.tempMiss.toFixed(1)}°</b>
          </div>`).join('')}
      </div>`;
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

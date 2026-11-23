// Token Launch Radar dashboard: renders window.RADAR (written by main.ts).
// No network: every number on this page comes from the snapshot via data.js.
(function () {
  var R = window.RADAR;
  var rows = R.rows.slice();
  var fmt$ = function (n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
    return '$' + n;
  };
  var fmtPct = function (x) { return x === null || x === undefined ? '—' : (x > 0 ? '+' : '') + x.toFixed(1) + '%'; };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

  document.getElementById('asOf').textContent = R.as_of + ' (' + R.source.split(', fetched ')[1] + ')';
  document.getElementById('counts').textContent = R.board_size + ' pre-token protocols ranked · ' + R.watchlist_size + ' on the watchlist · ' + R.live_size + ' live-token references';

  var m = R.model, v = R.validation;
  document.getElementById('modelText').innerHTML =
    'Fitted FDV = exp(' + m.fit.intercept + ' + ' + m.fit.log_tvl_slope + ' × ln TVL), a log-log fit on ' + m.fit.peers +
    ' live-token peers in this snapshot. The multiple falls with size, so big protocols are not overvalued. ' +
    'Growth tilt: ' + esc(m.growth_tilt) + '. Age tilt: ' + esc(m.age_tilt) + '. Launch odds: ' + esc(m.odds) + '. ' +
    'Implied value = fitted FDV × growth tilt × age tilt × launch odds. Range: ' + esc(m.range) + '. ' +
    'Dropped on blind tests: ' + esc(m.dropped) + '.';
  document.getElementById('valStats').innerHTML =
    '<div class="stat"><span>Leave-one-out (128 peers)</span><b>median |log err| ' + v.loo.med + '</b>mean ' + v.loo.mean + ' · within 2× ' + v.loo.within2x + '%</div>' +
    '<div class="stat"><span>Walk-forward (52 fit, 43 test)</span><b>median |log err| ' + v.walk_forward.med + '</b>mean ' + v.walk_forward.mean + ' · within 2× ' + v.walk_forward.within2x + '%</div>' +
    '<div class="stat"><span>Flat multiple 0.25 (starter)</span><b>median |log err| ' + v.flat_multiple_025.med + '</b>mean ' + v.flat_multiple_025.mean + ' — worse on both tests</div>' +
    '<div class="stat"><span>What the range means</span><b>×0.3 to ×3.3</b>implied value is a factor-3 claim, not a price target</div>';

  // filter controls
  var cats = {}, chains = {};
  rows.forEach(function (r) { if (r.category) cats[r.category] = 1; r.chains.forEach(function (c) { chains[c] = 1; }); });
  var catSel = document.getElementById('cat'), chainSel = document.getElementById('chain');
  Object.keys(cats).sort().forEach(function (c) { var o = document.createElement('option'); o.value = c; o.textContent = c; catSel.appendChild(o); });
  Object.keys(chains).sort().forEach(function (c) { var o = document.createElement('option'); o.value = c; o.textContent = c; chainSel.appendChild(o); });

  var sortKey = 'rank';
  function visible() {
    var q = document.getElementById('q').value.trim().toLowerCase();
    var cat = catSel.value, ch = chainSel.value;
    var wl = document.getElementById('watchOnly').checked;
    var list = rows.filter(function (r) {
      if (wl && !r.watchlist) return false;
      if (cat && r.category !== cat) return false;
      if (ch && r.chains.indexOf(ch) < 0) return false;
      if (q && (r.name + ' ' + r.slug).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var key = sortKey;
    list.sort(function (a, b) {
      if (key === 'tvl') return b.tvl_usd - a.tvl_usd;
      if (key === 'growth') return (b.change_7d || 0) - (a.change_7d || 0);
      if (key === 'odds') return b.odds - a.odds;
      if (key === 'age') return (b.age_days || 0) - (a.age_days || 0);
      return a.rank - b.rank;
    });
    return list;
  }
  function render() {
    var list = visible();
    var tb = document.getElementById('rows');
    tb.innerHTML = list.map(function (r) {
      return '<tr data-slug="' + esc(r.slug) + '"><td>' + r.rank + (r.watchlist ? ' <span class="wl">★</span>' : '') + '</td>' +
        '<td><b>' + esc(r.name) + '</b><br><span class="tag">' + esc(r.slug) + '</span></td>' +
        '<td>' + esc(r.category || '—') + '</td><td>' + r.chains.slice(0, 3).map(esc).join(', ') + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') + '</td>' +
        '<td class="num">' + fmt$(r.tvl_usd) + '</td><td class="num">' + fmtPct(r.change_7d) + '</td>' +
        '<td class="num">' + (r.odds * 100).toFixed(0) + '%</td><td class="num"><b>' + fmt$(r.value) + '</b></td>' +
        '<td class="num">' + fmt$(r.low) + ' – ' + fmt$(r.high) + '</td></tr>';
    }).join('');
    document.getElementById('shown').textContent = 'Showing ' + list.length + ' of ' + rows.length + ' ranked protocols. ★ = on the 40-protocol watchlist. Click a row for its detail and farm plan.';
  }
  document.querySelectorAll('#board th[data-k]').forEach(function (th) {
    th.addEventListener('click', function () {
      var k = th.getAttribute('data-k');
      sortKey = k === 'name' ? 'rank' : k === 'category' ? 'rank' : k === 'chains' ? 'rank' : k === 'value' ? 'rank' : k;
      if (k === 'tvl' || k === 'growth' || k === 'odds' || k === 'age') sortKey = k;
      document.getElementById('sort').value = sortKey === 'rank' ? 'rank' : sortKey;
      render();
    });
  });
  ['q', 'cat', 'chain', 'watchOnly', 'preOnly', 'sort'].forEach(function (id) {
    document.getElementById(id).addEventListener('input', function () {
      if (id === 'sort') sortKey = document.getElementById('sort').value;
      render();
    });
  });
  document.getElementById('rows').addEventListener('click', function (e) {
    var tr = e.target.closest('tr');
    if (tr) showDetail(tr.getAttribute('data-slug'));
  });

  // detail view
  var fmt$2 = fmt$;
  function showDetail(slug) {
    var r = null;
    rows.forEach(function (x) { if (x.slug === slug) r = x; });
    if (!r) return;
    var age = r.age_days === null ? 'unknown' : (r.age_days / 365.25).toFixed(1) + ' years (' + r.age_days + ' days)';
    document.getElementById('dName').textContent = '#' + r.rank + ' ' + r.name + (r.watchlist ? ' ★ watchlist' : '');
    document.getElementById('dMeta').textContent = (r.category || 'No category') + ' · ' + r.chains.join(', ') + ' · listed ' + (r.listed_at || 'unknown') + ' · records no token';
    document.getElementById('dGrid').innerHTML =
      '<div><span>Implied value</span><b>' + fmt$2(r.value) + '</b></div>' +
      '<div><span>Range (×0.3 – ×3.3)</span><b>' + fmt$2(r.low) + ' – ' + fmt$2(r.high) + '</b></div>' +
      '<div><span>Fitted FDV (before odds)</span><b>' + fmt$2(r.fdv) + '</b></div>' +
      '<div><span>Launch odds</span><b>' + (r.odds * 100).toFixed(0) + '%</b></div>' +
      '<div><span>TVL</span><b>' + fmt$2(r.tvl_usd) + '</b></div>' +
      '<div><span>7-day TVL change</span><b>' + fmtPct(r.change_7d) + '</b></div>' +
      '<div><span>Age</span><b>' + age + '</b></div>' +
      '<div><span>Implied FDV / TVL</span><b>' + (r.fdv / r.tvl_usd).toFixed(2) + '×</b></div>';
    document.getElementById('dSteps').innerHTML = r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    document.getElementById('dWarn').textContent = 'This is not a promise of an airdrop. ' + r.name + ' records no token in the snapshot; that is DefiLlama\'s record, not proof it has none, and nothing here says whether or when a token is issued. Farm only money you can afford to lock up, and never pay anyone for a “guaranteed” allocation.';
    document.getElementById('detail').hidden = false;
    document.getElementById('detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  document.getElementById('closeDetail').addEventListener('click', function () {
    document.getElementById('detail').hidden = true;
  });

  // live-token reference table
  document.getElementById('liveRows').innerHTML = R.live.map(function (p) {
    return '<tr><td><b>' + esc(p.name) + '</b><br><span class="tag">' + esc(p.slug) + '</span></td><td>' + esc(p.category || '—') + '</td>' +
      '<td class="num">' + fmt$2(p.tvl_usd) + '</td><td class="num">' + fmt$2(p.mcap_usd) + '</td>' +
      '<td class="num">' + p.multiple.toFixed(2) + '×</td><td class="num">' + fmt$2(p.fitted) + '</td></tr>';
  }).join('');

  render();
})();

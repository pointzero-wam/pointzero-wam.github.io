/* Interactive result charts. Replaces each results table with a grouped bar
   chart (the table stays, one click away, as the table view).
   Colour is NOT decided here: every series carries the colour assigned by the
   one global method->colour map in tools/build_charts_json.py, which guarantees
   a method wears the same hue in all three charts and no hue is ever reused for
   a second method. Baselines take the validated categorical slots; the orange
   family (#f69674 / #eb6834 / #ad4214) is reserved for PointZero variants.
   Worst same-chart adjacent separation is CVD dE 9.2 / normal dE 16.3, both
   above floor. Aqua, yellow, magenta and the light orange sit under 3:1
   contrast, so the relief rule applies -> the legend, the per-bar tooltip and
   the table view are always available. */
(function () {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';
  function el(n, a) {
    var e = document.createElementNS(SVGNS, n);
    for (var k in a) e.setAttribute(k, a[k]);
    return e;
  }
  function nice(v) {
    var p = Math.pow(10, Math.floor(Math.log10(v)));
    return Math.ceil(v / p * 2) / 2 * p;
  }
  function fmt(v) { return v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2).replace(/0$/, ''); }

  /* Hairline ring on the legend swatches. The palette's light steps (yellow,
     magenta, light orange) are under 3:1 against the page, and a 10px chip of
     them nearly vanishes without an edge. Injected rather than added to
     index.css so this file stays self-contained (no new <link> in index.html). */
  var css = document.createElement('style');
  css.textContent = '.ch-leg i{box-shadow:inset 0 0 0 1px rgba(11,11,11,0.14)}';
  document.head.appendChild(css);

  var tip = document.createElement('div');
  tip.className = 'ch-tip'; tip.style.display = 'none';
  tip.id = 'chart-value-tooltip'; tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);

  function scaleMax(chart, metric, groups) {
    var vals = [];
    chart.series.forEach(function (series) {
      groups.forEach(function (group) {
        var v = series.data[group] && series.data[group][metric];
        if (v !== null && v !== undefined) vals.push(v);
      });
    });
    var dmax = Math.max.apply(null, vals.concat([0]));
    return (chart.axis_max && dmax <= chart.axis_max)
      ? chart.axis_max : (dmax > 0 ? nice(dmax * 1.02) : 1);
  }

  function placeTip(x, y) {
    var left = Math.min(x + 14, window.innerWidth - tip.offsetWidth - 12);
    var top = Math.min(y - 10, window.innerHeight - tip.offsetHeight - 12);
    tip.style.left = Math.max(12, left) + 'px';
    tip.style.top = (Math.max(12, top) + window.scrollY) + 'px';
  }

  function barTip(bar, chart, series, group, metric, value) {
    var label = series.name + ', ' + group + ', ' + metric + ': ' + value;
    bar.setAttribute('tabindex', '0');
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', label + '. ' + chart.unit);
    var title = el('title', {});
    title.textContent = label;
    bar.appendChild(title);
    function show(ev) {
      tip.innerHTML = '<b>' + series.name + '</b><br>' + group + ' · ' + metric +
        '<br><span class="ch-tip-v">' + value + '</span>';
      tip.style.display = 'block';
      var rect = bar.getBoundingClientRect();
      placeTip(ev && ev.clientX !== undefined ? ev.clientX : rect.right,
        ev && ev.clientY !== undefined ? ev.clientY : rect.top);
    }
    bar.addEventListener('mouseenter', show);
    bar.addEventListener('mousemove', function (ev) { placeTip(ev.clientX, ev.clientY); });
    bar.addEventListener('mouseleave', function () {
      if (document.activeElement !== bar) tip.style.display = 'none';
    });
    bar.addEventListener('focus', show);
    bar.addEventListener('click', show);
    bar.addEventListener('blur', function () { tip.style.display = 'none'; });
    bar.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') tip.style.display = 'none';
    });
  }
  document.addEventListener('click', function (ev) {
    if (!ev.target.closest('.ch-bar')) tip.style.display = 'none';
  });

  function panel(chart, metric, groups, width, height, showAxisLabel) {
    var mL = 46, mR = 8, mT = 10, mB = 42;
    var svg = el('svg', { viewBox: '0 0 ' + width + ' ' + height, class: 'ch-svg' });
    var iw = width - mL - mR, ih = height - mT - mB;
    // Percentages keep their declared ceiling; errors use a shared auto scale.
    var max = scaleMax(chart, metric, groups);

    // Whole-number ticks print without a pointless ".0" (0/25/50/75/100).
    var whole = [0, 1, 2, 3, 4].every(function (t) {
      return Math.abs(max * t / 4 - Math.round(max * t / 4)) < 1e-9;
    });

    // recessive grid + axis
    for (var t = 0; t <= 4; t++) {
      var y = mT + ih - (t / 4) * ih;
      svg.appendChild(el('line', { x1: mL, y1: y, x2: mL + iw, y2: y,
        stroke: '#e8eaee', 'stroke-width': 1 }));
      var lab = el('text', { x: mL - 8, y: y + 3.5, 'text-anchor': 'end', class: 'ch-axis' });
      lab.textContent = whole ? String(Math.round(max * t / 4)) : fmt(max * t / 4);
      svg.appendChild(lab);
    }

    var gw = iw / groups.length;
    var n = chart.series.length;
    var bw = Math.max(4, (gw * 0.78) / n - 2);   // 2px surface gap between bars
    groups.forEach(function (g, gi) {
      var gx = mL + gi * gw + (gw - (bw + 2) * n) / 2;
      chart.series.forEach(function (s, si) {
        var v = s.data[g] && s.data[g][metric];
        var x = gx + si * (bw + 2);
        if (v === null || v === undefined) {
          var dash = el('line', { x1: x, y1: mT + ih, x2: x + bw, y2: mT + ih,
            stroke: '#c7cbd1', 'stroke-width': 2, 'stroke-dasharray': '2 2' });
          svg.appendChild(dash);
          return;
        }
        var h = Math.max(2, v / max * ih);
        var r = el('rect', { x: x, y: mT + ih - h, width: bw, height: h, rx: Math.min(4, bw / 2),
          fill: s.color, class: 'ch-bar' });
        barTip(r, chart, s, g, metric, v);
        svg.appendChild(r);
      });
      var gl = el('text', { x: mL + gi * gw + gw / 2, y: height - 24, 'text-anchor': 'middle', class: 'ch-glabel' });
      gl.textContent = g.length > 14 ? g.replace(/ \(.*\)/, '') : g;
      svg.appendChild(gl);
    });
    svg.appendChild(el('line', { x1: mL, y1: mT + ih, x2: mL + iw, y2: mT + ih,
      stroke: '#c7cbd1', 'stroke-width': 1.2 }));
    if (showAxisLabel) {
      var ax = el('text', { x: mL, y: height - 6, 'text-anchor': 'start', class: 'ch-axis' });
      ax.textContent = chart.unit;
      svg.appendChild(ax);
    }
    return svg;
  }

  function render(chart, host) {
    var metric = chart.metrics[0];
    var wrap = document.createElement('div');
    wrap.className = 'ch-wrap' + (chart.facet ? '' : ' ch-has-mobile');
    wrap.dataset.chart = chart.id;
    wrap.innerHTML =
      '<div class="ch-controls">' +
      (chart.metrics.length > 1
        ? '<span class="ch-metrics">' + chart.metrics.map(function (m, i) {
            return '<button type="button" class="ch-pill' + (i === 0 ? ' is-active' : '') + '" aria-pressed="' + (i === 0) + '" data-m="' + m + '">' + m + '</button>';
          }).join('') + '</span>'
        : '') +
      '<button type="button" class="ch-table-btn" aria-expanded="false">show table</button></div>' +
      '<div class="ch-legend">' + chart.series.map(function (s) {
        return '<span class="ch-leg"><i style="background:' + s.color + '"></i>' + s.name + '</span>';
      }).join('') + '</div>' +
      '<div class="ch-plots"></div>' +
      '<p class="ch-note">' + chart.note + '</p>';
    host.parentNode.insertBefore(wrap, host);
    host.style.display = 'none';

    var plots = wrap.querySelector('.ch-plots');
    var selectedGroup = chart.groups[0];
    var mobilePlot, mobileUnit, mobileAxis;
    if (!chart.facet) {
      var mobile = document.createElement('div');
      mobile.className = 'ch-mobile';
      mobile.setAttribute('role', 'group');
      mobile.setAttribute('aria-label', chart.title);
      var groupLabel = document.createElement('label');
      groupLabel.className = 'ch-group-select';
      groupLabel.appendChild(document.createTextNode(chart.id === 'imitation' ? 'Task' : 'Scene'));
      var select = document.createElement('select');
      chart.groups.forEach(function (group) {
        var option = document.createElement('option');
        option.value = group; option.textContent = group;
        select.appendChild(option);
      });
      groupLabel.appendChild(select);
      mobile.appendChild(groupLabel);
      mobileUnit = document.createElement('p');
      mobileUnit.className = 'ch-mobile-unit';
      mobile.appendChild(mobileUnit);
      mobilePlot = document.createElement('div');
      mobilePlot.className = 'ch-mobile-plot';
      mobile.appendChild(mobilePlot);
      mobileAxis = document.createElement('div');
      mobileAxis.className = 'ch-mobile-axis';
      mobileAxis.setAttribute('aria-hidden', 'true');
      mobile.appendChild(mobileAxis);
      var scaleNote = document.createElement('p');
      scaleNote.className = 'ch-mobile-scale';
      scaleNote.textContent = 'Same scale across ' + (chart.id === 'imitation' ? 'tasks.' : 'scenes.');
      mobile.appendChild(scaleNote);
      plots.parentNode.insertBefore(mobile, plots.nextSibling);
      select.addEventListener('change', function () {
        selectedGroup = select.value;
        drawMobile();
      });
    }

    function drawMobile() {
      if (!mobilePlot) return;
      var max = scaleMax(chart, metric, chart.groups);
      mobileUnit.textContent = (metric === 'SR' ? '' : metric + ' · ') + chart.unit;
      mobilePlot.innerHTML = '';
      chart.series.forEach(function (series) {
        var value = series.data[selectedGroup] && series.data[selectedGroup][metric];
        var missing = value === null || value === undefined;
        var row = document.createElement('div');
        row.className = 'ch-mobile-row';
        var heading = document.createElement('div');
        heading.className = 'ch-mobile-heading';
        var name = document.createElement('span');
        name.className = 'ch-leg';
        name.textContent = series.name;
        var number = document.createElement('span');
        number.className = 'ch-mobile-value';
        number.textContent = missing ? '—' : String(value) + (metric === 'SR' ? '%' : '');
        if (missing) number.setAttribute('aria-label', 'Not reported');
        heading.appendChild(name); heading.appendChild(number);
        row.appendChild(heading);
        var track = document.createElement('div');
        track.className = 'ch-mobile-track';
        track.setAttribute('aria-hidden', 'true');
        var bar = document.createElement('div');
        bar.className = 'ch-mobile-bar';
        bar.style.width = (missing ? 0 : value / max * 100) + '%';
        bar.style.backgroundColor = series.color;
        track.appendChild(bar); row.appendChild(track);
        mobilePlot.appendChild(row);
      });
      mobileAxis.innerHTML = '';
      [0, max / 2, max].forEach(function (value) {
        var tick = document.createElement('span');
        tick.textContent = fmt(value);
        mobileAxis.appendChild(tick);
      });
    }

    function draw() {
      tip.style.display = 'none';
      plots.innerHTML = '';
      if (chart.facet) {
        chart.groups.forEach(function (g, i) {
          var col = document.createElement('div');
          col.className = 'ch-facet';
          col.innerHTML = '<span class="ch-facet-title">' + g + '</span>';
          col.appendChild(panel(chart, metric, [g], 250, 190, i === 0));
          plots.appendChild(col);
        });
      } else {
        plots.appendChild(panel(chart, metric, chart.groups, 780, 260, true));
      }
      drawMobile();
    }
    wrap.querySelectorAll('.ch-pill').forEach(function (b) {
      b.addEventListener('click', function () {
        wrap.querySelectorAll('.ch-pill').forEach(function (o) {
          o.classList.remove('is-active'); o.setAttribute('aria-pressed', 'false');
        });
        b.classList.add('is-active'); b.setAttribute('aria-pressed', 'true');
        metric = b.dataset.m;
        draw();
      });
    });
    var tb = wrap.querySelector('.ch-table-btn');
    tb.addEventListener('click', function () {
      var on = host.style.display === 'none';
      host.style.display = on ? '' : 'none';
      tb.textContent = on ? 'hide table' : 'show table';
      tb.setAttribute('aria-expanded', String(on));
    });
    draw();
  }

  fetch('static/hero_data/charts.json?v=' + Date.now())
    .then(function (r) { return r.json(); })
    .then(function (charts) {
      var hosts = document.querySelectorAll('.results-table-container');
      charts.forEach(function (c, i) { if (hosts[i]) render(c, hosts[i]); });
    })
    .catch(function (e) { console.error('charts', e); });
})();

/* Interactive result charts. Replaces each results table with a grouped bar
   chart (the table stays, one click away, as the table view).
   Palette: dataviz reference categorical slots, order validated for adjacent
   pairs on a light surface (CVD dE 9.1 / normal dE 22.9, both above floor).
   Aqua + yellow sit under 3:1 contrast, so the relief rule applies -> the
   table view and per-bar tooltips are always available. */
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

  var tip = document.createElement('div');
  tip.className = 'ch-tip'; tip.style.display = 'none';
  document.body.appendChild(tip);

  function panel(chart, metric, groups, width, height, showAxisLabel) {
    var mL = 46, mR = 8, mT = 10, mB = 42;
    var svg = el('svg', { viewBox: '0 0 ' + width + ' ' + height, class: 'ch-svg' });
    var iw = width - mL - mR, ih = height - mT - mB;
    var vals = [];
    chart.series.forEach(function (s) {
      groups.forEach(function (g) {
        var v = s.data[g] && s.data[g][metric];
        if (v !== null && v !== undefined) vals.push(v);
      });
    });
    var max = nice(Math.max.apply(null, vals) * 1.02);

    // recessive grid + axis
    for (var t = 0; t <= 4; t++) {
      var y = mT + ih - (t / 4) * ih;
      svg.appendChild(el('line', { x1: mL, y1: y, x2: mL + iw, y2: y,
        stroke: '#e8eaee', 'stroke-width': 1 }));
      var lab = el('text', { x: mL - 8, y: y + 3.5, 'text-anchor': 'end', class: 'ch-axis' });
      lab.textContent = fmt(max * t / 4);
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
        r.addEventListener('mouseenter', function (ev) {
          tip.innerHTML = '<b>' + s.name + '</b><br>' + g + ' · ' + metric +
            '<br><span class="ch-tip-v">' + fmt(v) + '</span>';
          tip.style.display = 'block';
          tip.style.left = (ev.clientX + 14) + 'px';
          tip.style.top = (ev.clientY + window.scrollY - 10) + 'px';
        });
        r.addEventListener('mousemove', function (ev) {
          tip.style.left = (ev.clientX + 14) + 'px';
          tip.style.top = (ev.clientY + window.scrollY - 10) + 'px';
        });
        r.addEventListener('mouseleave', function () { tip.style.display = 'none'; });
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
    wrap.className = 'ch-wrap';
    wrap.innerHTML =
      '<div class="ch-controls">' +
      (chart.metrics.length > 1
        ? '<span class="ch-metrics">' + chart.metrics.map(function (m, i) {
            return '<button class="ch-pill' + (i === 0 ? ' is-active' : '') + '" data-m="' + m + '">' + m + '</button>';
          }).join('') + '</span>'
        : '') +
      '<button class="ch-table-btn">show table</button></div>' +
      '<div class="ch-legend">' + chart.series.map(function (s) {
        return '<span class="ch-leg"><i style="background:' + s.color + '"></i>' + s.name + '</span>';
      }).join('') + '</div>' +
      '<div class="ch-plots"></div>' +
      '<p class="ch-note">' + chart.note + '</p>';
    host.parentNode.insertBefore(wrap, host);
    host.style.display = 'none';

    var plots = wrap.querySelector('.ch-plots');
    function draw() {
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
    }
    wrap.querySelectorAll('.ch-pill').forEach(function (b) {
      b.addEventListener('click', function () {
        wrap.querySelectorAll('.ch-pill').forEach(function (o) { o.classList.remove('is-active'); });
        b.classList.add('is-active');
        metric = b.dataset.m;
        draw();
      });
    });
    var tb = wrap.querySelector('.ch-table-btn');
    tb.addEventListener('click', function () {
      var on = host.style.display === 'none';
      host.style.display = on ? '' : 'none';
      tb.textContent = on ? 'hide table' : 'show table';
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

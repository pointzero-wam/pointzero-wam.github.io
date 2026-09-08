/* Glossary affordances for the results tables and charts.
   Injects, at runtime:
     - a link on every baseline method name (table row/column headers + chart legend)
     - a "?" chip after each method name, showing what the method does
     - a "?" chip after each error metric (MDE / MSE / CD / EMD) and the
       imitation success-rate column, showing the definition + equation.
   Self-contained: touches nothing in index.html. Idempotent, and re-runs via a
   MutationObserver so it works whether it loads before or after charts.js. */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ data */

  var METHODS = {
    'GBND': {
      title: 'Graph-Based Neural Dynamics',
      url: 'https://gs-dynamics.github.io/',
      desc: 'Downsamples the point cloud to 100 particles per scene and connects each to its 5 nearest ' +
            'neighbours to form a spatial graph, then applies a GNN to predict next-step per-particle ' +
            'velocities. Longer horizons come from rolling the one-step model out sequentially.'
    },
    'ParticleFormer': {
      title: 'ParticleFormer',
      url: 'https://arxiv.org/abs/2506.23126',
      desc: 'Takes the same particle input as GBND, but encodes the particles and decodes their predicted ' +
            'velocities with a transformer instead of a graph network.'
    },
    'PGND': {
      title: 'Particle-Grid Neural Dynamics',
      url: 'https://kywind.github.io/pgnd',
      desc: 'Combines a PointNet encoder with a grid-based representation to predict next-step particle ' +
            'velocities. Its six real robot–object interaction scenes form the benchmark used here.'
    },
    'PTv3': {
      title: 'Point Transformer v3',
      url: 'https://arxiv.org/abs/2312.10035',
      desc: 'Predicts next-step particle motion and rolls out sequentially in the same way as PGND, but ' +
            'with a transformer architecture.'
    },
    '3PoinTr': {
      title: '3PoinTr',
      url: 'https://arxiv.org/abs/2603.08485',
      desc: 'Pre-trains a 3D point-track prediction model from casual human videos and then conditions the ' +
            'manipulation policy on the predicted tracks. We follow its imitation-learning evaluation protocol.'
    },
    'DP3': {
      title: '3D Diffusion Policy',
      url: 'https://3d-diffusion-policy.github.io/',
      desc: 'A behaviour-cloning method: it encodes the observation into a simple 3D representation and ' +
            'generates action chunks with a conditional diffusion model.'
    },
    'DP': {
      title: 'Diffusion Policy',
      url: 'https://diffusion-policy.cs.columbia.edu/',
      desc: 'A behaviour-cloning method that encodes observations and generates action chunks with a ' +
            'conditional diffusion model. It was not run on the real-world tasks, so it is omitted here.'
    },
    'ATM': {
      title: 'Any-point Trajectory Modeling',
      url: 'https://xingyu-lin.github.io/atm/',
      desc: 'Pre-trains a point-track prediction model from videos and then conditions the policy on the ' +
            'predicted point tracks.'
    }
  };

  var PTS = '<span class="gl-note">P are the predicted points and G the ground-truth points of the ' +
            'final-timestep point cloud; N<sub>p</sub> is the number of points.</span>';

  function frac(a, b) {
    return '<span class="gl-frac"><span class="gl-num">' + a + '</span>' +
           '<span class="gl-den">' + b + '</span></span>';
  }
  function sum(lo, hi) {
    return '<span class="gl-op"><span class="gl-lim">' + (hi || '') + '</span>' +
           '<span class="gl-big">∑</span><span class="gl-lim">' + lo + '</span></span>';
  }
  function under(op, lo) {
    return '<span class="gl-op"><span class="gl-lim"></span><span class="gl-mid">' + op + '</span>' +
           '<span class="gl-lim">' + lo + '</span></span>';
  }
  var NP = 'N<sub>p</sub>';
  function term(s) { return '<span class="gl-term">' + s + '</span> '; }

  var METRICS = {
    'MSE': {
      title: 'Mean squared error',
      desc: 'Mean squared Euclidean distance between each predicted point and its ground-truth ' +
            'counterpart, using the known point correspondence.',
      eq: term('<span class="gl-lhs">ℒ<sub>MSE</sub>(P, G)</span> =') +
          term(frac('1', NP) + sum('i=1', NP) + '‖P<sub>i</sub> − G<sub>i</sub>‖<sub>2</sub><sup>2</sup>')
    },
    'MDE': {
      title: 'Mean distance error',
      desc: 'Mean Euclidean distance between each predicted point and its ground-truth counterpart. ' +
            'Reported in centimetres.',
      eq: term('<span class="gl-lhs">ℒ<sub>MDE</sub>(P, G)</span> =') +
          term(frac('1', NP) + sum('i=1', NP) + '‖P<sub>i</sub> − G<sub>i</sub>‖<sub>2</sub>')
    },
    'CD': {
      title: 'Bi-directional Chamfer distance',
      desc: 'Average nearest-neighbour distance in both directions between the two point sets. ' +
            'It needs no point correspondence, so it measures shape agreement rather than per-point accuracy.',
      eq: term('<span class="gl-lhs">ℒ<sub>CD</sub>(P, G)</span> =') +
          term(frac('1', '2' + NP) + sum('p∈P') + under('min', 'g∈G') +
               '‖p − g‖<sub>2</sub> +') +
          term(frac('1', '2' + NP) + sum('g∈G') + under('min', 'p∈P') +
               '‖g − p‖<sub>2</sub>')
    },
    'EMD': {
      title: 'Earth mover’s distance',
      desc: 'Cost of the cheapest one-to-one assignment π between predicted and ground-truth points, ' +
            'minimised over all valid transport plans Π(P, G).',
      eq: term('<span class="gl-lhs">ℒ<sub>EMD</sub>(P, G)</span> =') +
          term(under('min', 'π∈Π(P,G)') + frac('1', NP) +
               sum('i=1', NP) + sum('j=1', NP) +
               'π<sub>ij</sub>‖P<sub>i</sub> − G<sub>j</sub>‖<sub>2</sub>')
    },
    'SR': {
      title: 'Imitation success rate',
      label: 'Success rate (%)',
      desc: 'Percentage of evaluation trials in which the policy completes the task. Every policy is trained ' +
            'from 20 expert demonstrations with action labels plus 100 action-free demonstration videos. ' +
            'Object position and orientation are varied across trials, and all methods are evaluated from the ' +
            'same initial configurations.',
      eq: term('<span class="gl-lhs">SR</span> = 100 ·') +
          term(frac('successful trials', 'total trials')),
      noPts: true
    }
  };

  /* --------------------------------------------------------------- tooltip */

  var tip = null, current = null, pinned = false;

  function ensureTip() {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.className = 'gl-tip';
    tip.id = 'gl-tip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    document.body.appendChild(tip);
    tip.addEventListener('mouseenter', function () { clearTimeout(tip._t); });
    tip.addEventListener('mouseleave', function () { if (!pinned) hide(); });
    return tip;
  }

  function bodyFor(btn) {
    var kind = btn.getAttribute('data-gl-kind');
    var key = btn.getAttribute('data-gl-key');
    if (kind === 'method') {
      var m = METHODS[key];
      if (!m) return '';
      return '<span class="gl-h">' + m.title + '</span>' +
             '<span class="gl-b">' + m.desc + '</span>' +
             '<a class="gl-more" href="' + m.url + '" target="_blank" rel="noreferrer">project page ↗</a>';
    }
    var q = METRICS[key];
    if (!q) return '';
    return '<span class="gl-h">' + q.title + '</span>' +
           '<span class="gl-b">' + q.desc + '</span>' +
           '<span class="gl-eq">' + q.eq + '</span>' +
           (q.noPts ? '' : PTS);
  }

  function place(btn) {
    var r = btn.getBoundingClientRect();
    tip.style.left = '0px';
    tip.style.top = '0px';
    tip.style.maxWidth = Math.min(380, window.innerWidth - 24) + 'px';
    var t = tip.getBoundingClientRect();
    var left = r.left + r.width / 2 - t.width / 2;
    left = Math.max(12, Math.min(left, window.innerWidth - t.width - 12));
    var top = r.bottom + 8;
    if (top + t.height > window.innerHeight - 8 && r.top - t.height - 8 > 8) top = r.top - t.height - 8;
    top = Math.max(8, Math.min(top, window.innerHeight - t.height - 8));
    tip.style.left = Math.round(left) + 'px';
    tip.style.top = Math.round(top) + 'px';
  }

  function show(btn, pin) {
    ensureTip();
    clearTimeout(tip._t);
    var html = bodyFor(btn);
    if (!html) return;
    if (current && current !== btn) current.setAttribute('aria-expanded', 'false');
    current = btn;
    pinned = !!pin;
    tip.innerHTML = html;
    tip.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    place(btn);
  }

  function hide() {
    if (!tip || tip.hidden) return;
    tip.hidden = true;
    if (current) current.setAttribute('aria-expanded', 'false');
    current = null;
    pinned = false;
  }

  function lazyHide() {
    ensureTip();
    clearTimeout(tip._t);
    tip._t = setTimeout(function () { if (!pinned) hide(); }, 140);
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { var c = current; hide(); if (c) c.focus(); }
  });
  document.addEventListener('click', function (e) {
    if (!pinned || !tip || tip.hidden) return;
    if (tip.contains(e.target) || (current && current.contains(e.target))) return;
    hide();
  }, true);
  window.addEventListener('scroll', function () { if (current && tip && !tip.hidden) place(current); }, true);
  window.addEventListener('resize', function () { if (current && tip && !tip.hidden) place(current); });

  /* --------------------------------------------------------------- chips */

  function chip(kind, key, name) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'gl-q';
    b.textContent = '?';
    b.setAttribute('data-gl-kind', kind);
    b.setAttribute('data-gl-key', key);
    b.setAttribute('aria-label', 'What is ' + name + '?');
    b.setAttribute('aria-expanded', 'false');
    b.setAttribute('aria-describedby', 'gl-tip');
    b.addEventListener('mouseenter', function () { show(b, pinned && current === b); });
    b.addEventListener('mouseleave', lazyHide);
    b.addEventListener('focus', function () { show(b, true); });
    b.addEventListener('blur', function () { if (pinned && current === b) hide(); });
    b.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      if (pinned && current === b) hide(); else show(b, true);
    });
    return b;
  }

  function link(url, text) {
    var a = document.createElement('a');
    a.className = 'gl-link';
    a.href = url;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.textContent = text;
    return a;
  }

  function norm(s) {
    return (s || '').replace(/[↓↑ ]/g, '').replace(/\s+/g, ' ').trim();
  }

  /* ------------------------------------------------------------ annotation */

  // A cell whose entire text is a baseline name -> link + chip.
  function decorateMethodCell(cell, key) {
    var m = METHODS[key];
    cell.setAttribute('data-gl', '1');
    var text = cell.textContent.trim();
    cell.textContent = '';
    var wrap = document.createElement('span');
    wrap.className = 'gl-name';
    wrap.appendChild(m.url ? link(m.url, text) : document.createTextNode(text));
    wrap.appendChild(chip('method', key, m.title));
    cell.appendChild(wrap);
  }

  // A metric header cell ("MDE↓") -> keep contents, append chip.
  function decorateMetricCell(cell, key) {
    cell.setAttribute('data-gl', '1');
    cell.appendChild(chip('metric', key, METRICS[key].title));
  }

  function annotateTables() {
    var tables = document.querySelectorAll('table.results-table');
    for (var t = 0; t < tables.length; t++) {
      var cells = tables[t].querySelectorAll('th, tbody tr > td:first-child');
      for (var i = 0; i < cells.length; i++) {
        var c = cells[i];
        if (c.getAttribute('data-gl')) continue;
        var key = norm(c.textContent);
        if (METHODS[key]) decorateMethodCell(c, key);
        else if (METRICS[key] && c.tagName === 'TH') decorateMetricCell(c, key);
      }
    }
  }

  // Wrap in-prose mentions inside the caption notes: bare "DP", "success rate",
  // and metric acronyms (the latter only in the chart note, where the table
  // headers are not visible).
  function annotateNote(p, allowMetrics) {
    if (!p || p.getAttribute('data-gl')) return;
    p.setAttribute('data-gl', '1');
    var patterns = [
      { re: /\bDP\b(?!\s*<)/, kind: 'method', key: 'DP' },
      { re: /success rates?(\s*\(%\))?/i, kind: 'metric', key: 'SR' }
    ];
    if (allowMetrics) {
      ['MDE', 'MSE', 'CD', 'EMD'].forEach(function (k) {
        patterns.push({ re: new RegExp('\\b' + k + '\\b'), kind: 'metric', key: k });
      });
    }
    patterns.forEach(function (pat) {
      var walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, null);
      var node;
      while ((node = walker.nextNode())) {
        if (node.parentNode && node.parentNode.classList &&
            node.parentNode.classList.contains('gl-name')) continue;
        var m = pat.re.exec(node.nodeValue);
        if (!m) continue;
        var after = node.splitText(m.index);
        after.nodeValue = after.nodeValue.slice(m[0].length);
        var wrap = document.createElement('span');
        wrap.className = 'gl-name';
        var label = pat.kind === 'method' ? METHODS[pat.key].title : METRICS[pat.key].title;
        if (pat.kind === 'method' && METHODS[pat.key].url) {
          wrap.appendChild(link(METHODS[pat.key].url, m[0]));
        } else {
          wrap.appendChild(document.createTextNode(m[0]));
        }
        wrap.appendChild(chip(pat.kind, pat.key, label));
        after.parentNode.insertBefore(wrap, after);
        break;
      }
    });
  }

  function annotateNotes() {
    var notes = document.querySelectorAll('p.table-note, p.ch-note');
    for (var i = 0; i < notes.length; i++) {
      annotateNote(notes[i], notes[i].classList.contains('ch-note'));
    }
  }

  function annotateCharts() {
    // legend entries -> link + chip
    var legs = document.querySelectorAll('.ch-leg');
    for (var i = 0; i < legs.length; i++) {
      var leg = legs[i];
      if (leg.getAttribute('data-gl')) continue;
      var key = norm(leg.textContent);
      if (!METHODS[key]) continue;
      leg.setAttribute('data-gl', '1');
      var swatch = leg.querySelector('i');
      var name = leg.textContent.trim();
      leg.textContent = '';
      if (swatch) leg.appendChild(swatch);
      var wrap = document.createElement('span');
      wrap.className = 'gl-name';
      wrap.appendChild(link(METHODS[key].url, name));
      wrap.appendChild(chip('method', key, METHODS[key].title));
      leg.appendChild(wrap);
    }

    // metric pills -> chip sibling right after each pill
    var pills = document.querySelectorAll('.ch-metrics .ch-pill');
    for (var j = 0; j < pills.length; j++) {
      var pill = pills[j];
      if (pill.getAttribute('data-gl')) continue;
      var mk = norm(pill.getAttribute('data-m') || pill.textContent);
      if (!METRICS[mk]) continue;
      pill.setAttribute('data-gl', '1');
      var c = chip('metric', mk, METRICS[mk].title);
      c.classList.add('gl-q-pill');
      pill.parentNode.insertBefore(c, pill.nextSibling);
    }

    // single-metric charts have no pills: label the y-unit in the controls bar
    var wraps = document.querySelectorAll('.ch-wrap');
    for (var k = 0; k < wraps.length; k++) {
      var w = wraps[k];
      if (w.getAttribute('data-gl')) continue;
      if (w.querySelector('.ch-metrics')) { w.setAttribute('data-gl', '1'); continue; }
      var axes = w.querySelectorAll('text.ch-axis');
      var isSR = false;
      for (var a = 0; a < axes.length; a++) {
        if (/success rate/i.test(axes[a].textContent)) isSR = true;
      }
      if (!isSR) continue;
      var controls = w.querySelector('.ch-controls');
      if (!controls) continue;
      w.setAttribute('data-gl', '1');
      var tag = document.createElement('span');
      tag.className = 'gl-name gl-tag';
      tag.appendChild(document.createTextNode(METRICS.SR.label));
      tag.appendChild(chip('metric', 'SR', METRICS.SR.title));
      controls.insertBefore(tag, controls.firstChild);
    }
  }

  function annotate() {
    try {
      annotateTables();
      annotateNotes();
      annotateCharts();
    } catch (e) {
      console.error('glossary', e);
    }
  }

  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; annotate(); });
  }

  function start() {
    ensureTip();
    annotate();
    if (window.MutationObserver) {
      new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();

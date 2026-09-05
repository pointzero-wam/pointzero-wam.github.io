/* Multi-sample widget: five JiT samples drawn from the SAME input, plus a panel
   colouring every point by how much the samples disagree there.

   All panels share one WebGL context (blitted into per-panel 2D canvases), the
   same camera and one playhead, so the only thing that differs between tiles is
   the sampled trajectory. The dense cloud is subsampled - six live panels is
   six times the per-frame kNN work of the hero viewer. */
(function () {
  'use strict';
  var host = document.getElementById('multimodal-figure');
  if (!host) return;

  var BASE = 'static/hero_data/';
  var KEY = 'towel_mm';
  var VIEW = [20, 28, 1.40];        // az, el, distance scale (towel, as on the page)
  var STRIDE = 3;                   // keep every Nth display point

  function part(buf, man, name) {
    var p = man.parts[name];
    var n = p.shape.reduce(function (a, b) { return a * b; }, 1);
    return p.dtype === 'uint16' ? new Uint16Array(buf, p.offset, n)
                                : new Uint8Array(buf, p.offset, n);
  }
  function dequant(u16, lo, hi, n) {
    var out = new Float32Array(n * 3);
    var s = [(hi[0] - lo[0]) / 65535, (hi[1] - lo[1]) / 65535, (hi[2] - lo[2]) / 65535];
    for (var i = 0; i < n; i++)
      for (var c = 0; c < 3; c++) out[3 * i + c] = lo[c] + u16[3 * i + c] * s[c];
    return out;
  }
  // page-matched exposure: median-anchored gain + extended Reinhard, as hero.js
  function gainOf(bufs) {
    var l = [];
    bufs.forEach(function (u8) {
      var step = Math.max(3, Math.floor(u8.length / 3 / 4000)) * 3;
      for (var i = 0; i + 2 < u8.length; i += step) {
        var r = Math.pow(u8[i] / 255, 2.2), g = Math.pow(u8[i + 1] / 255, 2.2), b = Math.pow(u8[i + 2] / 255, 2.2);
        l.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
      }
    });
    if (!l.length) return 1.6;
    l.sort(function (a, b) { return a - b; });
    return Math.max(1, Math.min(16, 0.30 / Math.max(l[Math.floor(l.length * 0.5)], 1e-4)));
  }
  function tone(u8, n, gain, idx) {
    var out = new Float32Array(n * 3), W2 = 16;
    for (var i = 0; i < n; i++) {
      var s = 3 * (idx ? idx[i] : i);
      var r = Math.pow(u8[s] / 255, 2.2), g = Math.pow(u8[s + 1] / 255, 2.2), b = Math.pow(u8[s + 2] / 255, 2.2);
      var lum = 0.2126 * r + 0.7152 * g + 0.0722 * b, x = lum * gain;
      var sc = lum > 1e-5 ? (x * (1 + x / W2) / (1 + x)) / lum : gain;
      out[3 * i] = Math.min(1, r * sc); out[3 * i + 1] = Math.min(1, g * sc); out[3 * i + 2] = Math.min(1, b * sc);
    }
    return out;
  }
  // the disagreement ramp is already display sRGB; only undo gamma for three.js
  function plain(u8, n, idx) {
    var out = new Float32Array(n * 3);
    for (var i = 0; i < n; i++) {
      var s = 3 * (idx ? idx[i] : i);
      for (var c = 0; c < 3; c++) out[3 * i + c] = Math.pow(u8[s + c] / 255, 2.2);
    }
    return out;
  }

  var SR = null, SRC = null;
  function shared() {
    if (SR) return SR;
    SRC = document.createElement('canvas');
    SR = new THREE.WebGLRenderer({ canvas: SRC, antialias: true, alpha: true });
    SR.setPixelRatio(1);
    return SR;
  }

  function build(man, buf) {
    var lo = man.lo, hi = man.hi, T = man.T, K = man.K;
    var diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    var bg = dequant(part(buf, man, 'bg_pos'), lo, hi, man.n_bg);
    var bgC = part(buf, man, 'bg_col');
    var objAll = dequant(part(buf, man, 'obj_base'), lo, hi, man.n_obj);
    var objC = part(buf, man, 'obj_col');
    var uncC = part(buf, man, 'unc_col');
    var nnI = part(buf, man, 'nn_idx'), nnWraw = part(buf, man, 'nn_w');
    var vt = part(buf, man, 'var_trk');

    // subsample the display cloud - six panels animate at once
    var keep = [];
    for (var i = 0; i < man.n_obj; i += STRIDE) keep.push(i);
    var NO = keep.length;
    var base = new Float32Array(NO * 3), ni = new Uint16Array(NO * K), nw = new Float32Array(NO * K);
    for (var j = 0; j < NO; j++) {
      var src = keep[j];
      for (var c = 0; c < 3; c++) base[3 * j + c] = objAll[3 * src + c];
      var sum = 0, k;
      for (k = 0; k < K; k++) sum += nnWraw[src * K + k];
      for (k = 0; k < K; k++) { ni[j * K + k] = nnI[src * K + k]; nw[j * K + k] = nnWraw[src * K + k] / (sum || 1); }
    }
    var gain = gainOf([bgC, objC]);
    var objColF = tone(objC, NO, gain, keep);
    var uncColF = plain(uncC, NO, keep);

    var frames = [];
    for (var v = 0; v < man.n_var; v++) {
      var f = [];
      for (var t = 0; t < T; t++) {
        var off = ((v * T + t) * man.n_trk) * 3;
        f.push(dequant(vt.subarray(off, off + man.n_trk * 3), lo, hi, man.n_trk));
      }
      frames.push(f);
    }

    var panels = [];
    function panel(cell, variant, useUnc) {
      var canvas = cell.querySelector('canvas');
      var ctx2 = canvas.getContext('2d');
      var scene = new THREE.Scene();
      var cam = new THREE.PerspectiveCamera(42, 16 / 9, 0.01, 50);
      function pts(pos, col, size) {
        var g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos.slice(), 3));
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        var m = new THREE.PointsMaterial({ size: size, vertexColors: true, sizeAttenuation: true });
        return new THREE.Points(g, m);
      }
      var bgCol = useUnc ? plain(bgC, man.n_bg) : tone(bgC, man.n_bg, gain);
      if (useUnc) for (var q = 0; q < bgCol.length; q++) bgCol[q] = bgCol[q] * 0.30 + 0.62;  // mute
      scene.add(pts(bg, bgCol, diag * 0.016));
      var op = pts(base, useUnc ? uncColF : objColF, diag * 0.020);
      scene.add(op);
      panels.push({ canvas: canvas, ctx: ctx2, scene: scene, cam: cam,
                    attr: op.geometry.getAttribute('position'), variant: variant });
    }

    var wrap = document.createElement('div');
    wrap.className = 'mm-grid';
    var labels = [];
    for (var s = 0; s < man.n_var; s++) labels.push({ t: 'sample ' + (s + 1), v: s, u: false });
    labels.push({ t: 'where they disagree', v: 0, u: true });
    labels.forEach(function (L) {
      var cell = document.createElement('figure');
      cell.className = 'mm-cell' + (L.u ? ' is-unc' : '');
      cell.innerHTML = '<canvas></canvas><figcaption>' + L.t + '</figcaption>';
      wrap.appendChild(cell);
      panel(cell, L.v, L.u);
    });
    host.appendChild(wrap);
    var leg = document.createElement('div');
    leg.className = 'mm-legend';
    leg.innerHTML = '<span class="mm-key"><i class="mm-sw mm-sw-lo"></i>agree (' +
      man.spread_lo_mm + ' mm)</span><span class="mm-key"><i class="mm-sw mm-sw-hi"></i>disagree (' +
      man.spread_hi_mm + ' mm)</span><span class="mm-note-i">same input, same conditioning track &mdash; only the noise draw differs</span>';
    host.appendChild(leg);

    var lerp = new Float32Array(man.n_trk * 3);
    var t0 = performance.now(), visible = true;
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) {
        es.forEach(function (e) { visible = e.isIntersecting; });
      }, { rootMargin: '150px' }).observe(host);
    }

    function frame() {
      requestAnimationFrame(frame);
      if (!visible) return;
      var el = (performance.now() - t0) / 1000;
      var ph = (el % 4.0) / 4.0 * (T - 1);           // one 4 s loop, shared by all panels
      var i0 = Math.floor(ph), i1 = Math.min(T - 1, i0 + 1), a = ph - i0;
      var az = (VIEW[0] + Math.sin(el * 0.18) * 9) * Math.PI / 180, elv = VIEW[1] * Math.PI / 180;
      var dist = diag * 0.62 * VIEW[2];
      var R = shared();
      panels.forEach(function (P) {
        var A = frames[P.variant][i0], B = frames[P.variant][i1], Z = frames[P.variant][0];
        for (var q = 0; q < lerp.length; q++) lerp[q] = A[q] + (B[q] - A[q]) * a - Z[q];
        var dst = P.attr.array;
        for (var i = 0; i < NO; i++) {
          var dx = 0, dy = 0, dz = 0, o = i * K;
          for (var k = 0; k < K; k++) {
            var w = nw[o + k], ji = ni[o + k] * 3;
            dx += w * lerp[ji]; dy += w * lerp[ji + 1]; dz += w * lerp[ji + 2];
          }
          dst[3 * i] = base[3 * i] + dx; dst[3 * i + 1] = base[3 * i + 1] + dy;
          dst[3 * i + 2] = base[3 * i + 2] + dz;
        }
        P.attr.needsUpdate = true;
        var cw = Math.round(P.canvas.clientWidth || 240), ch = Math.round(P.canvas.clientHeight || 150);
        if (!cw || !ch) return;
        if (P.canvas.width !== cw || P.canvas.height !== ch) { P.canvas.width = cw; P.canvas.height = ch; }
        P.cam.position.set(man.center[0] + dist * Math.cos(elv) * Math.sin(az),
                           man.center[1] + dist * Math.sin(elv),
                           man.center[2] + dist * Math.cos(elv) * Math.cos(az));
        P.cam.lookAt(man.center[0], man.center[1], man.center[2]);
        P.cam.aspect = cw / ch; P.cam.updateProjectionMatrix();
        R.setSize(cw, ch, false);
        R.render(P.scene, P.cam);
        P.ctx.clearRect(0, 0, cw, ch);
        P.ctx.drawImage(SRC, 0, 0, cw, ch);
      });
    }
    frame();
  }

  fetch(BASE + 'manifest.json?t=' + Date.now())
    .then(function (r) { return r.json(); })
    .then(function (m) {
      var man = m.scenes[KEY];
      if (!man) throw new Error('no ' + KEY + ' in manifest');
      return fetch(BASE + KEY + '.bin').then(function (r) { return r.arrayBuffer(); })
        .then(function (b) { build(man, b); });
    })
    .catch(function (e) {
      host.innerHTML = '<p class="pz-note">multi-sample figure failed to load</p>';
      console.error('multimodal', e);
    });
})();

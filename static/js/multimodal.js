/* Multi-sample widget: five JiT samples drawn from the SAME input, plus a panel
   colouring every point by how much the samples disagree there.

   All panels share one WebGL context (blitted into per-panel 2D canvases), the
   same camera and one playhead, so the only thing that differs between tiles is
   the sampled trajectory. The dense cloud is subsampled - six live panels is
   six times the per-frame kNN work of the hero viewer.

   Every <scene>_mm entry in the manifest is offered in a dropdown, ordered by
   how much the samples actually disagree (measured, see ORDER), so the scenes
   can be compared side by side rather than one being hard-coded. */
(function () {
  'use strict';
  var host = document.getElementById('multimodal-figure');
  if (!host) return;

  var BASE = 'static/hero_data/';
  var STRIDE = 3;                   // keep every Nth display point

  /* az, el, distance scale, look-at point. Solved offline by tools/mm_views.py:
     the distance frames the object cloud over the whole clip and the whole
     orbit, and the look-at point is nudged off the scene-box centre so the
     object sits in the middle of the panel under this downward view. */
  var VIEWS = {
    uniqlo_sweater_mm: [20, 28, 0.92, [0.1170, -0.5309, -0.6920]],
    amazon_notebook_mm: [20, 28, 0.82, [-0.0555, -0.5847, -0.5022]],
    towel_mm: [20, 28, 1.09, [-0.0488, -0.5001, -0.5093]],
    shorts_mm: [20, 28, 1.31, [-0.0704, -0.4825, -0.6503]],
    cloth_mm: [15, 24, 0.81, [-0.0413, -0.2090, -0.3122]],
    stapler_mm: [24, 20, 1.20, [-0.0426, -0.3352, -0.4060]],
    heater_box_mm: [20, 28, 1.34, [0.0585, -0.3644, -0.6529]],
    trash_mm: [55, 30, 1.26, [-0.0609, -0.1041, -0.5282]]
  };
  var DEFAULT_VIEW = [20, 28, 1.1];
  // strongest demonstration first; measured spread and how different the five
  // samples actually look (tools/mm_rank.py, tools/mm_samples_sheet.py)
  var ORDER = ['amazon_notebook_mm', 'towel_mm', 'uniqlo_sweater_mm', 'shorts_mm',
               'cloth_mm', 'stapler_mm', 'heater_box_mm', 'trash_mm'];
  var START = 'towel_mm';

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

  /* ---------------------------------------------------------------- one scene */
  function makeScene(key, man, buf, grid) {
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

    var grasp = null, nGrasp = 0;
    if (man.graspers && man.graspers.length) {
      nGrasp = man.graspers[0].length;
      grasp = new Float32Array(T * nGrasp * 3);
      for (var gt = 0; gt < T; gt++)
        for (var gg = 0; gg < nGrasp; gg++)
          for (var gc = 0; gc < 3; gc++)
            grasp[(gt * nGrasp + gg) * 3 + gc] = man.graspers[gt][gg][gc];
    }

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
      var cam = new THREE.PerspectiveCamera(42, 16 / 10, 0.01, 50);
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
      // the conditioning track: identical across every panel, because it is the
      // input. Drawn in full (the model is given the whole thing) with a marker
      // riding the playhead so it reads as the cue the samples respond to.
      var head = null;
      if (grasp && grasp.length > 1) {
        // a tube, not a Line: WebGL caps linewidth at 1px, so a Line would be a
        // hairline at panel size. Radius/marker follow hero.js's 'slim' scale.
        for (var gi = 0; gi < nGrasp; gi++) {
          var cp = [];
          for (var t = 0; t < T; t++)
            cp.push(new THREE.Vector3(grasp[(t * nGrasp + gi) * 3],
                                      grasp[(t * nGrasp + gi) * 3 + 1],
                                      grasp[(t * nGrasp + gi) * 3 + 2]));
          var curve = new THREE.CatmullRomCurve3(cp);
          scene.add(new THREE.Mesh(
            new THREE.TubeGeometry(curve, 64, diag * 0.0030, 8, false),
            new THREE.MeshBasicMaterial({ color: 0xe0662a,
              transparent: true, opacity: useUnc ? 0.5 : 0.95 })));
        }
        head = new THREE.Mesh(
          new THREE.SphereGeometry(diag * 0.0090, 16, 12),
          new THREE.MeshBasicMaterial({ color: 0xe0662a,
            transparent: true, opacity: useUnc ? 0.55 : 1 }));
        scene.add(head);
      }
      panels.push({ canvas: canvas, ctx: ctx2, scene: scene, cam: cam,
                    attr: op.geometry.getAttribute('position'), variant: variant,
                    head: head });
    }

    var labels = [];
    for (var s = 0; s < man.n_var; s++) labels.push({ t: 'sample ' + (s + 1), v: s, u: false });
    labels.push({ t: 'where they disagree', v: 0, u: true });
    labels.forEach(function (L) {
      var cell = document.createElement('figure');
      cell.className = 'mm-cell' + (L.u ? ' is-unc' : '');
      cell.innerHTML = '<canvas></canvas><figcaption>' + L.t + '</figcaption>';
      grid.appendChild(cell);
      panel(cell, L.v, L.u);
    });

    var view = VIEWS[key] || DEFAULT_VIEW;
    var ctr = view[3] || man.center;
    return { panels: panels, frames: frames, T: T, K: K, NO: NO, base: base,
             grasp: grasp, nGrasp: nGrasp,
             ni: ni, nw: nw, view: view, ctr: ctr, diag: diag,
             lerp: new Float32Array(man.n_trk * 3) };
  }

  function dispose(S) {
    if (!S) return;
    S.panels.forEach(function (P) {
      P.scene.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    });
  }

  /* ------------------------------------------------------------------ widget */
  var bar = document.createElement('div');
  bar.className = 'mm-bar';
  var grid = document.createElement('div');
  grid.className = 'mm-grid';
  var leg = document.createElement('div');
  leg.className = 'mm-legend';
  host.appendChild(bar); host.appendChild(grid); host.appendChild(leg);

  var CUR = null, t0 = performance.now(), visible = true, running = false;
  var cache = {};

  function legend(man) {
    leg.innerHTML = '<span class="mm-key"><i class="mm-sw mm-sw-lo"></i>agree (' +
      man.spread_lo_mm + ' mm)</span><span class="mm-key"><i class="mm-sw mm-sw-hi"></i>disagree (' +
      man.spread_hi_mm + ' mm)</span><span class="mm-note-i">same input, same conditioning track &mdash; only the noise draw differs</span>';
  }

  function frame() {
    requestAnimationFrame(frame);
    if (!visible || !CUR) return;
    var S = CUR, T = S.T, K = S.K, NO = S.NO, lerp = S.lerp;
    var el = (performance.now() - t0) / 1000;
    var ph = (el % 4.0) / 4.0 * (T - 1);           // one 4 s loop, shared by all panels
    var i0 = Math.floor(ph), i1 = Math.min(T - 1, i0 + 1), a = ph - i0;
    var az = (S.view[0] + Math.sin(el * 0.18) * 9) * Math.PI / 180;
    var elv = S.view[1] * Math.PI / 180;
    var dist = S.diag * 0.62 * S.view[2];
    var R = shared();
    S.panels.forEach(function (P) {
      var A = S.frames[P.variant][i0], B = S.frames[P.variant][i1], Z = S.frames[P.variant][0];
      for (var q = 0; q < lerp.length; q++) lerp[q] = A[q] + (B[q] - A[q]) * a - Z[q];
      var dst = P.attr.array;
      for (var i = 0; i < NO; i++) {
        var dx = 0, dy = 0, dz = 0, o = i * K;
        for (var k = 0; k < K; k++) {
          var w = S.nw[o + k], ji = S.ni[o + k] * 3;
          dx += w * lerp[ji]; dy += w * lerp[ji + 1]; dz += w * lerp[ji + 2];
        }
        dst[3 * i] = S.base[3 * i] + dx; dst[3 * i + 1] = S.base[3 * i + 1] + dy;
        dst[3 * i + 2] = S.base[3 * i + 2] + dz;
      }
      P.attr.needsUpdate = true;
      if (P.head && S.grasp) {
        var gi0 = i0 * S.nGrasp * 3, gi1 = i1 * S.nGrasp * 3;
        P.head.position.set(
          S.grasp[gi0] + (S.grasp[gi1] - S.grasp[gi0]) * a,
          S.grasp[gi0 + 1] + (S.grasp[gi1 + 1] - S.grasp[gi0 + 1]) * a,
          S.grasp[gi0 + 2] + (S.grasp[gi1 + 2] - S.grasp[gi0 + 2]) * a);
      }
      var cw = Math.round(P.canvas.clientWidth || 240), ch = Math.round(P.canvas.clientHeight || 150);
      if (!cw || !ch) return;
      if (P.canvas.width !== cw || P.canvas.height !== ch) { P.canvas.width = cw; P.canvas.height = ch; }
      P.cam.position.set(S.ctr[0] + dist * Math.cos(elv) * Math.sin(az),
                         S.ctr[1] + dist * Math.sin(elv),
                         S.ctr[2] + dist * Math.cos(elv) * Math.cos(az));
      P.cam.lookAt(S.ctr[0], S.ctr[1], S.ctr[2]);
      P.cam.aspect = cw / ch; P.cam.updateProjectionMatrix();
      R.setSize(cw, ch, false);
      R.render(P.scene, P.cam);
      P.ctx.clearRect(0, 0, cw, ch);
      P.ctx.drawImage(SRC, 0, 0, cw, ch);
    });
  }

  function show(manifest, key, sel) {
    var man = manifest.scenes[key];
    if (sel) sel.disabled = true;
    host.classList.add('is-loading');
    var got = cache[key] ? Promise.resolve(cache[key])
                         : fetch(BASE + key + '.bin?v=' + (manifest.build || 0)).then(function (r) { return r.arrayBuffer(); })
                             .then(function (b) { cache[key] = b; return b; });
    return got.then(function (buf) {
      dispose(CUR);
      CUR = null;
      grid.innerHTML = '';
      CUR = makeScene(key, man, buf, grid);
      legend(man);
      t0 = performance.now();
      host.classList.remove('is-loading');
      if (sel) { sel.disabled = false; sel.value = key; }
      if (!running) { running = true; frame(); }
    });
  }

  fetch(BASE + 'manifest.json?t=' + Date.now())
    .then(function (r) { return r.json(); })
    .then(function (manifest) {
      var keys = Object.keys(manifest.scenes).filter(function (k) {
        return /_mm$/.test(k) && manifest.scenes[k].mode === 'mm';
      });
      if (!keys.length) throw new Error('no *_mm scenes in manifest');
      keys.sort(function (a, b) {
        var ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
      // ?mm=<key> opens straight on one scene, for screenshotting a comparison
      var want = (location.search.match(/[?&]mm=([A-Za-z0-9_]+)/) || [])[1] || START;
      if (want && keys.indexOf(want) < 0 && keys.indexOf(want + '_mm') >= 0) want += '_mm';
      var start = keys.indexOf(want) >= 0 ? want : keys[0];

      var sel = document.createElement('select');
      sel.className = 'mm-select';
      sel.setAttribute('aria-label', 'multi-sample scene');
      keys.forEach(function (k) {
        var m = manifest.scenes[k];
        // follow the parent scene's label, so renaming a scene renames it here
        var parent = manifest.scenes[k.replace(/_mm$/, '')];
        var o = document.createElement('option');
        o.value = k;
        o.textContent = ((parent && parent.label) || m.label) + '  —  spread ' +
                        m.spread_lo_mm + '–' + m.spread_hi_mm + ' mm';
        sel.appendChild(o);
      });
      // with a single scene the picker is noise, so only show it when there is
      // genuinely something to switch between
      if (keys.length > 1) {
        var lab = document.createElement('label');
        lab.className = 'mm-pick';
        lab.innerHTML = '<span>scene</span>';
        lab.appendChild(sel);
        bar.appendChild(lab);
      }
      sel.addEventListener('change', function () {
        show(manifest, sel.value, sel).catch(function (e) {
          // a failed swap must not leave the picker stuck disabled
          host.classList.remove('is-loading');
          sel.disabled = false;
          console.error('multimodal', e);
        });
      });

      if ('IntersectionObserver' in window) {
        new IntersectionObserver(function (es) {
          es.forEach(function (e) { visible = e.isIntersecting; });
        }, { rootMargin: '150px' }).observe(host);
      }
      return show(manifest, start, sel);
    })
    .catch(function (e) {
      host.innerHTML = '<p class="pz-note">multi-sample figure failed to load</p>';
      console.error('multimodal', e);
    });
})();

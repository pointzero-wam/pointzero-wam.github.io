/* PointZero interactive hero — pre-training / post-training viewer.
   Vanilla three.js (vendored UMD), no build step.
   Scene kinds:
     real: static RGB background + object densified from predicted tracks + conditioning tubes
     ctx:  animated real 4D capture (bg+robot, object masked) + predicted object + EEF trail
     sim:  animated simulated rollout cloud + EEF trail */
(function () {
  'use strict';

  var BASE = 'static/hero_data/';
  var ACCENT = 0xe0662a;

  var VIEWS = {
    cloth:      [15, 24, 1.35],
    stapler:    [24, 20, 1.75],
    trash:      [55, 30, 1.55],
    drawer:     [28, 22, 1.55],
    rope:       [20, 50, 0.88],
    pgnd_cloth: [200, 25, 0.82],
    sloth:      [20, 45, 0.74],
    paperbag:   [20, 46, 0.80],
    bread:      [20, 46, 0.80],
    sim_blockstack: [10, 30, 0.88],
    sim_glass:      [10, 30, 0.88],
    sim_microwave:  [10, 30, 0.88]
  };
  var MODES = [
    { key: 'pre',  label: 'Pre-training',  sub: 'zero-shot 3D dynamics' },
    { key: 'post', label: 'Post-training', sub: 'robot dynamics & control' }
  ];

  var HOSTS = [].slice.call(document.querySelectorAll('[data-pz-viewer]'));
  if (!HOSTS.length) return;
  var sharedCache = {};

  function makeViewer(root) {

  function webglOK() {
    try {
      var c = document.createElement('canvas');
      return !!(window.WebGLRenderingContext && (c.getContext('webgl') || c.getContext('experimental-webgl')));
    } catch (e) { return false; }
  }
  if (!window.THREE || !webglOK()) {
    root.innerHTML = '<img src="static/images/fig1_teaser.png" style="width:100%;display:block;background:#fff;padding:1rem;border-radius:12px;" alt="PointZero teaser">';
    return null;
  }

  root.innerHTML =
    '<div class="pz-modes"></div>' +
    '<div class="pz-tabs"></div>' +
    '<div class="pz-stage">' +
    '  <canvas class="pz-canvas"></canvas>' +
    '  <div class="pz-loading"><div class="pz-spin"></div></div>' +
    '  <div class="pz-hint">drag to rotate &middot; scroll to zoom</div>' +
    '  <div class="pz-phase"><span class="pz-phase-main"></span><span class="pz-phase-sub"></span></div>' +
    '  <div class="pz-rgb-wrap"><img class="pz-rgb" alt="input RGB"><span class="pz-rgb-label">input view</span></div>' +
    '  <div class="pz-bar">' +
    '    <button class="pz-play" aria-label="Play/pause"></button>' +
    '    <input class="pz-scrub" type="range" min="0" max="1000" value="0">' +
    '    <span class="pz-time">t = 0</span>' +
    '    <select class="pz-variant" style="display:none" title="prediction variant"></select>' +
    '  </div>' +
    '</div>' +
    '<p class="pz-caption"></p>';

  var modesEl = root.querySelector('.pz-modes');
  var tabsEl = root.querySelector('.pz-tabs');
  var stage = root.querySelector('.pz-stage');
  var canvas = root.querySelector('.pz-canvas');
  var loadEl = root.querySelector('.pz-loading');
  var playBtn = root.querySelector('.pz-play');
  var scrub = root.querySelector('.pz-scrub');
  var timeEl = root.querySelector('.pz-time');
  var capEl = root.querySelector('.pz-caption');
  var legendEl = { innerHTML: '' };   // legend retired; the phase badge carries the story
  var phaseEl = root.querySelector('.pz-phase');
  var phaseMain = root.querySelector('.pz-phase-main');
  var phaseSub = root.querySelector('.pz-phase-sub');
  var phaseKey = '';
  var variantSel = root.querySelector('.pz-variant');
  var rgbWrap = root.querySelector('.pz-rgb-wrap');
  var rgbImg = root.querySelector('.pz-rgb');

  MODES.forEach(function (m) {
    var b = document.createElement('button');
    b.className = 'pz-mode';
    b.dataset.mode = m.key;
    b.innerHTML = '<span class="pz-mode-label">' + m.label + '</span><span class="pz-mode-sub">' + m.sub + '</span>';
    modesEl.appendChild(b);
  });

  var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.01, 50);
  var group = new THREE.Group();
  scene.add(group);

  var manifest = null, currentKey = null, currentMode = 'pre';
  var playing = true, playhead = 0, lastTs = null, idleT = 0, visible = true;

  var orb = { az: 0.3, el: 0.5, dist: 1.2, target: new THREE.Vector3() };
  function applyCamera() {
    var ce = Math.cos(orb.el), se = Math.sin(orb.el);
    camera.position.set(
      orb.target.x + orb.dist * ce * Math.sin(orb.az),
      orb.target.y + orb.dist * se,
      orb.target.z + orb.dist * ce * Math.cos(orb.az));
    camera.lookAt(orb.target);
  }

  var drag = null, pinch0 = 0;
  stage.addEventListener('pointerdown', function (e) {
    if (e.target.closest('.pz-bar')) return;
    drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
    stage.setPointerCapture && stage.setPointerCapture(e.pointerId);
    idleT = 0;
  });
  stage.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    orb.az -= (e.clientX - drag.x) * 0.006;
    orb.el = Math.max(-0.1, Math.min(1.35, orb.el + (e.clientY - drag.y) * 0.006));
    drag.x = e.clientX; drag.y = e.clientY; idleT = 0;
  });
  window.addEventListener('pointerup', function () { drag = null; });
  stage.addEventListener('wheel', function (e) {
    e.preventDefault();
    orb.dist *= (1 + Math.sign(e.deltaY) * 0.08);
    orb.dist = Math.max(0.25, Math.min(4, orb.dist));
    idleT = 0;
  }, { passive: false });
  stage.addEventListener('touchstart', function (e) {
    if (e.touches.length === 2) {
      pinch0 = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    }
  }, { passive: true });
  stage.addEventListener('touchmove', function (e) {
    if (e.touches.length === 2 && pinch0 > 0) {
      var p = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      orb.dist = Math.max(0.25, Math.min(4, orb.dist * pinch0 / p));
      pinch0 = p; idleT = 0;
      e.preventDefault();
    }
  }, { passive: false });

  function resize() {
    var w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);

  function dequant(u16, lo, hi, n) {
    var out = new Float32Array(n * 3);
    var sx = (hi[0] - lo[0]) / 65535, sy = (hi[1] - lo[1]) / 65535, sz = (hi[2] - lo[2]) / 65535;
    for (var i = 0; i < n; i++) {
      out[3 * i] = lo[0] + u16[3 * i] * sx;
      out[3 * i + 1] = lo[1] + u16[3 * i + 1] * sy;
      out[3 * i + 2] = lo[2] + u16[3 * i + 2] * sz;
    }
    return out;
  }
  function part(buf, man, name) {
    var p = man.parts[name];
    var len = p.shape.reduce(function (a, b) { return a * b; }, 1);
    if (p.dtype === 'uint16' || p.dtype === '<u2') return new Uint16Array(buf, p.offset, len);
    return new Uint8Array(buf, p.offset, len);
  }
  function normW(wRaw, n, K) {
    var w = new Float32Array(wRaw.length);
    for (var i = 0; i < n; i++) {
      var s = 0;
      for (var k = 0; k < K; k++) s += wRaw[i * K + k];
      for (var k2 = 0; k2 < K; k2++) w[i * K + k2] = s > 0 ? wRaw[i * K + k2] / s : 0;
    }
    return w;
  }
  var cache = sharedCache;
  function loadScene(key) {
    if (cache[key]) return Promise.resolve(cache[key]);
    return fetch(BASE + key + '.bin?v=' + (manifest.build || 0)).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
      var man = manifest.scenes[key];
      var d = { man: man };
      if (man.kind === 'real') {
        d.bg = dequant(part(buf, man, 'bg_pos'), man.lo, man.hi, man.n_bg);
        d.bgc = part(buf, man, 'bg_col');
        d.objBase = dequant(part(buf, man, 'obj_base'), man.lo, man.hi, man.n_obj);
        d.objc = part(buf, man, 'obj_col');
        d.nnIdx = part(buf, man, 'nn_idx');
        d.nnW = normW(part(buf, man, 'nn_w'), man.n_obj, man.K);
        d.nnExtra = {};
        ['enr', 'dep', 'fps'].forEach(function (nm) {
          if (!man.parts['nn_idx_' + nm]) return;
          d.nnExtra[nm] = { idx: part(buf, man, 'nn_idx_' + nm),
                            w: normW(part(buf, man, 'nn_w_' + nm), man.n_obj, man.K) };
        });
        d.varFrames = [];
        var vt = part(buf, man, 'var_trk');
        var NV = man.n_var || 1;
        for (var vi = 0; vi < NV; vi++) {
          var fr = [];
          for (var t = 0; t < man.T; t++) {
            var off = (vi * man.T + t) * man.n_trk * 3;
            fr.push(dequant(vt.subarray(off, off + man.n_trk * 3), man.lo, man.hi, man.n_trk));
          }
          d.varFrames.push(fr);
        }
      } else if (man.kind === 'ctx') {
        d.bgFrames = []; d.bgColFrames = [];
        var bp = part(buf, man, 'bg_pos'), bc = part(buf, man, 'bg_col');
        for (var t2 = 0; t2 < man.T; t2++) {
          d.bgFrames.push(dequant(bp.subarray(t2 * man.n_bg * 3, (t2 + 1) * man.n_bg * 3), man.lo, man.hi, man.n_bg));
          d.bgColFrames.push(bc.subarray(t2 * man.n_bg * 3, (t2 + 1) * man.n_bg * 3));
        }
        d.objBase = dequant(part(buf, man, 'obj_base'), man.lo, man.hi, man.n_obj);
        d.objc = part(buf, man, 'obj_col');
        d.nnIdx = part(buf, man, 'nn_idx');
        d.nnW = normW(part(buf, man, 'nn_w'), man.n_obj, man.K);
        d.trkFrames = [];
        var vt2 = part(buf, man, 'var_trk');
        for (var t3 = 0; t3 < man.T; t3++) {
          d.trkFrames.push(dequant(vt2.subarray(t3 * man.n_trk * 3, (t3 + 1) * man.n_trk * 3), man.lo, man.hi, man.n_trk));
        }
      } else {
        d.bgFrames = []; d.bgColFrames = [];
        var bp2 = part(buf, man, 'bg_pos'), bc2 = part(buf, man, 'bg_col');
        for (var t4 = 0; t4 < man.T; t4++) {
          d.bgFrames.push(dequant(bp2.subarray(t4 * man.n_bg * 3, (t4 + 1) * man.n_bg * 3), man.lo, man.hi, man.n_bg));
          d.bgColFrames.push(bc2.subarray(t4 * man.n_bg * 3, (t4 + 1) * man.n_bg * 3));
        }
      }
      if (man.kind === 'real') d.gain = sceneGain([d.bgc, d.objc]);
      else if (man.kind === 'ctx') d.gain = sceneGain([d.bgColFrames[0], d.objc]);
      else d.gain = sceneGain([d.bgColFrames[0]]);
      cache[key] = d;
      return d;
    });
  }

  function sceneGain(buffers) {
    // auto-exposure anchored on the MEDIAN luminance; target/white point tuned
    // empirically so subjects land ~200/255 with ~0% clipping (see README).
    var lums = [];
    buffers.forEach(function (u8) {
      if (!u8) return;
      var step = Math.max(3, Math.floor(u8.length / 3 / 4000)) * 3;
      for (var i = 0; i + 2 < u8.length; i += step) {
        var r = Math.pow(u8[i] / 255, 2.2), g = Math.pow(u8[i + 1] / 255, 2.2), b = Math.pow(u8[i + 2] / 255, 2.2);
        lums.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
      }
    });
    if (!lums.length) return 1.6;
    lums.sort(function (a, b) { return a - b; });
    var med = lums[Math.floor(lums.length * 0.5)] || 0.01;
    return Math.max(1.0, Math.min(16.0, 0.40 / Math.max(med, 1e-4)));
  }

  function colorsToAttr(u8, n, gain) {
    // sRGB -> linear, median-anchored exposure, hue-preserving extended-
    // Reinhard highlight rolloff (white point 1.4), back to sRGB by renderer.
    var g = gain || 1.6, W2 = 4.0 * 4.0;   // high white point: bright mids, no clipping
    var out = new Float32Array(n * 3);
    for (var i = 0; i < n; i++) {
      var r = Math.pow(u8[3 * i] / 255, 2.2);
      var gr = Math.pow(u8[3 * i + 1] / 255, 2.2);
      var b = Math.pow(u8[3 * i + 2] / 255, 2.2);
      var lum = 0.2126 * r + 0.7152 * gr + 0.0722 * b;
      var x = lum * g;
      var lumOut = x * (1 + x / W2) / (1 + x);
      var sc = lum > 1e-5 ? lumOut / lum : g;
      out[3 * i] = Math.min(1, r * sc);
      out[3 * i + 1] = Math.min(1, gr * sc);
      out[3 * i + 2] = Math.min(1, b * sc);
    }
    return out;
  }

  var discTex = (function () {
    var c = document.createElement('canvas');
    c.width = c.height = 64;
    var x = c.getContext('2d');
    var g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.7, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();

  function makePoints(pos, colAttr, size, opacity) {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos.slice(0), 3));
    if (colAttr) g.setAttribute('color', new THREE.BufferAttribute(colAttr, 3));
    var m = new THREE.PointsMaterial({
      size: size, vertexColors: !!colAttr, sizeAttenuation: true,
      map: discTex, alphaTest: 0.4, transparent: true, opacity: opacity,
      depthWrite: opacity >= 1
    });
    if (!colAttr) m.color.setHex(0x9aa0a6);
    return new THREE.Points(g, m);
  }

  function clearGroup() {
    while (group.children.length) {
      var c = group.children.pop();
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
    }
  }

  var anim = null;
  function addEEF(man, diag, withTube, slim) {
    var G = man.graspers[0].length;
    anim.graspers = man.graspers; anim.spheres = []; anim.tubes = [];
    var TUBE_SEGS = (man.T - 1) * 8;
    for (var gi = 0; gi < G; gi++) {
      var pts = [];
      for (var t = 0; t < man.T; t++) {
        var p = man.graspers[t][gi];
        pts.push(new THREE.Vector3(p[0], p[1], p[2]));
      }
      var curve = new THREE.CatmullRomCurve3(pts);
      // arc-length fraction of each knot (TubeGeometry samples uniformly by
      // arc length, so time-based reveal desyncs from the marker when the EEF
      // speed varies; map time -> arc fraction instead)
      var lens = curve.getLengths(200), total = lens[lens.length - 1] || 1;
      var knotArc = [];
      for (var ki = 0; ki < man.T; ki++) {
        var tt = ki / (man.T - 1);
        var li = Math.min(199, Math.round(tt * 200));
        knotArc.push(lens[li] / total);
      }
      if (withTube) {
        var tubeGeo = new THREE.TubeGeometry(curve, TUBE_SEGS, diag * (slim ? 0.0016 : 0.0032), 8, false);
        var tube = new THREE.Mesh(tubeGeo,
          new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.9 }));
        tube.userData.idxPerSeg = tubeGeo.index.count / TUBE_SEGS;
        tube.userData.segs = TUBE_SEGS;
        tube.userData.curve = curve;
        tube.userData.knotArc = knotArc;
        tube.geometry.setDrawRange(0, 0);
        group.add(tube);
        anim.tubes.push(tube);
      }
      var sp = new THREE.Mesh(
        new THREE.SphereGeometry(diag * (slim ? 0.0075 : 0.010), 20, 16),
        new THREE.MeshBasicMaterial({ color: ACCENT }));
      sp.userData.curve = curve;
      sp.userData.knotArc = knotArc;
      group.add(sp);
      anim.spheres.push(sp);
    }
  }

  function showScene(key) {
    var d = cache[key], man = d.man;
    clearGroup();
    currentKey = key;
    var diag = Math.hypot(man.hi[0] - man.lo[0], man.hi[1] - man.lo[1], man.hi[2] - man.lo[2]);
    var v = VIEWS[key] || [20, 28, 1.1];
    orb.az = v[0] * Math.PI / 180;
    orb.el = v[1] * Math.PI / 180;
    orb.dist = diag * 0.62 * v[2];
    orb.target.set(man.center[0], man.center[1], man.center[2]);
    anim = { kind: man.kind, T: man.T, twoPhase: (man.kind === 'real' || man.kind === 'ctx') };

    if (man.kind === 'real') {
      group.add(makePoints(d.bg, colorsToAttr(d.bgc, man.n_bg, d.gain), diag * 0.0070, 0.92));
      var obj = makePoints(d.objBase, colorsToAttr(d.objc, man.n_obj, d.gain), diag * 0.0084, 1.0);
      group.add(obj);
      anim.points = obj; anim.base = d.objBase; anim.nObj = man.n_obj;
      anim.nnIdx = d.nnIdx; anim.nnW = d.nnW; anim.K = man.K;
      anim.nnExtra = d.nnExtra || {};
      anim.varFrames = d.varFrames;
      anim.variant = (window.__pzVariant !== undefined && window.__pzVariant < (man.variants || []).length)
        ? window.__pzVariant : (man.default_variant || 0);
      anim.variants = man.variants || [];
      anim.trkFrames = d.varFrames[anim.variant];
      anim.trkLerp = new Float32Array(man.n_trk * 3);
      addEEF(man, diag, true);
      if (anim.variants.length > 1) {
        variantSel.innerHTML = anim.variants.map(function (v, i) {
          return '<option value="' + i + '">' + v.label + ' · ' + (v.approx ? '≈' : '') + v.mde_mm + ' mm</option>';
        }).join('');
        variantSel.value = String(anim.variant);
        variantSel.style.display = '';
      } else {
        variantSel.style.display = 'none';
      }
      updateRealLegend();
    } else if (man.kind === 'ctx') {
      var bgP = makePoints(d.bgFrames[0], colorsToAttr(d.bgColFrames[0], man.n_bg, d.gain), diag * 0.0180, 0.9);
      group.add(bgP);
      anim.bgPoints = bgP; anim.bgFrames = d.bgFrames; anim.bgColFrames = d.bgColFrames;
      anim.nBg = man.n_bg; anim.bgShown = -1; anim.gain = d.gain;
      var obj2 = makePoints(d.objBase, colorsToAttr(d.objc, man.n_obj, d.gain), diag * 0.0192, 1.0);
      group.add(obj2);
      anim.points = obj2; anim.base = d.objBase; anim.nObj = man.n_obj;
      anim.nnIdx = d.nnIdx; anim.nnW = d.nnW; anim.K = man.K;
      anim.trkFrames = d.trkFrames; anim.trkLerp = new Float32Array(1000 * 3);
      addEEF(man, diag, true);
      variantSel.style.display = 'none';
      legendEl.innerHTML = '<span class="pz-dot" style="background:#e0662a"></span> robot end-effector &nbsp;&nbsp;<span class="pz-dot pz-dot-rgb"></span> predicted object dynamics &nbsp;&middot;&nbsp; scene: real 4D capture &nbsp;&middot;&nbsp; mean error ' + man.mde_mm + ' mm';
    } else {
      var bgS = makePoints(d.bgFrames[0], colorsToAttr(d.bgColFrames[0], man.n_bg, d.gain), diag * 0.0092, 1.0);
      group.add(bgS);
      anim.bgPoints = bgS; anim.bgFrames = d.bgFrames; anim.bgColFrames = d.bgColFrames;
      anim.nBg = man.n_bg; anim.bgShown = -1; anim.gain = d.gain;
      addEEF(man, diag, true, true);
      variantSel.style.display = 'none';
      legendEl.innerHTML = '<span class="pz-dot" style="background:#e0662a"></span> robot end-effector trail &nbsp;&middot;&nbsp; fine-tuned policy rollout (successful episode)';
    }
    if (man.rgb) {
      rgbImg.src = BASE + man.rgb + '?v=' + (manifest.build || 0);
      rgbImg.style.imageRendering = man.kind === 'sim' ? 'pixelated' : 'auto';
      rgbWrap.style.display = '';
    } else {
      rgbWrap.style.display = 'none';
    }
    capEl.textContent = man.caption;
    playhead = 0; playing = true; updatePlayIcon();
    tabsEl.querySelectorAll('.pz-tab').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.key === key);
    });
    applyCamera();
  }

  function updateRealLegend() {
    if (!anim || anim.kind !== 'real') return;
    var v = anim.variants[anim.variant] || { mde_mm: '?', label: '' };
    legendEl.innerHTML = '<span class="pz-dot" style="background:#e0662a"></span> conditioning tracks &nbsp;&nbsp;<span class="pz-dot pz-dot-rgb"></span> predicted scene motion' +
      ' &nbsp;&middot;&nbsp; ' + v.label + ' &nbsp;&middot;&nbsp; mean error ' + (v.approx ? '≈' : '') + v.mde_mm + ' mm';
  }
  variantSel.addEventListener('change', function () {
    if (anim && anim.kind === 'real') {
      anim.variant = parseInt(variantSel.value, 10);
      anim.trkFrames = anim.varFrames[anim.variant];
      updateRealLegend();
    }
  });
  function updatePlayIcon() {
    playBtn.innerHTML = playing
      ? '<svg viewBox="0 0 16 16" width="14" height="14"><rect x="2.5" y="2" width="4" height="12" rx="1" fill="currentColor"/><rect x="9.5" y="2" width="4" height="12" rx="1" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M3.5 2.2 13.5 8 3.5 13.8z" fill="currentColor"/></svg>';
  }
  playBtn.addEventListener('click', function () { playing = !playing; updatePlayIcon(); idleT = 0; });
  scrub.addEventListener('input', function () {
    playing = false; updatePlayIcon();
    if (anim) playhead = (scrub.value / 1000) * (anim.T - 1);
  });

  function tick(ts) {
    requestAnimationFrame(tick);
    if (!visible) return;
    if (!anim) { renderer.render(scene, camera); return; }
    var dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0;
    lastTs = ts;
    idleT += dt;
    var CYCLE = anim.kind === 'real' ? 5.4 : 6.6, HOLD = 0.9;
    // scenes with conditioning play in two phases: the input track draws first,
    // then the scene animates along it
    var AF = anim.twoPhase ? 0.34 : 0;
    var uu;
    if (playing) {
      uu = Math.min(1, ((ts / 1000) % (CYCLE + HOLD)) / CYCLE);
      scrub.value = Math.round(uu * 1000);
    } else {
      uu = scrub.value / 1000;
    }
    if (window.__pzFixedT !== undefined) { playing = false; uu = window.__pzFixedT; }
    var trackFrac, isInput;
    if (uu < AF) { trackFrac = AF > 0 ? uu / AF : 1; playhead = 0; isInput = true; }
    else { trackFrac = 1; playhead = ((uu - AF) / (1 - AF)) * (anim.T - 1); isInput = false; }
    if (phaseEl) {
      if (!anim.twoPhase) { phaseEl.style.display = 'none'; }
      else {
        phaseEl.style.display = '';
        var key = isInput ? 'in' : 'out';
        if (key !== phaseKey) {
          phaseKey = key;
          var zeroShot = anim.kind === 'real';
          phaseMain.textContent = isInput ? 'INPUT'
            : (zeroShot ? 'ZERO-SHOT PREDICTION' : 'PREDICTION');
          phaseSub.textContent = isInput
            ? 'conditioning track — the only motion given'
            : (zeroShot ? 'unseen scene' : 'fine-tuned to condition on robot pose');
          phaseEl.classList.toggle('is-input', isInput);
        }
      }
    }
    timeEl.textContent = isInput ? 'input' : ('t = ' + Math.round(playhead) + ' / ' + (anim.T - 1));

    if (anim.bgFrames) {
      var fi = Math.round(Math.max(0, Math.min(anim.T - 1, playhead)));
      if (fi !== anim.bgShown) {
        anim.bgShown = fi;
        var pa = anim.bgPoints.geometry.getAttribute('position');
        pa.array.set(anim.bgFrames[fi]); pa.needsUpdate = true;
        var ca = anim.bgPoints.geometry.getAttribute('color');
        ca.array.set(colorsToAttr(anim.bgColFrames[fi], anim.nBg, anim.gain)); ca.needsUpdate = true;
      }
    }
    if (anim.trkFrames) {
      var Tn = anim.T, ff = Math.max(0, Math.min(Tn - 1, playhead));
      var j0 = Math.floor(ff), j1 = Math.min(Tn - 1, j0 + 1), aa = ff - j0;
      var A2 = anim.trkFrames[j0], B2 = anim.trkFrames[j1], L = anim.trkLerp, T0 = anim.trkFrames[0];
      for (var q = 0; q < L.length; q++) L[q] = A2[q] + (B2[q] - A2[q]) * aa - T0[q];
      var attr = anim.points.geometry.getAttribute('position');
      var vnn = anim.variants && anim.variants[anim.variant] && anim.variants[anim.variant].nn;
      var extraT = vnn && anim.nnExtra && anim.nnExtra[vnn];
      var dst = attr.array, base = anim.base, K = anim.K,
          NI = extraT ? extraT.idx : anim.nnIdx,
          NW = extraT ? extraT.w : anim.nnW;
      for (var i = 0; i < anim.nObj; i++) {
        var dx = 0, dy = 0, dz = 0, o = i * K;
        for (var k = 0; k < K; k++) {
          var wgt = NW[o + k], ji = NI[o + k] * 3;
          dx += wgt * L[ji]; dy += wgt * L[ji + 1]; dz += wgt * L[ji + 2];
        }
        dst[3 * i] = base[3 * i] + dx;
        dst[3 * i + 1] = base[3 * i + 1] + dy;
        dst[3 * i + 2] = base[3 * i + 2] + dz;
      }
      attr.needsUpdate = true;
    }
    function arcFracAt(ud, tv) {
      var T = anim.T, f2 = Math.max(0, Math.min(T - 1, tv));
      var i0 = Math.floor(f2), i1 = Math.min(T - 1, i0 + 1), a = f2 - i0;
      return ud.knotArc[i0] + (ud.knotArc[i1] - ud.knotArc[i0]) * a;
    }
    var tubeTime = anim.twoPhase ? (isInput ? trackFrac * (anim.T - 1) : anim.T - 1) : playhead;
    // phase 1: the marker draws the track; phase 2: it parks at the end so the
    // scene animates on its own
    var markTime = anim.twoPhase ? (isInput ? trackFrac * (anim.T - 1) : anim.T - 1) : playhead;
    if (anim.tubes) {
      for (var ti = 0; ti < anim.tubes.length; ti++) {
        var tb = anim.tubes[ti];
        var nseg = Math.max(1, Math.round(arcFracAt(tb.userData, tubeTime) * tb.userData.segs));
        tb.geometry.setDrawRange(0, nseg * tb.userData.idxPerSeg);
      }
    }
    if (anim.spheres) {
      for (var gi = 0; gi < anim.spheres.length; gi++) {
        var sp2 = anim.spheres[gi];
        var af = Math.max(0, Math.min(1, arcFracAt(sp2.userData, markTime)));
        sp2.position.copy(sp2.userData.curve.getPointAt(af));
      }
    }
    if (!drag && idleT > 3) orb.az += dt * 0.12;
    applyCamera();
    renderer.render(scene, camera);
  }

  function select(key) {
    loadEl.style.display = 'flex';
    loadScene(key).then(function () {
      showScene(key);
      loadEl.style.display = 'none';
    }).catch(function (e) {
      loadEl.innerHTML = '<span style="color:#bbb;font-size:0.9rem;">failed to load scene</span>';
      console.error(e);
    });
  }
  function setMode(mode, sceneKey) {
    currentMode = mode;
    modesEl.querySelectorAll('.pz-mode').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.mode === mode);
    });
    var pin = root.dataset.pzViewer;      // 'pre' | 'ctx' | 'sim' | '' (both)
    var keys = manifest.order.filter(function (k) {
      var sc = manifest.scenes[k];
      if (pin === 'ctx' || pin === 'sim') return sc.kind === pin;
      if (pin === 'pre') return sc.mode === 'pre';
      return sc.mode === mode;
    });
    tabsEl.innerHTML = '';
    keys.forEach(function (k) {
      var b = document.createElement('button');
      b.className = 'pz-tab';
      b.dataset.key = k;
      b.textContent = manifest.scenes[k].label;
      tabsEl.appendChild(b);
    });
    select(sceneKey && keys.indexOf(sceneKey) >= 0 ? sceneKey : keys[0]);
  }
  modesEl.addEventListener('click', function (e) {
    var b = e.target.closest('.pz-mode');
    if (b && b.dataset.mode !== currentMode) setMode(b.dataset.mode);
  });
  tabsEl.addEventListener('click', function (e) {
    var b = e.target.closest('.pz-tab');
    if (b) select(b.dataset.key);
  });

  return function (m) {
    manifest = m;
    var pin = root.dataset.pzViewer;
    if (pin) modesEl.style.display = 'none';
    resize();
    var q = new URLSearchParams(location.search);
    var qs = q.get('scene');
    var tParam = parseFloat(q.get('t'));
    var vParam = parseInt(q.get('variant'), 10);
    if (!isNaN(vParam)) { window.__pzVariant = vParam; }
    if (!isNaN(tParam)) { window.__pzFixedT = Math.max(0, Math.min(1, tParam)); }
    if (q.get('bare') === '1') root.classList.add('pz-bare');
    var wanted = (qs && m.scenes[qs]) ? qs : null;
    var startMode = wanted ? m.scenes[wanted].mode : 'pre';
    setMode(startMode, wanted);
    // only render while on screen: several viewers share one page
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) {
        es.forEach(function (e) { visible = e.isIntersecting; });
      }, { rootMargin: '200px' }).observe(stage);
    }
    requestAnimationFrame(tick);
    setTimeout(function () {
      manifest.order.forEach(function (k) {
        var sc = manifest.scenes[k];
        var mine = pin === 'ctx' || pin === 'sim' ? sc.kind === pin
                 : pin === 'pre' ? sc.mode === 'pre' : true;
        if (mine) loadScene(k);
      });
    }, 3500);
  };
  }

  fetch(BASE + 'manifest.json?t=' + Date.now()).then(function (r) { return r.json(); })
    .then(function (m) { HOSTS.forEach(function (h) { var init = makeViewer(h); if (init) init(m); }); });
})();

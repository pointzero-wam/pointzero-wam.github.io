/* Interactive method figure.
   Concept A is a row of LIVE 3D widgets built from the same data the hero uses:
   observed cloud, a single conditioning track, DINOv2 features (+ a Perceiver-IO
   token-compression widget), a noise -> tracks denoising animation, and 3D
   outputs for the downstream tasks.
   Concepts B and C remain available in the dropdown. */
(function () {
  'use strict';

  var root = document.getElementById('method-figure');
  if (!root) return;

  var BASE = 'static/hero_data/';
  var ACCENT = 0xe0662a, BLUE = '#3f7fbf', PURPLE = '#8a63c4', GREEN = '#3f9e78';
  var SCENE = 'heater_box', SIM = 'sim_blockstack', WAM = 'rope';

  root.innerHTML =
    '<div class="mf-head">' +
    '  <span class="mf-hint"></span>' +
    '</div>' +
    '<div class="mf-stage"></div>' +
    '<div class="mf-info"><span class="mf-info-title"></span>' +
    '<span class="mf-info-body"></span></div>';

  // pinned to concept A; B and C stay in the file but are no longer offered
  var sel = { value: 'schematic', addEventListener: function () {} };
  var stage = root.querySelector('.mf-stage');
  var hintEl = root.querySelector('.mf-hint');
  var infoT = root.querySelector('.mf-info-title');
  var infoB = root.querySelector('.mf-info-body');
  function info(t, b) { infoT.textContent = t; infoB.innerHTML = b; }

  // ---------------------------------------------------------------- data
  var manifestP = null, binCache = {};
  function getManifest() {
    if (!manifestP) manifestP = fetch(BASE + 'manifest.json?t=' + Date.now()).then(function (r) { return r.json(); });
    return manifestP;
  }
  function part(buf, man, name) {
    var p = man.parts[name];
    var len = p.shape.reduce(function (a, b) { return a * b; }, 1);
    return (p.dtype === 'uint16' || p.dtype === '<u2')
      ? new Uint16Array(buf, p.offset, len) : new Uint8Array(buf, p.offset, len);
  }
  function dequant(u16, lo, hi, n) {
    var out = new Float32Array(n * 3);
    var s = [(hi[0] - lo[0]) / 65535, (hi[1] - lo[1]) / 65535, (hi[2] - lo[2]) / 65535];
    for (var i = 0; i < n; i++) {
      out[3 * i] = lo[0] + u16[3 * i] * s[0];
      out[3 * i + 1] = lo[1] + u16[3 * i + 1] * s[1];
      out[3 * i + 2] = lo[2] + u16[3 * i + 2] * s[2];
    }
    return out;
  }
  function gainOf(u8, n) {
    var lums = [], step = Math.max(1, Math.floor(n / 3000));
    for (var i = 0; i < n; i += step) {
      var r = Math.pow(u8[3 * i] / 255, 2.2), g = Math.pow(u8[3 * i + 1] / 255, 2.2), b = Math.pow(u8[3 * i + 2] / 255, 2.2);
      lums.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
    }
    if (!lums.length) return 1;
    lums.sort(function (a, b) { return a - b; });
    var med = lums[Math.floor(lums.length * 0.5)] || 0.01;
    return Math.max(1.0, Math.min(16.0, 0.40 / Math.max(med, 1e-4)));
  }
  function srgb(u8, n, gain) {
    var out = new Float32Array(n * 3), g = gain || 3.0, W2 = 16;
    for (var i = 0; i < n; i++) {
      var r = Math.pow(u8[3 * i] / 255, 2.2), gr = Math.pow(u8[3 * i + 1] / 255, 2.2), b = Math.pow(u8[3 * i + 2] / 255, 2.2);
      var lum = 0.2126 * r + 0.7152 * gr + 0.0722 * b, x = lum * g;
      var sc = lum > 1e-5 ? (x * (1 + x / W2) / (1 + x)) / lum : g;
      out[3 * i] = Math.min(1, r * sc); out[3 * i + 1] = Math.min(1, gr * sc); out[3 * i + 2] = Math.min(1, b * sc);
    }
    return out;
  }
  function grayOf(u8, n, gain) {
    var out = new Float32Array(n * 3), g = gain || 1;
    for (var i = 0; i < n; i++) {
      var r = Math.pow(u8[3 * i] / 255, 2.2), gr = Math.pow(u8[3 * i + 1] / 255, 2.2), b = Math.pow(u8[3 * i + 2] / 255, 2.2);
      var l = Math.min(1, (0.2126 * r + 0.7152 * gr + 0.0722 * b) * g);
      l = Math.pow(l, 1 / 2.2) * 0.62;
      out[3 * i] = l; out[3 * i + 1] = l * 1.01; out[3 * i + 2] = l * 1.05;
    }
    return out;
  }
  function loadScene(key) {
    if (binCache[key]) return binCache[key];
    binCache[key] = getManifest().then(function (m) {
      var man = m.scenes[key];
      return fetch(BASE + key + '.bin?v=' + (m.build || 0)).then(function (r) { return r.arrayBuffer(); })
        .then(function (buf) {
          var d = { man: man };
          if (man.kind === 'dn') {
            // Real sampler intermediates: (n_steps + 1) states x T x n_trk x 3.
            // State 0 is the t = 0 initialisation the sampler started from.
            var dv = part(buf, man, 'dn_trk'), NT = man.n_trk, sz = NT * 3;
            d.dn = [];
            for (var si = 0; si <= man.n_steps; si++) {
              var frames = [];
              for (var ti = 0; ti < man.T; ti++) {
                var o5 = (si * man.T + ti) * sz;
                frames.push(dequant(dv.subarray(o5, o5 + sz), man.lo, man.hi, NT));
              }
              d.dn.push(frames);
            }
          } else if (man.kind === 'ctx') {
            var Kx = man.K, so = 3, nOx = Math.floor(man.n_obj / so);
            var obx = part(buf, man, 'obj_base'), ocx = part(buf, man, 'obj_col');
            var nix = part(buf, man, 'nn_idx'), nwx = part(buf, man, 'nn_w');
            var obsx = new Uint16Array(nOx * 3), ocsx = new Uint8Array(nOx * 3);
            var nisx = new Uint16Array(nOx * Kx), nwsx = new Float32Array(nOx * Kx);
            for (var jx = 0; jx < nOx; jx++) {
              var sx2 = jx * so;
              for (var cx = 0; cx < 3; cx++) { obsx[3 * jx + cx] = obx[3 * sx2 + cx]; ocsx[3 * jx + cx] = ocx[3 * sx2 + cx]; }
              var swx = 0;
              for (var kx = 0; kx < Kx; kx++) swx += nwx[sx2 * Kx + kx];
              for (var kx2 = 0; kx2 < Kx; kx2++) { nisx[jx * Kx + kx2] = nix[sx2 * Kx + kx2]; nwsx[jx * Kx + kx2] = swx > 0 ? nwx[sx2 * Kx + kx2] / swx : 0; }
            }
            d.obj = dequant(obsx, man.lo, man.hi, nOx);
            d.objCol = ocsx; d.nnIdx = nisx; d.nnW = nwsx; d.nObj = nOx; d.K = Kx;
            d.frames = []; d.cols = [];
            var bpx = part(buf, man, 'bg_pos'), bcx = part(buf, man, 'bg_col');
            var sb = 4, nBx = Math.floor(man.n_bg / sb);
            for (var tx = 0; tx < man.T; tx++) {
              var sub2 = new Uint16Array(nBx * 3), subc2 = new Uint8Array(nBx * 3);
              for (var ix = 0; ix < nBx; ix++) for (var cc = 0; cc < 3; cc++) {
                sub2[3 * ix + cc] = bpx[(tx * man.n_bg + ix * sb) * 3 + cc];
                subc2[3 * ix + cc] = bcx[(tx * man.n_bg + ix * sb) * 3 + cc];
              }
              d.frames.push(dequant(sub2, man.lo, man.hi, nBx));
              d.cols.push(subc2);
            }
            d.n = nBx;
            var vtx = part(buf, man, 'var_trk');
            d.trk = [];
            for (var t3 = 0; t3 < man.T; t3++) {
              var offx = t3 * man.n_trk * 3;
              d.trk.push(dequant(vtx.subarray(offx, offx + man.n_trk * 3), man.lo, man.hi, man.n_trk));
            }
          } else if (man.kind === 'sim') {
            d.frames = []; d.cols = [];
            var bp = part(buf, man, 'bg_pos'), bc = part(buf, man, 'bg_col');
            var step = 3, n = Math.floor(man.n_bg / step);
            for (var t = 0; t < man.T; t++) {
              var sub = new Uint16Array(n * 3), subc = new Uint8Array(n * 3);
              for (var i = 0; i < n; i++) for (var c = 0; c < 3; c++) {
                sub[3 * i + c] = bp[(t * man.n_bg + i * step) * 3 + c];
                subc[3 * i + c] = bc[(t * man.n_bg + i * step) * 3 + c];
              }
              d.frames.push(dequant(sub, man.lo, man.hi, n));
              d.cols.push(subc);
            }
            d.n = n;
          } else {
            var K = man.K, stepO = 3, nO = Math.floor(man.n_obj / stepO);
            var ob = part(buf, man, 'obj_base'), oc = part(buf, man, 'obj_col');
            var ni = part(buf, man, 'nn_idx'), nwRaw = part(buf, man, 'nn_w');
            var obs = new Uint16Array(nO * 3), ocs = new Uint8Array(nO * 3);
            var nis = new Uint16Array(nO * K), nws = new Float32Array(nO * K);
            for (var j = 0; j < nO; j++) {
              var src2 = j * stepO;
              for (var c2 = 0; c2 < 3; c2++) { obs[3 * j + c2] = ob[3 * src2 + c2]; ocs[3 * j + c2] = oc[3 * src2 + c2]; }
              var sw = 0;
              for (var k = 0; k < K; k++) sw += nwRaw[src2 * K + k];
              for (var k2 = 0; k2 < K; k2++) { nis[j * K + k2] = ni[src2 * K + k2]; nws[j * K + k2] = sw > 0 ? nwRaw[src2 * K + k2] / sw : 0; }
            }
            d.obj = dequant(obs, man.lo, man.hi, nO);
            d.objCol = ocs; d.nnIdx = nis; d.nnW = nws; d.nObj = nO; d.K = K;
            var stepB = 5, nB = Math.floor(man.n_bg / stepB);
            var bg = part(buf, man, 'bg_pos'), bgc = part(buf, man, 'bg_col');
            var bs = new Uint16Array(nB * 3), bcs = new Uint8Array(nB * 3);
            for (var q = 0; q < nB; q++) for (var c3 = 0; c3 < 3; c3++) {
              bs[3 * q + c3] = bg[3 * q * stepB + c3]; bcs[3 * q + c3] = bgc[3 * q * stepB + c3];
            }
            d.bg = dequant(bs, man.lo, man.hi, nB); d.bgCol = bcs; d.nBg = nB;
            var vt = part(buf, man, 'var_trk'), vi = man.default_variant || 0;
            d.trk = [];
            for (var t2 = 0; t2 < man.T; t2++) {
              var off = (vi * man.T + t2) * man.n_trk * 3;
              d.trk.push(dequant(vt.subarray(off, off + man.n_trk * 3), man.lo, man.hi, man.n_trk));
            }
          }
          return d;
        });
    });
    return binCache[key];
  }

  // ---------------------------------------------------------------- 3D widget
  var discTex = null;
  function disc() {
    if (discTex) return discTex;
    var c = document.createElement('canvas'); c.width = c.height = 64;
    var x = c.getContext('2d');
    var g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.7, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, 64, 64);
    discTex = new THREE.CanvasTexture(c);
    return discTex;
  }

  // -------------------------------------------------------- denoising clock
  // One shared, scrubbable clock for the DiT panel. The 3D denoising widget,
  // the step chips and the slider all read this single value, so they can never
  // drift apart.
  //
  // There is nothing synthetic left here: the panel replays the nine real Euler
  // steps the JiT sampler took on this scene (heater_box, seed 25 — the same run
  // the rest of the page ships), captured out of the sampler by
  // tools/dit_denoise_steps.py and exported by tools/export_denoise.py.
  // The step count comes from the bin, not from this file.  `u` in [0,1] is
  // a LINEAR axis over the states, so u * NSTEP is the true (fractional) step
  // index and the slider is a true step axis.  Only the wall-clock pacing is a
  // presentation choice: the loop sweeps the steps, then dwells on the resolved
  // trajectory, and it opens on that dwell so a visitor arriving mid-page sees
  // the answer first and the noise second.
  var DIT = {
    u: 1, ph: 0, drag: false, hold: 0, playing: true,
    NSTEP: 9,             // real Euler steps; NSTEP + 1 captured states
    // Pacing only — the CONTENT is the captured states and nothing else. The
    // loop sweeps the steps (EASE < 1 plays the early, noisiest ones slightly
    // faster), then dwells on the resolved trajectory. Step indices, chips and
    // the readout are unaffected: they always report the real step.
    SWEEP: 4.6, DWELL: 4.0, EASE: 0.72,   // seconds, seconds, exponent
    D2F: null,            // mm from the final state after each state, from the manifest
    subs: [],
    frac: function () { return this.SWEEP / (this.SWEEP + this.DWELL); },
    pos: function () { return this.u * this.NSTEP; },     // 0 .. NSTEP, fractional
    // which step is being executed / has just finished
    step: function () {
      var p = this.pos();
      return p <= 1e-6 ? 0 : Math.min(this.NSTEP, Math.ceil(p - 1e-6));
    },
    // linearly interpolated "how much noise is left", in mm
    noiseMM: function () {
      var d = this.D2F;
      if (!d || !d.length) return null;
      var p = Math.min(this.pos(), d.length - 1), i = Math.floor(p), f = p - i;
      return d[i] + (d[Math.min(d.length - 1, i + 1)] - d[i]) * f;
    },
    emit: function () { for (var i = 0; i < this.subs.length; i++) { try { this.subs[i](this.u); } catch (e) {} } },
    set: function (u) {
      this.u = Math.max(0, Math.min(1, u));
      this.ph = Math.pow(this.u, 1 / this.EASE) * this.frac();
      this.emit();
    },
    // jump the scrubber to the state just after step k (k = 0 is the noise init)
    goStep: function (k) { this.set(k / this.NSTEP); this.hold = 1.6; },
    tick: function (dt) {
      if (this.drag || !this.playing) return;
      if (this.hold > 0) { this.hold -= dt; return; }
      this.ph = (this.ph + dt / (this.SWEEP + this.DWELL)) % 1;
      this.u = Math.pow(Math.min(1, this.ph / this.frac()), this.EASE);
      this.emit();
    }
  };
  if (!DIT._up) {
    DIT._up = true;
    window.addEventListener('pointerup', function () {
      if (DIT.drag) { DIT.drag = false; DIT.hold = 1.1; }
    });
  }

  var widgets = [];
  var SR = null, SRC = null;
  function sharedRenderer() {
    if (SR) return SR;
    SRC = document.createElement('canvas');
    SR = new THREE.WebGLRenderer({ canvas: SRC, antialias: true, alpha: true });
    SR.setPixelRatio(1);
    return SR;
  }
  function mini(canvas, key, mode) {
    if (!window.THREE) return null;
    var ctx2 = canvas.getContext('2d');
    var scene = new THREE.Scene(), group = new THREE.Group();
    scene.add(group);
    var cam = new THREE.PerspectiveCamera(42, 1.35, 0.01, 60);
    var st = { az: 0.35, el: 0.4, dist: 1, tgt: new THREE.Vector3(), visible: true, t: 0 };
    var W = { st: st };
    widgets.push(W);

    function points(pos, col, size, opacity) {
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos.slice(0), 3));
      if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      var op = opacity === undefined ? 1 : opacity;
      var m = new THREE.PointsMaterial({ size: size, vertexColors: !!col, sizeAttenuation: true,
        map: disc(), alphaTest: Math.min(0.4, op * 0.5), transparent: true, opacity: op });
      if (!col) m.color.setHex(0x9aa6b4);
      return new THREE.Points(g, m);
    }

    // the denoising panel needs the scene's dense cloud AND the sampler states,
    // which live in a small companion bin so nothing is duplicated
    var loadP = (mode === 'denoise')
      ? Promise.all([loadScene(key), loadScene(key + '_dn')]).then(function (a) {
          a[0].dnd = a[1]; return a[0];
        })
      : loadScene(key);

    loadP.then(function (d) {
      var man = d.man;
      var diag = Math.hypot(man.hi[0] - man.lo[0], man.hi[1] - man.lo[1], man.hi[2] - man.lo[2]);
      st.tgt.set(man.center[0], man.center[1], man.center[2]);
      st.dist = diag * (mode === 'sim' ? 0.5 : (mode === 'cloud' || mode === 'track') ? 0.68 : mode === 'denoise' ? 0.76 : 0.47);
      st.el = mode === 'sim' ? 0.42 : 0.34;
      if (mode === 'denoise' && d.dnd) {
        // frame the whole noise burst, not just the resolved tracks
        var dm = d.dnd.man;
        st.tgt.set(dm.center[0], dm.center[1], dm.center[2]);
        st.dist = Math.hypot(dm.hi[0] - dm.lo[0], dm.hi[1] - dm.lo[1], dm.hi[2] - dm.lo[2]) * 1.02;
      }

      if (mode === 'sim' || mode === 'wam') {
        var gsim = gainOf(d.cols[0], d.n);
        W.bgPts = points(d.frames[0], srgb(d.cols[0], d.n, gsim), diag * 0.0072, 1);
        group.add(W.bgPts);
        W.frames = d.frames; W.cols = d.cols; W.gain = gsim; W.n = d.n;
        W.T = man.T; W.shown = -1;
        if (mode === 'wam') {
          W.pts = points(d.obj, srgb(d.objCol, d.nObj, gainOf(d.objCol, d.nObj)), diag * 0.0082, 1);
          group.add(W.pts);
          W.obj = d.obj; W.nnIdx = d.nnIdx; W.nnW = d.nnW; W.K = d.K;
          W.trk = d.trk; W.nObj = d.nObj; W.animate = true;
        }
      } else {
        var faint = (mode === 'track');
        if (mode !== 'denoise') {
          group.add(points(d.bg,
          faint ? grayOf(d.bgCol, d.nBg, gainOf(d.bgCol, d.nBg))
                : srgb(d.bgCol, d.nBg, gainOf(d.bgCol, d.nBg)),
          diag * 0.0062, faint ? 0.5 : 0.85));
        }
        var objCol = faint ? grayOf(d.objCol, d.nObj, gainOf(d.objCol, d.nObj))
                           : srgb(d.objCol, d.nObj, gainOf(d.objCol, d.nObj));
        if (mode === 'denoise') {
          // What the DiT denoises is a TRAJECTORY per point, not one cloud, so
          // we hold three things and drive all of them from the SAME captured
          // sampler states:
          //   * the cloud at t = 0            (the observation — given, fixed)
          //   * the cloud at t = T-1          (end state)
          //   * the polyline between them     (the trajectory itself)
          // d.dnd.dn[k] is the model's real state after Euler step k (k = 0 is
          // the initialisation it started from), each a T-long list of the 1000
          // sampled tracks.  Every k gets its own dense end cloud and its own
          // polyline bundle, precomputed here; the frame loop only interpolates
          // between two of them, so scrubbing is exact and cheap.
          var TN = man.T, KN = d.K, nObj = d.nObj;
          var DN = d.dnd.dn, NSTEP = d.dnd.man.n_steps, NSTATE = NSTEP + 1;
          var first = DN[0][0];          // t = 0 is identical in every state

          // --- start cloud (decimated by 2 so start and end never fight) ----
          var sd = 2, nD = Math.ceil(nObj / sd);
          var cleanS = new Float32Array(nD * 3);
          for (var i = 0, wI = 0; i < nObj; i += sd, wI++) {
            cleanS[3 * wI] = d.obj[3 * i];
            cleanS[3 * wI + 1] = d.obj[3 * i + 1];
            cleanS[3 * wI + 2] = d.obj[3 * i + 2];
          }

          // --- which dense points carry a drawn polyline --------------------
          // kept even so every polyline endpoint coincides with a rendered dot
          var NLwant = 120;
          var stepL = Math.max(2, Math.floor(nObj / NLwant / 2) * 2);
          var lidx = [];
          for (var q2 = 0; q2 < nObj; q2 += stepL) lidx.push(q2);
          var NL = lidx.length;

          // --- one end cloud + one polyline bundle per denoising state ------
          var endS = [], lineS = [];
          for (var s5 = 0; s5 < NSTATE; s5++) {
            var frames = DN[s5], last = frames[TN - 1];
            var eArr = new Float32Array(nD * 3);
            for (var i2 = 0, w2i = 0; i2 < nObj; i2 += sd, w2i++) {
              var dx = 0, dy = 0, dz = 0, oK = i2 * KN;
              for (var k = 0; k < KN; k++) {
                var w = d.nnW[oK + k], ji = d.nnIdx[oK + k] * 3;
                dx += w * (last[ji] - first[ji]);
                dy += w * (last[ji + 1] - first[ji + 1]);
                dz += w * (last[ji + 2] - first[ji + 2]);
              }
              eArr[3 * w2i] = d.obj[3 * i2] + dx;
              eArr[3 * w2i + 1] = d.obj[3 * i2 + 1] + dy;
              eArr[3 * w2i + 2] = d.obj[3 * i2 + 2] + dz;
            }
            endS.push(eArr);
            var lArr = new Float32Array(NL * TN * 3);
            for (var li = 0; li < NL; li++) {
              var pi = lidx[li], ob = pi * 3, oK2 = pi * KN;
              for (var t = 0; t < TN; t++) {
                var Tt = frames[t], ax = 0, ay = 0, az = 0;
                for (var k2 = 0; k2 < KN; k2++) {
                  var w2 = d.nnW[oK2 + k2], j2 = d.nnIdx[oK2 + k2] * 3;
                  ax += w2 * (Tt[j2] - first[j2]);
                  ay += w2 * (Tt[j2 + 1] - first[j2 + 1]);
                  az += w2 * (Tt[j2 + 2] - first[j2 + 2]);
                }
                var b0 = (li * TN + t) * 3;
                lArr[b0] = d.obj[ob] + ax;
                lArr[b0 + 1] = d.obj[ob + 1] + ay;
                lArr[b0 + 2] = d.obj[ob + 2] + az;
              }
            }
            lineS.push(lArr);
          }

          // --- geometry: colour ramps t = 0 (slate) -> t = T-1 (orange) -----
          var lcol = new Float32Array(NL * TN * 3);
          var C0 = [0.52, 0.60, 0.70], C1 = [1.0, 0.46, 0.16];
          for (var li2 = 0; li2 < NL; li2++)
            for (var t2 = 0; t2 < TN; t2++) {
              var bc = (li2 * TN + t2) * 3, ft = TN > 1 ? t2 / (TN - 1) : 1;
              lcol[bc] = C0[0] + (C1[0] - C0[0]) * ft;
              lcol[bc + 1] = C0[1] + (C1[1] - C0[1]) * ft;
              lcol[bc + 2] = C0[2] + (C1[2] - C0[2]) * ft;
            }
          var lidxArr = new Uint16Array(NL * (TN - 1) * 2), lw = 0;
          for (var la = 0; la < NL; la++)
            for (var lb = 0; lb < TN - 1; lb++) {
              lidxArr[lw++] = la * TN + lb; lidxArr[lw++] = la * TN + lb + 1;
            }
          var lg = new THREE.BufferGeometry();
          lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lineS[NSTEP]), 3));
          lg.setAttribute('color', new THREE.BufferAttribute(lcol, 3));
          lg.setIndex(new THREE.BufferAttribute(lidxArr, 1));
          var lines = new THREE.LineSegments(lg,
            new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55 }));

          // the start cloud is deliberately recessive: where nothing moves the two
          // clouds coincide, and an equally bright grey would dither against the
          // orange instead of reading as "ghost of t=0"
          var sp = points(cleanS, null, diag * 0.0066, 0.55);
          sp.material.color.setHex(0x7f8ea6);
          var ep = points(endS[NSTEP], null, diag * 0.0082, 1);
          ep.material.color.setHex(0xff7a33);
          group.add(sp); group.add(ep); group.add(lines);

          W.dn = {
            nD: nD, NL: NL, T: TN, NSTEP: NSTEP,
            endS: endS, lineS: lineS,
            endPts: ep, lines: lines
          };
          DIT.NSTEP = NSTEP;
          DIT.D2F = d.dnd.man.dist_to_final_mm || null;
          if (DIT.chips) DIT.chips();
          DIT.emit();
        } else {
          W.pts = points(d.obj, objCol, diag * 0.0078, faint ? 0.5 : 1);
          group.add(W.pts);
          W.obj = d.obj; W.nnIdx = d.nnIdx; W.nnW = d.nnW; W.K = d.K;
          W.trk = d.trk; W.nObj = d.nObj; W.T = man.T;
          W.animate = (mode === 'pred');
        }
        if (mode === 'track' && man.graspers) {
          var pts = man.graspers.map(function (fr) { return new THREE.Vector3(fr[0][0], fr[0][1], fr[0][2]); });
          var curve = new THREE.CatmullRomCurve3(pts);
          group.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 64, diag * 0.0052, 10, false),
            new THREE.MeshBasicMaterial({ color: ACCENT })));
          var sp = new THREE.Mesh(new THREE.SphereGeometry(diag * 0.017, 20, 16),
            new THREE.MeshBasicMaterial({ color: ACCENT }));
          group.add(sp);
          W.curve = curve; W.marker = sp;   // viewpoint stays identical to the cloud panel
        }
      }
    });

    W.tick = function (dt) {
      if (!st.visible) return;
      st.az += dt * 0.15; st.t += dt;
      var ce = Math.cos(st.el), se = Math.sin(st.el);
      cam.position.set(st.tgt.x + st.dist * ce * Math.sin(st.az),
                       st.tgt.y + st.dist * se,
                       st.tgt.z + st.dist * ce * Math.cos(st.az));
      cam.lookAt(st.tgt);
      var u = (st.t % 4.4) / 4.4;
      if (W.dn) {
        // driven by the shared, scrubbable denoising clock — the slider and the
        // step chips read exactly the same value, so they cannot drift. All that
        // happens here is a lerp between two REAL captured sampler states.
        var D = W.dn, p = DIT.pos();
        var s0 = Math.min(D.NSTEP, Math.floor(p)), s1 = Math.min(D.NSTEP, s0 + 1);
        var fa = p - s0;
        var lerp = function (obj3, A, B, n3) {
          var at = obj3.geometry.getAttribute('position'), o = at.array;
          for (var i2 = 0; i2 < n3; i2++) o[i2] = A[i2] + (B[i2] - A[i2]) * fa;
          at.needsUpdate = true;
        };
        lerp(D.endPts, D.endS[s0], D.endS[s1], D.nD * 3);
        lerp(D.lines, D.lineS[s0], D.lineS[s1], D.NL * D.T * 3);
        // lines only assert themselves once they mean something
        D.lines.material.opacity = 0.10 + 0.62 * Math.pow(p / D.NSTEP, 1.5);
      } else if (W.animate && W.pts) {
        var f = Math.min(1, u / 0.85) * (W.T - 1);
        var j0 = Math.floor(f), j1 = Math.min(W.T - 1, j0 + 1), aa = f - j0;
        var A = W.trk[j0], B = W.trk[j1], T0 = W.trk[0];
        var at = W.pts.geometry.getAttribute('position'), dst = at.array;
        for (var p = 0; p < W.nObj; p++) {
          var dx = 0, dy = 0, dz = 0, o = p * W.K;
          for (var k = 0; k < W.K; k++) {
            var w = W.nnW[o + k], ji = W.nnIdx[o + k] * 3;
            dx += w * (A[ji] + (B[ji] - A[ji]) * aa - T0[ji]);
            dy += w * (A[ji + 1] + (B[ji + 1] - A[ji + 1]) * aa - T0[ji + 1]);
            dz += w * (A[ji + 2] + (B[ji + 2] - A[ji + 2]) * aa - T0[ji + 2]);
          }
          dst[3 * p] = W.obj[3 * p] + dx;
          dst[3 * p + 1] = W.obj[3 * p + 1] + dy;
          dst[3 * p + 2] = W.obj[3 * p + 2] + dz;
        }
        at.needsUpdate = true;
      }
      if (W.frames && W.bgPts) {
        var fi = Math.round(Math.min(1, u / 0.9) * (W.T - 1));
        if (fi !== W.shown) {
          W.shown = fi;
          var pa = W.bgPts.geometry.getAttribute('position');
          pa.array.set(W.frames[fi]); pa.needsUpdate = true;
          var ca = W.bgPts.geometry.getAttribute('color');
          ca.array.set(srgb(W.cols[fi], W.n, W.gain)); ca.needsUpdate = true;
        }
      }
      if (W.marker && W.curve) W.marker.position.copy(W.curve.getPointAt(Math.min(1, u / 0.9)));
      // render through the one shared context, then blit into this card
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var cw = Math.round((canvas.clientWidth || 250) * dpr);
      var ch = Math.round((canvas.clientHeight || 180) * dpr);
      if (!cw || !ch) return;
      if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
      var R = sharedRenderer();
      R.setSize(cw, ch, false);
      cam.aspect = cw / ch; cam.updateProjectionMatrix();
      R.render(scene, cam);
      ctx2.clearRect(0, 0, cw, ch);
      ctx2.drawImage(SRC, 0, 0, cw, ch);
    };
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) { es.forEach(function (e) { st.visible = e.isIntersecting; }); },
        { rootMargin: '150px' }).observe(canvas);
    }
    return W;
  }

  var rafOn = false, last = null;
  function loop(ts) {
    requestAnimationFrame(loop);
    var dt = last ? Math.min(0.05, (ts - last) / 1000) : 0; last = ts;
    for (var i = 0; i < widgets.length; i++) { try { widgets[i].tick(dt); } catch (e) {} }
  }

  // ---------------------------------------------------------------- concept A
  var CARDS = {
    cloud: { title: 'Observed point cloud',
      body: 'A single RGB-D frame, unprojected into 3D. We predict a future 3D trajectory for each observed point.' },
    track: { title: 'Partial point tracks',
      body: 'A small number of complete trajectories (orange) are supplied as conditioning, 1-3 trajectories in practice.' },
    dino: { title: 'DINOv2 features',
      body: 'Features from a frozen DINOv2 encoder. We find this helps a single checkpoint distinguish between object categories.' },
    perceiver: { title: 'Perceiver-IO',
      body: 'We use a perceiver-IO to reduce the total number of visual tokens to just 4 tokens.' },
    denoise: { title: 'Denoising transformer',
      body: 'What is denoised is a <b>trajectory per point</b>, not a single cloud: every observed point carries a full 3D path, shown by its start state (t&nbsp;=&nbsp;0, grey — the observation, which is given), its end state (t&nbsp;=&nbsp;T−1, orange) and the path between them. This panel plays the sampler\'s <b>real intermediate states</b> for this scene, captured from the 9 Euler steps it actually ran: the readout is the true step index and the true mean distance left to the final sample. Drag the slider or click a step to scrub. Layers alternate between point attention (between point tokens only) and global attention with all available tokens.'  },
    pred: { title: 'Dense 3D point tracks',
      body: 'The pre-training output: a future trajectory for every observed point.' },
    wam: { title: 'Action-conditioned dynamics',
      body: 'Fine-tuned to condition on robot end-effector pose instead of point tracks, the model predicts how the object responds to the robot.' },
    sim: { title: 'Robot manipulation',
      body: 'With a lightweight action head the same model predicts robot action chunks — a real policy rollout in simulation, in 3D.' }
  };

  function buildSchematic() {
    hintEl.textContent = 'live 3D — hover any panel, drag the denoising slider';
    widgets.length = 0;
    DIT.subs.length = 0;
    DIT.u = 1; DIT.ph = DIT.frac();      // open on the resolved trajectory
    DIT.drag = false; DIT.hold = 0; DIT.playing = true;
    // the shared denoising clock ticks first, so everything downstream in this
    // frame (3D widget, chips, slider knob) reads one consistent value
    widgets.push({ tick: function (dt) { DIT.tick(dt); } });
    var host = document.createElement('div');
    host.className = 'mf-flow';

    function attach(f, k) {
      f.addEventListener('mouseenter', function () { info(CARDS[k].title, CARDS[k].body); });
      f.addEventListener('click', function () { info(CARDS[k].title, CARDS[k].body); });
    }
    // A quiet qualifier on the cards whose output needs post-training, so a
    // reader can tell those apart from the pre-training output at a glance.
    function cap(label, post) {
      // the tag sits on its own line under the title: the output cards are
      // narrow, and putting it beside the title forces the title to wrap
      return '<figcaption>' + label +
        (post ? '<span class="mf-tag"><i>post-trained</i></span>' : '') + '</figcaption>';
    }
    function w3d(key, mode, label, k, tall, post) {
      var f = document.createElement('figure');
      f.className = 'mf-w' + (tall ? ' mf-w-tall' : '');
      if (tall) {
        f.innerHTML = '<canvas class="mf-w-canvas mf-dit-canvas"></canvas>' +
          '<div class="mf-dit-legend">' +
          '  <span class="mf-lg"><i class="mf-lg-d mf-lg-start"></i>start state · t = 0</span>' +
          '  <span class="mf-lg"><i class="mf-lg-line"></i>trajectory per point</span>' +
          '  <span class="mf-lg"><i class="mf-lg-d mf-lg-end"></i>end state · t = T−1</span>' +
          '</div>' +
          '<div class="mf-dit-steps"></div>' +
          '<figcaption>' + label + '</figcaption>';
        buildLayers(f.querySelector('.mf-dit-steps'));
      } else {
        f.innerHTML = '<canvas class="mf-w-canvas"></canvas>' + cap(label, post);
      }
      attach(f, k);
      setTimeout(function () { mini(f.querySelector('canvas'), key, mode); }, 0);
      return f;
    }

    // Denoising steps, driven by the SAME clock as the 3D animation above.
    // The slider scrubs that clock, so dragging it moves the widget; the chips
    // light up in lockstep and can themselves be clicked to jump to a step.
    function buildLayers(host) {
      // One chip per REAL Euler step. The sampler takes 9 of them, so there are
      // 9 chips — no schematic ellipsis, no invented step count. Chip j is the
      // state after step j+1; the slider's zero is the t = 0 initialisation the
      // sampler started from, which no chip claims.
      var steps = [];

      var head = document.createElement('span');
      head.className = 'mf-steps-head';
      host.appendChild(head);

      var bar = document.createElement('div');
      bar.className = 'mf-dit-scrub-row';
      bar.innerHTML =
        '<button type="button" class="mf-dit-play" title="pause / play">&#10074;&#10074;</button>' +
        '<input class="mf-dit-scrub" type="range" min="0" max="1000" step="1" value="0" ' +
        'aria-label="scrub the denoising steps">' +
        '<span class="mf-dit-read"></span>';
      host.appendChild(bar);
      var slider = bar.querySelector('.mf-dit-scrub');
      var play = bar.querySelector('.mf-dit-play');
      var read = bar.querySelector('.mf-dit-read');

      var row = document.createElement('div');
      row.className = 'mf-steps-row mf-steps-row-n';
      host.appendChild(row);

      // Built from DIT.NSTEP, and rebuilt if the loaded bin reports a different
      // count — the chip row can never advertise a step count the data does not
      // actually contain.
      function renderChips() {
        if (steps.length === DIT.NSTEP) return;
        steps.length = 0;
        row.innerHTML = '<span class="mf-steps-axis">step</span>';
        head.innerHTML = 'the sampler takes <b>' + DIT.NSTEP + ' Euler steps</b>, and every ' +
          'one of them runs the whole stack — many alternating point / global attention layers';
        for (var i = 0; i < DIT.NSTEP; i++) {
          var b = document.createElement('div');
          b.className = 'mf-step-b mf-step-c';
          b.setAttribute('role', 'button');
          b.setAttribute('tabindex', '0');
          b.setAttribute('title', 'jump to the state after denoising step ' + (i + 1));
          var bars = '';
          for (var L2 = 0; L2 < 4; L2++)
            bars += '<i class="' + (L2 % 2 === 0 ? 'is-p' : 'is-g') + '"></i>';
          b.innerHTML = '<span class="mf-step-stack">' + bars + '</span>' +
                        '<span class="mf-step-lab">' + (i + 1) + '</span>';
          row.appendChild(b);
          steps.push(b);
          (function (j, el) {
            function jump(ev) { ev.stopPropagation(); DIT.goStep(j + 1); }
            el.addEventListener('click', jump);
            el.addEventListener('keydown', function (ev) {
              if (ev.key === 'Enter' || ev.key === ' ') jump(ev);
            });
          })(i, b);
        }
        lastIdx = -1;
      }
      DIT.chips = renderChips;
      renderChips();

      var foot = document.createElement('span');
      foot.className = 'mf-steps-foot';
      foot.textContent = 'real sampler states, captured from this scene’s run';
      host.appendChild(foot);

      // ---- slider drives the clock ----------------------------------------
      function grab(ev) { ev.stopPropagation(); DIT.drag = true; }
      slider.addEventListener('pointerdown', grab);
      slider.addEventListener('mousedown', grab);
      slider.addEventListener('touchstart', grab, { passive: true });
      slider.addEventListener('click', function (ev) { ev.stopPropagation(); });
      slider.addEventListener('input', function () {
        DIT.drag = true;
        DIT.set(slider.value / 1000);
      });
      slider.addEventListener('change', function () { DIT.drag = false; DIT.hold = 1.1; });
      play.addEventListener('click', function (ev) {
        ev.stopPropagation();
        DIT.playing = !DIT.playing;
        DIT.hold = 0;
        play.innerHTML = DIT.playing ? '&#10074;&#10074;' : '&#9654;';
        play.classList.toggle('is-paused', !DIT.playing);
      });

      // ---- clock drives the chips, the readout and the slider knob --------
      // The readout carries the TRUE step index and the actual amount of noise
      // still in the sample: the mean distance, over all points and all future
      // timesteps, between this state and the sampler's final one.
      var lastIdx = -1, lastRead = '', lastVal = -1;
      DIT.subs.push(function (u) {
        var cur = DIT.step();
        if (cur !== lastIdx) {
          lastIdx = cur;
          for (var j = 0; j < steps.length; j++) {
            steps[j].classList.toggle('is-on', j + 1 === cur);
            steps[j].classList.toggle('is-done', j + 1 < cur);
          }
        }
        var mm = DIT.noiseMM();
        var txt = (cur === 0 ? 'noise · t = 0' : 'step ' + cur + ' / ' + DIT.NSTEP);
        if (mm !== null) {
          txt += ' · ' + (mm < 0.05 ? '0' : (mm < 10 ? mm.toFixed(1) : Math.round(mm)));
          txt += ' mm from final';
        }
        if (txt !== lastRead) { lastRead = txt; read.textContent = txt; }
        var v = Math.round(u * 1000);
        if (v !== lastVal) { lastVal = v; if (!DIT.drag) slider.value = v; }
      });
      DIT.emit();
    }

    var ci = document.createElement('div'); ci.className = 'mf-fcol';
    ci.innerHTML = '<span class="mf-col-label">inputs</span>';
    ci.appendChild(w3d(SCENE, 'cloud', 'Observed point cloud', 'cloud'));
    ci.appendChild(w3d(SCENE, 'track', 'Partial point tracks', 'track'));

    var dcard = document.createElement('figure'); dcard.className = 'mf-w mf-dino-card';
    var grid = '';
    for (var r = 0; r < 4; r++) for (var c = 0; c < 11; c++)
      grid += '<rect x="' + (6 + c * 7) + '" y="' + (6 + r * 6) + '" width="5" height="4.4" rx="1" fill="' + PURPLE + '" opacity="0.5"/>';
    var dots = '';
    for (var i = 0; i < 4; i++) dots += '<circle cx="156" cy="' + (10 + i * 7) + '" r="3.2" fill="' + PURPLE + '"/>';
    dcard.innerHTML =
      '<img class="mf-w-img" src="static/method/dino_pca.png" alt="DINOv2 features">' +
      '<div class="mf-pio-inline"><svg viewBox="0 0 176 38" class="mf-pio-svg">' + grid +
      '<path d="M84,19 L132,19" stroke="#b9bec6" stroke-width="1.3" fill="none" marker-end="url(#mfa2)"/>' + dots +
      '<defs><marker id="mfa2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">' +
      '<path d="M0,0 L10,5 L0,10 z" fill="#b9bec6"/></marker></defs></svg>' +
      '<span>patches &rarr; Perceiver-IO &rarr; a few tokens</span></div>' +
      '<figcaption>DINOv2 features + Perceiver-IO</figcaption>';
    attach(dcard, 'dino');
    dcard.querySelector('.mf-pio-inline').addEventListener('mouseenter', function (ev) {
      ev.stopPropagation(); info(CARDS.perceiver.title, CARDS.perceiver.body);
    });
    ci.appendChild(dcard);

    var cd = document.createElement('div'); cd.className = 'mf-fcol mf-fcol-dit';
    cd.innerHTML = '<span class="mf-col-label">Diffusion Transformer (DiT)</span>';
    cd.appendChild(w3d(SCENE, 'denoise', 'noise &rarr; a 3D trajectory per point', 'denoise', true));

    var co = document.createElement('div'); co.className = 'mf-fcol';
    co.innerHTML = '<span class="mf-col-label">outputs</span>';
    co.appendChild(w3d(SCENE, 'pred', 'Dense 3D point tracks', 'pred'));
    co.appendChild(w3d(WAM, 'wam', 'Action-conditioned dynamics', 'wam', false, true));
    var vcard = document.createElement('figure'); vcard.className = 'mf-w';
    vcard.innerHTML = '<video class="mf-w-vid" autoplay muted loop playsinline preload="metadata" ' +
      'poster="static/method/rollout_blockstack.jpg">' +
      '<source src="static/method/rollout_blockstack.mp4" type="video/mp4"></video>' +
      cap('Robot manipulation', true);
    attach(vcard, 'sim');
    co.appendChild(vcard);

    function arrow() { var a = document.createElement('div'); a.className = 'mf-arrow'; a.innerHTML = '&rsaquo;'; return a; }
    [ci, arrow(), cd, arrow(), co].forEach(function (n) { host.appendChild(n); });
    stage.innerHTML = ''; stage.appendChild(host);
    info('PointZero, end to end',
      'One transformer takes an observed point cloud, a couple of partial tracks and DINOv2 vision, and denoises a future trajectory for every point. Every 3D panel here is live, running real model output.');
    if (!rafOn && window.THREE) { rafOn = true; requestAnimationFrame(loop); }
  }

  // ---------------------------------------------------------------- concept B
  function svgEl(n, a) {
    var e = document.createElementNS('http://www.w3.org/2000/svg', n);
    for (var k in a) e.setAttribute(k, a[k]);
    return e;
  }
  function buildAttention() {
    hintEl.textContent = 'step through the decoder layers';
    widgets.length = 0;
    var L = 6, step = 0, timer = null;
    var wrap = document.createElement('div');
    wrap.className = 'mf-attn';
    wrap.innerHTML =
      '<div class="mf-attn-canvas"><svg viewBox="0 0 840 300" class="mf-svg"></svg></div>' +
      '<div class="mf-attn-bar"><button class="mf-btn mf-step">next layer ▸</button>' +
      '<button class="mf-btn mf-auto">auto</button><span class="mf-attn-state"></span></div>';
    stage.innerHTML = ''; stage.appendChild(wrap);
    var svg = wrap.querySelector('svg'), stateEl = wrap.querySelector('.mf-attn-state');
    var SEG = [
      { label: 'point tokens', count: 'N_p', color: BLUE, w: 300 },
      { label: 'track', count: 'T·N_a', color: '#e0662a', w: 132 },
      { label: 'visual', count: 'N_V', color: PURPLE, w: 118 }
    ];
    function draw() {
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      var isPoint = step % 2 === 0, layer = Math.floor(step / 2) + 1;
      var t = svgEl('text', { x: 20, y: 30, class: 'mf-label', 'text-anchor': 'start' });
      t.textContent = 'queries  X_Q  (one per observed point)'; svg.appendChild(t);
      var qx = 20, qy = 44, qw = 500, qn = 14;
      for (var i = 0; i < qn; i++) {
        svg.appendChild(svgEl('rect', { x: qx + i * (qw / qn), y: qy, width: qw / qn - 4, height: 26, rx: 4,
          fill: GREEN, 'fill-opacity': isPoint ? 0.85 : 0.35, stroke: GREEN, 'stroke-width': 1 }));
      }
      var ky = 210, cx = 20;
      var t2 = svgEl('text', { x: 20, y: 196, class: 'mf-label', 'text-anchor': 'start' });
      t2.textContent = 'memory  X_K = [ X_P | X_A | X_V ]'; svg.appendChild(t2);
      SEG.forEach(function (s) {
        svg.appendChild(svgEl('rect', { x: cx, y: ky, width: s.w, height: 30, rx: 5,
          fill: s.color, 'fill-opacity': isPoint ? 0.18 : 0.8, stroke: s.color, 'stroke-width': 1.4 }));
        var lb = svgEl('text', { x: cx + s.w / 2, y: ky + 20, 'text-anchor': 'middle', class: 'mf-sub' });
        lb.textContent = s.label + ' (' + s.count + ')'; svg.appendChild(lb);
        cx += s.w + 8;
      });
      if (isPoint) {
        for (var j = 0; j < qn - 1; j++) {
          var x1 = qx + j * (qw / qn) + (qw / qn - 4) / 2, x2 = qx + (j + 1) * (qw / qn) + (qw / qn - 4) / 2;
          svg.appendChild(svgEl('path', { d: 'M' + x1 + ',' + qy + ' Q' + (x1 + x2) / 2 + ',' + (qy - 26) + ' ' + x2 + ',' + qy,
            fill: 'none', stroke: BLUE, 'stroke-width': 1.5, opacity: 0.85 }));
        }
      } else {
        for (var k2 = 0; k2 < qn; k2 += 2) {
          var sx = qx + k2 * (qw / qn) + (qw / qn - 4) / 2;
          [70, 340, 470].forEach(function (tx, ti) {
            svg.appendChild(svgEl('path', { d: 'M' + sx + ',' + (qy + 26) + ' C' + sx + ',' + (qy + 90) + ' ' + tx + ',' + (ky - 60) + ' ' + tx + ',' + ky,
              fill: 'none', stroke: [BLUE, '#e0662a', PURPLE][ti], 'stroke-width': 1.1, opacity: 0.5 }));
          });
        }
      }
      svg.appendChild(svgEl('rect', { x: 560, y: 40, width: 258, height: 116, rx: 10,
        fill: isPoint ? BLUE : PURPLE, 'fill-opacity': 0.12, stroke: isPoint ? BLUE : PURPLE, 'stroke-width': 1.6 }));
      var bt = svgEl('text', { x: 689, y: 74, 'text-anchor': 'middle', class: 'mf-label' });
      bt.textContent = isPoint ? 'Point attention' : 'Global attention'; svg.appendChild(bt);
      (isPoint ? ['each point attends within', 'its own trajectory tokens', '→ how one point moves in time']
               : ['points attend into X_K:', 'other points, tracks, vision', '→ interaction + scene context'])
        .forEach(function (ln, i2) {
          var e = svgEl('text', { x: 689, y: 98 + i2 * 18, 'text-anchor': 'middle', class: 'mf-sub' });
          e.textContent = ln; svg.appendChild(e);
        });
      stateEl.textContent = 'layer ' + layer + ' / ' + L + '  ·  ' + (isPoint ? 'point attention' : 'global attention');
      info(isPoint ? 'Point attention' : 'Global attention',
        isPoint ? 'Cheap per-point attention over that point’s own trajectory tokens — never mixes points, so cost stays linear in N<sub>p</sub>.'
                : 'Cross-attention from every query into the memory <b>X<sub>K</sub></b> — where a point learns about its neighbours, the conditioning track, and the image.');
    }
    wrap.querySelector('.mf-step').addEventListener('click', function () { step = (step + 1) % (L * 2); draw(); });
    wrap.querySelector('.mf-auto').addEventListener('click', function (e) {
      if (timer) { clearInterval(timer); timer = null; e.target.textContent = 'auto'; }
      else { e.target.textContent = 'stop'; timer = setInterval(function () { step = (step + 1) % (L * 2); draw(); }, 1400); }
    });
    draw();
  }

  // ---------------------------------------------------------------- concept C
  var demo = null;
  function buildLive() {
    hintEl.textContent = 'drag the slider through the pipeline';
    widgets.length = 0;
    var wrap = document.createElement('div');
    wrap.className = 'mf-live';
    wrap.innerHTML = '<canvas class="mf-canvas" width="900" height="506"></canvas>' +
      '<div class="mf-attn-bar"><input class="mf-scrub" type="range" min="0" max="1000" value="0">' +
      '<span class="mf-attn-state"></span></div>';
    stage.innerHTML = ''; stage.appendChild(wrap);
    var cv = wrap.querySelector('canvas'), ctx = cv.getContext('2d');
    var scrub = wrap.querySelector('.mf-scrub'), stEl = wrap.querySelector('.mf-attn-state');
    var img = new Image();
    var STAGES = [
      ['1 · RGB-D observation', 'A single frame — the only image the model ever sees.'],
      ['2 · Unproject to points', 'Masked depth becomes the observed cloud <b>P<sup>obs</sup></b>.'],
      ['3 · DINOv2 features', 'The image is tokenised into patch features, compressed by Perceiver-IO.'],
      ['4 · Conditioning track', 'One partial trajectory (orange) — the only motion cue given.'],
      ['5 · Noise', 'Every point receives trajectory noise <b>ε<sub>i</sub> ∈ ℝ<sup>3T</sup></b>.'],
      ['6 · Denoised 3D tracks', 'A future trajectory for <b>every</b> point. Real model output.']
    ];
    function drawAt(u) {
      var W = cv.width, H = cv.height;
      ctx.clearRect(0, 0, W, H);
      var si = Math.min(STAGES.length - 1, Math.floor(u * STAGES.length));
      var f = u * STAGES.length - si;
      var pad = 16, aspect = (demo && demo.aspect) || 16 / 9;
      var iw = W - pad * 2, ih = iw / aspect;
      if (ih > H - pad * 2) { ih = H - pad * 2; iw = ih * aspect; }
      var ox = (W - iw) / 2, oy = (H - ih) / 2;
      var px = function (p) { return [ox + p[0] * iw, oy + p[1] * ih]; };
      if (img.complete && img.naturalWidth) {
        ctx.globalAlpha = si === 0 ? 1 : Math.max(0.22, 0.62 - si * 0.08);
        ctx.drawImage(img, ox, oy, iw, ih); ctx.globalAlpha = 1;
      }
      if (si === 2) {
        ctx.strokeStyle = 'rgba(138,99,196,' + (0.3 + 0.45 * Math.sin(f * Math.PI)) + ')';
        ctx.lineWidth = 1;
        for (var gx = 0; gx <= 16; gx++) { ctx.beginPath(); ctx.moveTo(ox + gx / 16 * iw, oy); ctx.lineTo(ox + gx / 16 * iw, oy + ih); ctx.stroke(); }
        for (var gy = 0; gy <= 10; gy++) { ctx.beginPath(); ctx.moveTo(ox, oy + gy / 10 * ih); ctx.lineTo(ox + iw, oy + gy / 10 * ih); ctx.stroke(); }
      }
      if (!demo) return;
      var T = demo.T, tr = demo.tracks, n = demo.n, tEnd = si >= 5 ? f * (T - 1) : 0;
      for (var i = 0; i < n; i++) {
        var base = tr[0][i], p = base;
        if (si >= 5) {
          var i0 = Math.floor(tEnd), i1 = Math.min(T - 1, i0 + 1), a = tEnd - i0;
          p = [tr[i0][i][0] + (tr[i1][i][0] - tr[i0][i][0]) * a, tr[i0][i][1] + (tr[i1][i][1] - tr[i0][i][1]) * a];
        } else if (si === 4) {
          p = [base[0] + Math.sin(i * 12.9 + f * 40) * 0.012 * f, base[1] + Math.cos(i * 78.2 + f * 40) * 0.012 * f];
        }
        var q = px(p), dd = demo.depth[i];
        ctx.fillStyle = si >= 5 ? 'rgba(' + Math.round(224 - dd * 60) + ',' + Math.round(102 + dd * 60) + ',42,0.92)'
                                : 'rgba(' + Math.round(90 + dd * 60) + ',' + Math.round(140 + dd * 50) + ',200,0.85)';
        if (si === 1 && i / n > f) continue;
        ctx.beginPath(); ctx.arc(q[0], q[1], si >= 5 ? 2.1 : 1.8, 0, 6.283); ctx.fill();
      }
      if (si >= 3) {
        ctx.strokeStyle = '#e0662a'; ctx.lineWidth = 3.2; ctx.lineCap = 'round';
        var lim = si === 3 ? Math.max(1, Math.floor(f * (T - 1))) : T - 1;
        ctx.beginPath();
        for (var t2 = 0; t2 <= lim; t2++) { var c = px(demo.cond[t2][0]); if (t2 === 0) ctx.moveTo(c[0], c[1]); else ctx.lineTo(c[0], c[1]); }
        ctx.stroke();
        var head = px(demo.cond[lim][0]);
        ctx.fillStyle = '#e0662a'; ctx.beginPath(); ctx.arc(head[0], head[1], 7, 0, 6.283); ctx.fill();
      }
      stEl.textContent = STAGES[si][0];
      info(STAGES[si][0], STAGES[si][1]);
    }
    var u = 0, raf = null, dragging = false;
    scrub.addEventListener('input', function () { dragging = true; u = scrub.value / 1000; drawAt(u); });
    function lp() { raf = requestAnimationFrame(lp); if (!dragging) { u = (u + 0.0016) % 1; scrub.value = Math.round(u * 1000); drawAt(u); } }
    fetch(BASE + 'method_demo.json?v=' + Date.now()).then(function (r) { return r.json(); }).then(function (d) {
      demo = d; img.onload = function () { drawAt(0); if (!raf) lp(); }; img.src = BASE + d.rgb;
    });
  }

  var BUILD = { schematic: buildSchematic, attention: buildAttention, live: buildLive };

  var mfp = new URLSearchParams(location.search).get('mf');
  buildSchematic();
})();

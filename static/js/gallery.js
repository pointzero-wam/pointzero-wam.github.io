/* 4D dataset gallery: looping clips from the synthetic training set.
   Clips are real dataset episodes. */
(function () {
  var DSV = '?v=3';   // bump when clips are re-encoded
  'use strict';
  var root = document.getElementById('dataset-gallery');
  if (!root) return;
  root.innerHTML =
    '<div class="dg-grid"></div>' +
    '<p class="dg-note">Sixteen episodes sampled from the 2.9 M-frame synthetic set &mdash; each clip is a real training sequence, looped. ' +
    'Every frame also carries dense 3D point tracks; those are what the model is trained to complete.</p>';
  var grid = root.querySelector('.dg-grid');

  fetch('static/dataset/manifest.json?v=' + Date.now()).then(function (r) { return r.json(); })
    .then(function (m) {
      m.clips.forEach(function (c) {
        var d = document.createElement('figure');
        d.className = 'dg-item';
        d.dataset.cat = c.category;
        d.innerHTML =
          '<video muted loop playsinline preload="none" poster="static/dataset/' + c.poster + DSV + '">' +
          '<source src="static/dataset/' + c.file + DSV + '" type="video/mp4"></video>' +
          '<figcaption>' + c.category + '</figcaption>';
        grid.appendChild(d);
      });
      var vids = grid.querySelectorAll('video');
      // only play what is on screen
      if ('IntersectionObserver' in window) {
        var io = new IntersectionObserver(function (es) {
          es.forEach(function (e) {
            var v = e.target;
            if (e.isIntersecting) { v.play().catch(function () {}); }
            else { v.pause(); }
          });
        }, { rootMargin: '120px' });
        vids.forEach(function (v) { io.observe(v); });
      } else {
        vids.forEach(function (v) { v.play().catch(function () {}); });
      }
    });

})();

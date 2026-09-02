# PointZero — project page

Source for the PointZero project page: **https://pointzero-wam.github.io**

*PointZero: 3D Point Track Completion for Learning Transferable 3D Dynamics*

Static site — no build step. Open `index.html`, or serve the directory:

```bash
python3 -m http.server 8000
```

- `index.html` — the page
- `static/js/hero.js` — interactive 3D point-cloud viewers (vendored three.js)
- `static/js/method.js` — interactive method figure
- `static/js/charts.js` — interactive result charts
- `static/js/gallery.js` — 4D dataset gallery
- `static/hero_data/` — quantised point-cloud/track data for the viewers

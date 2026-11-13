// theme.js — the accent colour of every Chamber page: five ready-made colours, RGB, or the visitor's own.
// ONE copy of the logic (2026-11-13). The app (index.html), the front/account page (landing.html) and the help pages
// load this file and call ChamberTheme.init() once, after their picker markup if they have one:
//   <div id="theme-picker">  buttons .swatch[data-accent="#rrggbb"] and one .swatch[data-accent="rgb"]  </div>
//   <label id="accent-custom-wrap"><input type="color" id="accent-custom"> Custom colour</label>
//   <button id="accent-reset">, <div id="accent-name">
// A page without that markup (help) just shows the colour that was picked elsewhere.
// The pick is kept per browser in localStorage.chamber_accent (a hex colour, or the word "rgb") and sets the ONE CSS
// variable --accent-pick; each page derives the rest of its palette from it (the light theme darkens it for text).
//
// SPDX-License-Identifier: AGPL-3.0-only  |  Copyright (C) 2026 GhostPort Technologies
(function () {
  'use strict';
  const THEME_KEY = 'chamber_accent', HEX_RE = /^#[0-9a-f]{6}$/i, RGB = 'rgb';
  const root = document.documentElement;
  const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };   // storage can be switched off (private windows); the page must still work
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const lsDel = k => { try { localStorage.removeItem(k); } catch {} };
  let followServer = false;                                           // only the app asks the server for a workspace default (/api/theme needs a login)

  function applyAccent(hex) {
    root.style.setProperty('--accent-pick', hex);                     // one variable -> the whole palette follows
    const custom = document.getElementById('accent-custom');
    if (custom) custom.value = hex;                                   // keep the colour chooser showing the live value
    mark();
  }
  function setAccent(hex) {                                           // the person's pick: remember it and let it win over the server
    if (!HEX_RE.test(hex)) return;
    stopRgb(); applyAccent(hex); lsSet(THEME_KEY, hex);
  }
  function resetAccent() {                                            // drop the pick -> the standard colour again (or the server's, in the app)
    stopRgb(); lsDel(THEME_KEY);
    root.style.removeProperty('--accent-pick'); mark();
    if (followServer) syncTheme();
  }
  async function syncTheme() {                                        // the server's default accent, never over a local pick
    if (lsGet(THEME_KEY)) return;
    try {
      const r = await fetch('/api/theme');
      if (!r.ok) return;
      const { accent } = await r.json();
      if (accent && HEX_RE.test(accent) && !lsGet(THEME_KEY)) applyAccent(accent);
    } catch {}
  }

  // ── RGB: GhostPort's signature accent (the rainbow swatch of the blog's colour picker, /_shared/toggles.js) ──
  // The accent travels round the colour wheel, one lap in about 24 seconds, with a slow "breath" in brightness, at the
  // same speeds as on the blog. Two things differ here because Chamber is an app people read in all day:
  //   * every colour on the way is kept readable. Names and links are drawn in the accent, so blue and violet are lifted
  //     a little on the dark themes and yellow and green are deepened a little on the light theme (rgbColor below);
  //   * it is gentle on the device: ten small steps a second instead of every frame, nothing while the tab is hidden,
  //     and for people whose device asks for less motion it changes colour in one quiet step every 30 seconds instead.
  const RGB_STEP_MS = 100, RGB_DEG_PER_MS = 0.015, RGB_BREATH_PER_MS = 0.002;
  let rgbOn = false, rgbRAF = 0, rgbTimer = 0, rgbLast = 0, rgbHue = 140, rgbPhase = 0, rgbLight = false, rgbLightAt = -1e9;
  function hsl2hex(h, s, l) { h = ((h % 360) + 360) % 360; s /= 100; l /= 100; const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l), f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)))); return '#' + [f(0), f(8), f(4)].map(v => v.toString(16).padStart(2, '0')).join(''); }
  function hexLum(hex) { const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }   // how bright a colour looks, 0 to 1
  function hexHue(hex) { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255), max = Math.max(r, g, b), d = max - Math.min(r, g, b); if (!d) return 140; return (((max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60) + 360) % 360; }
  function halfBlack(hex) { return '#' + [1, 3, 5].map(i => Math.round(parseInt(hex.slice(i, i + 2), 16) / 2).toString(16).padStart(2, '0')).join(''); }   // what the light theme draws: the pick mixed half with black
  function rgbColor(hue, bri, light) {                                // the wheel colour at this hue, nudged until it reads well on the theme in use
    let l = 60 * bri, hex = hsl2hex(hue, 100, l);
    if (light) while (l > 20 && hexLum(halfBlack(hex)) > 0.16) hex = hsl2hex(hue, 100, l -= 2);   // light theme: at least as dark as the standard green is there
    else while (l < 90 && hexLum(hex) < 0.25) hex = hsl2hex(hue, 100, l += 2);                     // dark themes: 4.5 to 1 or better against every panel colour
    return hex;
  }
  function rgbPaint(ts) {
    if (ts - rgbLightAt > 1000) { rgbLightAt = ts; const bg = getComputedStyle(root).getPropertyValue('--bg').trim(); rgbLight = HEX_RE.test(bg) && hexLum(bg) > 0.4; }   // also catches the device switching between light and dark ("System" theme)
    root.style.setProperty('--accent-pick', rgbColor(rgbHue, 0.92 + ((Math.sin(rgbPhase) + 1) / 2) * 0.08, rgbLight));
  }
  function rgbFrame(ts) {
    if (!rgbOn) return;
    rgbRAF = requestAnimationFrame(rgbFrame);
    const dt = ts - rgbLast; if (dt < RGB_STEP_MS) return;
    rgbLast = ts; const d = Math.min(dt, 500);                        // after a pause (hidden tab) it carries on from where it was, no jump
    rgbHue = (rgbHue + RGB_DEG_PER_MS * d) % 360; rgbPhase += RGB_BREATH_PER_MS * d; rgbPaint(ts);
  }
  function startRgb() {
    if (rgbOn) return; rgbOn = true;
    const cur = (getComputedStyle(root).getPropertyValue('--accent-pick') || '').trim();
    if (HEX_RE.test(cur)) rgbHue = hexHue(cur);                       // set off from the colour that is on screen now
    rgbPhase = Math.PI / 2; rgbLast = performance.now(); rgbLightAt = -1e9; rgbPaint(rgbLast);
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) rgbTimer = setInterval(() => { rgbHue = (rgbHue + 30) % 360; rgbPaint(performance.now()); }, 30000);
    else rgbRAF = requestAnimationFrame(rgbFrame);
    mark();
  }
  function stopRgb() { if (!rgbOn) return; rgbOn = false; cancelAnimationFrame(rgbRAF); clearInterval(rgbTimer); }
  function setRgb() { lsSet(THEME_KEY, RGB); startRgb(); }
  // A theme switch (Dark / Light / ...) changes which colours are readable: repaint at once instead of on the next step.
  try { new MutationObserver(() => { if (rgbOn) { rgbLightAt = -1e9; rgbPaint(performance.now()); } }).observe(root, { attributes: true, attributeFilter: ['data-theme'] }); } catch {}

  function mark() {                                                   // which accent is in use: a ring on its swatch (or on "Custom colour") and its name in words under the row
    const cur = (getComputedStyle(root).getPropertyValue('--accent-pick') || '').trim().toLowerCase(); let name = '';
    document.querySelectorAll('#theme-picker .swatch').forEach(b => { const on = rgbOn ? b.dataset.accent === RGB : b.dataset.accent.toLowerCase() === cur; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); if (on) name = b.title; });
    const own = !name && !!lsGet(THEME_KEY), wrap = document.getElementById('accent-custom-wrap'), label = document.getElementById('accent-name');
    if (wrap) wrap.classList.toggle('on', own);
    if (label) label.textContent = name || (own ? `Custom colour ${cur}` : 'Standard colour');
  }
  function applySaved(fresh) {                                        // show what is stored; fresh = a pick made in another tab just now
    const saved = lsGet(THEME_KEY);
    if (saved === RGB) return startRgb();
    stopRgb();
    if (saved && HEX_RE.test(saved)) return applyAccent(saved);
    if (fresh) { root.style.removeProperty('--accent-pick'); if (followServer) syncTheme(); }
    mark();
  }
  function init(opts) {
    followServer = !!(opts && opts.server);
    applySaved(false);
    document.querySelectorAll('#theme-picker .swatch').forEach(b => b.addEventListener('click', () => b.dataset.accent === RGB ? setRgb() : setAccent(b.dataset.accent)));
    const custom = document.getElementById('accent-custom'); if (custom) custom.addEventListener('input', e => setAccent(e.target.value));
    const reset = document.getElementById('accent-reset'); if (reset) reset.addEventListener('click', resetAccent);
    window.addEventListener('storage', e => { if (e.key === THEME_KEY) applySaved(true); });   // picked in another tab (the app, the account page): follow it here too
    if (followServer) { syncTheme(); setInterval(syncTheme, 30000); }
  }
  // A row of choice buttons (#boxId button[data-<kind>]) that sets <html data-<kind>> and remembers it, e.g. the theme
  // (Dark / Light / System / Contrast). The app has its own, older copy of this for its longer list of preferences.
  function wirePref(kind, key, def, boxId) {
    const btns = () => document.querySelectorAll('#' + boxId + ' button');
    const show = v => btns().forEach(b => { const on = b.dataset[kind] === v; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
    btns().forEach(b => b.addEventListener('click', () => { const v = b.dataset[kind] || def; root.dataset[kind] = v; lsSet(key, v); show(v); }));
    window.addEventListener('storage', e => { if (e.key === key) { const v = lsGet(key) || def; root.dataset[kind] = v; show(v); } });
    show(root.dataset[kind] || lsGet(key) || def);
  }
  window.ChamberTheme = { init, mark, setAccent, setRgb, reset: resetAccent, wirePref, rgbColor, hexLum, halfBlack };
})();

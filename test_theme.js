#!/usr/bin/env node
// test_theme.js — T-0073: the design tokens of every theme must read well (WCAG AA) and every page must carry the same theme blocks.
// Run: node test_theme.js   (exit 0 = all green). test_isolation.js requires this file and folds the result into its count.
'use strict';
const fs = require('fs'), path = require('path');
function lum(hex) { const c = hex.replace('#', ''); const [r, g, b] = [0, 2, 4].map(i => parseInt(c.length === 3 ? c[i / 2] + c[i / 2] : c.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }
function contrast(a, b) { const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); }
function mix(a, b, pct) { const c = h => [1, 3, 5].map(i => parseInt(h.replace('#', '').slice(i - 1, i + 1), 16)); const [x, y] = [c(a), c(b)]; return '#' + x.map((v, i) => Math.round(v * pct + y[i] * (1 - pct)).toString(16).padStart(2, '0')).join(''); }
function tokens(block) { const out = {}; for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,6})/g)) out[m[1]] = m[2]; return out; }
function run(quiet) {
  let pass = 0, fail = 0;
  const check = (name, ok, detail = '') => { if (ok) { pass++; if (!quiet) console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${detail}`); } };
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const rootBlock = html.slice(html.indexOf(':root {'), html.indexOf('\n  }\n', html.indexOf(':root {')));
  const lightBlock = (html.match(/:root\[data-theme=light\] \{([^}]*)\}/) || [])[1] || '';
  const contrastBlock = (html.match(/:root\[data-theme=contrast\] \{([^}]*)\}/) || [])[1] || '';
  const dark = tokens(rootBlock); dark.accent = dark.accent || dark['accent-pick'];                   // --accent is var(--accent-pick) in the dark theme
  const light = { ...dark, ...tokens(lightBlock) }, hc = { ...dark, ...tokens(contrastBlock) };
  light.accent = mix(dark['accent-pick'], '#000000', 0.5);                                   // color-mix(in srgb, pick 50%, #000)
  const pairs = [['text', 'bg', 7], ['text', 'surface', 7], ['text-dim', 'surface', 4.5], ['text-dim', 'bg', 4.5], ['text-faint', 'surface', 3], ['accent', 'bg', 4.5], ['accent', 'surface', 4.5], ['human', 'surface', 4.5], ['danger', 'surface', 4.5], ['info', 'surface', 4.5], ['warn', 'surface', 3], ['diff-add-fg', 'surface', 3], ['diff-del-fg', 'surface', 3], ['tok-str', 'surface', 3], ['accent-ink', 'accent', 4.5]];
  for (const [name, th] of [['dark', dark], ['light', light], ['contrast', hc]]) {
    check(`${name} theme defines its tokens`, th.bg && th.surface && th.text && th['text-dim'] && th['text-faint'] && th.accent);
    for (const [fg, bg, min] of pairs) { if (!th[fg] || !th[bg]) { check(`${name}: ${fg} on ${bg} is defined`, false); continue; } const c = contrast(th[fg], th[bg]); check(`${name}: ${fg} on ${bg} ≥ ${min}:1 (${c.toFixed(2)})`, c >= min); }
  }
  for (const f of ['landing.html', 'help.html', 'api.html']) {
    const t = fs.readFileSync(path.join(__dirname, 'public', f), 'utf8');
    check(`${f} carries the same light theme block and the pre-paint theme script`, t.includes(lightBlock) && t.includes("l.getItem('chamber-theme')"));
    check(`${f}: grey text follows the theme (--dim and --faint come from --text-dim and --text-faint)`, /--text-dim:\s*#8d978f/.test(t) && /--dim:\s*var\(--text-dim\)/.test(t) && /--faint:\s*var\(--text-faint\)/.test(t));
    check(`${f} loads the shared colour script and starts it`, t.includes('<script src="/theme.js"></script>') && t.includes('ChamberTheme.init('));
  }
  { const tj = fs.readFileSync(path.join(__dirname, 'public', 'theme.js'), 'utf8'); let parses = true; try { new (require('vm').Script)(tj); } catch { parses = false; }
    check('the shared colour script parses, and the app loads it instead of carrying its own copy', parses && html.includes('<script src="/theme.js"></script>') && html.includes('ChamberTheme?.init(') && !/function rgbColor|const THEME_KEY/.test(html)); }
  check('the app sets the theme before first paint', html.indexOf("l.getItem('chamber-theme')") < html.indexOf('<style>'));
  check('no hard-coded diff or string colours remain outside the tokens', !/#7ee787|#ffa198|#79c0ff|#e0a060/.test(html.replace(rootBlock, '')));
  return { pass, fail };
}
if (require.main === module) { const res = run(false); console.log(`\n${res.pass} passed, ${res.fail} failed`); process.exit(res.fail ? 1 : 0); }
module.exports = { run };

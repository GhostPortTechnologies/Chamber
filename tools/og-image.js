// tools/og-image.js: draws public/og.png, the link-preview picture (1200x630) shown when the front page is shared.
// It carries the front page headline, so redraw it whenever the headline changes:
//   NODE_PATH=<folder with playwright-core> PLAYWRIGHT_BROWSERS_PATH=<its browsers> node tools/og-image.js public/og.png
// (on the hosted server the browser check has both, under /opt/chamber-browsercheck). Uses the Noto Sans font.
// SPDX-License-Identifier: AGPL-3.0-only  |  Copyright (C) 2026 GhostPort Technologies
const { chromium } = require('playwright-core');
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:1200px;height:630px;background:#0a0c0b;color:#d8ded9;font-family:"Noto Sans",sans-serif;overflow:hidden}
.w{padding:54px 70px}
.b{font-weight:800;font-size:32px;letter-spacing:.02em;color:#00ff88}.b small{color:#8d978f;font-weight:400;font-size:21px;margin-left:10px;letter-spacing:0}
h1{font-size:56px;line-height:1.16;margin:34px 0 0;font-weight:700;letter-spacing:-.005em}h1 em{color:#00ff88;font-style:normal}
p{color:#8d978f;font-size:26px;line-height:1.4;margin:22px 0 0}
.s{position:absolute;left:70px;right:70px;bottom:44px;border:1px solid #303934;background:#101412;border-radius:10px;padding:14px 20px;font-size:22px;color:#d8ded9;white-space:pre}
</style></head><body><div class="w"><div class="b">CHAMBER<small>by GhostPort</small></div>
<h1>Your developers move at AI speed.<br><em>Your business keeps the approvals<br>and the record.</em></h1>
<p>Vet, log and review the work your AI agents do, as a team or on your own.</p></div>
<div class="s">T-0231    proposed by an agent   -&gt;   approved by you   -&gt;   done, with a run log</div></body></html>`;
(async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1200, height: 630 } });
  await p.setContent(html, { waitUntil: 'networkidle' }); await p.screenshot({ path: process.argv[2] || 'og.png', clip: { x: 0, y: 0, width: 1200, height: 630 } }); await b.close(); console.log('drawn'); })()
  .catch(e => { console.log('FAILED', e.message.split('\n')[0]); process.exit(1); });

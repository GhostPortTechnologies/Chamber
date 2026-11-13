// tools/browser-check.js (T-0173): open the real pages in a real browser before a release.
//   node browser-check.js <base-url> <server-log> <output-dir>
// Run by /opt/chamber-browsercheck/run.sh (from chamber-deploy) against a private copy of the staged app that has
// CHAMBER_TEST_HOOKS=1 and the free trial on. Never pointed at the live site: it signs up accounts and posts messages.
// Why it exists: on 2026-11-12 a stray `else` in landing.html blanked the front page, log in and sign up for 45 minutes
// while every server-side test passed. A server answering 200 is not a page a person can use.
// At phone size and desktop size it: loads each public page (not blank, no script error, nothing wider than the screen),
// signs up through the form, confirms the email with the link from the server log, enters the app, sends a message,
// opens every tab, proposes a ticket, reaches Sign out in the gear menu, and logs back in through the form.
// playwright-core lives outside the app (/opt/chamber-browsercheck); Chamber itself stays dependency-free.
// SPDX-License-Identifier: AGPL-3.0-only  |  Copyright (C) 2026 GhostPort Technologies
'use strict';
const { chromium } = require('playwright-core'); const fs = require('fs'), path = require('path');
const [BASE, LOG, OUT] = process.argv.slice(2);
if (!BASE || !LOG || !OUT) { console.error('usage: browser-check.js <base-url> <server-log> <output-dir>'); process.exit(2); }
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(BASE)) { console.error('refusing: this check only runs against a private copy on 127.0.0.1'); process.exit(2); }
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + String(detail).slice(0, 300) : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SIZES = {
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  desktop: { viewport: { width: 1280, height: 800 } },
};
const PUBLIC = [   // [path, text that must be on screen, selectors that must be visible]
  ['/', /Start free trial/, ['h1', 'a[href="/signup"]', '#ct-email']],
  ['/login', /Log in/, ['#li-email', '#li-pass', 'button[type=submit]:visible']],
  ['/signup', /Create account/i, ['#su-email', '#su-user', '#su-pass', 'button[type=submit]:visible']],
  ['/forgot', /./, ['input:visible']],
  ['/demo', /./, ['#play']],
  ['/help', /./, []], ['/help/api', /./, []], ['/terms', /Free trial/, []], ['/privacy', /./, []], ['/refunds', /Free trial/, []],
];

async function run(size) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext(SIZES[size]); const page = await ctx.newPage(); page.setDefaultTimeout(12000);
  let errs = [];
  page.on('pageerror', e => errs.push('script error: ' + e.message));
  page.on('response', r => { const u = new URL(r.url()); let at = ''; try { at = new URL(page.url()).pathname; } catch {}
    const expected = r.status() === 401 && (u.pathname === '/account/me' || at !== '/app');   // logged-out pages ask who you are; the account page of a not-yet-confirmed person asks for rooms
    if (r.status() >= 400 && u.origin === BASE && !expected) errs.push(`${r.status()} ${u.pathname}`); });
  const clean = (what) => { const e = errs; errs = []; check(`${size}: ${what}: no script errors, nothing failed to load`, e.length === 0, e.join(' | ')); };
  const shot = async name => { try { await page.screenshot({ path: path.join(OUT, `${size}-${name}.png`) }); } catch {} };
  const step = async (name, fn) => { try { await fn(); } catch (e) { check(`${size}: ${name}`, false, e.message.split('\n')[0]); await shot('FAILED-' + name.replace(/\W+/g, '-').slice(0, 40)); return false; } return true; };

  for (const [p, must, sels] of PUBLIC) {
    await step(`${p} opens`, async () => {
      await page.goto(BASE + p, { waitUntil: 'networkidle' });
      const info = await page.evaluate(() => ({ text: document.body.innerText, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      check(`${size}: ${p} is not blank and says what it should`, info.text.trim().length > 150 && must.test(info.text), `${info.text.trim().length} characters on screen`);
      check(`${size}: ${p} fits the screen (no sideways scrolling)`, info.sw <= info.cw + 1, `page is ${info.sw}px wide on a ${info.cw}px screen`);
      for (const s of sels) check(`${size}: ${p} shows ${s}`, await page.locator(s).first().isVisible());
    });
    if (p === '/') { try { await page.screenshot({ path: path.join(OUT, `${size}-front.png`), fullPage: true }); } catch {} }   // T-0179: keep a picture of the whole front page from every release
    if (p === '/demo') await step('demo plays', async () => { await page.click('#play'); await sleep(1500); });
    clean(p);
  }

  await step('front page settings wheel', async () => {                                           // 2026-11-13: colours (RGB included) and theme on the front, account and help pages, same controls as in the app
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    const pick = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent-pick').trim());
    await page.click('#gear-btn'); await page.locator('#menu.open').waitFor();
    const box = await page.evaluate(() => { const m = document.getElementById('menu').getBoundingClientRect(), h = document.querySelector('header').getBoundingClientRect(), sw = [...document.querySelectorAll('#theme-picker .swatch')].map(e => e.getBoundingClientRect());
      return { l: Math.round(m.left), r: Math.round(m.right), b: Math.round(m.bottom), vw: innerWidth, vh: innerHeight, header: Math.round(h.height), dots: sw.length, oneRow: sw.every(r => Math.abs((r.top + r.bottom) - (sw[0].top + sw[0].bottom)) < 2), custom: document.getElementById('accent-custom-wrap').innerText.trim(), icon: Math.round(document.querySelector('#gear-btn svg')?.getBoundingClientRect().width || 0), page: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 }; });
    check(`${size}: the front page has a settings wheel; its menu opens inside the screen with the six colours in one row and a labelled custom colour`, box.l >= 0 && box.r <= box.vw && box.b <= box.vh && box.dots === 6 && box.oneRow && /custom colour/i.test(box.custom) && box.icon >= 14 && box.page, JSON.stringify(box));
    check(`${size}: the wheel does not make the top bar taller`, box.header <= (size === 'phone' ? 100 : 56), `top bar is ${box.header}px high`);
    await page.click('#accent-rgb'); const a1 = await pick(); await sleep(700); const a2 = await pick(); await shot('front-wheel');
    check(`${size}: RGB works on the front page`, a1 !== a2 && /^#[0-9a-f]{6}$/.test(a2) && (await page.evaluate(() => localStorage.getItem('chamber_accent'))) === 'rgb' && /RGB/.test(await page.locator('#accent-name').textContent()), JSON.stringify({ a1, a2 }));
    await page.click('#theme-mode button[data-theme=light]'); await sleep(400);
    const lt = await page.evaluate(() => { const lum = c => { const m = c.match(/[\d.]+/g).map(Number).slice(0, 3).map(v => v / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]; };
      const con = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return Math.round((x + 0.05) / (y + 0.05) * 100) / 100; }, bg = getComputedStyle(document.body).backgroundColor, col = sel => getComputedStyle(document.querySelector(sel)).color;
      return { theme: document.documentElement.dataset.theme, saved: localStorage.getItem('chamber-theme'), on: document.querySelector('#theme-mode button[data-theme=light]').classList.contains('on'), greyLink: con(col('nav a:not(.btn)'), bg), greyText: con(col('.hero-fit'), bg), name: con(col('.brand'), bg), text: con(getComputedStyle(document.body).color, bg) }; });
    await shot('front-light'); try { await page.screenshot({ path: path.join(OUT, `${size}-front-light-full.png`), fullPage: true }); } catch {}
    check(`${size}: Light on the front page is remembered and keeps normal text, grey text and the RGB name readable`, lt.theme === 'light' && lt.saved === 'light' && lt.on && lt.text >= 7 && lt.greyLink >= 4.5 && lt.greyText >= 4.5 && lt.name >= 4, JSON.stringify(lt));
    await page.goto(BASE + '/help', { waitUntil: 'networkidle' }); const h1 = await pick(); await sleep(700); const h2 = await pick();
    const hp = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor })); await shot('help-light');
    check(`${size}: the help page follows: RGB keeps moving there and the Light theme carries over`, h1 !== h2 && hp.theme === 'light' && hp.bg !== 'rgb(10, 12, 11)', JSON.stringify({ h1, h2, hp }));
    await page.goto(BASE + '/', { waitUntil: 'networkidle' }); await page.click('#gear-btn'); await page.click('#theme-mode button[data-theme=dark]'); await page.click('#accent-reset'); await sleep(200);
    const back = await page.evaluate(() => ({ key: localStorage.getItem('chamber_accent'), theme: document.documentElement.dataset.theme, name: document.getElementById('accent-name').textContent, pick: getComputedStyle(document.documentElement).getPropertyValue('--accent-pick').trim() }));
    await page.keyboard.press('Escape'); const closed = !(await page.locator('#menu').isVisible());
    check(`${size}: Dark and Reset put the front page back, and Escape closes the menu`, back.key === null && back.theme === 'dark' && back.name === 'Spring' && back.pick === '#00ff88' && closed, JSON.stringify({ back, closed }));
  });
  clean('front page settings wheel');

  const user = `bc${size.slice(0, 1)}${Date.now().toString(36)}`, email = `${user}@test.invalid`, pw = 'browser-check-password';
  let inApp = false;
  await step('sign up through the form', async () => {
    await page.goto(BASE + '/signup', { waitUntil: 'networkidle' });
    await page.fill('#su-email', email); await page.fill('#su-user', user); await page.fill('#su-pass', pw);
    await page.click('button[type=submit]:visible');
    await page.waitForFunction(() => /confirm/i.test(document.body.innerText) && !document.querySelector('#su-email')?.offsetParent, null, { timeout: 12000 });
    check(`${size}: after sign-up the page asks to confirm the email`, true); await shot('after-signup');
    let link = null; for (let i = 0; i < 40 && !link; i++) { link = (fs.readFileSync(LOG, 'utf8').match(new RegExp(`verify link for ${user}: (\\S+)`)) || [])[1]; if (!link) await sleep(150); }
    if (!link) throw new Error('no confirm link in the server log');
    await page.goto(link, { waitUntil: 'networkidle' });
    await page.locator('a[href="/app"]').first().waitFor({ state: 'visible' });
    check(`${size}: the confirm link leads to a page with an Open Chamber button`, /verified=1/.test(page.url())); await shot('after-confirm');
    await page.locator('a[href="/app"]').first().click();
    await page.waitForSelector('#msg-input:not([disabled])');
    check(`${size}: Open Chamber lands in the app with the message box ready`, new URL(page.url()).pathname === '/app'); inApp = true; await shot('app');
    check(`${size}: a new owner sees one getting-started checklist, not two`, await page.locator('#start-card').isVisible() && !(await page.locator('#onboard').isVisible()));
    await step('hide the checklist', async () => { await page.getByRole('button', { name: 'Hide getting started' }).click(); await sleep(300); check(`${size}: hiding the checklist does not bring back the old one`, !(await page.locator('#onboard').isVisible()) && !(await page.locator('#start-card').isVisible())); });
  });
  clean('sign-up to app');

  if (inApp) {
    const hello = `hello from the browser check ${user}`;
    await step('send a message', async () => {
      await page.fill('#msg-input', hello); await page.click('#send-btn');
      await page.locator('#messages', { hasText: hello }).waitFor(); check(`${size}: a message typed in the box shows up in the room`, true);
    });
    await step('a file name with a quote mark is only a name', async () => {                      // 2026-11-13: such a name used to run as code when the picture was clicked
      const name = "x');window.__pwn=1;('.png";
      const posted = await page.evaluate(async (name) => {
        const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
        const up = await fetch('/api/files?room=general', { method: 'POST', headers: { 'Content-Type': 'image/png', 'X-File-Name': encodeURIComponent(name) }, body: png });
        const f = (await up.json()).file || {};
        const r = await fetch('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'a picture with a quote mark in its name', attachments: [f.id] }) });
        return { up: up.status, post: r.status, name: f.name };
      }, name);
      const tile = page.locator('#messages .att-img').last(); await tile.waitFor(); await tile.click(); await sleep(300);
      const seen = await page.evaluate(() => ({ pwn: window.__pwn, open: document.getElementById('lightbox').classList.contains('show'), shown: document.getElementById('lb-name').textContent }));
      check(`${size}: a picture whose name contains a quote mark opens as a picture and runs nothing`, posted.up === 201 && posted.post === 201 && posted.name === name && seen.pwn === undefined && seen.open && seen.shown === name, JSON.stringify(posted) + ' ' + JSON.stringify(seen));
      await page.keyboard.press('Escape'); await sleep(200);
    });
    await step('a text file opens as a preview, it does not download', async () => {             // 2026-11-13: a tap used to download it at once
      const body = 'first line of the notes\nsecond line <b>not bold</b>';
      const posted = await page.evaluate(async (body) => {
        const up = await fetch('/api/files?room=general', { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-File-Name': 'notes.txt' }, body });
        const f = (await up.json()).file || {};
        const r = await fetch('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'a text file', attachments: [f.id] }) });
        return { up: up.status, post: r.status };
      }, body);
      let downloads = 0; const onDl = () => { downloads++; }; page.on('download', onDl);
      const chip = page.locator('#messages .att-file', { hasText: 'notes.txt' }).last(); await chip.waitFor(); await chip.click();
      await page.locator('#lb-text', { hasText: 'second line' }).waitFor({ timeout: 8000 });
      const seen = await page.evaluate(() => ({ text: document.getElementById('lb-text').textContent, bold: document.querySelectorAll('#lb-text b').length, open: document.getElementById('lightbox').classList.contains('show') }));
      await sleep(400); page.off('download', onDl);
      check(`${size}: tapping a text file shows its text and downloads nothing`, posted.up === 201 && posted.post === 201 && seen.open && seen.text === body && seen.bold === 0 && downloads === 0, JSON.stringify(posted) + ' downloads=' + downloads + ' ' + JSON.stringify(seen).slice(0, 200));
      await shot('text-preview'); await page.keyboard.press('Escape'); await sleep(200);
    });
    await step('files tab with many files', async () => {                                        // 2026-11-13: with many files every tile was squashed and its name cut off
      const made = await page.evaluate(async () => {
        let n = 0;
        for (let g = 0; g < 3; g++) { const ids = [];
          for (let i = 0; i < 5; i++) { const up = await fetch('/api/files?room=general', { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-File-Name': `many-${g}-${i}.txt` }, body: `file ${g}-${i}` }); ids.push(((await up.json()).file || {}).id); }
          const r = await fetch('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'many files ' + g, attachments: ids }) }); if (r.status === 201) n += 5; }
        return n;
      });
      await page.click('.tab[data-view="files"]'); await page.waitForSelector('#files-view.active', { state: 'visible' }); await page.locator('.fcard .fname', { hasText: 'many-2-4.txt' }).first().waitFor();
      const m = await page.evaluate(() => { const cards = [...document.querySelectorAll('#files-grid .fcard')]; return { cards: cards.length, minH: Math.min(...cards.map(c => c.getBoundingClientRect().height)), cut: cards.filter(c => { const b = c.querySelector('.facts'); return !b || b.getBoundingClientRect().bottom > c.getBoundingClientRect().bottom + 1; }).length }; });
      await shot('files-many');
      check(`${size}: with many files every tile is full height and shows its name and links`, made === 15 && m.cards >= 15 && m.minH >= 150 && m.cut === 0, JSON.stringify(m));
      let downloads = 0; const onDl = () => { downloads++; }; page.on('download', onDl);
      await page.locator('.fcard', { hasText: 'many-2-4.txt' }).first().locator('.thumb').click(); await page.locator('#lb-text', { hasText: 'file 2-4' }).waitFor({ timeout: 8000 }); await sleep(300); page.off('download', onDl);
      check(`${size}: tapping a tile in the Files tab opens the preview and downloads nothing`, downloads === 0);
      await page.keyboard.press('Escape'); await sleep(200); await page.click('.tab[data-view="chat"]'); await sleep(200);
    });
    for (const v of ['tickets', 'reviews', 'files', 'activity', 'code', 'chat']) await step(`${v} tab`, async () => {
      await page.click(`.tab[data-view="${v}"]`); await page.waitForSelector(`#${v}-view.active`, { state: 'visible' });
      const box = await page.locator(`#${v}-view`).boundingBox(); check(`${size}: the ${v} tab opens`, !!box && box.height > 100, JSON.stringify(box)); await sleep(250);
    });
    await step('propose a ticket', async () => {
      await page.click('.tab[data-view="tickets"]'); await page.getByText('+ Propose ticket').click();
      await page.fill('#prop-title', 'Browser check ticket'); await page.fill('#prop-body', 'Made by the pre-release browser check.');
      await page.locator('input[name="prop-for"]').first().check(); await page.click('#prop-submit');
      const card = page.locator('.ticket-card', { hasText: 'Browser check ticket' }).first(); await card.waitFor(); check(`${size}: a proposed ticket appears on the board`, true); await shot('tickets');
      const cb = await card.boundingBox(); check(`${size}: the ticket is on the first screen`, !!cb && cb.y + cb.height <= SIZES[size].viewport.height * 0.75, JSON.stringify(cb));
    });
    await step('add an agent', async () => {
      await page.click('.tab[data-view="chat"]'); await page.click('#gear-btn'); await page.click('#menu-add-agent');
      await page.fill('#aw-name', 'check-bot-' + size); await page.click('#aw-mkkey');
      // 2026-11-13: this used to wait for "--token chk_<letter>", which the placeholder chk_PASTE_THE_TOKEN also matches, so now and then the
      // command was read before the real key had come back and the check failed for no reason. Wait for a key that is not the placeholder.
      await page.waitForFunction(() => { const t = document.getElementById('aw-cmd').textContent; return /--token '?chk_/.test(t) && !/PASTE/.test(t); });
      const cmd = await page.locator('#aw-cmd').textContent();
      check(`${size}: Add an agent makes the key itself and writes the full install command`, /install\.sh \| sudo bash/.test(cmd) && /--role connector/.test(cmd) && /--commanders /.test(cmd) && !/PASTE/.test(cmd), cmd.replace(/chk_[A-Za-z0-9_-]+/, "chk_…")); await shot('add-agent');
      await page.locator('#agent-wizard .close-x').click();
    });
    await step('accent row: RGB and the custom colour', async () => {                            // 2026-11-13: RGB added; the colour chooser used to look like a sixth ready-made colour
      await page.click('.tab[data-view="chat"]'); await page.click('#gear-btn'); await page.locator('#theme-picker').waitFor();
      const customText = (await page.locator('#accent-custom-wrap').innerText()).trim(), nameBefore = await page.locator('#accent-name').textContent();
      check(`${size}: the settings wheel in the app is a drawn icon (not a character some devices lack)`, await page.evaluate(() => (document.querySelector('#gear-btn svg')?.getBoundingClientRect().width || 0) >= 14));
      const pick = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent-pick').trim());
      await page.click('#accent-rgb'); const a1 = await pick(); await sleep(700); const a2 = await pick(); await shot('accent-rgb');
      const st = await page.evaluate(() => ({ key: localStorage.getItem('chamber_accent'), on: document.getElementById('accent-rgb').classList.contains('on'), name: document.getElementById('accent-name').textContent,
        cost: (() => { const t = performance.now(); for (let i = 0; i < 20; i++) { document.documentElement.style.setProperty('--accent-pick', ChamberTheme.rgbColor(i * 18, 1, false)); getComputedStyle(document.body).color; document.body.offsetHeight; } return Math.round((performance.now() - t) / 20 * 100) / 100; })() }));
      check(`${size}: RGB makes the accent colour travel, is marked as chosen and named in words`, nameBefore === 'Spring' && a1 !== a2 && /^#[0-9a-f]{6}$/.test(a2) && st.key === 'rgb' && st.on && /RGB/.test(st.name), JSON.stringify({ nameBefore, a1, a2, st }));
      console.log(`  note ${size}: one RGB colour step costs about ${st.cost} ms in this browser (it takes ten steps a second)`);
      const worst = await page.evaluate(() => { let d = 1, l = 0; for (let h = 0; h < 360; h++) for (const b of [0.92, 1]) { d = Math.min(d, ChamberTheme.hexLum(ChamberTheme.rgbColor(h, b, false))); l = Math.max(l, ChamberTheme.hexLum(ChamberTheme.halfBlack(ChamberTheme.rgbColor(h, b, true)))); } return { darkest_on_dark: d, lightest_on_light: l }; });
      check(`${size}: every colour on the RGB wheel stays readable, on dark and on light`, worst.darkest_on_dark >= 0.25 && worst.lightest_on_light <= 0.16, JSON.stringify(worst));
      await page.reload({ waitUntil: 'networkidle' }); await page.waitForSelector('#msg-input:not([disabled])'); const r1 = await pick(); await sleep(700); const r2 = await pick();
      check(`${size}: RGB is remembered after a reload`, r1 !== r2 && /^#[0-9a-f]{6}$/.test(r2), JSON.stringify({ r1, r2 }));
      await page.click('#gear-btn'); await page.click('#theme-picker .swatch[data-accent="#00d4ff"]'); const c1 = await pick(); await sleep(400); const c2 = await pick();
      check(`${size}: picking a fixed colour stops RGB`, c1 === '#00d4ff' && c2 === '#00d4ff' && (await page.locator('#accent-name').textContent()) === 'Cyan', JSON.stringify({ c1, c2 }));
      await page.fill('#accent-custom', '#a1b2c3');
      const cu = await page.evaluate(() => ({ on: document.getElementById('accent-custom-wrap').classList.contains('on'), name: document.getElementById('accent-name').textContent, anySwatch: !!document.querySelector('#theme-picker .swatch.on') }));
      check(`${size}: the colour chooser is labelled "Custom", and is marked and named when it is the one in use`, /custom/i.test(customText) && cu.on && /Custom colour #a1b2c3/.test(cu.name) && !cu.anySwatch && (await pick()) === '#a1b2c3', JSON.stringify({ customText, cu })); await shot('accent-custom');
      const fits = await page.evaluate(() => { const m = document.getElementById('menu').getBoundingClientRect(), sw = [...document.querySelectorAll('#theme-picker .swatch')].map(e => e.getBoundingClientRect()); return { inside: [...document.querySelectorAll('#theme-picker > *, #accent-foot > *, #accent-name')].map(e => e.getBoundingClientRect()).every(r => r.width > 0 && r.left >= m.left - 1 && r.right <= m.right + 1), oneRow: sw.every(r => Math.abs((r.top + r.bottom) - (sw[0].top + sw[0].bottom)) < 2), n: sw.length, w: sw[0].width }; });
      check(`${size}: the six colours sit in one row inside the menu, big enough to tap, with Custom and Reset under them`, fits.inside && fits.oneRow && fits.n === 6 && fits.w >= 26, JSON.stringify(fits));
      await page.click('#accent-reset'); await sleep(300); const back = await page.evaluate(() => ({ key: localStorage.getItem('chamber_accent'), name: document.getElementById('accent-name').textContent }));
      check(`${size}: Reset goes back to the standard colour`, back.key === null && (await pick()) === '#00ff88' && back.name === 'Spring', JSON.stringify(back));
      await page.evaluate(() => toggleMenu(false));
    });
    await step('gear menu reaches Sign out', async () => {
      await page.click('#gear-btn'); const so = page.locator('#menu-signout'); await so.scrollIntoViewIfNeeded();
      const b = await so.boundingBox(), vh = SIZES[size].viewport.height;
      check(`${size}: Sign out can be scrolled to and sits inside the screen`, !!b && b.y >= 0 && b.y + b.height <= vh, JSON.stringify(b)); await shot('gear');
      await so.click(); await page.waitForFunction(() => location.pathname !== '/app');
      check(`${size}: Sign out leaves the app`, true);
    });
    clean('inside the app');
    await step('log in through the form', async () => {
      await page.goto(BASE + '/login', { waitUntil: 'networkidle' });
      await page.fill('#li-email', email); await page.fill('#li-pass', pw); await page.click('button[type=submit]:visible');
      await page.waitForSelector('#msg-input:not([disabled])');
      await page.locator('#messages', { hasText: hello }).waitFor();
      check(`${size}: logging in through the form lands in the app with the earlier message still there`, new URL(page.url()).pathname === '/app');
    });
    await step('account page follows the colour picked in the app', async () => {                 // 2026-11-13
      await page.evaluate(() => localStorage.setItem('chamber_accent', 'rgb')); await page.goto(BASE + '/billing', { waitUntil: 'networkidle' });
      const pick = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent-pick').trim());
      const b1 = await pick(); await sleep(700); const b2 = await pick();
      await page.click('#gear-btn'); await page.locator('#menu.open').waitFor(); const on = await page.evaluate(() => document.getElementById('accent-rgb').classList.contains('on')); await shot('account-wheel');
      check(`${size}: RGB picked in the app carries over to the account page, and the wheel there shows it as chosen`, b1 !== b2 && on, JSON.stringify({ b1, b2, on }));
      await page.click('#accent-reset'); await page.keyboard.press('Escape');
    });
    await step('account page offers extra storage when the server sells it', async () => {      // storage add-on: the server's answers are stood in for here (the server side has its own tests)
      let packs = 0, sent = null; const offer = () => ({ packGb: 10, label: '$49.99 / year', maxPacks: 10, baseMb: 500, packs, canChange: true, isPayer: true });
      await page.route('**/account/me', async route => { const r = await route.fetch(); const j = await r.json(); j.storage = offer(); await route.fulfill({ response: r, json: j }); });
      await page.route('**/billing/storage', async route => { sent = JSON.parse(route.request().postData()); packs = sent.packs; const j = await (await page.request.get(BASE + '/account/me')).json(); j.storage = offer(); await route.fulfill({ json: j }); });
      let dialogs = 0; page.on('dialog', d => { dialogs++; d.dismiss(); });
      await page.goto(BASE + '/billing', { waitUntil: 'networkidle' });
      await page.locator('#sg-box').waitFor(); await page.locator('#sg-box').scrollIntoViewIfNeeded();
      const hiddenFirst = await page.locator('#sg-confirm').isHidden();
      await page.selectOption('#sg-packs', '2'); await page.click('#sg-save'); await page.locator('#sg-confirm').waitFor();
      const asked = await page.locator('#sg-what').textContent(), btn = await page.locator('#sg-yes').textContent();
      await page.locator('#sg-yes').scrollIntoViewIfNeeded(); await shot('storage-confirm');
      await page.click('#sg-yes'); await page.waitForTimeout(300); const sentWithoutPw = sent;                // no password typed: nothing may be sent
      await page.fill('#sg-pw', 'my-password-123'); await page.click('#sg-yes');
      await page.locator('#sg-box', { hasText: 'plus 20 GB extra' }).waitFor(); await page.locator('#sg-box').scrollIntoViewIfNeeded();
      const info = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, wide: [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && e.offsetParent).slice(0, 4).map(e => e.tagName + '#' + e.id + ':' + e.textContent.trim().slice(0, 30)) }));
      check(`${size}: the account page offers extra storage and says what will be charged before anything is sent`, hiddenFirst && /charged now/.test(asked) && asked.includes('$49.99 / year') && asked.includes('20 GB') && /charge my card/.test(btn), asked.slice(0, 160));
      check(`${size}: adding storage asks for the password and sends nothing without it`, sentWithoutPw === null && sent?.packs === 2 && sent.password === 'my-password-123' && dialogs === 0, JSON.stringify({ sentWithoutPw, sent, dialogs }));
      check(`${size}: the account page shows the new amount and still fits the screen`, info.sw <= info.cw + 1, JSON.stringify(info)); await shot('storage-after');
      await page.selectOption('#sg-packs', '0'); await page.click('#sg-save'); const pwHidden = await page.locator('#sg-pw-wrap').isHidden(), redText = await page.locator('#sg-what').textContent();
      check(`${size}: reducing storage asks no password and says no files are deleted`, pwHidden && /No files are deleted/.test(redText), redText.slice(0, 120));
      await page.unroute('**/account/me'); await page.unroute('**/billing/storage');
    });
    clean('log in');
  }
  await browser.close();
}
(async () => { for (const size of Object.keys(SIZES)) { console.log(`browser check, ${size} size`); await run(size); }
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  FAIL the browser check itself crashed  -> ' + e.message.split('\n')[0]); console.log(`${pass} passed, ${fail + 1} failed`); process.exit(1); });

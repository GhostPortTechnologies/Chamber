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
  ['/', /Start free trial/, ['h1', 'a[href="/signup"]', '#ct-email', '#two-keys', '#phone-loop', '#pr-free', '#pr-team', '#pr-company']],   // T-0295: the three sizes are on screen   // T-0287, T-0292: the two new sections are on screen
  ['/login', /Log in/, ['#li-email', '#li-pass', 'button[type=submit]:visible']],
  ['/signup', /Create account/i, ['#su-email', '#su-user', '#su-pass', 'button[type=submit]:visible']],
  ['/forgot', /./, ['input:visible']],
  ['/demo', /./, ['#play']],
  ['/help', /./, []], ['/help/api', /./, []], ['/compare', /Chamber compared/i, []], ['/download', /Run Chamber on your own computer/i, ['h1', 'pre.cmd']], ['/terms', /Free trial/, []], ['/privacy', /./, []], ['/refunds', /Free trial/, []],
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
    if (p === '/') { try { await page.screenshot({ path: path.join(OUT, `${size}-front.png`), fullPage: true }); } catch {} }
    if (p === '/') await step('front page pricing', async () => {   // T-0295: what a visitor reads about the price
      const cards = await page.evaluate(() => ({ free: document.getElementById('pr-free').innerText, team: document.getElementById('pr-team').innerText, company: document.getElementById('pr-company').innerText,
        promises: document.getElementById('pr-promises').innerText, renew: (document.getElementById('pr-renew') || {}).innerText || '', founding: !document.getElementById('pr-founding').hidden }));
      await page.locator('#pr-team').scrollIntoViewIfNeeded(); await shot('pricing-cards');
      check(`${size}: the front page shows Free (3 people), Team ($50 a month or $500 a year, 5 builders) and Company ($150 a month or $1,500 a year, 25 builders), the promises, the renewal email and receipts, and the founding price (T-0295, T-0310)`,
        /Up to 3 people/.test(cards.free) && /\$50\s*\/ month/.test(cards.team) && /\$500 a year/.test(cards.team) && /Up to 5 builders/.test(cards.team) && /\$150\s*\/ month/.test(cards.company) && /\$1,500 a year/.test(cards.company) && /Up to 25 builders/.test(cards.company)
        && !/\$49|\$199/.test(cards.team + cards.company) && /never a price per person/.test(cards.promises) && /14 days before each renewal/.test(cards.renew) && /receipt/.test(cards.renew) && cards.founding, JSON.stringify(cards));
    });   // T-0179: keep a picture of the whole front page from every release
    if (p === '/demo') await step('demo plays', async () => {   // 18 Nov 2026: play the whole story fast and check each choice does what the page says
      await page.goto(BASE + '/demo?speed=50', { waitUntil: 'networkidle' });
      await page.click('#play');
      const tap = async label => { const b = page.locator('#choice button', { hasText: label }).first(); await b.waitFor(); await b.click(); };
      await tap('Approve'); await tap('Allow'); await tap('Looks good'); await tap('Check the record');
      await page.locator('#verdict.ok').waitFor();
      const good = await page.evaluate(() => ({ rows: document.querySelectorAll('#rec .rec-row').length, bad: document.querySelectorAll('#rec .rec-row.bad').length, v: document.getElementById('verdict').textContent }));
      await tap('Edit an entry'); await page.locator('#verdict.bad').waitFor();
      const edited = await page.evaluate(() => ({ bad: document.querySelectorAll('#rec .rec-row.bad').length, v: document.getElementById('verdict').textContent }));
      await page.click('#r-hide'); await page.waitForFunction(() => /no longer matches the entry before/.test(document.getElementById('verdict').textContent));
      const hidden = await page.evaluate(() => document.getElementById('verdict').textContent);
      await page.click('#r-undo'); await page.locator('#verdict.ok').waitFor();
      await tap('Next: try to break the rules');
      for (const l of ['approves its own', 'without saying how it checked', '~/.ssh']) await tap(l);
      await page.waitForFunction(() => document.querySelectorAll('#chat .m.refused').length === 3);
      const chat = await page.evaluate(() => document.getElementById('chat').innerText);
      const fit = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
      check(`${size}: demo: approve, allow, looks good; the record checks out, an edited entry fails the check (recomputing it moves the failure to the next entry), putting it back passes; the three rule breaks are refused in the server's words; fits the screen`,
        good.rows >= 8 && good.bad === 0 && /All \d+ entries match/.test(good.v) && edited.bad >= 1 && /Check failed at entry #\d+: its content/.test(edited.v) && /Check failed at entry #\d+: it no longer matches the entry before/.test(hidden)
        && /only a person can approve a ticket; an agent cannot/.test(chat) && /close note needs CHECK:/.test(chat) && fit, JSON.stringify({ good, edited, hidden: hidden.slice(0, 120), fit }));
      await shot('demo-end');
    });
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
    await step('folders: the owner may rename a folder of shared files, a member sees no rename or delete there', async () => {   // T-0244
      const setup = await page.evaluate(async () => {
        await fetch('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'team box' }) });
        const f = ((await (await fetch('/api/files?limit=50')).json()).files || [])[0] || {};
        const mv = await fetch(`/api/files/${f.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: 'team box' }) });
        const ws = await (await fetch('/account/workspace')).json();
        return { moved: mv.status, invite: ws.inviteUrl };
      });
      await page.click('.tab[data-view="files"]'); await page.waitForSelector('#files-view.active', { state: 'visible' });
      await page.evaluate(() => openFolder('team box')); await page.locator('#files-crumbs a', { hasText: 'rename folder' }).waitFor();
      const ownerSees = await page.locator('#files-crumbs a', { hasText: 'delete folder' }).isVisible();
      const ctx2 = await browser.newContext(SIZES[size]); const p2 = await ctx2.newPage(); p2.setDefaultTimeout(12000); const errs2 = []; p2.on('pageerror', e => errs2.push(e.message));
      try {
        await p2.goto(setup.invite, { waitUntil: 'networkidle' });
        const mu = `mf${size.slice(0, 1)}${Date.now().toString(36)}`;
        await p2.fill('#su-email', `${mu}@test.invalid`); await p2.fill('#su-user', mu); await p2.fill('#su-pass', 'browser-check-password'); await p2.click('button[type=submit]:visible');
        await p2.waitForFunction(() => !document.querySelector('#su-email')?.offsetParent, null, { timeout: 12000 });
        await p2.goto(BASE + '/app', { waitUntil: 'networkidle' });
        await p2.evaluate(() => switchView('files')); await p2.waitForSelector('#files-view.active', { state: 'visible' });
        await p2.evaluate(() => openFolder('team box')); await p2.locator('#files-crumbs', { hasText: 'team box' }).waitFor(); await sleep(500);
        const memberSees = await p2.evaluate(() => /rename folder|delete folder/.test(document.getElementById('files-crumbs').textContent));
        try { await p2.screenshot({ path: path.join(OUT, `${size}-member-folder.png`) }); } catch {}
        check(`${size}: folders: the owner gets rename and delete on a folder of shared files; a member does not (T-0244)`, setup.moved === 200 && ownerSees && !memberSees && !errs2.length, JSON.stringify({ moved: setup.moved, ownerSees, memberSees, errs2 }));
      } finally { await ctx2.close(); }
      await page.evaluate(() => openFolder('')); await page.click('.tab[data-view="chat"]'); await sleep(200);
    });
    for (const v of ['tickets', 'reviews', 'tasks', 'files', 'activity', 'code', 'chat']) await step(`${v} tab`, async () => {
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
    await step('owner and member: who removes messages, edits a proposed ticket and closes a held one', async () => {   // T-0247
      const inv = await page.evaluate(async () => (await (await fetch('/account/workspace')).json()).inviteUrl);
      const ctx2 = await browser.newContext(SIZES[size]); const p2 = await ctx2.newPage(); p2.setDefaultTimeout(12000); const errs2 = []; p2.on('pageerror', e => errs2.push(e.message));
      try {
        await p2.goto(inv, { waitUntil: 'networkidle' });
        const mu = `mp${size.slice(0, 1)}${Date.now().toString(36)}`;
        await p2.fill('#su-email', `${mu}@test.invalid`); await p2.fill('#su-user', mu); await p2.fill('#su-pass', 'browser-check-password'); await p2.click('button[type=submit]:visible');
        await p2.waitForFunction(() => !document.querySelector('#su-email')?.offsetParent, null, { timeout: 12000 });
        const tag = Date.now().toString(36);
        const mine = await p2.evaluate(async t => {
          const post = async (url, body) => (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
          const msg = (await post('/api/messages', { room: 'general', text: 'member note ' + t })).message?.id;
          const tk = ((await post('/api/tickets', { by: 'x', title: 'member ticket ' + t, for: 'agent' })).message || '').match(/T-\d+/)?.[0];
          return { msg, tk };
        }, tag);
        const own = await page.evaluate(async t => {
          const post = async (url, body) => (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
          await post('/api/messages', { room: 'general', text: 'owner note ' + t });
          const proposed = ((await post('/api/tickets', { by: 'x', title: 'owner proposal ' + t, for: 'agent' })).message || '').match(/T-\d+/)?.[0];
          const held = ((await post('/api/tickets', { by: 'x', title: 'owner holds ' + t, for: 'human' })).message || '').match(/T-\d+/)?.[0];
          await post(`/api/tickets/${held}/approve`, { by: 'x' }); await post(`/api/tickets/${held}/claim`, { by: 'x' });
          return { proposed, held };
        }, tag);
        await page.goto(BASE + '/app', { waitUntil: 'networkidle' }); await page.click('.tab[data-view="chat"]');
        const mRow = page.locator(`.msg[data-id="${mine.msg}"]`); await mRow.waitFor();
        const ownerRemove = await mRow.locator('.actions a', { hasText: /^remove$/ }).count();
        const ownerOwnRow = page.locator('.msg', { hasText: 'owner note ' + tag }).last(); const ownerOwnLinks = await ownerOwnRow.locator('.actions a').allTextContents();
        await mRow.locator('.actions a', { hasText: /^remove$/ }).evaluate(a => a.click()); await mRow.locator('.actions a', { hasText: 'confirm remove' }).evaluate(a => a.click());
        await page.locator(`.msg[data-id="${mine.msg}"] .text.deleted`).waitFor({ timeout: 8000 });
        await shot('owner-removed-member-message');
        await p2.goto(BASE + '/app', { waitUntil: 'networkidle' }); await p2.evaluate(() => switchView('chat'));
        const oRow = p2.locator('.msg', { hasText: 'owner note ' + tag }).last(); await oRow.waitFor();
        const memberLinksOnOwner = await oRow.locator('.actions a').allTextContents();
        const btns = async id => p2.evaluate(async i => { await loadTickets(); openTicketModal(i); await new Promise(r => setTimeout(r, 300)); const a = document.getElementById('tm-actions'); const out = { text: a.textContent.replace(/\s+/g, ' ').trim(), buttons: [...a.querySelectorAll('button')].map(b => b.textContent.trim()) }; closeTicketModal(); return out; }, id);
        const onOwnerProposal = await btns(own.proposed), onOwn = await btns(mine.tk), onHeld = await btns(own.held);
        await p2.evaluate(i => { openTicketModal(i); }, own.held); await sleep(300); try { await p2.screenshot({ path: path.join(OUT, `${size}-member-held-ticket.png`) }); } catch {} await p2.evaluate(() => closeTicketModal());
        const fits = await p2.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
        const ok = ownerRemove === 1 && ownerOwnLinks.includes('delete') && !ownerOwnLinks.includes('remove') && !memberLinksOnOwner.some(x => /remove|delete|edit/.test(x))
          && !onOwnerProposal.buttons.includes('Edit') && onOwn.buttons.includes('Edit') && !onHeld.buttons.includes('Mark done') && !onHeld.buttons.includes('Add note') && /holds this ticket/.test(onHeld.text) && fits && !errs2.length
          && !onHeld.buttons.includes('Cancel') && !onHeld.buttons.some(x => /Release/.test(x));   // T-0262: no Cancel or Release / retry on a ticket the owner proposed and holds
        check(`${size}: the owner removes a member's message; the member gets no remove on the owner's message, no Edit on the owner's proposal (but on their own) and no Add note, Mark done, Cancel or Release on a ticket the owner holds (T-0247, T-0262)`, ok,
          JSON.stringify({ ownerRemove, ownerOwnLinks, memberLinksOnOwner, onOwnerProposal: onOwnerProposal.buttons, onOwn: onOwn.buttons, onHeld, fits, errs2 }));
      } finally { await ctx2.close(); }
    });
    await step('ticket export page: Chamber colours on screen, dark on white on paper', async () => {   // T-0228
      const app = await page.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, id: getComputedStyle(document.querySelector('.ticket-card .id')).color }));
      const px = await page.context().newPage(); try {
        await px.goto(BASE + '/api/tickets/export', { waitUntil: 'networkidle' });
        const look = () => px.evaluate(() => { const cs = q => getComputedStyle(document.querySelector(q)); return { bg: cs('body').backgroundColor, text: cs('body').color, h1: cs('h1').color, id: cs('.t .id').color, font: cs('body').fontFamily, cards: document.querySelectorAll('.t').length, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }; });
        const scr = await look(); try { await px.screenshot({ path: path.join(OUT, `${size}-ticket-export.png`), fullPage: true }); } catch {}
        await px.emulateMedia({ media: 'print' }); const prn = await look(); try { await px.screenshot({ path: path.join(OUT, `${size}-ticket-export-print.png`), fullPage: true }); } catch {}
        check(`${size}: the ticket export has the app's background, accent and typeface on screen, fits the screen, and prints dark on white with coloured headings`,
          scr.bg === app.bg && scr.id === app.id && scr.h1 === app.id && /JetBrains Mono/.test(scr.font) && scr.cards > 0 && scr.sw <= scr.cw + 1
          && prn.bg === 'rgb(255, 255, 255)' && prn.text === 'rgb(17, 17, 17)' && prn.h1 !== prn.text && prn.h1 !== scr.h1, JSON.stringify({ app, scr, prn }));
      } finally { await px.close(); }
    });
    await step('review a proposed change: comment on a line and ask for changes', async () => { try {    // T-0189
      const tid = await page.evaluate(async () => {
        const r = await fetch('/api/tickets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Review check: set x', body: 'A change to review.', for: 'agent', by: 'x' }) });
        const id = ((await r.json()).message || '').match(/T-\d+/)[0];
        await fetch(`/api/tickets/${id}/diff`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ diff: 'diff --git a/app.py b/app.py\n--- a/app.py\n+++ b/app.py\n@@ -1 +1 @@\n-x = 1\n+x = 2\n' }) });
        return id; });
      await page.click('.tab[data-view="tickets"]'); await page.evaluate(() => loadTickets());
      const card = page.locator('.ticket-card', { hasText: 'Review check: set x' }).first(); await card.waitFor(); await card.click();
      await page.locator('#tm-diff .tabs-mini button', { hasText: 'Diff' }).click();
      await page.locator('#tm-diff .pane.df span.line').nth(5).click(); const picked = await page.inputValue('#dv-line');
      await page.fill('#dv-text', 'Use 3 here, not 2.'); await page.locator('#tm-diff button', { hasText: 'Comment' }).click();
      await page.locator('#tm-diff .dv-comments', { hasText: 'Use 3 here, not 2.' }).waitFor(); await shot('review-comment');
      const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
      check(`${size}: on a ticket with a change, tapping a line number picks the line and a comment shows under the diff`, picked === '6' && fits, JSON.stringify({ picked, fits }));
      await page.locator('#tm-actions button', { hasText: 'Ask for changes' }).click(); await page.fill('#ask-text', 'Please make it 3.'); await page.click('#ask-ok');
      await page.waitForFunction(() => !document.getElementById('ticket-modal')?.classList.contains('show'), null, { timeout: 8000 }).catch(() => {});
      await page.evaluate(() => loadTickets()); const card2 = page.locator('.ticket-card', { hasText: 'Review check: set x' }).first(); await card2.locator('.pill', { hasText: 'changes asked' }).waitFor(); await card2.click();
      const st = await page.evaluate(() => ({ note: document.getElementById('tm-actions').innerText, approve: [...document.querySelectorAll('#tm-actions button')].some(b => /,'approve'\)/.test(b.getAttribute('onclick') || '')) }));
      await shot('review-changes'); await page.evaluate(() => closeTicketModal());
      check(`${size}: Ask for changes marks the ticket, says what was asked, and takes Approve away until a new version comes`, /Changes asked for by/.test(st.note) && /Please make it 3/.test(st.note) && !st.approve && !!tid, JSON.stringify(st).slice(0, 300));
    } finally { await page.evaluate(() => { try { closeTicketModal(); document.getElementById('ask-cancel')?.click(); } catch {} }).catch(() => {}); } });
    await step('activity: a longer period, the export and progress by week', async () => {          // T-0219
      await page.click('.tab[data-view="activity"]'); await page.waitForSelector('#activity-view.active', { state: 'visible' });
      await page.selectOption('#act-range', '7d'); await page.locator('#act-count', { hasText: /in the last 7 days/ }).waitFor();
      await page.locator('#act-progress-body table').waitFor();
      const a = await page.evaluate(async () => { const csv = document.getElementById('act-csv').href, t = await (await fetch(csv)).text();
        return { count: document.getElementById('act-count').textContent, days: document.querySelectorAll('#activity-list .ev-day').length, rows: document.querySelectorAll('#activity-list .event-row').length, csv, head: t.split('\n')[0], lines: t.trim().split('\n').length,
          prog: document.getElementById('act-progress-body').innerText, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }; });
      await shot('activity-period');
      check(`${size}: the Activity tab shows a longer period with a date above each day, exports it as a spreadsheet file, and shows progress by week, inside the screen`, /\d+ events? in the last 7 days/.test(a.count) && a.days >= 1 && a.rows >= 1 && /format=csv/.test(a.csv) && a.head === 'time_utc,what,who,ref,title,details,seconds' && a.lines >= 2
        && /Week of/.test(a.prog) && /Proposed/.test(a.prog) && /Typical time to done/.test(a.prog) && a.sw <= a.cw + 1, JSON.stringify(a).slice(0, 400));
      await page.selectOption('#act-range', 'custom'); const custom = await page.locator('#act-custom').isVisible(); await page.selectOption('#act-range', '24h');
      check(`${size}: "Dates I pick" shows two date boxes`, custom);
    });
    await step('add an agent', async () => {
      await page.goto(BASE + '/settings', { waitUntil: 'networkidle' }); await page.evaluate(() => { location.hash = 'ai'; }); await page.click('#set-add-agent');   // T-0329: Settings > AI agents
      await page.waitForURL(u => new URL(u).pathname === '/app'); await page.locator('#agent-wizard.show').waitFor();
      await page.fill('#aw-name', 'check-bot-' + size); await page.click('#aw-mkkey');
      // 2026-11-13: this used to wait for "--token chk_<letter>", which the placeholder chk_PASTE_THE_TOKEN also matches, so now and then the
      // command was read before the real key had come back and the check failed for no reason. Wait for a key that is not the placeholder.
      await page.waitForFunction(() => document.getElementById('aw-token').value.startsWith('chk_') && /--token -( |$)/m.test(document.getElementById('aw-cmd').textContent));   // T-0217: by default the command asks for the key
      const cmd0 = await page.locator('#aw-cmd').textContent(), keyRow = await page.locator('#aw-key-row').isVisible(), fits0 = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
      check(`${size}: by default the install command asks for the key instead of carrying it, and the key has its own Copy button`, /--token -( |$)/m.test(cmd0) && !/chk_/.test(cmd0) && keyRow && fits0, cmd0); await shot('add-agent-ask-key');
      await page.check('#aw-keyin');
      await page.waitForFunction(() => { const t = document.getElementById('aw-cmd').textContent; return /--token '?chk_/.test(t) && !/PASTE/.test(t); });
      const cmd = await page.locator('#aw-cmd').textContent();
      check(`${size}: Add an agent makes the key itself and writes the full install command`, /install\.sh \| sudo bash/.test(cmd) && /--role connector/.test(cmd) && /--commanders /.test(cmd) && !/PASTE/.test(cmd), cmd.replace(/chk_[A-Za-z0-9_-]+/, "chk_…")); await shot('add-agent');
      await page.check('input[name="aw-kind"][value="laptop"]'); const lcmd = await page.locator('#aw-cmd').textContent();   // T-0186
      const lnote = await page.locator('#aw-signin').innerText();
      check(`${size}: Add an agent also writes a laptop command that needs no sudo, and says the agent reads nothing until a folder is attached`, /laptop\.sh \| sh -s -- --token chk_/.test(lcmd) && !/sudo/.test(lcmd) && !/^cd /.test(lcmd) && /reads nothing on that computer until you attach a folder/.test(lnote) && /chamber-attach/.test(lnote), lcmd.replace(/chk_[A-Za-z0-9_-]+/, 'chk_…')); await shot('add-agent-laptop');
      // T-0320: the key is never on screen in full; T-0315: a drag from inside the window that ends outside it does not close it
      const keyFull = await page.evaluate(() => { const k = document.getElementById('aw-token').value; return { inText: document.body.innerText.includes(k), status: document.getElementById('aw-token-status').textContent, masked: document.getElementById('aw-cmd').textContent.includes(k.slice(0, 8) + '••') , secret: getComputedStyle(document.getElementById('aw-token')).webkitTextSecurity || '' }; });
      check(`${size}: the key is never shown in full: the command and the note show its first letters only, the key field shows dots, and the window warns about screenshots (T-0320)`,
        !keyFull.inText && keyFull.masked && /Key created: chk_\S{4}••••/.test(keyFull.status) && keyFull.secret === 'disc' && /Don't share screenshots/.test(await page.locator('#agent-wizard').innerText()), JSON.stringify(keyFull));
      const box = await page.locator('#agent-wizard .modal-box').boundingBox(), vp = page.viewportSize(), inner = await page.locator('#aw-name').boundingBox();
      const out = box.y > 12 ? { x: vp.width / 2, y: box.y / 2 } : (box.y + box.height < vp.height - 12 ? { x: vp.width / 2, y: (box.y + box.height + vp.height) / 2 } : null);
      let stayed = true, closes = true;
      if (out) {
        await page.mouse.move(inner.x + 10, inner.y + inner.height / 2); await page.mouse.down(); await page.mouse.move(out.x, out.y, { steps: 4 }); await page.mouse.up();
        stayed = await page.evaluate(() => document.getElementById('agent-wizard').classList.contains('show'));
        await page.mouse.click(out.x, out.y); closes = !(await page.evaluate(() => document.getElementById('agent-wizard').classList.contains('show')));
        if (!closes) await page.locator('#agent-wizard .close-x').click();
      } else await page.locator('#agent-wizard .close-x').click();
      check(`${size}: selecting from inside the window and letting go outside it keeps the window (and the key) open; a click on the backdrop still closes it (T-0315)`, stayed && closes, JSON.stringify({ out, stayed, closes }));
    });
    await step('standing approvals: set one up, offer it when proposing, withdraw it', async () => { try {      // T-0200
      await page.click('.tab[data-view="tickets"]'); await page.click('#standing-btn'); await page.locator('#standing-modal.show').waitFor();
      await page.fill('#sa-what', 'fix failing tests'); await page.fill('#sa-paths', 'tests/'); await page.click('#sa-save');
      const item = page.locator('#sa-list .sa-item', { hasText: 'fix failing tests' }).first(); await item.locator('.pill', { hasText: 'Active' }).waitFor(); await shot('standing');
      const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), txt = await item.innerText();
      check(`${size}: Standing approvals sets one up and lists it with its limits, inside the screen`, /only in tests\//.test(txt) && /until \d{4}-\d\d-\d\d/.test(txt) && fits, JSON.stringify({ txt: txt.slice(0, 200), fits }));
      await page.evaluate(() => closeStanding()); await page.getByText('+ Propose ticket').click();
      await page.check('input[name="prop-for"][value="agent"]'); await page.locator('#prop-standing-wrap').waitFor({ state: 'visible' });
      const opts = await page.locator('#prop-standing option').allTextContents(); await shot('standing-propose');
      check(`${size}: the propose form offers the standing approval when an agent does the job`, opts.some(o => /fix failing tests/.test(o)), opts.join(' | '));
      await page.check('input[name="prop-for"][value="human"]'); await sleep(150);
      check(`${size}: and does not offer it when a person does the job`, !(await page.locator('#prop-standing-wrap').isVisible()));
      await page.evaluate(() => closeProposeModal()); await page.click('#standing-btn');
      await page.locator('#sa-list .sa-item', { hasText: 'fix failing tests' }).first().locator('button', { hasText: 'Withdraw' }).click();
      await page.locator('#sa-list .sa-item', { hasText: 'fix failing tests' }).first().locator('.pill', { hasText: 'Withdrawn' }).waitFor();
      check(`${size}: one tap withdraws it`, true);
    } finally { await page.evaluate(() => { try { closeStanding(); closeProposeModal(); } catch {} }).catch(() => {}); } });
    await step('add an agent: any AI tool (MCP)', async () => {                                       // T-0198
      await page.click('.tab[data-view="chat"]'); await page.evaluate(() => openAgentWizard());   // T-0329: the way there is checked in the step before
      await page.check('input[name="aw-kind"][value="mcp"]'); const mcmd = await page.locator('#aw-cmd').textContent(); await shot('add-agent-mcp');
      const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
      await page.selectOption('#aw-mcp-tool', 'antigravity');   // T-0281: pick a tool, the note says where the result goes and that we have not tried it
      const mnote = await page.locator('#aw-signin').innerText(), mfit = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
      check(`${size}: Add an agent, MCP: choosing Google Antigravity says where the entry goes and that it is not tried by us yet; Claude Code carries no such label`,
        /Google Antigravity/.test(mnote) && /mcp_config\.json/.test(mnote) && /Not tried by us yet/.test(mnote) && mfit && await (async () => { await page.selectOption('#aw-mcp-tool', 'claude'); const n = await page.locator('#aw-signin').innerText(); return /claude mcp add/.test(n) && !/Not tried/.test(n); })(), mnote.slice(0, 200));
      check(`${size}: Add an agent offers any AI tool through MCP, with a one-line setup that needs no sudo`, /chamber-mcp\.py/.test(mcmd) && /--setup --url /.test(mcmd) && !/sudo/.test(mcmd) && fits, mcmd.replace(/chk_[A-Za-z0-9_-]+/, 'chk_…'));
      await page.locator('#agent-wizard .close-x').click();
    });
    await step('an agent asks: Allow once / Deny in the room', async () => {                         // T-0188
      const made = await page.evaluate(async () => {
        const k = await (await fetch('/account/workspace/tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Asker', username: 'asker-' + Date.now().toString(36).slice(-5) }) })).json();
        await fetch('/account/workspace/tokens/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: k.id, on: true }) });
        sessionStorage.setItem('bcAsker', k.token || '');                        // T-0210: the notification step asks with the same agent
        const r = await fetch('/api/asks', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + k.token }, body: JSON.stringify({ room: 'general', tool: 'Bash', summary: 'run this command: npm test -- --watch=false', waitSec: 300 }) });
        return { status: r.status, err: k.error };
      });
      await page.click('.tab[data-view="chat"]'); await page.evaluate(() => { if (currentRoom !== 'general') switchRoom('general'); return loadAsks(); });
      const item = page.locator('#ask-bar .ask-item').first(); await item.waitFor(); await shot('ask-bar');
      const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), txt = await item.innerText();
      check(`${size}: a question from an agent shows in the room with the exact command, Allow once and Deny, inside the screen`, made.status === 201 && /npm test -- --watch=false/.test(txt) && /Allow once/.test(txt) && /Deny/.test(txt) && fits, JSON.stringify({ made, txt: txt.slice(0, 160), fits }));
      await item.locator('button', { hasText: 'Allow once' }).click(); await page.locator('#ask-bar').waitFor({ state: 'hidden' });
      check(`${size}: Allow once answers it and the question goes away`, true);
      const reach = await page.evaluate(async () => {                                        // T-0218: what the agent can read shows under its name
        const h = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sessionStorage.getItem('bcAsker') };
        const me = await (await fetch('/api/me', { headers: h })).json();
        const ping = reach => fetch('/api/ping', { method: 'POST', headers: h, body: JSON.stringify({ username: me.username, version: '3.27.0', rooms: ['general'], state: 'idle', reach }) });
        const line = async () => { await loadPresence(); const li = [...document.querySelectorAll('#user-list .user-item')].find(x => x.querySelector('.uname')?.textContent === me.username), el = li && li.querySelector('.agent-reach'); return el ? { text: el.textContent, tip: el.title } : null; };
        await ping({ mode: 'attached', names: [], private: 0 }); const b = await line();
        await ping({ mode: 'all', private: 0, cmd: true }); const c = await line();
        await ping({ mode: 'attached', names: ['shop', 'notes.txt'], private: 1 }); const a = await line();
        return { a, b, c, user: me.username };
      });
      check(`${size}: under an agent's name it says what the agent can read on its own machine: the attached folders, nothing yet, or everything`, reach.a && reach.a.text === 'can read: shop, notes.txt' && /It can read nothing else there\./.test(reach.a.tip) && /1 place is marked/.test(reach.a.tip)
        && reach.b && /nothing attached yet/.test(reach.b.text) && reach.c && /all its account can · runs commands/.test(reach.c.text), JSON.stringify(reach).slice(0, 400)); await shot('agent-reach');
      const madeJ = await page.evaluate(async () => { const r = await fetch('/api/asks', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sessionStorage.getItem('bcAsker') }, body: JSON.stringify({ room: 'general', tool: 'Bash', summary: 'run this command: npm test', waitSec: 300, job: true }) }); return (await r.json()).id; });   // T-0211
      await page.evaluate(() => loadAsks()); const itemJ = page.locator('#ask-bar .ask-item', { hasText: 'npm test' }).first(); await itemJ.waitFor(); await shot('ask-bar-job');
      const txtJ = await itemJ.innerText(), fitsJ = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
      await itemJ.locator('button', { hasText: 'Allow for this job' }).click(); await page.locator('#ask-bar').waitFor({ state: 'hidden' });
      const scopeJ = await page.evaluate(async id => ((await (await fetch('/api/asks')).json()).asks || []).find(a => a.id === id)?.scope, madeJ);
      check(`${size}: an agent that can honour it gets a third button, Allow for this job, with what it trusts said plainly, inside the screen; a tap answers for the job`, /Allow once/.test(txtJ) && /Allow for this job/.test(txtJ) && /Deny/.test(txtJ) && /you are trusting those changes too/.test(txtJ) && fitsJ && scopeJ === 'job', JSON.stringify({ txtJ: txtJ.slice(0, 240), fitsJ, scopeJ }));
    });
    await step('a question arrives as a notification with Allow once / Deny', async () => {       // T-0210
      // The test browser (headless shell) cannot display notifications at all, so the two display calls of the service worker are
      // replaced by a recorder. Everything else is the real thing: the push event, the worker's own request for the waiting
      // questions and its answer, both over the signed-in session.
      const sw = await page.evaluate(async () => { const reg = await navigator.serviceWorker.ready; await new Promise(r => setTimeout(r, 300)); return { active: !!reg.active, max: Notification.maxActions || 0 }; });
      const worker = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 8000 });
      await worker.evaluate(() => { const shown = self.__shown = [];
        self.registration.showNotification = async (title, o) => { const old = shown.findIndex(n => n.tag === (o || {}).tag); if (old >= 0) shown.splice(old, 1); const n = { title, ...(o || {}), close() { const i = shown.indexOf(n); if (i >= 0) shown.splice(i, 1); } }; shown.push(n); };
        self.registration.getNotifications = async () => shown.slice(); });
      const made = await page.evaluate(async () => {
        const token = sessionStorage.getItem('bcAsker');
        const ask = async cmd => { const r = await fetch('/api/asks', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ room: 'general', tool: 'Bash', summary: 'run this command: ' + cmd, waitSec: 300 }) }); return (await r.json()).id || ('HTTP ' + r.status); };
        return { a: await ask('pip install requests-mock'), b: await ask('git push origin main'), c: await ask('npm audit fix') };
      });
      const cdp = await ctx.newCDPSession(page); let regId = null, pushed = 'a real push event';
      cdp.on('ServiceWorker.workerRegistrationUpdated', e => { for (const r of e.registrations || []) if (!r.isDeleted) regId = r.registrationId; });
      await cdp.send('ServiceWorker.enable'); for (let i = 0; i < 30 && !regId; i++) await sleep(100);
      const notes = () => worker.evaluate(() => self.__shown.map(n => ({ title: n.title, body: n.body, tag: n.tag, actions: (n.actions || []).map(a => a.action + '=' + a.title), ask: n.data && n.data.ask, url: n.data && n.data.url })));
      const asks = ns => ns.filter(n => /^ask-A-/.test(n.tag));
      try { await cdp.send('ServiceWorker.deliverPushMessage', { origin: BASE, registrationId: regId, data: '' }); } catch (e) { pushed = 'push not deliverable here: ' + e.message.slice(0, 80); }
      let ns = []; for (let i = 0; i < 25; i++) { ns = await notes(); if (asks(ns).length >= 3) break; await sleep(200); }
      if (asks(ns).length < 3) { pushed = 'the push handler called directly; ' + pushed; await worker.evaluate(async () => { await showAsks(await waitingAsks() || []); }); ns = await notes(); }
      const na = ns.find(n => n.ask === made.a);
      check(`${size}: a waiting question becomes a notification with the exact command, Allow once and Deny, and no second "new message" notification (${pushed})`, sw.active && !!na && asks(ns).length === 3 && /asks: may I run this command\?$/.test(na.title) && /^pip install requests-mock\n/.test(na.body) && /No answer by .+ means no\.$/.test(na.body)
        && (sw.max >= 2 ? na.actions.join() === 'allow=Allow once,deny=Deny' : /Tap to open Chamber and answer/.test(na.body)) && /^\/app#m=[a-z0-9]+$/i.test(na.url) && !ns.some(n => n.tag === 'chamber'), JSON.stringify({ sw, made, ns }).slice(0, 700));
      const tap = (id, decision) => worker.evaluate(async ([id, decision]) => { const n = self.__shown.find(x => x.data && x.data.ask === id); const d = n ? n.data : { ask: id, what: '', url: '/app' }; if (n) n.close(); return answerAsk(d, decision); }, [id, decision]);
      const t1 = await tap(made.a, 'allow'), t2 = await tap(made.b, 'deny');
      const state = ids => page.evaluate(async ids => { const r = await (await fetch('/api/asks')).json(); return ids.map(id => { const a = (r.asks || []).find(x => x.id === id) || {}; return [a.status, a.answeredBy, a.via]; }); }, ids);
      const after = await state([made.a, made.b]), said = (await notes()).find(n => n.tag === 'ask-note');
      check(`${size}: a tap on Allow once or Deny answers over the signed-in session, says what was done, and the record says it came from the notification`, t1 === null && t2 === null && after[0][0] === 'allowed' && after[1][0] === 'denied' && after.every(x => x[2] === 'notification' && !!x[1]) && said?.title === 'You said no', JSON.stringify({ t1, t2, after, said }));
      const late = await tap(made.b, 'allow'), still = (await state([made.b]))[0][0], lateNote = (await notes()).find(n => n.tag === 'ask-note');
      check(`${size}: a tap after the question was answered changes nothing and says so`, /already denied/.test(late || '') && still === 'denied' && lateNote?.title === 'Not answered', JSON.stringify({ late, still, lateNote }));
      await page.click('.tab[data-view="tickets"]');                                   // a plain tap (no buttons, as on iPhone): the worker tells the open app where the question is
      await worker.evaluate(async url => { for (const c of await clients.matchAll({ type: 'window', includeUncontrolled: true })) c.postMessage({ kind: 'chamber-open', url }); }, na ? na.url : '/app');
      let onChat = false; for (let i = 0; i < 25 && !onChat; i++) { await sleep(150); onChat = await page.evaluate(() => document.querySelector('nav.tabs .tab.active')?.dataset.view === 'chat' && !location.hash); }
      check(`${size}: where notifications have no buttons, a tap brings the open app to the question`, onChat);
      await page.click('.tab[data-view="chat"]'); await page.evaluate(() => { if (currentRoom !== 'general') switchRoom('general'); return loadAsks(); });
      const item = page.locator('#ask-bar .ask-item', { hasText: 'npm audit fix' }); await item.waitFor(); const before = asks(await notes()).length;
      await item.locator('button', { hasText: 'Deny' }).click(); await page.locator('#ask-bar').waitFor({ state: 'hidden' });
      let left = 9; for (let i = 0; i < 20 && left; i++) { await sleep(150); left = asks(await notes()).length; }
      check(`${size}: a question answered in the app takes its notification off this device`, before === 1 && left === 0, JSON.stringify({ before, left }));
    });
    await step('thread reply box: tap to tag an agent, attach a photo, send it into the thread', async () => {   // T-0269
      await page.goto(BASE + '/app', { waitUntil: 'networkidle' }); await page.click('.tab[data-view="chat"]');
      const root = await page.evaluate(async () => (await (await fetch('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: 'general', text: 'thread root for the reply box ' + Date.now() }) })).json()).message?.id);
      await sleep(400); await page.evaluate(id => openThread(id), root); await page.locator('#thread-panel').waitFor();
      const chip = page.locator('#thread-tags button').first(); await chip.waitFor({ timeout: 10000 }); const agent = (await chip.textContent()).trim();
      await chip.click(); const tagged = await page.inputValue('#thread-input');
      await page.setInputFiles('#thread-file-input', { name: 'thread-shot.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64') });
      await page.locator('#thread-attach-bar .chip.ok').waitFor({ timeout: 10000 });
      await page.locator('#thread-input').click(); await page.keyboard.press('End'); await page.keyboard.type('look at this picture');
      await shot('thread-reply-tools'); await page.click('#thread-send');
      await page.locator('#thread-list .msg', { hasText: 'look at this picture' }).waitFor({ timeout: 10000 });
      const sent = await page.evaluate(async id => { const d = await (await fetch('/api/messages/replies?id=' + encodeURIComponent(id))).json(); const r = (d.replies || []).find(x => /look at this picture/.test(x.text)); return r ? { text: r.text, files: (r.attachments || []).length } : null; }, root);
      const ui = await page.evaluate(() => ({ cleared: !document.getElementById('thread-attach-bar').classList.contains('show'), mainTags: document.querySelectorAll('#tag-row button').length, fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 }));
      check(`${size}: thread reply box: tapping ${agent} tags it, a photo attaches and goes into the thread with the reply, the main box has the same tag buttons (T-0269)`,
        tagged.startsWith(agent + ' ') && !!sent && sent.files === 1 && sent.text.startsWith(agent + ' ') && ui.cleared && ui.mainTags >= 1 && ui.fits, JSON.stringify({ agent, tagged, sent, ui }));
      await page.evaluate(() => closeThread());
    });
    await step('suggestion buttons: the x hides them and Settings > Display brings them back (T-0329)', async () => {   // 18 Nov 2026
      await page.evaluate(() => { try { localStorage.removeItem('chamber-chips'); } catch {} renderChips(); });
      const before = await page.evaluate(() => !document.getElementById('chips').hidden && document.querySelectorAll('#chips button').length > 2);
      await page.locator('#chips button.x').click();
      const gone = await page.evaluate(() => ({ box: document.getElementById('chips').hidden, state: document.getElementById('chips-state').textContent }));
      await page.goto(BASE + '/settings', { waitUntil: 'networkidle' }); await page.evaluate(() => { location.hash = 'display'; }); await page.locator('#chips-mode').waitFor();
      const shownOff = await page.evaluate(() => document.querySelector('#chips-mode button[data-chips="off"]').classList.contains('on'));
      await page.click('#chips-mode button[data-chips="on"]'); await page.goto(BASE + '/app', { waitUntil: 'networkidle' }); await page.waitForSelector('#msg-input:not([disabled])'); await page.locator('#chips button').nth(2).waitFor();
      const back = await page.evaluate(() => ({ box: !document.getElementById('chips').hidden, state: document.getElementById('chips-state').textContent, n: document.querySelectorAll('#chips button').length, menuOpen: document.getElementById('menu').classList.contains('open') }));
      check(`${size}: suggestion buttons: the x hides them, Settings > Display shows them as off and brings them back`,
        shownOff && before && gone.box && gone.state === 'off' && back.box && back.state === 'on' && back.n > 2 && !back.menuOpen, JSON.stringify({ shownOff, before, gone, back }));
    });
    await step('reviews: finished work lands in To check; pick a ticket, looks good, send back', async () => {   // T-0223
      const made = await page.evaluate(async size => {                           // two tickets asked by the person and finished by an agent
        const me = currentUser, ah = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sessionStorage.getItem('bcAsker') }, uh = { 'Content-Type': 'application/json' };
        const bot = (await (await fetch('/api/me', { headers: ah })).json()).username, post = (p, h, b) => fetch(p, { method: 'POST', headers: h, body: JSON.stringify(b) });
        const one = async title => { const id = ((await (await post('/api/tickets', uh, { by: me, title, body: 'Please make the shop page show the new price list.', for: 'agent' })).text()).match(/T-\d{4}/) || [])[0];
          await post(`/api/tickets/${id}/approve`, uh, { by: me }); await post(`/api/tickets/${id}/claim`, ah, { by: bot }); const c = await post(`/api/tickets/${id}/close`, ah, { by: bot, note: '1. price list on the shop page: done, opened once on a phone-size screen. CHECK: opened the page on a phone. RESULT: the new list shows. FAIL-IF: the old list shows.' }); return c.ok ? id : null; };
        const a = await one(`[agent] Price list for the ${size} check`), b = await one(`[agent] Opening hours for the ${size} check`); await loadTickets(); return { a, b, bot };
      }, size);
      await page.click('.tab[data-view="reviews"]'); await page.waitForSelector('#reviews-view.active', { state: 'visible' });
      await page.locator(`#rvcol-todo [data-check="${made.a}"]`).waitFor(); const badge = await page.locator('#review-badge').innerText();
      await page.fill('#rv-find', made.b.replace('T-', '')); const found = await page.locator(`#rv-found [data-found="${made.b}"]`).innerText(); const cards = await page.locator('#rvcol-todo .check-card').count(), seen = await page.evaluate(() => { const c = [...document.querySelectorAll('#rvcol-todo .check-card')].pop().getBoundingClientRect(), col = document.getElementById('rvcol-todo').getBoundingClientRect(); return c.bottom <= col.bottom + 1 && c.height > 30; }); await shot('reviews-to-check');
      await page.fill('#rv-find', 'opening hours ' + size); const byWords = await page.locator('#rv-found .rv-row').first().innerText(); await page.fill('#rv-find', '');
      await page.click('#rv-next'); await page.locator('#check-modal.show').waitFor();
      const first = await page.evaluate(() => ({ id: document.getElementById('ck-title').textContent, asked: document.getElementById('ck-asked').innerText, done: document.getElementById('ck-done').innerText, pos: document.getElementById('ck-pos').textContent, meta: document.getElementById('ck-meta').innerText,
        sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })); await shot('reviews-check-one');
      check(`${size}: finished work shows up in To check by itself, a ticket is found by its number or by words, and Check next opens the oldest with what was asked and what was done`, Number(badge) >= 2 && cards >= 2 && seen && /to check/.test(found) && byWords.includes(made.b) && first.id === made.a
        && /new price list/.test(first.asked) && /opened once on a phone-size screen/.test(first.done) && /left to check/.test(first.pos) && first.meta.includes(made.bot) && first.sw <= first.cw + 1, JSON.stringify({ badge, cards, seen, found, first }).slice(0, 400));
      await page.click('#ck-ok'); await page.waitForFunction(id => document.getElementById('ck-title').textContent === id && document.getElementById('check-modal').classList.contains('show'), made.b);
      await page.click('#ck-send-back'); await page.click('#ck-send'); const need = await page.locator('#ck-error').innerText();
      await page.fill('#ck-reason', 'The hours for Sunday are missing.'); await page.click('#ck-send');
      await page.locator(`#rvcol-back [data-check="${made.b}"]`).waitFor(); await page.locator(`#rvcol-ok [data-check="${made.a}"]`).waitFor();
      await page.waitForFunction(id => { const b = ticketsCache.find(x => x.id === id), f = b && b.check && ticketsCache.find(x => x.id === b.check.followup); return !!f && f.status === 'approved' && !/proposed/.test(document.querySelector(`#rvcol-back [data-check="${id}"]`).innerText); }, made.b);   // the follow-up is approved a moment after the send-back itself
      const end = await page.evaluate(ids => { const t = id => ticketsCache.find(x => x.id === id) || {}, b = t(ids.b), f = t(b.check && b.check.followup);
        return { a: t(ids.a).check && t(ids.a).check.state, b: b.check && b.check.state, fTitle: f.title, fStatus: f.status, back: document.querySelector(`#rvcol-back [data-check="${ids.b}"]`).innerText, todo: !!document.querySelector(`#rvcol-todo [data-check="${ids.a}"], #rvcol-todo [data-check="${ids.b}"]`) }; }, made);
      await shot('reviews-after');
      check(`${size}: Looks good moves the ticket to Checked and opens the next one; Send back asks for a reason, makes a follow-up that is started right away, and shows it under Sent back`, /wrong or missing/.test(need) && end.a === 'ok' && end.b === 'back'
        && /^\[agent\] Follow-up to T-\d{4}: The hours for Sunday are missing\.$/.test(end.fTitle) && end.fStatus === 'approved' && /approved/.test(end.back) && end.todo === false, JSON.stringify({ need, end }).slice(0, 400));
      await page.evaluate(() => closeCheck());
    });
    await step('tasks: add a weekly task due today, tick it off, it says who did it; take the tick back', async () => {   // T-0224
      const name = `Check the backup restores (${size})`;
      await page.click('.tab[data-view="tasks"]'); await page.waitForSelector('#tasks-view.active', { state: 'visible' });
      await page.click('#tk-add-btn'); await page.fill('#tk-title', name); await page.selectOption('#tk-every', 'week');
      await page.selectOption('#tk-wday', await page.evaluate(() => String(((new Date().getDay() + 6) % 7) + 1))); const pickers = { week: await page.locator('#tk-wday').isVisible(), month: await page.locator('#tk-mday').isVisible() };
      await page.click('#tk-save'); const row = page.locator('.tk-row', { hasText: name }); await row.waitFor(); await sleep(200); const formShut = await page.locator('#tk-form').isHidden();
      const before = { meta: await row.locator('.tk-meta').innerText(), badge: await page.evaluate(() => document.getElementById('task-badge').textContent) };
      await row.locator('.tk-box').click(); await page.locator('.tk-row.done', { hasText: name }).waitFor();
      const after = { meta: await page.locator('.tk-row.done', { hasText: name }).locator('.tk-meta').innerText(), checked: await page.locator('.tk-row.done', { hasText: name }).locator('.tk-box').getAttribute('aria-checked') };
      const sw = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })); await shot('tasks');
      await page.locator('.tk-row.done', { hasText: name }).locator('.tk-box').click(); await page.locator('.tk-row.today', { hasText: name }).waitFor();
      check(`${size}: a weekly task shows only the weekday picker; saved, the form closes; due today it says so and is counted on the tab; ticked off it shows who did it; the tick can be taken back; nothing is wider than the screen`,
        /due today/.test(before.meta) && +before.badge >= 1 && /Done by/.test(after.meta) && after.checked === 'true' && sw.sw <= sw.cw + 1 && pickers.week && !pickers.month && formShut, JSON.stringify({ before, after, sw, pickers, formShut }));
    });
    await step('tasks: the owner lets agents tick a marked task; the agent\'s tick shows its name and what it checked', async () => {   // T-0245
      const name = `Daily backups (${size})`;
      await page.goto(BASE + '/billing', { waitUntil: 'networkidle' }); await page.evaluate(() => { location.hash = 'team'; }); await page.locator('#at-on').waitFor();
      if (!(await page.locator('#at-on').isChecked())) await page.locator('#at-on').check(); await sleep(500);
      const saved = await page.evaluate(async () => (await (await fetch('/account/workspace')).json()).agentTasks);
      await page.goto(BASE + '/app', { waitUntil: 'networkidle' });
      await page.click('.tab[data-view="tasks"]'); await page.waitForSelector('#tasks-view.active', { state: 'visible' });
      await page.click('#tk-add-btn'); await page.fill('#tk-title', name); await page.selectOption('#tk-every', 'day'); await page.locator('#tk-agent').check(); await page.click('#tk-save');
      const row = page.locator('.tk-row', { hasText: name }); await row.waitFor(); const marked = await row.locator('.tk-meta').innerText();
      const res = await page.evaluate(async n => { const ah = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sessionStorage.getItem('bcAsker') };
        const t = ((await (await fetch('/api/tasks', { headers: ah })).json()).tasks || []).find(x => x.title === n) || {};
        const r = await fetch(`/api/tasks/${t.id}/done`, { method: 'POST', headers: ah, body: JSON.stringify({ note: 'Backup ok at 03:46 UTC, 19 copies kept' }) }); await loadTaskList(); return { status: r.status, may: t.mayTick }; }, name);
      const done = page.locator('.tk-row.done', { hasText: name }); await done.waitFor(); const meta = await done.locator('.tk-meta').innerText(); await shot('tasks-agent');
      const sw = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      check(`${size}: the owner lets agents see Tasks and marks a task; the agent ticks it with a note; the row shows the agent and the note; fits the screen (T-0245)`, saved === true && /an agent may tick it off/.test(marked) && res.status === 200 && res.may === true && /\(agent\)/.test(meta) && /19 copies kept/.test(meta) && sw.sw <= sw.cw + 1, JSON.stringify({ saved, marked, res, meta, sw }));
    });
    await step('a scheduled message says it was scheduled', async () => {                              // T-0214
      const made = await page.evaluate(async () => {
        const r = await fetch('/account/workspace/schedules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spec: '* * * * *', tz: 'UTC', room: 'general', text: 'Scheduled check: is everything still running?' }) });
        const d = await r.json(); await fetch('/api/_test/tick?at=' + Date.now());
        return { status: r.status, id: d.schedule && d.schedule.id };
      });
      await page.click('.tab[data-view="chat"]'); await page.evaluate(() => { if (currentRoom !== 'general') switchRoom('general'); });
      const tag = page.locator('.msg', { hasText: 'Scheduled check: is everything still running?' }).last().locator('.auto-tag'); await tag.waitFor(); await shot('scheduled-tag');
      const info = await tag.evaluate(a => ({ text: a.textContent, href: a.getAttribute('href'), title: a.getAttribute('title'), plain: document.querySelectorAll('.msg .auto-tag').length, all: document.querySelectorAll('.msg').length }));
      const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
      check(`${size}: a message a schedule posted carries a Scheduled tag next to the name, says nobody typed it, and links to that schedule; ordinary messages have no tag`, made.status === 201 && info.text === 'Scheduled' && info.href === '/billing#sched-' + made.id && /Nobody typed this just now/.test(info.title || '') && info.plain < info.all && fits, JSON.stringify({ made, info, fits }));
      await page.evaluate(async id => { await fetch('/account/workspace/schedules/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delete: true }) }); }, made.id);
    });
    await step('accent row: RGB and the custom colour (Settings > Display, T-0329)', async () => {                            // 2026-11-13: RGB added; the colour chooser used to look like a sixth ready-made colour
      await page.click('.tab[data-view="chat"]');
      check(`${size}: the settings wheel in the app is a drawn icon (not a character some devices lack)`, await page.evaluate(() => (document.querySelector('#gear-btn svg')?.getBoundingClientRect().width || 0) >= 14));
      const openDisplay = async () => { await page.goto(BASE + '/settings', { waitUntil: 'networkidle' }); await page.evaluate(() => { location.hash = 'display'; }); await page.locator('#theme-picker').waitFor(); };   // T-0329
      await openDisplay();
      const customText = (await page.locator('#accent-custom-wrap').innerText()).trim(), nameBefore = await page.locator('#accent-name').textContent();
      const pick = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent-pick').trim());
      await page.click('#accent-rgb'); const a1 = await pick(); await sleep(700); const a2 = await pick(); await shot('accent-rgb');
      const st = await page.evaluate(() => ({ key: localStorage.getItem('chamber_accent'), on: document.getElementById('accent-rgb').classList.contains('on'), name: document.getElementById('accent-name').textContent,
        cost: (() => { const t = performance.now(); for (let i = 0; i < 20; i++) { document.documentElement.style.setProperty('--accent-pick', ChamberTheme.rgbColor(i * 18, 1, false)); getComputedStyle(document.body).color; document.body.offsetHeight; } return Math.round((performance.now() - t) / 20 * 100) / 100; })() }));
      check(`${size}: RGB makes the accent colour travel, is marked as chosen and named in words`, nameBefore === 'Spring' && a1 !== a2 && /^#[0-9a-f]{6}$/.test(a2) && st.key === 'rgb' && st.on && /RGB/.test(st.name), JSON.stringify({ nameBefore, a1, a2, st }));
      console.log(`  note ${size}: one RGB colour step costs about ${st.cost} ms in this browser (it takes ten steps a second)`);
      const worst = await page.evaluate(() => { let d = 1, l = 0; for (let h = 0; h < 360; h++) for (const b of [0.92, 1]) { d = Math.min(d, ChamberTheme.hexLum(ChamberTheme.rgbColor(h, b, false))); l = Math.max(l, ChamberTheme.hexLum(ChamberTheme.halfBlack(ChamberTheme.rgbColor(h, b, true)))); } return { darkest_on_dark: d, lightest_on_light: l }; });
      check(`${size}: every colour on the RGB wheel stays readable, on dark and on light`, worst.darkest_on_dark >= 0.25 && worst.lightest_on_light <= 0.16, JSON.stringify(worst));
      await page.goto(BASE + '/app', { waitUntil: 'networkidle' }); await page.waitForSelector('#msg-input:not([disabled])'); const r1 = await pick(); await sleep(700); const r2 = await pick();
      check(`${size}: RGB picked in Settings is remembered, and the app shows it (T-0329)`, r1 !== r2 && /^#[0-9a-f]{6}$/.test(r2), JSON.stringify({ r1, r2 }));
      await openDisplay(); await page.click('#theme-picker .swatch[data-accent="#00d4ff"]'); const c1 = await pick(); await sleep(400); const c2 = await pick();
      check(`${size}: picking a fixed colour stops RGB`, c1 === '#00d4ff' && c2 === '#00d4ff' && (await page.locator('#accent-name').textContent()) === 'Cyan', JSON.stringify({ c1, c2 }));
      await page.fill('#accent-custom', '#a1b2c3');
      const cu = await page.evaluate(() => ({ on: document.getElementById('accent-custom-wrap').classList.contains('on'), name: document.getElementById('accent-name').textContent, anySwatch: !!document.querySelector('#theme-picker .swatch.on') }));
      check(`${size}: the colour chooser is labelled "Custom", and is marked and named when it is the one in use`, /custom/i.test(customText) && cu.on && /Custom colour #a1b2c3/.test(cu.name) && !cu.anySwatch && (await pick()) === '#a1b2c3', JSON.stringify({ customText, cu })); await shot('accent-custom');
      const fits = await page.evaluate(() => { const m = document.getElementById('set-look').closest('.set-card').getBoundingClientRect(), sw = [...document.querySelectorAll('#theme-picker .swatch')].map(e => e.getBoundingClientRect()); return { inside: [...document.querySelectorAll('#theme-picker > *, #accent-foot > *, #accent-name')].map(e => e.getBoundingClientRect()).every(r => r.width > 0 && r.left >= m.left - 1 && r.right <= m.right + 1), oneRow: sw.every(r => Math.abs((r.top + r.bottom) - (sw[0].top + sw[0].bottom)) < 2), n: sw.length, w: sw[0].width }; });
      check(`${size}: the six colours sit in one row inside the Display card, big enough to tap, with Custom and Reset under them`, fits.inside && fits.oneRow && fits.n === 6 && fits.w >= 26, JSON.stringify(fits));
      await page.click('#accent-reset'); await sleep(300); const back = await page.evaluate(() => ({ key: localStorage.getItem('chamber_accent'), name: document.getElementById('accent-name').textContent }));
      check(`${size}: Reset goes back to the standard colour`, back.key === null && (await pick()) === '#00ff88' && back.name === 'Spring', JSON.stringify(back));
      await page.goto(BASE + '/app', { waitUntil: 'networkidle' }); await page.waitForSelector('#msg-input:not([disabled])');
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
    await step('Lock now shows only the unlock form; the password opens the app again', async () => {   // T-0241 part 1
      await page.click('#gear-btn'); const lk = page.locator('#menu-lock'); await lk.scrollIntoViewIfNeeded(); await lk.click();
      await page.locator('#screen-lock').waitFor(); await page.locator('#sl-unlock-pw').waitFor();
      const st = await page.evaluate(h => { const r = document.getElementById('screen-lock').getBoundingClientRect(), m = document.getElementById('messages');
        return { covers: r.width >= innerWidth - 1 && r.height >= innerHeight - 1, says: /Chamber is locked/.test(document.getElementById('screen-lock').innerText), leaked: document.body.innerText.includes(h) || (m ? m.textContent.includes(h) : false),
                 focus: document.activeElement && document.activeElement.id, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }; }, hello);
      await shot('screen-lock');
      check(`${size}: Lock now replaces the app with the unlock form; no message from the workspace is left in the page`, st.covers && st.says && !st.leaked && st.focus === 'sl-unlock-pw' && st.sw <= st.cw + 1, JSON.stringify(st));
      await page.fill('#sl-unlock-pw', 'not-the-password'); await page.click('#sl-unlock button[type=submit]');
      await page.locator('#sl-unlock-msg', { hasText: /wrong/i }).waitFor();
      check(`${size}: a wrong password says so and stays locked`, await page.locator('#screen-lock').isVisible());
      await page.fill('#sl-unlock-pw', pw); await page.click('#sl-unlock button[type=submit]');
      await page.waitForSelector('#msg-input:not([disabled])'); await page.locator('#messages', { hasText: hello }).waitFor();
      check(`${size}: the right password opens the app again with the messages`, !(await page.locator('#screen-lock').count()));
      errs = errs.filter(e => !/^(423 |403 \/account\/unlock)/.test(e));      // the 423s and the wrong password above were on purpose
    });
    await step('Account page: screen lock choices save', async () => {                             // T-0241 part 1
      await page.goto(BASE + '/billing', { waitUntil: 'networkidle' }); await page.evaluate(() => { location.hash = 'you'; });
      await page.locator('#sl-box').scrollIntoViewIfNeeded(); await page.locator('#sl-state', { hasText: /Off/ }).waitFor();
      await page.selectOption('#sl-idle', '15'); await page.check('#sl-reopen'); await page.click('#sl-form button[type=submit]');
      await page.locator('#sl-msg', { hasText: /Saved/ }).waitFor(); await page.locator('#sl-box').scrollIntoViewIfNeeded(); await shot('screen-lock-settings');
      const on = (await page.locator('#sl-state').innerText()).trim();
      await page.selectOption('#sl-idle', '0'); await page.uncheck('#sl-reopen'); await page.click('#sl-form button[type=submit]');
      await page.locator('#sl-msg', { hasText: /password/i }).waitFor(); const still = (await page.locator('#sl-state').innerText()).trim();
      await page.fill('#sl-pw', pw); await page.click('#sl-form button[type=submit]'); await page.locator('#sl-msg', { hasText: /is off/i }).waitFor();
      const off = (await page.locator('#sl-state').innerText()).trim(), fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
      check(`${size}: Account > Security > Screen lock saves a stricter choice at once, asks for the password to loosen it, and fits the screen`, on === 'On' && still === 'On' && off === 'Off' && fits, JSON.stringify({ on, still, off, fits }));
      errs = errs.filter(e => !/^403 \/account\/screen-lock/.test(e));            // the loosen-without-password refusal above was on purpose
    });
    await step('Account page: signed-in devices list, sign out another device', async () => {        // T-0241 part 2
      const other = await fetch(BASE + '/account/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'chamber-cli/1.4' }, body: JSON.stringify({ email, password: pw }) });
      const otherTok = (await other.json()).token;
      await page.goto(BASE + '/billing', { waitUntil: 'networkidle' }); await page.evaluate(() => { location.hash = 'you'; });
      await page.locator('#ss-list .ss-row').first().waitFor(); await page.locator('#ss-box').scrollIntoViewIfNeeded();
      const before = await page.locator('#ss-list .ss-row').count(), hasThis = await page.locator('#ss-list .pill', { hasText: 'this device' }).count();
      await shot('devices');
      const cliRow = page.locator('#ss-list .ss-row', { hasText: 'Chamber command-line tool' }); await cliRow.locator('button').click();
      await page.locator('#ss-msg', { hasText: /Signed out that device/ }).waitFor();
      const gone = !(await page.locator('#ss-list .ss-row', { hasText: 'Chamber command-line tool' }).count());
      const dead = (await fetch(BASE + '/api/me', { headers: { Authorization: 'Bearer ' + otherTok } })).status === 401;
      const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
      check(`${size}: Account > Security lists signed-in devices (this one marked) and Sign out ends another device's sign-in`, before >= 2 && hasThis === 1 && gone && dead && fits, JSON.stringify({ before, hasThis, gone, dead, fits }));
    });
    await step('Account page: rules for everyone limit the screen lock choices; loosening them needs the password', async () => {   // T-0241 part 3
      await page.goto(BASE + '/billing', { waitUntil: 'networkidle' }); await page.evaluate(() => { location.hash = 'you'; }); await page.locator('#sr-box').waitFor(); await page.locator('#sr-box').scrollIntoViewIfNeeded();
      await page.selectOption('#sr-idle', '15'); await page.locator('#sr-form button[type=submit]').click(); await page.locator('#sr-msg', { hasText: /Saved/ }).waitFor();
      await sleep(400); await page.locator('#sl-box').scrollIntoViewIfNeeded();
      const limited = await page.evaluate(() => ({ never: document.querySelector('#sl-idle option[value="0"]').disabled, thirty: document.querySelector('#sl-idle option[value="30"]').disabled, five: document.querySelector('#sl-idle option[value="5"]').disabled, note: document.getElementById('sl-rule').hidden ? '' : document.getElementById('sl-rule').textContent, state: document.getElementById('sr-state').textContent }));
      await shot('rules-for-everyone');
      await page.locator('#sr-box').scrollIntoViewIfNeeded(); await page.selectOption('#sr-idle', '0'); await page.locator('#sr-form button[type=submit]').click(); await page.locator('#sr-msg', { hasText: /password/i }).waitFor();
      const refused = await page.locator('#sr-msg').innerText();
      errs = errs.filter(e => e !== '403 /account/workspace');                                  // that refusal (no password) was on purpose
      await page.fill('#sr-pw', pw); await page.locator('#sr-form button[type=submit]').click(); await page.locator('#sr-msg', { hasText: /Saved/ }).waitFor(); await sleep(400);
      const freed = await page.evaluate(() => ({ never: document.querySelector('#sl-idle option[value="0"]').disabled, note: document.getElementById('sl-rule').hidden, state: document.getElementById('sr-state').textContent }));
      const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
      check(`${size}: Account > Rules for everyone: a 15-minute rule greys out Never and 30 minutes in the person's own screen lock and says why; loosening asks for the password; removed, the choices come back; fits the screen`,
        limited.never && limited.thirty && !limited.five && /requires a lock after at most 15 minutes/.test(limited.note) && limited.state === 'On' && /password/i.test(refused) && !freed.never && freed.note && freed.state === 'Off' && fits, JSON.stringify({ limited, refused, freed, fits }));
    });
    await step('confirm it is you: a sensitive change asks for the password in place and then goes through', async () => {   // T-0241 part 4
      await page.goto(BASE + '/billing', { waitUntil: 'networkidle' }); await page.evaluate(() => { location.hash = 'you'; }); await page.locator('#rc-box').waitFor(); await page.locator('#rc-box').scrollIntoViewIfNeeded();
      await page.selectOption('#rc-min', '5'); await page.locator('#rc-form button[type=submit]').click(); await page.locator('#rc-msg', { hasText: /Saved/ }).waitFor();
      await page.evaluate(() => fetch('/api/_test/recheck-age', { method: 'POST' }));
      await page.locator('#ss-box').scrollIntoViewIfNeeded(); await page.selectOption('#sp-days', '1'); await page.locator('#sp-form button[type=submit]').click();
      await page.locator('#recheck #rc-pw-x').waitFor(); await shot('recheck'); const asked = await page.locator('#recheck').innerText();
      const boxFits = await page.evaluate(() => { const f = document.querySelector('#recheck form').getBoundingClientRect(); return f.left >= 0 && f.right <= window.innerWidth; });
      await page.fill('#rc-pw-x', 'not-the-password'); await page.click('#rc-ok-x'); await page.locator('#rc-msg-x', { hasText: /./ }).waitFor(); const wrong = await page.locator('#rc-msg-x').innerText();
      await page.fill('#rc-pw-x', pw); await page.click('#rc-ok-x'); await page.locator('#sp-msg', { hasText: /Saved/ }).waitFor();
      const gone = !(await page.locator('#recheck').count());
      errs = errs.filter(e => !/^403 \/account\/(session-policy|recheck)$/.test(e));                    // the refusal and the wrong password were on purpose
      await page.locator('#rc-box').scrollIntoViewIfNeeded(); await page.selectOption('#rc-min', '0'); await page.fill('#rc-pw', pw); await page.locator('#rc-form button[type=submit]').click(); await page.locator('#rc-msg', { hasText: /does not ask/ }).waitFor();
      const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
      check(`${size}: ask again before sensitive actions: an old check makes a sign-in length change show "Confirm it is you"; a wrong password is refused there; the right one saves the change without redoing it; fits the screen (T-0241 part 4)`,
        /Confirm it is you/.test(asked) && boxFits && /wrong/i.test(wrong) && gone && fits, JSON.stringify({ asked: asked.slice(0, 160), boxFits, wrong, gone, fits }));
    });
    await step('passkeys: add one with the device, then unlock the screen lock with it', async () => {   // T-0241 part 5
      const LB = BASE.replace('127.0.0.1', 'localhost'), ctx3 = await browser.newContext(SIZES[size]), p3 = await ctx3.newPage(); p3.setDefaultTimeout(15000);   // passkeys need a host name, not an IP address
      const errs3 = []; p3.on('pageerror', e => errs3.push(e.message));
      try {
        const cdp = await ctx3.newCDPSession(p3); await cdp.send('WebAuthn.enable');
        await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
        await p3.goto(LB + '/login', { waitUntil: 'networkidle' }); await p3.fill('#li-email', email); await p3.fill('#li-pass', pw); await p3.click('button[type=submit]:visible');
        await p3.waitForURL(u => !/\/login/.test(String(u)), { timeout: 15000 }); await p3.goto(LB + '/billing', { waitUntil: 'networkidle' }); await p3.evaluate(() => { location.hash = 'you'; });
        await p3.locator('#pk-box').waitFor(); await p3.locator('#pk-box').scrollIntoViewIfNeeded(); await p3.fill('#pk-name', 'Check key'); await p3.click('#pk-add');
        await p3.locator('#pk-msg', { hasText: /Passkey added/ }).waitFor(); const listed = await p3.locator('#pk-list').innerText();
        try { await p3.screenshot({ path: path.join(OUT, `${size}-passkeys.png`) }); } catch {}
        await p3.goto(LB + '/app', { waitUntil: 'networkidle' }); await p3.evaluate(() => window.ChamberScreenLock.lockNow());
        await p3.locator('#sl-passkey').waitFor(); try { await p3.screenshot({ path: path.join(OUT, `${size}-unlock-passkey.png`) }); } catch {}
        await p3.click('#sl-passkey'); await p3.waitForFunction(() => !document.getElementById('screen-lock') && document.querySelector('.tab[data-view="chat"]'), null, { timeout: 15000 });
        const fits = await p3.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
        check(`${size}: passkeys: one is added with the device, listed by name, and then unlocks the screen lock without the password (T-0241 part 5)`, /Check key/.test(listed) && fits && !errs3.length, JSON.stringify({ listed, fits, errs3 }));
      } finally { await ctx3.close(); }
    });
    await step('account page follows the colour picked in the app', async () => {                 // 2026-11-13
      await page.evaluate(() => localStorage.setItem('chamber_accent', 'rgb')); await page.goto(BASE + '/billing', { waitUntil: 'networkidle' });
      const pick = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent-pick').trim());
      const b1 = await pick(); await sleep(700); const b2 = await pick();
      await page.evaluate(() => { location.hash = 'display'; }); await page.locator('#theme-picker').waitFor(); const on = await page.evaluate(() => document.getElementById('accent-rgb').classList.contains('on')); await shot('account-wheel');
      check(`${size}: RGB picked in the app carries over to Settings, and Display there shows it as chosen (T-0329)`, b1 !== b2 && on, JSON.stringify({ b1, b2, on }));
      await page.click('#accent-reset'); await page.keyboard.press('Escape');
    });
    await step('managers and clients: approval rules and a requester', async () => {               // T-0190, T-0199
      await page.goto(BASE + '/billing', { waitUntil: 'networkidle' }); await page.evaluate(() => { location.hash = 'rules'; });
      await page.locator('#ap-save').waitFor(); const rulesOk = await page.locator('#ap-save').isEnabled() && await page.locator('#ap-two').isVisible();
      await page.evaluate(() => { location.hash = 'team'; }); await page.locator('button[data-gnew="requester"]').click(); await page.locator('button[data-gcopy="requester"]').waitFor();
      const link = await page.evaluate(() => [...document.querySelectorAll('.guest-inv code')].map(c => c.textContent).find(t => /\/join\//.test(t)));
      await page.locator('.guest-inv').first().scrollIntoViewIfNeeded(); await shot('guest-links');
      const ctx2 = await browser.newContext(SIZES[size]); const p2 = await ctx2.newPage(); p2.setDefaultTimeout(12000); const errs2 = []; p2.on('pageerror', e => errs2.push(e.message));
      try {
        await p2.goto(link, { waitUntil: 'networkidle' });
        const ru = `rq${size.slice(0, 1)}${Date.now().toString(36)}`;
        await p2.fill('#su-email', `${ru}@test.invalid`); await p2.fill('#su-user', ru); await p2.fill('#su-pass', 'browser-check-password'); await p2.click('button[type=submit]:visible');
        await p2.waitForFunction(() => !document.querySelector('#su-email')?.offsetParent, null, { timeout: 12000 });
        await p2.goto(BASE + '/app', { waitUntil: 'networkidle' }); const onReq = new URL(p2.url()).pathname === '/requests';
        await p2.fill('#rq-title', 'Please add a price list to the shop'); await p2.fill('#rq-body', 'Sent by the browser check.');
        await p2.setInputFiles('#rq-files', { name: 'price list.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64') });   // T-0206: a 1 x 1 picture
        const pickedNote = await p2.locator('#rq-files-note').innerText(); await p2.click('#rq-send');
        await p2.locator('#rq-list', { hasText: 'Please add a price list to the shop' }).waitFor();
        const info = await p2.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, status: document.querySelector('#rq-list .st')?.textContent }));
        const mailRow = await p2.evaluate(() => { const r = document.getElementById('rq-mail-row'), c = document.getElementById('rq-mail'); return { shown: !!r && !r.hidden && r.offsetParent !== null, checked: !!c && c.checked, off: !!c && c.disabled, note: document.getElementById('rq-mail-note')?.textContent || '' }; });   // T-0205
        check(`${size}: Your requests has the email switch, and says plainly when this Chamber cannot send email`, mailRow.shown && mailRow.checked && (mailRow.off ? /no email set up/.test(mailRow.note) : true), JSON.stringify(mailRow));
        const pic = await p2.evaluate(async () => { const im = document.querySelector('#rq-list .rq-files img'); if (!im) return { found: false }; if (!im.complete) await new Promise(r => { im.onload = im.onerror = r; }); return { found: true, w: im.naturalWidth, src: im.getAttribute('src'), sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }; });   // T-0206
        check(`${size}: a picture added to a request is named before sending, goes with it, and shows on the requester's own request`, /price list\.png/.test(pickedNote) && pic.found && pic.w === 1 && /^\/api\/requests\/files\/[a-f0-9]{24}$/.test(pic.src) && pic.sw <= pic.cw + 1, JSON.stringify({ pickedNote, pic }));
        try { await p2.screenshot({ path: path.join(OUT, `${size}-requests.png`), fullPage: true }); } catch {}
        const reqId = await p2.evaluate(() => (document.querySelector('#rq-list .rq .dim')?.textContent.match(/T-\d+/) || [])[0] || '');                // T-0216: the team asks, the client answers
        const sentQ = await page.evaluate(async id => (await fetch(`/api/tickets/${id}/question`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Which prices should the list show?' }) })).status, reqId);
        await p2.reload({ waitUntil: 'networkidle' }); const qBox = p2.locator('#rq-list .rq-q', { hasText: 'Which prices should the list show?' }); await qBox.waitFor();
        try { await p2.screenshot({ path: path.join(OUT, `${size}-requests-question.png`), fullPage: true }); } catch {}
        await qBox.locator('textarea').fill('All the drinks, please.'); await qBox.locator('button').click(); await p2.locator('#rq-list .rq-a', { hasText: 'All the drinks, please.' }).waitFor();
        const qa = await p2.evaluate(() => ({ boxes: document.querySelectorAll('#rq-list .rq-q').length, text: document.querySelector('#rq-list .rq-a')?.innerText || '', sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
        check(`${size}: a question from the team shows under the client's request with an answer box; the answer is sent and shown, inside the screen`, sentQ === 200 && qa.boxes === 0 && /The team asked: Which prices should the list show\?/.test(qa.text) && /You answered: All the drinks, please\./.test(qa.text) && qa.sw <= qa.cw + 1 && errs2.length === 0, JSON.stringify({ sentQ, qa, errs2 }));
        check(`${size}: a client who joins through a requester link lands on Your requests, sends a request and sees it waiting`, onReq && info.status === 'Waiting for approval' && info.sw <= info.cw + 1 && errs2.length === 0, JSON.stringify({ url: p2.url(), info, errs2 }));
      } finally { await ctx2.close(); }
      const board = await page.evaluate(async () => ((await (await fetch('/api/tickets')).json()).tickets || []).some(t => /Please add a price list to the shop/.test(t.title) && (t.tags || []).includes('request')));
      await page.goto(BASE + '/app', { waitUntil: 'networkidle' });                 // T-0206: the team sees the picture on the ticket
      const seen = await page.evaluate(async () => { const t = ((await (await fetch('/api/tickets')).json()).tickets || []).find(t => /Please add a price list to the shop/.test(t.title)); if (!t) return {}; await loadTickets(); openTicketModal(t.id); await new Promise(r => setTimeout(r, 300)); const box = document.getElementById('tm-files'), im = box && box.querySelector('img'); if (im && !im.complete) await new Promise(r => { im.onload = im.onerror = r; }); const out = { files: (t.files || []).length, shown: !!box && box.style.display !== 'none' && /Sent with the request/.test(box.textContent), w: im ? im.naturalWidth : 0, fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 }; closeTicketModal(); return out; });
      check(`${size}: the team sees the requester's picture on the ticket`, seen.files === 1 && seen.shown && seen.w === 1 && seen.fits, JSON.stringify(seen));
      const cqSeen = await page.evaluate(async () => {                                // T-0216: the ticket shows the exchange, and the next question can be typed
        const t = ((await (await fetch('/api/tickets')).json()).tickets || []).find(t => /Please add a price list to the shop/.test(t.title)); if (!t) return {};
        await loadTickets(); openTicketModal(t.id); await new Promise(r => setTimeout(r, 300));
        const box = document.getElementById('tm-cq'), out = { shown: !!box && box.style.display !== 'none', txt: box ? box.innerText : '', form: !!document.getElementById('cq-text'), fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 };
        closeTicketModal(); return out; });
      check(`${size}: the ticket shows the question, who asked, and the client's answer, with room for the next question`, cqSeen.shown && /Questions to the requester/.test(cqSeen.txt) && /Which prices should the list show\?/.test(cqSeen.txt) && /answered, .*All the drinks, please\./.test(cqSeen.txt.replace(/\n/g, ' ')) && cqSeen.form && cqSeen.fits, JSON.stringify(cqSeen).slice(0, 400));
      const drafted = await page.evaluate(async () => {                               // T-0207: an agent drafts a plan for the request; a person adds it
        const h = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sessionStorage.getItem('bcAsker') };
        let job = null; for (let i = 0; i < 6 && !(job && /price list/.test(job.title)); i++) job = (await (await fetch('/api/drafts/next', { headers: h })).json()).job;
        if (!job) return { job: null };
        const r = await fetch(`/api/tickets/${job.ticket}/draft`, { method: 'POST', headers: h, body: JSON.stringify({ understood: 'The client wants a price list on the shop page.', plan: '1. Add a prices section to shop.html\n2. Link it from the menu', touches: 'shop.html', risk: 'low', risk_why: 'one page', who: 'agent', who_why: 'small and clear', question: 'Which prices should be listed?' }) });
        await loadTickets(); openTicketModal(job.ticket); await new Promise(r => setTimeout(r, 300));
        const box = document.getElementById('tm-draft');
        return { status: r.status, files: (job.files || []).length, shown: !!box && box.style.display !== 'none', txt: box ? box.innerText : '', fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 };
      });
      check(`${size}: an agent's draft shows on the request as a suggestion, apart from the request itself`, drafted.status === 201 && drafted.files === 1 && drafted.shown && /Agent's suggestion/.test(drafted.txt) && /not part of the ticket until a person adds it/.test(drafted.txt) && /Which prices should be listed/.test(drafted.txt) && drafted.fits, JSON.stringify(drafted).slice(0, 500));
      await shot('request-draft');
      await page.locator('#tm-draft button', { hasText: 'Add to the ticket' }).click();
      await page.waitForFunction(() => /Plan drafted by/.test(document.getElementById('tm-body')?.innerText || ''), null, { timeout: 8000 });
      const usedD = await page.evaluate(() => ({ body: document.getElementById('tm-body').innerText, draft: document.getElementById('tm-draft').innerText, btn: !!document.querySelector('#tm-draft button') })); await page.evaluate(() => closeTicketModal());
      check(`${size}: Add to the ticket puts the plan under the request and says who added it`, /Sent by the browser check\./.test(usedD.body) && /Link it from the menu/.test(usedD.body) && /added to the ticket by/.test(usedD.draft) && !usedD.btn, JSON.stringify(usedD).slice(0, 400));
      await page.goto(BASE + '/billing', { waitUntil: 'networkidle' });
      check(`${size}: the account page shows the approval rules, makes a requester link, and the owner sees the request on the board`, rulesOk && !!link && board, JSON.stringify({ rulesOk, link: !!link, board }));
    });
    await step('account page: check the record and AI usage', async () => {                           // T-0194
      await page.goto(BASE + '/billing', { waitUntil: 'networkidle' }); await page.evaluate(() => { location.hash = 'data'; });
      await page.locator('#au-verify').scrollIntoViewIfNeeded(); await page.click('#au-verify');
      await page.locator('#au-verify-msg', { hasText: /Intact|Nothing to check/ }).waitFor();
      await page.waitForFunction(() => !/Loading/.test(document.getElementById('usage-box')?.innerText || 'Loading'));
      const t = await page.evaluate(() => ({ v: document.getElementById('au-verify-msg').innerText, u: document.getElementById('usage-box').innerText, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      await page.evaluate(() => { location.hash = 'ai'; }); await page.locator('#usage').scrollIntoViewIfNeeded(); await shot('record-usage');
      check(`${size}: the account page checks the record and shows AI usage`, /Intact/.test(t.v) && t.u.length > 10 && t.sw <= t.cw + 1, JSON.stringify(t).slice(0, 300));
    });
    await step('account page: keep-for setting, passphrase and a sealed copy opened in the browser', async () => {   // T-0219
      await page.goto(BASE + '/billing', { waitUntil: 'networkidle' }); await page.evaluate(() => { location.hash = 'data'; });
      await page.locator('#rec-box').waitFor({ state: 'visible' }); await page.locator('#rec-pass').scrollIntoViewIfNeeded();
      const hadKey = !(await page.locator('#rec-key-new').isVisible());
      if (!hadKey) {                                                              // the first screen size makes the key; the second finds it set and changes nothing
        await page.fill('#rec-pass', 'short'); await page.fill('#rec-pass2', 'short'); await page.click('#rec-key-make');
        await page.locator('#rec-key-msg', { hasText: /12 characters or more/ }).waitFor();
        await page.fill('#rec-pass', 'a passphrase for the browser check'); await page.fill('#rec-pass2', 'a passphrase for the browser check'); await page.click('#rec-key-make');
        await page.locator('#rec-code-box').waitFor({ state: 'visible', timeout: 60000 });
        const code = await page.locator('#rec-code').innerText(); await shot('record-passphrase');
        check(`${size}: the owner sets a passphrase in the browser and is shown a recovery code once`, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){5}$/.test(code) && await page.locator('#rec-key-change').isVisible(), code.replace(/[A-Z2-9]/g, 'X'));
      }
      const before = await page.locator('#rec-saved .row-item').count();
      await page.click('#rec-now'); await page.locator('#rec-saved-msg', { hasText: /Saved a sealed copy/ }).waitFor();
      const row = page.locator('#rec-saved .row-item').first();
      await page.fill('#rec-open-pass', 'this is not the passphrase'); await row.locator('a[data-open]').click(); await page.locator('#rec-saved-msg', { hasText: /does not open this copy/ }).waitFor({ timeout: 60000 });
      await page.fill('#rec-open-pass', 'a passphrase for the browser check'); await row.locator('a[data-open]').click(); await page.locator('#rec-saved-msg', { hasText: /Opened here in your browser/ }).waitFor({ timeout: 60000 });
      const got = await page.evaluate(async () => { const r = document.querySelector('#rec-saved .row-item'), links = [...r.querySelectorAll('a.rec-dl')];
        const doc = JSON.parse(await (await fetch(links.find(a => /JSON/.test(a.textContent)).href)).text()), csv = await (await fetch(links.find(a => /CSV/.test(a.textContent)).href)).text();
        const sealed = await (await fetch('/account/workspace/records-saved/' + r.dataset.copy)).text();
        return { n: doc.entries.length, acts: doc.entries.map(e => e.action), head: csv.split('\n')[0], opened: r.dataset.opened, sealedHasAction: /owner-key-set|signup|record-copy-saved/.test(sealed), kind: JSON.parse(sealed).kind, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }; });
      await row.scrollIntoViewIfNeeded(); await shot('record-sealed-copy');
      check(`${size}: a sealed copy is saved, a wrong passphrase opens nothing, the right one opens it in the browser with JSON and CSV to download, and what the server holds is not readable`, (await page.locator('#rec-saved .row-item').count()) === before + 1
        && got.n >= 2 && got.acts.includes('owner-key-set') && got.head === 'ts,time_utc,actor,kind,action,details,request_id,ip' && got.opened === String(got.n) && got.sealedHasAction === false && got.kind === 'chamber-sealed-record' && got.sw <= got.cw + 1, JSON.stringify(got).slice(0, 400));
      page.once('dialog', d => d.accept());
      await page.selectOption('#rec-days', '90'); await page.check('#rec-copy'); await page.click('#rec-save'); await page.locator('#rec-msg', { hasText: /older than 90 days are removed once a day, after a sealed copy/ }).waitFor();
      await page.selectOption('#rec-days', '0'); await page.uncheck('#rec-copy'); await page.click('#rec-save'); await page.locator('#rec-msg', { hasText: /kept for good/ }).waitFor();
      check(`${size}: the owner sets how long the record is kept, with a sealed copy first, and can go back to keeping it for good`, true);
    });
    await step('account page: owner lock on, locked, unlocked, off', async () => {                     // T-0222
      page.removeAllListeners('dialog');                                            // an earlier step may leave a one-time dialog handler behind
      await page.goto(BASE + '/billing', { waitUntil: 'networkidle' }); await page.evaluate(() => { location.hash = 'data'; });
      await page.locator('#lock-box').waitFor({ state: 'visible' }); await page.locator('#lock-box').scrollIntoViewIfNeeded();
      const off0 = await page.locator('#lock-state').innerText();
      page.once('dialog', d => d.accept()); await page.click('#lock-on');
      await page.locator('#lock-state', { hasText: /On, and open/ }).waitFor({ timeout: 60000 }); await shot('owner-lock-on');
      page.once('dialog', d => d.accept()); await page.click('#lock-close'); await page.locator('#lock-state', { hasText: /^Locked\./ }).waitFor();
      const p2 = await page.context().newPage(); await p2.goto(BASE + '/app', { waitUntil: 'networkidle' }); await p2.locator('#ws-locked').waitFor({ timeout: 15000 });
      const appTxt = await p2.locator('body').innerText(), msgs = await p2.evaluate(async () => (await fetch('/api/messages?room=general')).status); await shot('owner-lock-app'); await p2.close();
      await page.fill('#lock-pass', 'not the right passphrase'); await page.click('#lock-unlock'); await page.locator('#lock-msg', { hasText: /does not open it/ }).waitFor({ timeout: 60000 });
      await page.fill('#lock-pass', 'a passphrase for the browser check'); await page.click('#lock-unlock'); await page.locator('#lock-state', { hasText: /On, and open/ }).waitFor({ timeout: 60000 });
      const opened = await page.evaluate(async () => (await fetch('/api/messages?room=general')).status);
      await page.fill('#lock-off-pw', pw); await page.click('#lock-off'); await page.locator('#lock-state', { hasText: /^Off\./ }).waitFor({ timeout: 60000 });
      const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1); await shot('owner-lock-off'); page.removeAllListeners('dialog');
      check(`${size}: the owner switches the lock on, locks it (the app then shows only that it is locked, and chat answers "locked"), unlocks it with the passphrase in the browser (a wrong one opens nothing) and switches it off with the password`,
        /^Off\./.test(off0) && /This workspace is locked/.test(appTxt) && /Unlock in Settings/.test(appTxt) && msgs === 423 && opened === 200 && fits, JSON.stringify({ off0: off0.slice(0, 40), app: appTxt.slice(0, 120), msgs, opened, fits }));
    });
    await step('weekly report: private link and page', async () => {                                   // T-0202
      await page.goto(BASE + '/billing', { waitUntil: 'networkidle' }); await page.evaluate(() => { location.hash = 'data'; });
      await page.locator('#rep-link').scrollIntoViewIfNeeded(); await page.click('#rep-link');
      await page.locator('#rep-url a').waitFor(); const href = await page.locator('#rep-url a').getAttribute('href');
      const p3 = await page.context().newPage(); try { await p3.goto(href, { waitUntil: 'networkidle' });
        const r = await p3.evaluate(() => ({ t: document.body.innerText, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
        try { await p3.screenshot({ path: path.join(OUT, `${size}-weekly-report.png`), fullPage: true }); } catch {}
        check(`${size}: the weekly report link opens a readable page that fits the screen`, /Weekly report/.test(r.t) && /In short/.test(r.t) && /Only measured facts/.test(r.t) && r.sw <= r.cw + 1, JSON.stringify({ sw: r.sw, cw: r.cw, t: r.t.slice(0, 120) }));
      } finally { await p3.close(); }
    });
    await step('account page offers extra storage when the server sells it', async () => {      // storage add-on: the server's answers are stood in for here (the server side has its own tests)
      let packs = 0, sent = null; const offer = () => ({ packGb: 10, label: '$5 / month', period: 'month', maxPacks: 10, baseMb: 500, packs, canChange: true, isPayer: true });   // T-0310: a monthly plan
      await page.route('**/account/me', async route => { const r = await route.fetch(); const j = await r.json(); j.storage = offer(); await route.fulfill({ response: r, json: j }); });
      await page.route('**/billing/storage', async route => { sent = JSON.parse(route.request().postData()); packs = sent.packs; const j = await (await page.request.get(BASE + '/account/me')).json(); j.storage = offer(); await route.fulfill({ json: j }); });
      let dialogs = 0; page.on('dialog', d => { dialogs++; d.dismiss(); });
      await page.goto(BASE + '/billing', { waitUntil: 'networkidle' }); await page.evaluate(() => { location.hash = 'billing'; });
      await page.locator('#sg-box').waitFor(); await page.locator('#sg-box').scrollIntoViewIfNeeded();
      const hiddenFirst = await page.locator('#sg-confirm').isHidden();
      await page.selectOption('#sg-packs', '2'); await page.click('#sg-save'); await page.locator('#sg-confirm').waitFor();
      const asked = await page.locator('#sg-what').textContent(), btn = await page.locator('#sg-yes').textContent();
      await page.locator('#sg-yes').scrollIntoViewIfNeeded(); await shot('storage-confirm');
      await page.click('#sg-yes'); await page.waitForTimeout(300); const sentWithoutPw = sent;                // no password typed: nothing may be sent
      await page.fill('#sg-pw', 'my-password-123'); await page.click('#sg-yes');
      await page.locator('#sg-box', { hasText: 'plus 20 GB extra' }).waitFor(); await page.locator('#sg-box').scrollIntoViewIfNeeded();
      const info = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, wide: [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && e.offsetParent).slice(0, 4).map(e => e.tagName + '#' + e.id + ':' + e.textContent.trim().slice(0, 30)) }));
      check(`${size}: the account page offers extra storage and says what will be charged before anything is sent`, hiddenFirst && /charged now/.test(asked) && /current month/.test(asked) && asked.includes('$5 / month') && asked.includes('20 GB') && /charge my card/.test(btn), asked.slice(0, 160));
      check(`${size}: adding storage asks for the password and sends nothing without it`, sentWithoutPw === null && sent?.packs === 2 && sent.password === 'my-password-123' && dialogs === 0, JSON.stringify({ sentWithoutPw, sent, dialogs }));
      check(`${size}: the account page shows the new amount and still fits the screen`, info.sw <= info.cw + 1, JSON.stringify(info)); await shot('storage-after');
      await page.selectOption('#sg-packs', '0'); await page.click('#sg-save'); const pwHidden = await page.locator('#sg-pw-wrap').isHidden(), redText = await page.locator('#sg-what').textContent();
      check(`${size}: reducing storage asks no password and says no files are deleted`, pwHidden && /No files are deleted/.test(redText), redText.slice(0, 120));
      await page.unroute('**/account/me'); await page.unroute('**/billing/storage');
    });
    await step('tasks: an agent proposes a duty with a reminder; the owner confirms it', async () => {   // T-0264 (runs after T-0245 switched agents on)
      const name = `Daily Moltbook check (${size})`;
      await page.goto(BASE + '/app', { waitUntil: 'networkidle' }); await page.click('.tab[data-view="tasks"]'); await page.waitForSelector('#tasks-view.active', { state: 'visible' });   // runs late, after the Account page steps
      const prop = await page.evaluate(async n => { const ah = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sessionStorage.getItem('bcAsker') };
        const r = await fetch('/api/tasks/propose', { method: 'POST', headers: ah, body: JSON.stringify({ title: n, every: 'day', remindAt: '09:00', tz: 'UTC' }) }); await loadTaskList(); return r.status; }, name);
      const row = page.locator('.tk-row.proposed', { hasText: name }); await row.waitFor(); const before = await row.innerText(); await shot('tasks-proposed');
      await row.locator('button', { hasText: 'Confirm' }).click();
      const live = page.locator('.tk-row:not(.proposed)', { hasText: name }); await live.waitFor(); const after = await live.locator('.tk-meta').innerText();
      await page.click('#tk-add-btn'); const formHas = await page.evaluate(() => !document.getElementById('tk-remind-l').hidden && document.getElementById('tk-remind-agent').options.length > 1); await page.evaluate(() => taskFormClose());
      const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
      check(`${size}: an agent's proposed task shows as proposed with Confirm; once confirmed it is a normal task that says whom it reminds and when; the form offers the reminder (T-0264)`,
        prop === 201 && /proposed by @/.test(before) && /Confirm/.test(before) && /reminds @\S+ at 09:00/.test(after) && formHas && fits, JSON.stringify({ prop, before, after, formHas, fits }));
    });
    await step('files: upload a new version of a file, see v2 and the earlier version', async () => {   // T-0266
      await page.goto(BASE + '/app', { waitUntil: 'networkidle' });   // it runs late, after the Account page steps
      const fid = await page.evaluate(async () => {
        const up = await (await fetch('/api/files?room=general', { method: 'POST', headers: { 'Content-Type': 'text/markdown', 'X-File-Name': 'living-sop.md' }, body: 'first version' })).json();
        await fetch('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: 'general', text: 'the living SOP', attachments: [up.file.id] }) });
        return up.file.id;
      });
      await page.click('.tab[data-view="files"]'); await page.waitForSelector('#files-view.active', { state: 'visible' }); await page.evaluate(() => openFolder(''));
      const card = page.locator(`.fcard[data-fid="${fid}"]`); await card.waitFor();
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), card.locator('.facts a', { hasText: 'new version' }).click()]);
      await chooser.setFiles({ name: 'living-sop.md', mimeType: 'text/markdown', buffer: Buffer.from('second version, a little longer') });
      await page.locator(`.fcard[data-fid="${fid}"] .fver`, { hasText: 'v2' }).waitFor({ timeout: 10000 });
      await page.locator(`.fcard[data-fid="${fid}"] .facts a`, { hasText: 'versions' }).click(); await page.locator('#ver-modal.show').waitFor();
      const rows = await page.locator('#ver-list .ver-row').allTextContents(); await shot('file-versions');
      const bytes = await page.evaluate(async id => (await fetch('/api/files/' + id)).text(), fid);
      const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
      check(`${size}: files: "new version" replaces the file in place (same card, v2), the link gives the new text, and Versions lists the earlier one (T-0266)`,
        rows.length === 2 && /Version 2 \(current\)/.test(rows[0]) && /Version 1/.test(rows[1]) && bytes === 'second version, a little longer' && fits, JSON.stringify({ rows, bytes, fits }));
      await page.evaluate(() => closeVersions()); await page.click('.tab[data-view="chat"]'); await sleep(200);
    });
    await step('what the site says the Terminal tab and its agent can do', async () => {   // T-0292: each public claim is opened here first
      await page.goto(BASE + '/app', { waitUntil: 'networkidle' });
      // (1) a proposed change in plain words with a risk label; the person approves; the agent reports where it applied it; Revert proposes the undo
      const made = await page.evaluate(async () => {
        const ah = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sessionStorage.getItem('bcAsker') }, uh = { 'Content-Type': 'application/json' };
        const bot = (await (await fetch('/api/me', { headers: ah })).json()).username;
        const pr = await (await fetch('/api/proposals', { method: 'POST', headers: ah, body: JSON.stringify({ title: 'Raise the upload limit to 20 MB', body: 'Change one number in nginx.conf.', reason: 'browser check', for: currentUser, room: 'general' }) })).json();
        const diff = 'diff --git a/nginx.conf b/nginx.conf\n--- a/nginx.conf\n+++ b/nginx.conf\n@@ -1 +1 @@\n-client_max_body_size 10m;\n+client_max_body_size 20m;\n';
        const at = await fetch(`/api/tickets/${pr.id}/diff`, { method: 'POST', headers: ah, body: JSON.stringify({ diff, repo: 'demo', plain: { what: 'Raises the upload limit from 10 MB to 20 MB.', try: 'Upload a 15 MB file.', risk: 'Bigger uploads use more disk.', undo: 'Put 10m back.', level: 'Low' } }) });
        await loadTickets(); return { id: pr.id, bot, at: at.status };
      });
      await page.evaluate(id => openTicketModal(id), made.id);
      await page.locator('#tm-diff .pw-row').first().waitFor();
      const card = await page.evaluate(() => ({ text: document.getElementById('tm-diff').innerText, pill: (document.querySelector('#tm-diff .pill') || {}).textContent || '', fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 }));
      await shot('t0292-plain-words-change');
      await page.locator('#tm-actions button', { hasText: 'Approve' }).first().click();
      await page.waitForFunction(id => (ticketsCache.find(t => t.id === id) || {}).status === 'approved', made.id);
      const applied = await page.evaluate(async id => {
        const ah = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sessionStorage.getItem('bcAsker') };
        const r = await fetch(`/api/tickets/${id}/applied`, { method: 'POST', headers: ah, body: JSON.stringify({ branch: 'chamber/' + id, sha: 'abc1234', repo: 'demo', pushed: false }) });
        await loadTickets(); closeTicketModal(); openTicketModal(id); return r.status;
      }, made.id);
      const rev = page.locator('#tm-actions button', { hasText: 'Revert' }); await rev.waitFor(); await shot('t0292-applied-revert'); await rev.click();
      await page.waitForFunction(id => { const u = ticketsCache.find(t => t.reverts === id); return !!u && openTicketId === u.id && /Undoes/.test(document.getElementById('tm-reverts-row').innerText); }, made.id);   // the undo ticket's own window is open
      const undo = await page.evaluate(id => { const u = ticketsCache.find(t => t.reverts === id) || {}; return { status: u.status, by: u.proposed_by, open: openTicketId === u.id, row: document.getElementById('tm-reverts-row').innerText, orig: (ticketsCache.find(t => t.id === id) || {}).status }; }, made.id);
      check(`${size}: a proposed change opens in plain words (what it changes, how to try it, what could go wrong, how to undo) with the agent's risk label; a person approves it; once the agent reports it applied, Revert proposes the undo as a new ticket that waits for a person (T-0292, T-0063, T-0072)`,
        made.at === 201 && /Raises the upload limit from 10 MB to 20 MB/.test(card.text) && /Bigger uploads use more disk/.test(card.text) && /Put 10m back/.test(card.text) && /risk: low/.test(card.pill) && card.fits && applied === 200 && undo.status === 'proposed' && undo.open && /Undoes/.test(undo.row), JSON.stringify({ made, pill: card.pill, applied, undo }));
      await page.evaluate(() => closeTicketModal());
      // (2) an agent's run: live steps and a Stop button while it works; afterwards the model, the cost and every command it ran
      const run = await page.evaluate(async () => {
        const ah = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sessionStorage.getItem('bcAsker') };
        const bot = (await (await fetch('/api/me', { headers: ah })).json()).username;
        const m = await (await fetch('/api/messages', { method: 'POST', headers: ah, body: JSON.stringify({ username: bot, room: 'general', text: 'Checking the upload limit', run: { state: 'running', for: currentUser, started: Date.now(), steps: [{ t: 'Reading nginx.conf', ok: true }, { t: 'Running the config test' }] } }) })).json();
        switchView('chat'); await poll(); return { id: (m.message || m).id, bot };
      });
      const line = page.locator(`#messages .run`).last(); await line.waitFor();
      const live = await page.evaluate(() => { const r = [...document.querySelectorAll('#messages .run')].pop(); return { steps: [...r.querySelectorAll('.run-steps li')].map(li => li.innerText.trim()), stop: !!r.querySelector('.run-head button') }; });
      await shot('t0292-run-live');
      await page.locator('#messages .run .run-head button', { hasText: 'Stop' }).last().click();
      const stopped = await page.evaluate(async id => {
        const ah = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sessionStorage.getItem('bcAsker') };
        let seen = null; for (let i = 0; i < 20 && !seen; i++) { const d = await (await fetch('/api/messages/one?id=' + encodeURIComponent(id), { headers: ah })).json(); seen = (d.message || {}).run && d.message.run.stop ? d.message.run.stop.by : null; if (!seen) await new Promise(r => setTimeout(r, 150)); }
        const e = await fetch('/api/messages/edit', { method: 'POST', headers: ah, body: JSON.stringify({ id, text: 'The upload limit is 20 MB and the config test passes.', run: { state: 'done', model: 'claude-opus-5-5', tokens_in: 1200, tokens_out: 300, ms: 4200, cost_cents: 3, steps: [{ t: 'Reading nginx.conf', ok: true }, { t: 'Running the config test', ok: true }], tools: [{ tool: 'Bash', input: 'nginx -t', out: 'syntax is ok', exit: 0, ms: 120 }] } }) });
        await poll(); return { by: seen, edit: e.status };
      }, run.id);
      await page.locator('#messages .run-foot').last().waitFor();
      const foot = await page.evaluate(id => { const f = [...document.querySelectorAll('#messages .run-foot')].pop(); toggleTranscript(id); const t = document.getElementById('tr-' + id); return { text: f.innerText, tr: t ? t.innerText : '', shown: !!t && t.classList.contains('show') }; }, run.id);
      await shot('t0292-run-done');
      check(`${size}: while an agent works its message shows the steps so far and a Stop button; Stop reaches the agent with who pressed it; afterwards the line shows the model, the cost and every command it ran (T-0292, T-0071)`,
        live.steps.length === 2 && /Reading nginx\.conf/.test(live.steps[0]) && live.stop && !!stopped.by && stopped.edit === 200 && /claude-opus-5-5/.test(foot.text) && /~3¢/.test(foot.text) && /ran 1 command/.test(foot.text) && foot.shown && /nginx -t/.test(foot.tr), JSON.stringify({ live, stopped, foot }));
      // (3) the Terminal tab runs a command on a machine the owner connected: the connector collects it and the answer comes back
      await page.evaluate(async () => { const ah = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sessionStorage.getItem('bcAsker') }; const bot = (await (await fetch('/api/me', { headers: ah })).json()).username;
        await fetch('/api/ping', { method: 'POST', headers: ah, body: JSON.stringify({ username: bot, version: '3.36.0', rooms: ['general'], state: 'idle', shell: 'on' }) }); });
      await page.goto(BASE + '/app', { waitUntil: 'networkidle' });
      await page.evaluate(() => switchView('terminal'));
      await page.waitForFunction(bot => [...document.querySelectorAll('#term-target option')].some(o => o.value === bot), run.bot);
      const picker = await page.evaluate(bot => [...document.querySelectorAll('#term-target option')].find(o => o.value === bot).textContent, run.bot);
      await page.selectOption('#term-mode', 'shell'); await page.selectOption('#term-target', run.bot);
      await page.fill('#term-cmd', 'echo chamber-check'); await page.evaluate(() => document.getElementById('term-form').requestSubmit());
      const relay = await page.evaluate(async () => {
        const ah = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sessionStorage.getItem('bcAsker') };
        let job = null; for (let i = 0; i < 40 && !job; i++) { job = (await (await fetch('/api/shell/pending', { headers: ah })).json()).job; if (!job) await new Promise(r => setTimeout(r, 150)); }
        if (!job) return { job: null };
        const r = await fetch('/api/shell/result', { method: 'POST', headers: ah, body: JSON.stringify({ id: job.id, out: 'chamber-check\n', err: '', code: 0, cwd: '/srv/demo' }) });
        return { cmd: job.cmd, by: job.by, result: r.status };
      });
      await page.waitForFunction(() => /chamber-check[\s\S]*chamber-check/.test(document.getElementById('term-out').innerText), null, { timeout: 15000 });
      const term = await page.evaluate(() => ({ out: document.getElementById('term-out').innerText.slice(-300), fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 }));
      await shot('t0292-terminal');
      check(`${size}: the Terminal tab lists a connected machine, sends it a command, and shows what came back from that machine; only that machine's connector could collect it (T-0292, T-0121)`,
        /their machine/.test(picker) && relay.cmd === 'echo chamber-check' && relay.result === 200 && /chamber-check/.test(term.out) && term.fits, JSON.stringify({ picker, relay, term }));
    });
    await step('pricing: Team or Company at checkout, builder seats and an approver link on the Account page', async () => {   // T-0295
      await page.goto(BASE + '/billing', { waitUntil: 'networkidle' }); await page.evaluate(() => { location.hash = 'billing'; }); await page.locator('#bi-sub-btn').waitFor(); await page.evaluate(() => { location.hash = 'team'; }); await page.locator('#ws-status').waitFor();
      const bill = await page.evaluate(() => ({ team: document.getElementById('bi-sub-btn').textContent, company: (document.getElementById('bi-sub-company') || {}).textContent || '', status: document.getElementById('ws-status').innerText,
        links: [...document.querySelectorAll('.guest-inv b')].map(x => x.textContent), fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 }));
      await page.locator('button[data-gnew="approver"]').click(); await page.locator('button[data-gcopy="approver"]').waitFor();
      const link = await page.evaluate(async () => (await (await fetch('/account/workspace')).json()).inviteUrls.approver || ''); await shot('pricing-account');
      check(`${size}: pricing: the billing page offers Team ($50 a month, 5 builders) and Company ($150 a month, 25 builders); the Account page counts builder seats and makes an approver link (T-0295, T-0310)`,
        /\$50 \/ month/.test(bill.team) && /5 builders/.test(bill.team) && /\$150 \/ month/.test(bill.company) && /25 builders/.test(bill.company) && /builder seats/.test(bill.status) && bill.links[0] === 'Approver link' && bill.fits && /\/join\//.test(link), JSON.stringify({ bill, link: !!link }));
    });
    await step('pricing: monthly or yearly at checkout (T-0310)', async () => {
      let asked = null;                                                       // the checkout call is stood in for: no payment service is reached
      await page.route('**/billing/checkout', async route => { asked = JSON.parse(route.request().postData() || '{}'); await route.fulfill({ json: { url: BASE + '/billing?checkout=stood-in' } }); });
      try {
        await page.goto(BASE + '/billing', { waitUntil: 'networkidle' }); await page.evaluate(() => { location.hash = 'billing'; }); await page.locator('#bi-iv').waitFor();
        const read = () => page.evaluate(() => ({ team: document.getElementById('bi-sub-btn').textContent, company: (document.getElementById('bi-sub-company') || {}).textContent || '',
          monthOn: !!document.querySelector('input[name="bi-iv"][value="month"]:checked'), yearText: (document.querySelector('input[name="bi-iv"][value="year"]') || {}).parentElement?.textContent || '', fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 }));
        const before = await read();
        await page.locator('input[name="bi-iv"][value="year"]').check(); const after = await read();
        await page.locator('#bi-iv').scrollIntoViewIfNeeded(); await shot('pricing-yearly');
        await page.locator('#bi-sub-btn').click(); await page.waitForURL(/checkout=stood-in/, { timeout: 8000 }).catch(() => {});
        check(`${size}: pricing: Monthly is picked first ($50 / $150 a month); picking Yearly (2 months free) shows $500 / $1,500 a year, and checkout is asked for Team, yearly (T-0310)`,
          before.monthOn && /\$50 \/ month/.test(before.team) && /\$150 \/ month/.test(before.company) && /2 months free/.test(before.yearText) && /\$500 \/ year/.test(after.team) && /\$1,500 \/ year/.test(after.company) && after.fits
          && asked && asked.plan === 'team' && asked.interval === 'year', JSON.stringify({ before, after, asked }));
      } finally { await page.unroute('**/billing/checkout'); }
    });
    await step('settings: six groups with a menu, one group at a time, deep links open the right group (T-0313)', async () => {
      const phoneSize = page.viewportSize().width <= 820;
      await page.goto(BASE + '/billing', { waitUntil: 'networkidle' }); await page.locator('#set-nav').waitFor({ state: 'attached' });
      const vis = () => page.evaluate(() => ({ show: document.getElementById('billing-box').dataset.show || '', hash: location.hash,
        groups: [...new Set([...document.querySelectorAll('.set-card')].filter(c => c.offsetParent).map(c => c.dataset.group))],
        nav: !!document.getElementById('set-nav').offsetParent, back: !!document.getElementById('set-back').offsetParent, fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 }));
      await page.waitForFunction(() => [...document.querySelectorAll('#set-nav [data-go]')].filter(b => !b.hidden).length >= 9, null, { timeout: 8000 }).catch(() => {});   // T-0329: groups the person cannot use are left out, after their data loads
      const first = await vis(), menu = await page.evaluate(() => [...document.querySelectorAll('#set-nav [data-go]')].filter(b => !b.hidden).map(b => b.dataset.go).join(','));
      const fl = await page.evaluate(async () => !!(await (await fetch('/api/me')).json()).fleetLink);   // the routers group shows only where the fleet link is on (it is, in this test copy)
      await shot('settings-first');
      await page.click('#set-nav [data-go="team"]'); await page.locator('#ws-status').waitFor();
      const team = await vis(), teamMore = await page.evaluate(() => ({
        caps: [...document.querySelectorAll('#billing-box label')].filter(l => l.offsetParent && l.querySelector('input[type=checkbox], input[type=radio]')).map(l => getComputedStyle(l).textTransform),
        links: [...document.querySelectorAll('.guest-inv code, #ws-invite')].filter(c => c.offsetParent).map(c => c.getBoundingClientRect().right <= document.documentElement.clientWidth + 1) }));
      await shot('settings-team');
      let backed = null;
      if (phoneSize) { await page.click('#set-back'); await page.locator('#set-nav').waitFor(); backed = await vis(); }
      await page.evaluate(() => { location.hash = 'owner-lock'; }); await page.waitForFunction(() => document.getElementById('billing-box').dataset.show === 'data', null, { timeout: 8000 });
      const data = await vis(), dz = await page.evaluate(() => { const f = document.getElementById('del-form'), cards = [...document.querySelectorAll('.set-card')].filter(c => c.offsetParent);
        return { zone: !!f && f.classList.contains('danger-zone') && /Danger zone/.test(f.innerText), last: !!f && cards.length > 1 && cards.every(c => c.contains(f) || c.getBoundingClientRect().top < f.getBoundingClientRect().top) }; });
      await page.locator('#del-form').scrollIntoViewIfNeeded(); await shot('settings-data');
      check(`${size}: Settings has a menu of its groups (routers only where the fleet link is on); ${phoneSize ? 'a phone starts on the menu' : 'a computer starts on You'} (T-0313)`,
        menu === (fl ? 'you,display,notify,team,ai,rules,data,billing,routers,advanced' : 'you,display,notify,team,ai,rules,data,billing,advanced') && first.nav && (phoneSize ? first.show === '' && first.groups.length === 0 : first.show === 'you' && first.groups.join() === 'you') && first.fits, JSON.stringify({ menu, fl, first }));
      check(`${size}: choosing Team shows only the Team card, with the switches in normal letters and the invite links inside the screen (T-0313)`,
        team.show === 'team' && team.hash === '#team' && team.groups.join() === 'team' && team.back === phoneSize && (!phoneSize || !team.nav) && teamMore.caps.length > 0 && teamMore.caps.every(t => t === 'none') && teamMore.links.every(Boolean) && team.fits,
        JSON.stringify({ team, teamMore }));
      if (phoneSize) check(`${size}: on a phone the back button returns to the menu of groups (T-0313)`, !!backed && backed.nav && backed.show === '' && backed.groups.length === 0, JSON.stringify(backed));
      check(`${size}: a link to a section (the owner lock) opens its group, Data, with the red Danger zone at the bottom (T-0313)`, data.show === 'data' && data.groups.join() === 'data' && dz.zone && dz.last && data.fits, JSON.stringify({ data, dz }));
    });
    await step('Settings is the one place: gear menu, Display, search, rooms and quiet hours, links into the app (T-0329)', async () => {
      const phoneSize = page.viewportSize().width <= 820, fitsNow = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
      const shown = () => page.evaluate(() => ({ show: document.getElementById('billing-box').dataset.show || '', groups: [...new Set([...document.querySelectorAll('.set-card')].filter(c => c.offsetParent).map(c => c.dataset.group))] }));
      await page.goto(BASE + '/app', { waitUntil: 'networkidle' }); await page.waitForSelector('#msg-input:not([disabled])');
      await page.click('#gear-btn'); await page.locator('#menu.open').waitFor();
      const gear = await page.evaluate(() => ({ rows: [...document.querySelectorAll('#menu .mi')].filter(e => e.checkVisibility()).map(e => e.textContent.trim()), look: document.getElementById('theme-picker').checkVisibility() }));
      await shot('settings-gear');
      await page.click('#menu-settings'); await page.waitForURL(u => new URL(u).pathname === '/settings'); await page.locator('#set-nav').waitFor();
      const wheel = await page.evaluate(() => !!document.querySelector('header .menu-wrap')?.checkVisibility());
      check(`${size}: the app's gear menu is only Settings, Help, Lock now and Sign out, and Settings opens the Settings page (T-0329)`,
        gear.rows.length === 4 && ['Settings', 'Help', 'Lock now', 'Sign out'].every((r, i) => gear.rows[i].startsWith(r)) && !gear.look && !wheel, JSON.stringify({ gear, wheel }));

      await page.evaluate(() => { location.hash = 'display'; }); await page.locator('#size-mode').waitFor(); await page.locator('#plain-row:not([hidden])').waitFor();
      await page.click('#size-mode button[data-size="large"]'); await page.click('#enter-mode button[data-enter="newline"]'); await shot('settings-display');
      const disp = { ...(await shown()), ...(await page.evaluate(() => ({ picker: !!document.getElementById('theme-picker').offsetParent, theme: !!document.querySelector('#set-theme #theme-mode button')?.offsetParent,
        saved: localStorage.getItem('chamber-size') + '/' + localStorage.getItem('chamber-enter') }))), fits: await fitsNow() };
      await page.click('#plain-mode button[data-plain="on"]'); await page.locator('#disp-msg', { hasText: 'plain language' }).waitFor();
      const plainOn = await page.evaluate(async () => (await (await fetch('/api/me')).json()).prefs?.plain === true);
      await page.click('#plain-mode button[data-plain="off"]'); await page.locator('#disp-msg', { hasText: 'are off' }).waitFor();
      await page.goto(BASE + '/app', { waitUntil: 'networkidle' }); await page.waitForSelector('#msg-input:not([disabled])');
      const inApp = await page.evaluate(() => ({ size: document.documentElement.dataset.size, enter: document.documentElement.dataset.enter }));
      await page.evaluate(() => { localStorage.setItem('chamber-size', 'normal'); localStorage.setItem('chamber-enter', 'auto'); });
      check(`${size}: Settings > Display holds colours, theme, text size, Enter key and plain-language replies, and the app follows what is picked there (T-0329)`,
        disp.groups.join() === 'display' && disp.picker && disp.theme && disp.saved === 'large/newline' && disp.fits && plainOn && inApp.size === 'large' && inApp.enter === 'newline', JSON.stringify({ disp, plainOn, inApp }));

      await page.goto(BASE + '/settings', { waitUntil: 'networkidle' }); await page.locator('#set-search').waitFor();
      await page.fill('#set-search', 'quiet hours'); const found = { ...(await shown()), box: await page.locator('#nt-quiet-on').isVisible() }; await shot('settings-search');
      await page.fill('#set-search', 'zzqx nothing'); const nothing = { ...(await shown()), none: await page.locator('#set-none').isVisible() };
      await page.fill('#set-search', ''); const cleared = await shown();
      check(`${size}: the search box finds a setting wherever it is (quiet hours), says so when nothing matches, and clearing it goes back (T-0329)`,
        found.show === 'search' && found.groups.includes('notify') && found.box && nothing.none && nothing.groups.length === 0 && cleared.show === (phoneSize ? '' : 'you'), JSON.stringify({ found, nothing, cleared }));

      await page.evaluate(() => { location.hash = 'notify'; }); await page.locator('#nt-rooms select[data-room]').first().waitFor();
      const sel = page.locator('#nt-rooms select[data-room]').first(), roomKey = await sel.getAttribute('data-room');
      await sel.selectOption('all'); await page.locator('#nt-msg', { hasText: 'All messages' }).waitFor();
      await page.check('#nt-quiet-on'); await page.fill('#nt-quiet-start', '23:00'); await page.fill('#nt-quiet-end', '06:30'); await page.fill('#nt-quiet-tz', 'UTC');
      await page.click('#nt-quiet-save'); await page.locator('#nt-msg', { hasText: 'quiet hours on' }).waitFor();
      const stored = await page.evaluate(async () => (await fetch('/account/notify')).json()), nfit = await fitsNow(); await shot('settings-notify');
      await sel.selectOption('mentions'); await page.locator('#nt-msg', { hasText: 'Mentions' }).waitFor();
      await page.uncheck('#nt-quiet-on'); await page.click('#nt-quiet-save'); await page.locator('#nt-msg', { hasText: 'quiet hours off' }).waitFor();
      check(`${size}: Settings > Notifications sets each room and the quiet hours for the person (they were a window in the app) (T-0329)`,
        stored.rooms?.[roomKey] === 'all' && stored.quiet?.enabled === true && stored.quiet.start === '23:00' && stored.quiet.end === '06:30' && nfit, JSON.stringify({ roomKey, stored, nfit }));

      await page.evaluate(() => { location.hash = 'data'; }); await page.locator('#arc-open').waitFor();
      const arc = await page.evaluate(() => { const s = document.getElementById('arc-room'); return { href: document.getElementById('arc-open').getAttribute('href'), room: s.value, n: s.options.length }; });
      await page.evaluate(() => { location.hash = 'advanced'; }); await page.click('#set-shortcuts');
      await page.waitForURL(u => new URL(u).pathname === '/app'); await page.locator('#shortcuts-modal.show').waitFor(); const tidy = new URL(page.url()).search;
      await page.evaluate(() => closeShortcuts());
      check(`${size}: links in Settings open the app's own windows (Keyboard shortcuts here; the archive link names its room), and the address is tidied so a reload does not open it again (T-0329)`,
        tidy === '' && arc.n > 0 && arc.href === '/app?open=archives&room=' + encodeURIComponent(arc.room), JSON.stringify({ tidy, arc }));
    });
    await step('the Billing tab: the plan, the price before every charge, storage, cancel in one confirmation (T-0311)', async () => {
      await page.goto(BASE + '/app', { waitUntil: 'networkidle' }); await page.locator('#tab-billing').waitFor({ state: 'visible' });
      await page.click('#tab-billing'); await page.locator('#bl-plan').waitFor();
      const trial = await page.evaluate(() => ({ plan: document.getElementById('bl-plan').innerText, sub: !!document.querySelector('[data-bl-sub="team"]'), pick: !!document.querySelector('input[name="bl-sub-iv"][value="year"]') }));
      const now = Math.floor(Date.now() / 1000), sent = { storage: [], cancel: [], preview: [] };
      const paid = { isOwner: true, owner: 'owner', role: 'owner', state: 'ok', plan: 'team', interval: 'month', price: '$50 / month', status: 'active', periodEnd: now + 20 * 86400, cancelAtPeriodEnd: false, paymentFailed: false, graceEndsAt: null,
        next: { amount: 5500, currency: 'usd', at: now + 20 * 86400 }, founding: { n: 1, label: '$50 / month' }, trial: false, free: false, builders: { n: 2, team: 5, company: 25 },
        plans: { team: { label: '$50 / month', month: '$50 / month', year: '$500 / year', builders: 5, storageMb: 500 }, company: { label: '$150 / month', month: '$150 / month', year: '$1,500 / year', builders: 25, storageMb: 5120 }, yearNote: '2 months free' },
        storage: { offered: true, usedBytes: 300 * 1048576, baseMb: 500, packs: 1, packGb: 10, maxPacks: 10, limitMb: 500 + 10240, label: '$5 / month', labels: { month: '$5 / month', year: '$50 / year' }, soldOut: false, paused: false, biggest: [{ name: 'design-files.zip', size: 200 * 1048576, folder: null }] },
        canChange: true, canSubscribe: false, canCancel: true, canPortal: true };
      let view = paid; await page.route('**/billing/overview', r => r.fulfill({ json: view }));   // T-0311: then an admin's read-only view
      await page.route('**/billing/preview', r => { const b = JSON.parse(r.request().postData() || '{}'); sent.preview.push(b);
        return r.fulfill({ json: b.packs === 0 ? { same: false, dueNow: 0, total: -100, currency: 'usd', then: '$50 / month', overFiles: true, usedMb: 600, limitMb: 500, needsPassword: false }
                                                : { same: false, dueNow: 333, total: 333, currency: 'usd', then: '$50 / month, plus 2 × $5 / month for 20 GB of storage', overFiles: false, usedMb: 300, limitMb: 20980, needsPassword: true } }); });
      await page.route('**/billing/storage', r => { sent.storage.push(JSON.parse(r.request().postData() || '{}')); return r.fulfill({ json: {} }); });
      await page.route('**/billing/cancel', r => { sent.cancel.push(JSON.parse(r.request().postData() || '{}')); return r.fulfill({ json: {} }); });
      try {
        await page.evaluate(() => loadBilling()); await page.locator('#bl-plan-now').waitFor();
        const shown = await page.evaluate(() => ({ plan: document.getElementById('bl-plan').innerText, storage: document.getElementById('bl-storage').innerText, change: !!document.getElementById('bl-plan-see'), cancel: !!document.getElementById('bl-cancel-btn'), pay: !!document.getElementById('bl-portal') }));
        await page.locator('#bl-plan').scrollIntoViewIfNeeded(); await shot('billing-tab');
        await page.click('#bl-st-add'); await page.locator('#bl-today').waitFor();
        const asked = await page.evaluate(() => ({ today: document.getElementById('bl-today').innerText, box: document.getElementById('bl-st-confirm').innerText, pw: !!document.getElementById('bl-pw'), yes: (document.getElementById('bl-yes') || {}).innerText || '' }));
        const storageBefore = sent.storage.length; await page.locator('#bl-st-confirm').scrollIntoViewIfNeeded(); await shot('billing-charge-first');
        await page.click('#bl-yes'); await page.waitForTimeout(200); const sentWithoutPw = sent.storage.length;
        await page.fill('#bl-pw', 'my-password-123'); await page.click('#bl-yes'); await page.waitForFunction(() => /sent you an email/.test(document.getElementById('bl-msg').textContent), null, { timeout: 8000 });
        await page.click('#bl-st-remove'); await page.locator('#bl-st-confirm .bl-warn').waitFor();
        const refuse = await page.evaluate(() => ({ text: document.getElementById('bl-st-confirm').innerText, yes: !!document.getElementById('bl-yes') }));
        await page.click('#bl-cancel-btn'); await page.locator('#bl-cancel-confirm').waitFor({ state: 'visible' });
        const conf = await page.evaluate(() => document.getElementById('bl-cancel-confirm').innerText); const cancelBefore = sent.cancel.length;
        await page.locator('#bl-cancel-confirm').scrollIntoViewIfNeeded(); await shot('billing-cancel');
        await page.click('#bl-cancel-yes'); await page.waitForFunction(() => /plan is cancelled/.test(document.getElementById('bl-msg').textContent), null, { timeout: 8000 });
        const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 && document.getElementById('billing-view').scrollWidth <= document.getElementById('billing-view').clientWidth + 1);
        view = { ...paid, isOwner: false, role: 'admin', canChange: false, canCancel: false, canPortal: false };   // T-0311 (the owner's answer, 20 Nov): an admin only looks
        await page.evaluate(() => loadBilling()); await page.locator('#bl-plan-now').waitFor();
        const adm = await page.evaluate(() => ({ plan: document.getElementById('bl-plan').innerText, storage: (document.getElementById('bl-storage') || {}).innerText || '',
          controls: ['bl-plan-see', 'bl-st-add', 'bl-st-remove', 'bl-portal', 'bl-cancel-btn', 'bl-keep'].filter(id => document.getElementById(id)), pwBox: !!document.getElementById('bl-pw') }));
        await page.locator('#bl-plan').scrollIntoViewIfNeeded(); await shot('billing-admin-view');
        check(`${size}: an admin's Billing tab shows the plan, the next charge and the storage, with no button that changes anything, and says only the owner can (T-0311)`,
          /\$55\.00/.test(adm.plan) && /only owner can change the plan or the storage/.test(adm.plan) && /Using 300 MB/.test(adm.storage) && adm.controls.length === 0 && !adm.pwBox, JSON.stringify(adm));
        check(`${size}: the Billing tab shows a free-trial workspace its plans to subscribe to, monthly or yearly (T-0311)`, /Free trial/.test(trial.plan) && trial.sub && trial.pick, JSON.stringify(trial));
        check(`${size}: the Billing tab shows the plan (Team, monthly, $50 / month), the next charge ($55.00), the founding price, the storage bar with what is used, and the change, card and cancel controls (T-0311)`,
          /Team/.test(shown.plan) && /monthly: \$50 \/ month/.test(shown.plan) && /\$55\.00/.test(shown.plan) && /Founding price/.test(shown.plan) && /Using 300 MB of 10\.5 GB/.test(shown.storage) && shown.change && shown.cancel && shown.pay, JSON.stringify(shown));
        check(`${size}: adding storage first says what is charged today ($3.33) and after, asks for the password, and sends nothing until both are given (T-0311)`,
          /You'll be charged \$3\.33 today/.test(asked.today) && /After that: \$50 \/ month, plus 2 × \$5 \/ month/.test(asked.box) && asked.pw && /\$3\.33/.test(asked.yes) && storageBefore === 0 && sentWithoutPw === 0 && sent.storage.length === 1 && sent.storage[0].packs === 2 && sent.storage[0].password === 'my-password-123',
          JSON.stringify({ asked, storageBefore, sentWithoutPw, storage: sent.storage.map(s => ({ packs: s.packs, pw: !!s.password })) }));
        check(`${size}: removing storage that would leave the files over the limit is refused on the page with the biggest files to delete, and no confirm button (T-0311)`, /Delete files first/.test(refuse.text) && /design-files\.zip/.test(refuse.text) && !refuse.yes, JSON.stringify(refuse));
        check(`${size}: cancelling is one tap and one confirmation that says what happens (free plan, nothing deleted), and then exactly one request (T-0311)`,
          cancelBefore === 0 && /free plan/.test(conf) && /nothing is deleted/.test(conf) && sent.cancel.length === 1 && fits, JSON.stringify({ conf: conf.slice(0, 160), cancels: sent.cancel.length, fits }));
      } finally { for (const u of ['**/billing/overview', '**/billing/preview', '**/billing/storage', '**/billing/cancel']) await page.unroute(u); }
    });
    await step('Reviews: cards like the Tickets tab, Looks good only inside an opened ticket, and the whole list scrolls to the last ticket (T-0309)', async () => {
      await page.goto(BASE + '/app', { waitUntil: 'networkidle' });               // the step before may leave the page on Account
      const made = await page.evaluate(async () => {
        const uh = { 'Content-Type': 'application/json' }, ah = { ...uh, Authorization: 'Bearer ' + sessionStorage.getItem('bcAsker') };
        const post = (u, h, b) => fetch(u, { method: 'POST', headers: h, body: JSON.stringify(b) });
        const me = currentUser, bot = (await (await fetch('/api/me', { headers: ah })).json()).username, ids = [];
        for (let i = 1; i <= 14; i++) {                                            // enough finished work to run past one screen
          const id = ((await (await post('/api/tickets', uh, { by: me, title: `[agent] Scroll check ${i} of 14`, body: 'Tidy one file.', for: 'agent' })).text()).match(/T-\d{4}/) || [])[0];
          await post(`/api/tickets/${id}/approve`, uh, { by: me }); await post(`/api/tickets/${id}/claim`, ah, { by: bot });
          await post(`/api/tickets/${id}/close`, ah, { by: bot, note: 'CHECK: read the file\nRESULT: it is tidy\nFAIL-IF: the file is untidy' }); ids.push(id);
        }
        await loadTickets(); switchView('reviews'); renderCheck();
        return { ids };
      });
      const card = page.locator(`#rvcol-todo [data-check="${made.ids[0]}"]`); await card.waitFor();
      const cardText = await card.innerText();
      const list = await page.evaluate(() => ({ looks: [...document.querySelectorAll('#reviews-view button, #reviews-view a')].filter(b => /looks good|start fresh|as checked/i.test(b.textContent)).length,
        cards: ['todo', 'ok', 'back'].map(c => document.querySelectorAll(`#rvcol-${c} .check-card`).length),
        want: [checkQueue().length, ticketsCache.filter(t => t.check && t.check.state === 'ok').length, ticketsCache.filter(t => t.check && t.check.state === 'back').length] }));
      await shot('reviews-cards');
      const vb = await page.locator('#reviews-view').boundingBox();                // scroll the way a person does, with the pointer over the cards
      await page.mouse.move(vb.x + vb.width / 3, vb.y + Math.min(vb.height - 20, 260));
      for (let i = 0; i < 40; i++) await page.mouse.wheel(0, 1500);
      await page.waitForTimeout(400);
      const end = await page.evaluate(() => {
        const v = document.getElementById('reviews-view'), cards = [...v.querySelectorAll('.check-card')], last = cards.reduce((a, c) => (!a || c.getBoundingClientRect().bottom > a.getBoundingClientRect().bottom ? c : a), null), r = last.getBoundingClientRect();
        return { overflowed: v.scrollHeight > v.clientHeight + 50, atEnd: v.scrollTop + v.clientHeight >= v.scrollHeight - 2, lastSeen: r.top >= 0 && r.bottom <= window.innerHeight + 1, lastId: last.dataset.check,
          clipped: [...v.querySelectorAll('.review-cards')].filter(c => c.scrollHeight > c.clientHeight + 1).length, barSeen: document.getElementById('rv-next').getBoundingClientRect().top >= 0, fits: document.documentElement.scrollWidth <= window.innerWidth + 1 };
      });
      await shot('reviews-bottom');
      const armed = await page.evaluate(id => { openCheck(id); const b = document.getElementById('ck-ok'); const on = !!b && b.disabled; closeCheck(); return on; }, made.ids[1]);
      await card.scrollIntoViewIfNeeded(); await card.click(); await page.locator('#check-modal.show').waitFor();
      await page.locator('#ck-ok:not([disabled])').waitFor();
      const where = await page.evaluate(() => { const b = document.getElementById('ck-ok'), d = document.getElementById('ck-done'), body = document.querySelector('#check-modal .modal-body');
        return { inBody: body.contains(b), after: !!(d.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING), below: b.getBoundingClientRect().top >= d.getBoundingClientRect().bottom - 1, note: /RESULT: it is tidy/.test(d.innerText) }; });
      await shot('check-window-looks-good');
      await page.click('#ck-ok');
      const checked = await page.waitForFunction(id => (ticketsCache.find(t => t.id === id) || {}).check?.state === 'ok', made.ids[0], { timeout: 8000 }).then(() => true).catch(() => false);
      check(`${size}: Reviews: each card shows what the Tickets tab shows (number, title, who does it, priority, who asked, status); every ticket is listed and the whole tab scrolls to the last one; Looks good is only inside the opened ticket, below the close note, and waits a moment; nothing in the tab marks a ticket checked from the list (T-0309)`,
        made.ids.length === 14 && made.ids.every(Boolean) && cardText.includes(made.ids[0]) && /Scroll check 1 of 14/.test(cardText) && /AGENT/.test(cardText) && /asked by /.test(cardText) && /status: done/.test(cardText)
          && list.looks === 0 && JSON.stringify(list.cards) === JSON.stringify(list.want) && list.cards[0] >= 14
          && end.overflowed && end.atEnd && end.lastSeen && end.clipped === 0 && end.barSeen && end.fits && armed === true && where.inBody && where.after && where.below && where.note && checked,
        JSON.stringify({ made, cardText, list, end, armed, where, checked }));
    });
    await step('passkey at sign-in: switch it on, sign out, sign in with the password and then the passkey', async () => {   // T-0241 (a); last, because switching it on signs out the other devices
      await page.goto('about:blank');                                             // T-0310: this step signs the main page out on purpose; park it off /app first
      const LB = BASE.replace('127.0.0.1', 'localhost'), ctx4 = await browser.newContext(SIZES[size]), p4 = await ctx4.newPage(); p4.setDefaultTimeout(15000);
      const errs4 = []; p4.on('pageerror', e => errs4.push(e.message));
      try {
        const cdp = await ctx4.newCDPSession(p4); await cdp.send('WebAuthn.enable');
        await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
        await p4.goto(LB + '/login', { waitUntil: 'networkidle' }); await p4.fill('#li-email', email); await p4.fill('#li-pass', pw); await p4.click('button[type=submit]:visible');
        await p4.waitForURL(u => !/\/login/.test(String(u)), { timeout: 15000 }); await p4.goto(LB + '/billing', { waitUntil: 'networkidle' }); await p4.evaluate(() => { location.hash = 'you'; });
        await p4.locator('#pk-box').waitFor(); await p4.locator('#pk-box').scrollIntoViewIfNeeded(); await p4.fill('#pk-name', 'Sign-in key'); await p4.click('#pk-add');
        await p4.locator('#pk-msg', { hasText: /Passkey added/ }).waitFor(); await p4.locator('#pk-login-row').waitFor();
        await p4.check('#pk-login'); await p4.locator('#pk-msg', { hasText: /asks for your passkey after your password/ }).waitFor();
        try { await p4.screenshot({ path: path.join(OUT, `${size}-passkey-signin-on.png`) }); } catch {}
        await ctx4.clearCookies(); await p4.goto(LB + '/login', { waitUntil: 'networkidle' });
        await p4.fill('#li-email', email); await p4.fill('#li-pass', pw); await p4.click('button[type=submit]:visible');
        await p4.locator('#li-pk').waitFor({ state: 'visible' });
        const second = await p4.evaluate(() => { const vis = el => !!el && el.offsetParent !== null; return { codeHidden: !vis(document.getElementById('li-code')) && !vis(document.querySelector('label[for="li-code"]')) && !vis(document.querySelector('#login-form button[type=submit]')), msg: document.getElementById('li-msg').textContent }; });   // the code box, its label and Log in are really gone
        try { await p4.screenshot({ path: path.join(OUT, `${size}-passkey-signin-step.png`) }); } catch {}
        await p4.click('#li-pk'); await p4.waitForURL(u => !/\/login/.test(String(u)), { timeout: 15000 });
        const inside = (await p4.evaluate(async () => (await fetch('/api/me')).status));
        const fits = await p4.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
        check(`${size}: passkey at sign-in: switched on in Account, then signing in asks for the passkey after the password (no code box) and the passkey lets the person in (T-0241 (a))`,
          second.codeHidden && /passkey/.test(second.msg) && inside === 200 && fits && !errs4.length, JSON.stringify({ second, inside, fits, errs4 }));
      } finally { await ctx4.close(); }
    });
    clean('log in');
  }
  await browser.close();
}
(async () => { for (const size of Object.keys(SIZES)) { console.log(`browser check, ${size} size`); await run(size); }
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  FAIL the browser check itself crashed  -> ' + e.message.split('\n')[0]); console.log(`${pass} passed, ${fail + 1} failed`); process.exit(1); });

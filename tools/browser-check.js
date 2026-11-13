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
  ['/help', /./, []], ['/help/api', /./, []], ['/compare', /Chamber compared/i, []], ['/terms', /Free trial/, []], ['/privacy', /./, []], ['/refunds', /Free trial/, []],
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
    await step('add an agent', async () => {
      await page.click('.tab[data-view="chat"]'); await page.click('#gear-btn'); await page.click('#menu-add-agent');
      await page.fill('#aw-name', 'check-bot-' + size); await page.click('#aw-mkkey');
      // 2026-11-13: this used to wait for "--token chk_<letter>", which the placeholder chk_PASTE_THE_TOKEN also matches, so now and then the
      // command was read before the real key had come back and the check failed for no reason. Wait for a key that is not the placeholder.
      await page.waitForFunction(() => { const t = document.getElementById('aw-cmd').textContent; return /--token '?chk_/.test(t) && !/PASTE/.test(t); });
      const cmd = await page.locator('#aw-cmd').textContent();
      check(`${size}: Add an agent makes the key itself and writes the full install command`, /install\.sh \| sudo bash/.test(cmd) && /--role connector/.test(cmd) && /--commanders /.test(cmd) && !/PASTE/.test(cmd), cmd.replace(/chk_[A-Za-z0-9_-]+/, "chk_…")); await shot('add-agent');
      await page.check('input[name="aw-kind"][value="laptop"]'); const lcmd = await page.locator('#aw-cmd').textContent();   // T-0186
      check(`${size}: Add an agent also writes a laptop command that needs no sudo`, /laptop\.sh \| sh -s -- --token chk_/.test(lcmd) && !/sudo/.test(lcmd) && /^cd /.test(lcmd), lcmd.replace(/chk_[A-Za-z0-9_-]+/, 'chk_…')); await shot('add-agent-laptop');
      await page.locator('#agent-wizard .close-x').click();
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
      await page.click('.tab[data-view="chat"]'); await page.click('#gear-btn'); await page.click('#menu-add-agent');
      await page.check('input[name="aw-kind"][value="mcp"]'); const mcmd = await page.locator('#aw-cmd').textContent(); await shot('add-agent-mcp');
      const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
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
    await step('managers and clients: approval rules and a requester', async () => {               // T-0190, T-0199
      await page.goto(BASE + '/billing', { waitUntil: 'networkidle' });
      await page.locator('#ap-save').waitFor(); const rulesOk = await page.locator('#ap-save').isEnabled() && await page.locator('#ap-two').isVisible();
      await page.locator('button[data-gnew="requester"]').click(); await page.locator('button[data-gcopy="requester"]').waitFor();
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
        check(`${size}: a client who joins through a requester link lands on Your requests, sends a request and sees it waiting`, onReq && info.status === 'Waiting for approval' && info.sw <= info.cw + 1 && errs2.length === 0, JSON.stringify({ url: p2.url(), info, errs2 }));
      } finally { await ctx2.close(); }
      const board = await page.evaluate(async () => ((await (await fetch('/api/tickets')).json()).tickets || []).some(t => /Please add a price list to the shop/.test(t.title) && (t.tags || []).includes('request')));
      await page.goto(BASE + '/app', { waitUntil: 'networkidle' });                 // T-0206: the team sees the picture on the ticket
      const seen = await page.evaluate(async () => { const t = ((await (await fetch('/api/tickets')).json()).tickets || []).find(t => /Please add a price list to the shop/.test(t.title)); if (!t) return {}; await loadTickets(); openTicketModal(t.id); await new Promise(r => setTimeout(r, 300)); const box = document.getElementById('tm-files'), im = box && box.querySelector('img'); if (im && !im.complete) await new Promise(r => { im.onload = im.onerror = r; }); const out = { files: (t.files || []).length, shown: !!box && box.style.display !== 'none' && /Sent with the request/.test(box.textContent), w: im ? im.naturalWidth : 0, fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 }; closeTicketModal(); return out; });
      check(`${size}: the team sees the requester's picture on the ticket`, seen.files === 1 && seen.shown && seen.w === 1 && seen.fits, JSON.stringify(seen));
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
      await page.goto(BASE + '/billing', { waitUntil: 'networkidle' });
      await page.locator('#au-verify').scrollIntoViewIfNeeded(); await page.click('#au-verify');
      await page.locator('#au-verify-msg', { hasText: /Intact|Nothing to check/ }).waitFor();
      await page.waitForFunction(() => !/Loading/.test(document.getElementById('usage-box')?.innerText || 'Loading'));
      const t = await page.evaluate(() => ({ v: document.getElementById('au-verify-msg').innerText, u: document.getElementById('usage-box').innerText, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      await page.locator('#usage').scrollIntoViewIfNeeded(); await shot('record-usage');
      check(`${size}: the account page checks the record and shows AI usage`, /Intact/.test(t.v) && t.u.length > 10 && t.sw <= t.cw + 1, JSON.stringify(t).slice(0, 300));
    });
    await step('weekly report: private link and page', async () => {                                   // T-0202
      await page.goto(BASE + '/billing', { waitUntil: 'networkidle' });
      await page.locator('#rep-link').scrollIntoViewIfNeeded(); await page.click('#rep-link');
      await page.locator('#rep-url a').waitFor(); const href = await page.locator('#rep-url a').getAttribute('href');
      const p3 = await page.context().newPage(); try { await p3.goto(href, { waitUntil: 'networkidle' });
        const r = await p3.evaluate(() => ({ t: document.body.innerText, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
        try { await p3.screenshot({ path: path.join(OUT, `${size}-weekly-report.png`), fullPage: true }); } catch {}
        check(`${size}: the weekly report link opens a readable page that fits the screen`, /Weekly report/.test(r.t) && /In short/.test(r.t) && /Only measured facts/.test(r.t) && r.sw <= r.cw + 1, JSON.stringify({ sw: r.sw, cw: r.cw, t: r.t.slice(0, 120) }));
      } finally { await p3.close(); }
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

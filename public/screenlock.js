// T-0241 part 1: the screen lock, shared by the app (/app), the Account page (/billing) and the Requests page (/requests).
// The server decides when a session is locked (idle lock, lock on reopen, or "Lock now") and then answers 423 with
// sessionLocked on every data call. This script only (1) tells the server the page is open and whether a person used it,
// (2) notices a 423 and swaps the page for the unlock form, and (3) sends the password to /account/unlock.
// A page that already showed workspace data reloads first, so nothing from the workspace stays in the page behind the form.
(() => {
  if (window.ChamberScreenLock) return;
  const ON_PAGES = ['/app', '/billing', '/account', '/requests'];
  const orig = window.fetch.bind(window);
  let shown = false, hadData = false, lastInputAt = Date.now(), lastReportAt = 0, prefs = null, stopped = false;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pathOf = u => { try { return new URL(typeof u === 'string' ? u : u.url, location.href).pathname; } catch { return ''; } };
  // T-0241 part 5: a passkey instead of the password (fingerprint, face or device PIN). Shared with the Account page.
  const canPasskey = () => !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.get);
  const ub = s => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4)), c => c.charCodeAt(0));
  const bu = buf => { let t = ''; for (const c of new Uint8Array(buf)) t += String.fromCharCode(c); return btoa(t).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  async function usePasskey(purpose) {                                  // true when Chamber accepted it; throws with a sentence otherwise
    const o = await orig('/account/passkeys/options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'get' }) }), od = await o.json().catch(() => ({}));
    if (!o.ok) throw new Error(od.error || 'No passkey here.');
    const pk = od.publicKey; pk.challenge = ub(pk.challenge); pk.allowCredentials = (pk.allowCredentials || []).map(c => ({ ...c, id: ub(c.id) }));
    let cred; try { cred = await navigator.credentials.get({ publicKey: pk }); } catch (e) { throw new Error(e && e.name === 'NotAllowedError' ? 'Cancelled, or the device did not allow it.' : 'The device could not use a passkey here.'); }
    const r = await orig('/account/passkeys/use', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose, id: cred.id, clientDataJSON: bu(cred.response.clientDataJSON), authenticatorData: bu(cred.response.authenticatorData), signature: bu(cred.response.signature) }) });
    const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'The passkey did not work.'); return true;
  }
  window.ChamberPasskey = { canPasskey, ub, bu, usePasskey };

  function show(j) {                                                    // replace what is on screen with the unlock form
    if (shown) return; shown = true;
    for (const el of [...document.body.children]) el.style.display = 'none';
    const box = document.createElement('div');
    box.id = 'screen-lock'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-labelledby', 'sl-title');
    box.style.cssText = 'position:fixed;inset:0;z-index:2147483647;overflow:auto;background:var(--bg,#0e1116);color:var(--text,#e6e6e6);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif';
    const field = 'display:block;width:100%;box-sizing:border-box;margin:6px 0 0;padding:10px 12px;font:inherit;color:inherit;background:var(--surface,#161b22);border:1px solid var(--line,#30363d);border-radius:var(--r,8px)';
    const btn = 'padding:9px 18px;font:inherit;font-weight:700;cursor:pointer;color:var(--accent-ink,#000);background:var(--accent,#2f81f7);border:0;border-radius:var(--r,8px)';
    box.innerHTML = `<main style="max-width:420px;margin:14vh auto 40px;padding:0 16px">`
      + `<h1 id="sl-title" style="font-size:21px;margin:0 0 8px">Chamber is locked</h1>`
      + `<p style="margin:0 0 18px;color:var(--text-dim,#9aa4ae)">${j && j.username ? `Signed in as <b>${esc(j.username)}</b>. ` : ''}It locked ${esc((j && j.why) || 'on this device')}. Enter your password to open your workspace again.</p>`
      + `<form id="sl-unlock" autocomplete="on"><label for="sl-unlock-pw">Password</label>`
      + `<input id="sl-unlock-pw" type="password" autocomplete="current-password" required style="${field}">`
      + `<div style="margin-top:14px;display:flex;gap:16px;align-items:center;flex-wrap:wrap"><button type="submit" style="${btn}">Unlock</button>`
      + `${j && j.passkeys && canPasskey() ? `<button type="button" id="sl-passkey" style="${btn.replace('color:var(--accent-ink,#000);background:var(--accent,#2f81f7);border:0', 'color:inherit;background:transparent;border:1px solid var(--line,#30363d)')}">Use a passkey</button>` : ''}`
      + `<a href="#" id="sl-signout" style="color:var(--text-dim,#9aa4ae)">Sign out instead</a></div>`
      + `<p id="sl-unlock-msg" role="alert" style="min-height:1.5em;margin:12px 0 0;color:var(--danger,#f85149)"></p></form></main>`;
    document.body.appendChild(box);
    const pw = document.getElementById('sl-unlock-pw'), msg = document.getElementById('sl-unlock-msg');
    try { pw.focus(); } catch { /* old browser */ }
    document.getElementById('sl-unlock').addEventListener('submit', async e => {
      e.preventDefault(); msg.textContent = '';
      try {
        const r = await orig('/account/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw.value }) });
        const d = await r.json().catch(() => ({}));
        if (r.ok) { location.reload(); return; }
        if (r.status === 401) { location.href = '/login'; return; }
        msg.textContent = d.error || 'Could not unlock. Try again.'; pw.value = ''; pw.focus();
      } catch { msg.textContent = 'No connection. Try again in a moment.'; }
    });
    const pkBtn = document.getElementById('sl-passkey');                // T-0241 part 5
    if (pkBtn) pkBtn.addEventListener('click', async () => { msg.textContent = ''; pkBtn.disabled = true; try { await usePasskey('unlock'); location.reload(); } catch (e) { msg.textContent = e.message; pkBtn.disabled = false; } });
    document.getElementById('sl-signout').addEventListener('click', async e => {
      e.preventDefault();
      try { await orig('/account/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch { /* signed out anyway below */ }
      location.href = '/login';
    });
  }
  function locked(j) { if (shown) return; if (hadData) { stopped = true; location.reload(); } else show(j); }

  // Every response passes through here: a 423 that says sessionLocked means "lock now"; any other answer from the server
  // means this page now shows workspace data, so a later lock reloads the page first.
  window.fetch = async (...args) => {
    const r = await orig(...args);
    const p = pathOf(args[0]);
    if (r.status === 423 && !shown) { try { const j = await r.clone().json(); if (j && j.sessionLocked) locked(j); } catch { /* not JSON */ } }
    else if (r.status === 403) {
      let j = null; try { j = await r.clone().json(); } catch { /* not JSON */ }
      if (j && j.recheckRequired) return (await askPassword(j)) ? window.fetch(...args) : r;   // T-0241 part 4: confirmed, so the same request goes again
      if (j && j.twoFactorRequired && location.pathname !== '/billing') { stopped = true; location.href = '/billing?need2fa=1'; }   // T-0241 part 3
    }
    else if (r.ok && (p.startsWith('/api/') || p.startsWith('/account/')) && p !== '/account/activity') hadData = true;
    return r;
  };

  // T-0241 part 4: "confirm it is you". One small form over the page; the password goes to /account/recheck, and the caller's
  // request is sent again when it is accepted. Cancel gives the caller the original refusal.
  let rcOpen = null;
  function askPassword(j) {
    if (rcOpen) return rcOpen;
    rcOpen = new Promise(resolve => {
      const box = document.createElement('div'); box.id = 'recheck'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-labelledby', 'rc-title-x');
      box.style.cssText = 'position:fixed;inset:0;z-index:2147483646;display:grid;place-items:center;padding:16px;background:rgba(0,0,0,.6);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif';
      const field = 'display:block;width:100%;box-sizing:border-box;margin:6px 0 0;padding:10px 12px;font:inherit;color:inherit;background:var(--bg,#0e1116);border:1px solid var(--line,#30363d);border-radius:var(--r,8px)';
      const btn = 'padding:9px 18px;font:inherit;font-weight:700;cursor:pointer;color:var(--accent-ink,#000);background:var(--accent,#2f81f7);border:0;border-radius:var(--r,8px)';
      box.innerHTML = `<form style="width:100%;max-width:380px;box-sizing:border-box;padding:18px;background:var(--surface,#161b22);color:var(--text,#e6e6e6);border:1px solid var(--line,#30363d);border-radius:var(--r,8px)">`
        + `<h2 id="rc-title-x" style="font-size:18px;margin:0 0 6px">Confirm it is you</h2><p style="margin:0 0 12px;color:var(--text-dim,#9aa4ae)">${esc((j && j.error) || 'Enter your password to continue.').replace(/^Confirm it is you: (.)/, (_, c) => c.toUpperCase())}</p>`
        + `<label for="rc-pw-x">Password</label><input id="rc-pw-x" type="password" autocomplete="current-password" required style="${field}">`
        + `<div style="margin-top:14px;display:flex;gap:12px;flex-wrap:wrap;align-items:center"><button type="submit" id="rc-ok-x" style="${btn}">Confirm</button>${j && j.passkeys && canPasskey() ? '<button type="button" id="rc-pk-x" style="padding:9px 14px;font:inherit;cursor:pointer;color:inherit;background:transparent;border:1px solid var(--line,#30363d);border-radius:var(--r,8px)">Use a passkey</button>' : ''}<a href="#" id="rc-cancel-x" style="color:var(--text-dim,#9aa4ae)">Cancel</a></div>`
        + `<p id="rc-msg-x" role="alert" style="min-height:1.4em;margin:10px 0 0;color:var(--danger,#f85149)"></p></form>`;
      document.body.appendChild(box);
      const pw = box.querySelector('#rc-pw-x'), msg = box.querySelector('#rc-msg-x'); try { pw.focus(); } catch { /* old browser */ }
      const done = ok => { box.remove(); rcOpen = null; resolve(ok); };
      box.querySelector('#rc-cancel-x').addEventListener('click', e => { e.preventDefault(); done(false); });
      const pkb = box.querySelector('#rc-pk-x');                          // T-0241 part 5
      if (pkb) pkb.addEventListener('click', async () => { msg.textContent = ''; pkb.disabled = true; try { await usePasskey('recheck'); done(true); } catch (e) { msg.textContent = e.message; pkb.disabled = false; } });
      box.querySelector('form').addEventListener('submit', async e => {
        e.preventDefault(); msg.textContent = '';
        try { const r = await orig('/account/recheck', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw.value }) }); const d = await r.json().catch(() => ({}));
          if (r.ok) { done(true); return; } msg.textContent = d.error || 'That did not work. Try again.'; pw.value = ''; pw.focus(); }
        catch { msg.textContent = 'No connection. Try again in a moment.'; }
      });
    });
    return rcOpen;
  }
  async function report() {                                             // "this page is open", and "a person used it" if they did
    if (shown || stopped) return;
    const active = lastInputAt > lastReportAt; lastReportAt = Date.now();
    try {
      const r = await window.fetch('/account/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active }) });
      if (r.status === 401) { stopped = true; return; }                 // not signed in here: nothing to report
      if (r.ok) prefs = (await r.json()).lock || null;
    } catch { /* offline: the server counts the gap */ }
  }
  function idleCheck() {
    if (shown || stopped || !prefs || !prefs.idle) return;
    if (Date.now() - lastInputAt > prefs.idle * (prefs.minuteMs || 60000)) lockNow('idle');
  }
  async function lockNow(reason) {
    stopped = true;
    try { await orig('/account/lock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: reason === 'idle' ? 'idle' : 'manual' }) }); } catch { /* the reload still asks the server */ }
    location.reload();
  }
  window.ChamberScreenLock = { lockNow: () => lockNow('manual'), show };

  if (!ON_PAGES.includes(location.pathname)) return;
  for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll']) addEventListener(ev, () => { lastInputAt = Date.now(); }, { passive: true, capture: true });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') report(); });
  const loop = async () => { await report(); if (!stopped) setTimeout(loop, Math.min(30000, ((prefs && prefs.minuteMs) || 60000) / 2)); };
  loop();
  setInterval(idleCheck, 5000);
})();

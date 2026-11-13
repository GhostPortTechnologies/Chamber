// mail.js — minimal SMTP client for Chamber (STARTTLS on 587 or implicit TLS on 465, AUTH LOGIN). Zero dependencies.
// Configured with CHAMBER_SMTP_HOST/PORT/USER/PASSWORD/FROM. When unset, send() resolves false and the caller says so.
// SPDX-License-Identifier: AGPL-3.0-only  |  Copyright (C) 2026 GhostPort Technologies
const net = require('net'); const tls = require('tls');

const HOST = process.env.CHAMBER_SMTP_HOST || '', PORT = parseInt(process.env.CHAMBER_SMTP_PORT, 10) || 587;
const USER = process.env.CHAMBER_SMTP_USER || '', PASS = process.env.CHAMBER_SMTP_PASSWORD || '';
const FROM = process.env.CHAMBER_SMTP_FROM || USER;
const NAME = (process.env.CHAMBER_SMTP_NAME || 'Chamber').replace(/[\r\n<>"]/g, '');   // shown as the sender's name
const EHLO = (() => { try { return new URL(process.env.CHAMBER_PUBLIC_URL || '').hostname || 'chamber.local'; } catch { return 'chamber.local'; } })();
const enabled = !!(HOST && USER && PASS);

function send({ to, subject, text }) {
  if (!enabled) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    let sock, buf = '', done = false;
    const finish = (err) => { if (done) return; done = true; try { sock.destroy(); } catch {} err ? reject(err) : resolve(true); };
    const timer = setTimeout(() => finish(new Error('SMTP timeout')), 20000);
    const steps = [];                                               // [expectCode, lineToSend] pairs run in order
    const say = (line) => sock.write(line + '\r\n');
    // 2026-11-12: the confirm email landed in Gmail's spam folder. A message with no Message-ID, a bare address as sender and bare
    // line feeds in the body looks machine-made to a spam filter, so send what a normal mail program sends.
    const addr = FROM.replace(/^.*<|>.*$/g, ''), dom = addr.split('@')[1] || 'localhost';
    const from = /</.test(FROM) ? FROM : `${NAME} <${addr}>`;
    const msg = ['From: ' + from, 'To: ' + to, 'Subject: ' + subject.replace(/[\r\n]/g, ' '), 'Date: ' + new Date().toUTCString(),
                 `Message-ID: <${require('crypto').randomBytes(16).toString('hex')}@${dom}>`, 'Reply-To: ' + addr, 'Auto-Submitted: auto-generated',
                 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', text.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..')].join('\r\n');
    const plan = () => { steps.push(
      [250, `EHLO chamber`], ...(PORT === 465 ? [] : [[220, 'STARTTLS']]),
    ); };
    let stage = 'greet', upgraded = PORT === 465;
    const onLine = (line) => {
      const code = parseInt(line.slice(0, 3), 10);
      if (line[3] === '-') return;                                  // multi-line reply continues
      if (code >= 400) return finish(new Error('SMTP ' + line.trim()));
      switch (stage) {
        case 'greet': stage = 'ehlo'; return say('EHLO ' + EHLO);
        case 'ehlo':
          if (!upgraded) { stage = 'starttls'; return say('STARTTLS'); }
          stage = 'auth'; return say('AUTH LOGIN');
        case 'starttls':
          sock.removeAllListeners('data');
          sock = tls.connect({ socket: sock, servername: HOST }, () => { upgraded = true; stage = 'ehlo2'; say('EHLO ' + EHLO); attach(); });
          sock.on('error', finish); return;
        case 'ehlo2': stage = 'auth'; return say('AUTH LOGIN');
        case 'auth': stage = 'user'; return say(Buffer.from(USER).toString('base64'));
        case 'user': stage = 'pass'; return say(Buffer.from(PASS).toString('base64'));
        case 'pass': stage = 'from'; return say(`MAIL FROM:<${FROM.replace(/^.*<|>.*$/g, '')}>`);
        case 'from': stage = 'rcpt'; return say(`RCPT TO:<${to}>`);
        case 'rcpt': stage = 'data'; return say('DATA');
        case 'data': stage = 'body'; return sock.write(msg + '\r\n.\r\n');
        case 'body': stage = 'quit'; say('QUIT'); clearTimeout(timer); return finish(null);
        default: return;
      }
    };
    const attach = () => sock.on('data', d => { buf += d.toString(); let i; while ((i = buf.indexOf('\r\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 2); onLine(line); } });
    sock = PORT === 465 ? tls.connect({ host: HOST, port: PORT, servername: HOST }) : net.connect({ host: HOST, port: PORT });
    sock.on('error', (e) => { clearTimeout(timer); finish(e); });
    attach();
  });
}
module.exports = { send, enabled };

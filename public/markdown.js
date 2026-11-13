// markdown.js — Chamber's message renderer (T-0014, T-0050, T-0068). One file shared by the app (window.ChamberMD) and the
// Node tests (require). Everything is HTML-escaped before any markup is added, so message text can never inject HTML.
//
//   render(raw, ctx)      -> HTML. ctx: { currentUser, repoUrl, codeBlock(lang, code) -> HTML, tasks: true|false (checkboxes editable) }
//   highlight(code, lang) -> HTML for a code body: strings, comments, numbers, keywords; diff lines coloured; `numbered` adds line spans
//   detectLang(code)      -> 'js' | 'python' | 'bash' | 'json' | 'yaml' | 'html' | 'css' | 'sql' | 'go' | 'rust' | 'diff' | 'text'
//   findSecrets(text)     -> [{kind, match, start, end}] things that look like keys, tokens or passwords (the composer's secret guard)
//   redact(text, found, hashes) -> text with each match replaced by [redacted <kind> …<hash8>]
//   tasks(raw)            -> [{index, done}] the task-list boxes in a message, in order; toggleTask(raw, i) -> new raw text
//
// SPDX-License-Identifier: AGPL-3.0-only  |  Copyright (C) 2026 GhostPort Technologies
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.ChamberMD = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function escA(s) { return esc(s).replace(/'/g, '&#39;'); }

  // ── Syntax colours ─────────────────────────────────────────────────────────────────────────────
  const KW = {
    js: 'const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|this|import|export|from|default|try|catch|finally|throw|await|async|yield|typeof|instanceof|in|of|null|undefined|true|false|void|delete|static|get|set',
    ts: null, python: 'def|class|return|if|elif|else|for|while|in|not|and|or|is|None|True|False|import|from|as|try|except|finally|raise|with|lambda|yield|pass|break|continue|global|nonlocal|assert|del|async|await',
    bash: 'if|then|else|elif|fi|for|while|do|done|case|esac|in|function|return|exit|local|export|source|echo|set|shift|read|sudo|cd|ls|cat|grep|sed|awk|curl|systemctl|journalctl',
    go: 'package|import|func|return|if|else|for|range|switch|case|default|break|continue|go|defer|chan|select|var|const|type|struct|interface|map|nil|true|false|make|new|len|append|error',
    rust: 'fn|let|mut|pub|use|mod|struct|enum|impl|trait|for|in|while|loop|if|else|match|return|break|continue|where|as|ref|self|Self|super|crate|const|static|unsafe|async|await|dyn|move|true|false|Some|None|Ok|Err',
    sql: 'SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|INDEX|DROP|ALTER|ADD|COLUMN|PRIMARY|KEY|NOT|NULL|DEFAULT|JOIN|LEFT|RIGHT|INNER|ON|AS|AND|OR|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|DISTINCT|COUNT|SUM|AVG|MIN|MAX|BEGIN|COMMIT|ROLLBACK|IF|EXISTS|UNION|CASE|WHEN|THEN|ELSE|END|LIKE|IN|IS|BETWEEN',
  };
  KW.ts = KW.js + '|interface|type|enum|implements|readonly|namespace|declare|keyof|unknown|never|any|string|number|boolean';
  KW.javascript = KW.js; KW.typescript = KW.ts; KW.py = KW.python; KW.sh = KW.bash; KW.shell = KW.bash; KW.zsh = KW.bash; KW.golang = KW.go; KW.rs = KW.rust;
  const KWRE = {}; for (const k in KW) if (KW[k]) KWRE[k] = new RegExp('\\b(?:' + KW[k] + ')\\b', k === 'sql' ? 'gi' : 'g');
  const COMMENT_UNUSED = { js: /\/\/.*$|\/\*[\s\S]*?\*\//g, ts: /\/\/.*$|\/\*[\s\S]*?\*\//g, go: /\/\/.*$|\/\*[\s\S]*?\*\//g, rust: /\/\/.*$|\/\*[\s\S]*?\*\//g, css: /\/\*[\s\S]*?\*\//g, python: /#.*$/g, bash: /#.*$/g, yaml: /#.*$/g, sql: /--.*$/g, html: /&lt;!--[\s\S]*?--&gt;/g };
  function normLang(lang) {
    lang = String(lang || '').toLowerCase();
    return ({ javascript: 'js', typescript: 'ts', py: 'python', sh: 'bash', shell: 'bash', zsh: 'bash', golang: 'go', rs: 'rust', patch: 'diff', yml: 'yaml', htm: 'html', xml: 'html', plaintext: 'text', plain: 'text', txt: 'text', console: 'bash' })[lang] || lang;
  }
  const LINE_COMMENT = { js: '//', ts: '//', go: '//', rust: '//', python: '#', bash: '#', yaml: '#', sql: '--' };
  function splitComment(e, marker) {                               // find the first comment marker that is outside quotes (e is escaped text)
    let q = null;
    for (let i = 0; i < e.length; i++) {
      if (q) {
        if (e[i] === '\\') { i++; continue; }
        if (q === '&quot;' ? e.startsWith('&quot;', i) : e[i] === q) { if (q === '&quot;') i += 5; q = null; }
        continue;
      }
      if (e.startsWith('&quot;', i)) { q = '&quot;'; i += 5; continue; }
      if (e[i] === "'" || e[i] === '`') { q = e[i]; continue; }
      if (e.startsWith(marker, i)) return [e.slice(0, i), e.slice(i)];
    }
    return [e, ''];
  }
  function highlightLine(e, lang) {                               // e is already HTML-escaped; placeholders protect what is done
    if (lang === 'diff') {
      if (e.startsWith('@@')) return '<span class="d-hunk">' + e + '</span>';
      if (e.startsWith('+++') || e.startsWith('---')) return '<span class="d-file">' + e + '</span>';
      if (e.startsWith('+')) return '<span class="d-add">' + e + '</span>';
      if (e.startsWith('-')) return '<span class="d-del">' + e + '</span>';
      return e;
    }
    if (lang === 'text' || !lang) return e;
    const store = [];
    const stash = html => String.fromCharCode(0xE000 + store.push(html) - 1);
    if (lang === 'html') e = e.replace(/&lt;!--[\s\S]*?--&gt;/g, c => stash('<span class="tok-com">' + c + '</span>'));
    if (['js', 'ts', 'go', 'rust', 'css'].includes(lang)) e = e.replace(/\/\*[\s\S]*?\*\//g, c => stash('<span class="tok-com">' + c + '</span>'));
    let comment = '';
    if (LINE_COMMENT[lang]) { const [code, c] = splitComment(e, LINE_COMMENT[lang]); e = code; comment = c; }
    e = e.replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, s => stash('<span class="tok-str">' + s + '</span>'));
    if (lang === 'json') e = e.replace(/[-](?=\s*:)/g, ph => { const i = ph.charCodeAt(0) - 0xE000; store[i] = store[i].replace('tok-str', 'tok-key'); return ph; });
    else if (lang === 'yaml') e = e.replace(/^(\s*-?\s*)([A-Za-z_][\w.-]*)(\s*:)(\s|$)/, (m, a, k, c, d) => a + stash('<span class="tok-key">' + k + '</span>') + c + d);
    else if (lang === 'html') e = e.replace(/(&lt;\/?)([a-zA-Z][\w-]*)/g, (m, a, t) => a + stash('<span class="tok-key">' + t + '</span>')).replace(/\s([a-zA-Z-]+)(=)/g, (m, a, eq) => ' ' + stash('<span class="tok-attr">' + a + '</span>') + eq);
    else if (lang === 'css') e = e.replace(/^(\s*)([a-zA-Z-]+)(\s*:)/, (m, a, p, c) => a + stash('<span class="tok-key">' + p + '</span>') + c).replace(/^([^{};:-]+)(\{)/, (m, sel, b) => stash('<span class="tok-sel">' + sel + '</span>') + b);
    e = e.replace(/\b\d+(?:\.\d+)?\b/g, n => stash('<span class="tok-num">' + n + '</span>'));
    if (KWRE[lang]) e = e.replace(KWRE[lang], k => stash('<span class="tok-key">' + k + '</span>'));
    if (comment) e += stash('<span class="tok-com">' + comment + '</span>');
    return e.replace(/[-]/g, ch => store[ch.charCodeAt(0) - 0xE000]);
  }
  function highlight(code, lang, numbered) {
    lang = normLang(lang) || detectLang(code);
    const lines = String(code).split('\n');
    const out = lines.map(l => highlightLine(esc(l), lang));
    if (!numbered) return out.join('\n');
    return out.map(l => '<span class="line">' + (l || ' ') + '</span>').join('');
  }
  function detectLang(t) {
    t = String(t || '');
    if (/^\s*(?:diff --git|@@ |index [0-9a-f]+\.\.|--- a\/|\+\+\+ b\/)/m.test(t)) return 'diff';
    const trimmed = t.trim();
    if (/^[\[{][\s\S]*[\]}]$/.test(trimmed)) { try { JSON.parse(trimmed); return 'json'; } catch (_) { /* not json */ } }
    if (/^\s*<(!doctype|html|div|span|p|a|ul|li|body|head|script|style|table|svg|section|button|form|input)\b/im.test(t)) return 'html';
    if (/#!.*\b(?:bash|sh|zsh)\b|^\s*(?:sudo|apt|systemctl|journalctl|curl|export|echo|cd)\b|\b(?:fi|esac|done)\b/m.test(t)) return 'bash';
    if (/\b(?:SELECT|INSERT INTO|CREATE TABLE|UPDATE)\b[\s\S]*\b(?:FROM|VALUES|SET|WHERE)\b/i.test(t)) return 'sql';
    if (/^\s*(?:package\s+\w+|func\s+\w+\(|import\s+\()/m.test(t)) return 'go';
    if (/\bfn\s+\w+\s*\(|\blet\s+mut\b|::\w+\(|impl\s+\w+/.test(t)) return 'rust';
    if (/^\s*(?:def|class)\s+\w+.*:\s*$|^\s*(?:import|from)\s+[\w.]+(?:\s+import)?|\belif\b/m.test(t)) return 'python';
    if (/\b(?:const|let|var|function)\b|=>|console\.log/.test(t)) return 'js';
    if (/^\s*[.#]?[\w-][^{}\n]*\{[^}]*\}/m.test(t) && /[a-z-]+\s*:\s*[^;{}]+;/.test(t)) return 'css';
    if (/^\w[\w-]*:\s*(?:\S|$)/m.test(t) && !/[;{}]/.test(t)) return 'yaml';
    return 'text';
  }

  // ── Markdown ───────────────────────────────────────────────────────────────────────────────────
  const TASK_RE = /^(\s*)([-*+]|\d+[.)])\s+\[( |x|X)\]\s/;
  function tasks(raw) { const out = []; let i = 0; for (const l of String(raw || '').split('\n')) { const m = l.match(TASK_RE); if (m) out.push({ index: i++, done: m[3] !== ' ' }); } return out; }
  function toggleTask(raw, index) {
    let i = 0;
    return String(raw || '').split('\n').map(l => { const m = l.match(TASK_RE); if (!m) return l; if (i++ !== index) return l; return l.replace(/\[( |x|X)\]/, m[3] === ' ' ? '[x]' : '[ ]'); }).join('\n');
  }
  function inline(s, ctx) {                                       // s is escaped text without fenced blocks
    const store = [];
    const stash = html => '\u0001' + (store.push(html) - 1) + '\u0001';
    s = s.replace(/`([^`\n]+)`/g, (m, c) => stash('<code class="inline">' + c + '</code>'));
    s = s.replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g, (m, t, u) => stash('<a href="' + u.replace(/'/g, '&#39;') + '" target="_blank" rel="noopener noreferrer">' + t + '</a>'));   // u is already escaped (the whole text was); escaping it again turned & into &amp;amp; and broke every link with two parameters
    s = s.replace(/(^|[^"'=>\w])(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, (m, pre, u) => pre + stash('<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + u + '</a>'));
    s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>');
    s = s.replace(/(^|[\s(])\*([^*\s][^*\n]*?[^*\s]|[^*\s])\*(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>');
    s = s.replace(/(^|[\s(])_([^_\s][^_\n]*?[^_\s]|[^_\s])_(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>');
    s = s.replace(/~~([^~\n]+?)~~/g, '<s>$1</s>');
    s = s.replace(/(^|[^\w-])(T-\d{4})\b/g, (m0, pre, id) => pre + '<a href="#" class="tlink" data-ticket="' + id + '" title="open ticket">' + id + '</a>');
    if (ctx.repoUrl) s = s.replace(/(^|[^\w\/#&;.])([0-9a-f]{7,40})\b(?![^<]*>)/g, (m0, pre, sha) => /\d/.test(sha) && /[a-f]/.test(sha) ? pre + '<a href="' + escA(ctx.repoUrl) + '/commit/' + sha + '" target="_blank" rel="noopener noreferrer" class="shalink" title="open commit">' + sha.slice(0, 10) + '</a>' : m0);
    s = s.replace(/(^|[^\w\/])@([A-Za-z0-9_-]{2,24})/g, (m0, pre, name) => pre + '<span class="mention' + (ctx.currentUser && name.toLowerCase() === String(ctx.currentUser).toLowerCase() ? ' me' : '') + '">@' + name + '</span>');
    return s.replace(/\u0001(\d+)\u0001/g, (m, i) => store[+i]);
  }
  function defaultCodeBlock(lang, code) { lang = normLang(lang) || detectLang(code); return '<pre class="code" data-lang="' + escA(lang) + '"><code class="lang-' + escA(lang) + '">' + highlight(code, lang) + '</code></pre>'; }
  function render(raw, ctx) {
    ctx = ctx || {}; raw = String(raw == null ? '' : raw);
    const blocks = []; const codeBlock = ctx.codeBlock || defaultCodeBlock;
    let text = raw.replace(/```([a-zA-Z0-9_+#.-]*)[^\n]*\n?([\s\S]*?)```/g, (m, lang, code) => { blocks.push(codeBlock(lang, code.replace(/\n$/, ''))); return '\u0000' + (blocks.length - 1) + '\u0000'; });
    const lines = esc(text).split('\n'); const out = []; let taskN = 0;
    const flushPara = (buf) => { if (buf.length) out.push(buf.map(l => inline(l, ctx)).join('<br>')); buf.length = 0; };
    const para = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      let m;
      if ((m = l.match(/^(#{1,3})\s+(.+?)\s*#*\s*$/))) { flushPara(para); out.push('<h' + m[1].length + ' class="md">' + inline(m[2], ctx) + '</h' + m[1].length + '>'); continue; }
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { flushPara(para); out.push('<hr class="md">'); continue; }
      if (/^\s*&gt;\s?/.test(l)) {                                                                     // blockquote (lines starting with >)
        flushPara(para); const q = [];
        while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) q.push(lines[i].replace(/^\s*&gt;\s?/, '')), i++;
        i--; out.push('<blockquote class="md">' + q.map(x => inline(x, ctx)).join('<br>') + '</blockquote>'); continue;
      }
      if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {   // table
        flushPara(para);
        const cells = r => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
        const aligns = cells(lines[i + 1]).map(c => /^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : '');
        let h = '<table class="md"><thead><tr>' + cells(l).map((c, k) => '<th' + (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : '') + '>' + inline(c, ctx) + '</th>').join('') + '</tr></thead><tbody>';
        i += 2;
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { h += '<tr>' + cells(lines[i]).map((c, k) => '<td' + (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : '') + '>' + inline(c, ctx) + '</td>').join('') + '</tr>'; i++; }
        i--; out.push(h + '</tbody></table>'); continue;
      }
      if (/^(\s*)([-*+]|\d+[.)])\s+\S/.test(l)) {                                                     // list (nested by indent, task boxes)
        flushPara(para);
        const stack = []; let html = '';
        const open = (ordered, indent) => { html += ordered ? '<ol class="md">' : '<ul class="md">'; stack.push({ ordered, indent }); };
        const close = () => { const s = stack.pop(); html += s.ordered ? '</ol>' : '</ul>'; };
        while (i < lines.length && (m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/))) {
          const indent = m[1].replace(/\t/g, '  ').length, ordered = /\d/.test(m[2]);
          while (stack.length && indent < stack[stack.length - 1].indent) close();
          if (!stack.length || indent > stack[stack.length - 1].indent) open(ordered, indent);
          else if (stack[stack.length - 1].ordered !== ordered) { close(); open(ordered, indent); }
          let body = m[3]; const t = body.match(/^\[( |x|X)\]\s+([\s\S]*)$/);
          if (t) { const done = t[1] !== ' '; html += '<li class="task' + (done ? ' done' : '') + '"><label><input type="checkbox" data-task="' + (taskN++) + '"' + (done ? ' checked' : '') + (ctx.tasks ? '' : ' disabled') + '> <span>' + inline(t[2], ctx) + '</span></label></li>'; }
          else html += '<li>' + inline(body, ctx) + '</li>';
          i++;
        }
        while (stack.length) close();
        i--; out.push(html); continue;
      }
      if (/^\u0000\d+\u0000\s*$/.test(l)) { flushPara(para); out.push(l.trim()); continue; }            // a fenced block on its own line
      if (l === '') { if (para.length) { flushPara(para); out.push(''); } continue; }                    // blank line = paragraph break (several count once)
      para.push(l);
    }
    flushPara(para);
    let html = ''; let prevInline = false;
    for (const e of out) {
      if (e === '') continue;
      const block = /^(?:<(?:h[1-3]|ul|ol|table|blockquote|hr|pre|div)|\u0000)/.test(e);   // the \u0000 placeholder of a code box does not start with '<': it never matched, so code boxes got a blank line above and below
      if (html && prevInline && !block) html += '<br><br>';
      html += e; prevInline = !block;
    }
    html = html.replace(/\u0000(\d+)\u0000/g, (m, i) => blocks[+i]);
    return html;
  }

  // ── Secret guard ───────────────────────────────────────────────────────────────────────────────
  const SECRETS = [
    ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/g],
    ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
    ['API key', /\bsk-(?!ant-)[A-Za-z0-9]{20,}\b/g],
    ['Stripe key', /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g],
    ['Stripe webhook secret', /\bwhsec_[A-Za-z0-9]{16,}\b/g],
    ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g],
    ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
    ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
    ['Chamber agent token', /\bchk_[a-f0-9]{8}_[A-Za-z0-9_-]{20,}/g],
    ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
    ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
    ['bearer token', /\bBearer\s+(?!<)[A-Za-z0-9._~+\/-]{20,}=*/g],
    ['password or secret value', /^[ \t]*(?:export\s+)?[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD)[A-Z0-9_]*[ \t]*=[ \t]*["']?([^\s"']{8,})["']?[ \t]*$/gm],
  ];
  const PLACEHOLDER = /^(?:\.{3}|<.*>|x{3,}|\*{3,}|your[-_]|changeme|example|placeholder|redacted|\$\{|\$[A-Z_]+$)/i;
  function findSecrets(text) {
    text = String(text || ''); const found = [];
    for (const [kind, re] of SECRETS) {
      re.lastIndex = 0; let m;
      while ((m = re.exec(text))) {
        const value = m[1] !== undefined ? m[1] : m[0];
        if (m[1] !== undefined && (PLACEHOLDER.test(value) || /^\[redacted/.test(value))) continue;
        const start = m[1] !== undefined ? m.index + m[0].indexOf(m[1]) : m.index;
        if (found.some(f => start < f.end && start + value.length > f.start)) continue;                 // already covered by a wider match
        found.push({ kind, match: value, start, end: start + value.length });
        if (!re.global) break;
      }
    }
    return found.sort((a, b) => a.start - b.start);
  }
  function redact(text, found, hashes) {
    let out = String(text || ''); const list = [...(found || [])].sort((a, b) => b.start - a.start);
    for (const f of list) { const h = hashes && hashes[f.match]; out = out.slice(0, f.start) + '[redacted ' + f.kind + (h ? ' …' + String(h).slice(0, 8) : '') + ']' + out.slice(f.end); }
    return out;
  }

  return { render, highlight, detectLang, normLang, findSecrets, redact, tasks, toggleTask, esc, escA };
});

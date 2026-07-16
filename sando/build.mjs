/* ============================================================
   SANDŌ static generator
   Pours _posts/*.md + _tabs/*.md into the handcrafted templates.
   Output: /dist  (a complete static site, domain-root paths)
   ============================================================ */
import { marked } from 'marked';
import hljs from 'highlight.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* build-time syntax highlighting inside SANDŌ terminal cards */
const copyBtnSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
marked.use({
  renderer: {
    code(a, b) {
      const text = (typeof a === 'object' ? a.text : a) ?? '';
      let lang = (typeof a === 'object' ? a.lang : b) || '';
      lang = String(lang).split(/\s+/)[0].toLowerCase();
      let out, label = lang;
      if (lang && hljs.getLanguage(lang)) { out = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value; }
      else { const au = hljs.highlightAuto(text, ['bash', 'python', 'powershell', 'cpp', 'x86asm', 'ruby', 'javascript', 'http', 'sql', 'ini']); out = au.value; label = label || au.language || 'shell'; }
      label = label || 'shell';
      return `<div class="code-card"><div class="code-card__bar"><span class="code-card__dots"><i></i><i></i><i></i></span><span class="code-card__lang">${label}</span><button class="code-card__copy" type="button">${copyBtnSvg}<span>copy</span></button></div><pre><code class="hljs">${out}</code></pre></div>\n`;
    }
  }
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist');
const POSTS_DIR = path.join(ROOT, '_posts');
const TABS_DIR = path.join(ROOT, '_tabs');

/* ---------- helpers ---------- */
const rmrf = (p) => fs.existsSync(p) && fs.rmSync(p, { recursive: true, force: true });
const mkdir = (p) => fs.mkdirSync(p, { recursive: true });
const write = (rel, html) => { const f = path.join(OUT, rel); mkdir(path.dirname(f)); fs.writeFileSync(f, html); };
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slugify = (s) => s.toString().toLowerCase().trim()
  .replace(/[^\w\s-]/g, '').replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (d) => `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, '0')}, ${d.getUTCFullYear()}`;

/* ---------- front-matter parser (focused YAML subset) ---------- */
function parseFront(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: raw };
  const data = {}; const body = m[2];
  const lines = m[1].split(/\r?\n/);
  let key = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s+/.test(line) && key) { // nested (image: path:)
      const nm = line.trim().match(/^(\w+):\s*(.*)$/);
      if (nm) { data[key] = data[key] || {}; data[key][nm[1]] = strip(nm[2]); }
      continue;
    }
    const km = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!km) continue;
    key = km[1]; let val = km[2].trim();
    if (val === '') { data[key] = {}; continue; } // block follows
    if (val.startsWith('[') && val.endsWith(']')) {
      data[key] = val.slice(1, -1).split(',').map(s => strip(s)).filter(Boolean);
    } else { data[key] = strip(val); key = null; }
  }
  return { data, body };
}
const strip = (s) => s.trim().replace(/^["']|["']$/g, '').replace(/\s+#.*$/, '').trim();

/* enforce "no em dashes" everywhere: ranges -> arrow, spaced -> comma, bare -> hyphen */
const deEmDash = (s = '') => s
  .replace(/(\d{4})\s*—\s*(Present|\d{4})/g, '$1 → $2')
  .replace(/\s+—\s+/g, ', ')
  .replace(/—/g, '-');

/* ---------- markdown → SANDŌ html ---------- */
const copySvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';

function renderBody(md) {
  // strip Liquid raw guards (keep inner content)
  md = md.replace(/\{%-?\s*(end)?raw\s*-?%\}/g, '');
  let html = marked.parse(md, { mangle: false, headerIds: false });
  const toc = [];

  // Chirpy prompt callouts: blockquote + {: .prompt-TYPE }
  html = html.replace(/<blockquote>([\s\S]*?)<\/blockquote>/g, (m, inner) => {
    const pm = inner.match(/\{:\s*\.prompt-(tip|info|warning|danger)\s*\}/);
    const type = pm ? pm[1] : null;
    inner = inner.replace(/\{:\s*\.[^}]*\}/g, '').replace(/\s+<\/p>/g, '</p>');
    return `<blockquote${type ? ` class="prompt prompt--${type}"` : ''}>${inner}</blockquote>`;
  });
  // strip any leftover kramdown attribute lists (image widths, ids, etc.)
  html = html.replace(/\{:\s*[^}]*\}/g, '');

  // rewrite image paths -> /images/...
  html = html.replace(/(<img[^>]*\ssrc=")(?:\.\.\/)?images\//g, '$1/images/');

  // strip a leading duplicate <h1> (post title already in hero); demote other h1 -> h2
  html = html.replace(/^\s*<h1[^>]*>[\s\S]*?<\/h1>/, '');
  html = html.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/g, '<h2>$1</h2>');

  // headings -> ids + collect toc
  html = html.replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (_, lvl, inner) => {
    const text = inner.replace(/<[^>]+>/g, '').trim();
    const id = slugify(text) || ('s' + toc.length);
    if (lvl === '2') toc.push({ id, text: deEmDash(text) });
    return `<h${lvl} id="${id}">${inner}</h${lvl}>`;
  });

  // (code fences are rendered as terminal cards by the marked renderer)

  // lone images -> framed plates (caption only when alt is meaningful)
  html = html.replace(/<p>(<img[^>]*>)<\/p>/g, (_, img) => {
    const alt = (img.match(/alt="([^"]*)"/) || [, ''])[1];
    const cap = alt && !/^(image|img)?[\s._-]*(\.png|\.jpg)?$/i.test(alt.trim()) && !/^image\.png$/i.test(alt)
      ? `<figcaption>${esc(alt)}</figcaption>` : '';
    return `<figure class="plate">${img}${cap}</figure>`;
  });

  // external links -> new tab
  html = html.replace(/<a href="(https?:\/\/[^"]+)"/g, '<a href="$1" target="_blank" rel="noopener"');

  // strip em dashes from prose, leaving code blocks (<pre>) untouched
  html = html.split(/(<pre[\s\S]*?<\/pre>)/).map((seg, i) => i % 2 ? seg : deEmDash(seg)).join('');

  return { html, toc };
}

/* ---------- load posts ---------- */
const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.md'));
const posts = files.map(file => {
  const raw = fs.readFileSync(path.join(POSTS_DIR, file), 'utf8');
  const { data, body } = parseFront(raw);
  const slug = slugify(file.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, ''));
  const dm = (data.date || file.slice(0, 10)).toString().slice(0, 10);
  const date = new Date(dm + 'T00:00:00Z');
  const { html, toc } = renderBody(body);
  const cats = [].concat(data.categories || []);
  const tags = [].concat(data.tags || []);
  let img = (data.image && (data.image.path || data.image)) || '';
  if (img) img = '/' + img.replace(/^\/?(\.\.\/)?/, '').replace(/^\//, '');
  const words = body.replace(/[#>*`\-\[\]!]/g, ' ').split(/\s+/).filter(Boolean).length;
  const readMin = Math.max(2, Math.round(words / 200));
  const plain = body.replace(/^---[\s\S]*?---/, '').replace(/[#>*`!\[\]()]/g, '')
    .replace(/https?:\/\/\S+/g, '').replace(/\.\.\/images\/\S+/g, '').replace(/\s+/g, ' ').trim();
  const excerpt = plain.slice(0, 155).replace(/\s\S*$/, '') + '…';
  return {
    file, slug, url: `/posts/${slug}/`, title: deEmDash(data.title || slug), date, dateStr: fmtDate(date),
    cats, tags, img, html, toc, readMin, excerpt: deEmDash(excerpt),
    catSlugs: cats.map(c => ({ name: c, slug: slugify(c) })),
    tagSlugs: tags.map(t => ({ name: t, slug: slugify(t) })),
  };
}).sort((a, b) => b.date - a.date || a.title.localeCompare(b.title));

/* ---------- taxonomy ---------- */
const byCat = {}, byTag = {};
for (const p of posts) {
  for (const c of p.catSlugs) { (byCat[c.slug] ||= { name: c.name, posts: [] }).posts.push(p); }
  for (const t of p.tagSlugs) { (byTag[t.slug] ||= { name: t.name, posts: [] }).posts.push(p); }
}
const catList = Object.entries(byCat).map(([slug, v]) => ({ slug, ...v })).sort((a, b) => b.posts.length - a.posts.length);
const tagList = Object.entries(byTag).map(([slug, v]) => ({ slug, ...v })).sort((a, b) => b.posts.length - a.posts.length);

/* category → short subtitle */
const CAT_SUB = {
  'windows-machine': 'Active Directory · privesc', 'linux-machine': 'web · enumeration · CVEs',
  'web-challenges': 'SSRF · SSTI · IDOR', 'exploit-development': 'SEH · egghunter · DEP',
  'ad-chain': 'trust abuse · full estate',
};

/* ============================================================
   TEMPLATES
   ============================================================ */
const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Shippori+Mincho+B1:wght@500;600;700&family=Zen+Kaku+Gothic+New:wght@400;500;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">`;
const SEAL = `<svg viewBox="0 0 24 24" fill="none" stroke="var(--ember)" stroke-width="1.6" stroke-linecap="round"><path d="M3 8h18M5 8v11M19 8v11M2 8l10-5 10 5M8 8v11M16 8v11"/></svg>`;
const TORII = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 6h18M4 6 2 3M20 6l2-3M5 6v15M19 6v15M5 10h14"/></svg>`;
const ARROW = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`;

const nav = (active = '') => `
<header class="nav"><div class="nav__inner">
  <a class="brand" href="/" aria-label="Remo, home"><span class="brand__seal">${SEAL}</span><span class="brand__name">Remo<small>参道 · SANDŌ</small></span></a>
  <nav class="nav__links" aria-label="Primary">
    <a href="/"${active === 'home' ? ' aria-current="page"' : ''}>Home</a>
    <a href="/categories/"${active === 'cat' ? ' aria-current="page"' : ''}>Categories</a>
    <a href="/tags/"${active === 'tag' ? ' aria-current="page"' : ''}>Tags</a>
    <a href="/archives/"${active === 'arc' ? ' aria-current="page"' : ''}>Archive</a>
    <a href="/about/"${active === 'about' ? ' aria-current="page"' : ''}>About</a>
  </nav>
  <div class="nav__tools">
    <button class="icon-btn search-btn" data-cmdk-open aria-label="Search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg><span>Search</span><kbd>⌘K</kbd></button>
    <button class="icon-btn" data-theme-toggle aria-label="Toggle daylight"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v2M12 19v2M5 12H3M21 12h-2M6 6 4.5 4.5M19.5 19.5 18 18M18 6l1.5-1.5M4.5 19.5 6 18"/><circle cx="12" cy="12" r="4"/></svg></button>
    <button class="icon-btn nav__burger" aria-label="Menu"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
  </div>
</div></header>
<div class="drawer"><div class="drawer__inner">
  <a href="/">Home<small>参道</small></a><a href="/categories/">Categories<small>区</small></a>
  <a href="/tags/">Tags<small>札</small></a><a href="/archives/">Archive<small>記録</small></a><a href="/about/">About<small>私</small></a>
</div></div>`;

const footer = () => `
<footer class="foot"><div class="vkanji foot__vk">また会おう</div><div class="wrap-wide">
  <div class="foot__inner">
    <div class="foot__brand"><a class="brand" href="/"><span class="brand__seal">${SEAL}</span><span class="brand__name">Remo<small>参道 · SANDŌ</small></span></a>
      <p>Offensive-security field notes. Always hacking, always learning. 火を絶やすな, keep the lantern lit.</p></div>
    <div class="foot__col"><h4>Explore</h4><a href="/">Home</a><a href="/categories/">Categories</a><a href="/tags/">Tags</a><a href="/archives/">Archive</a><a href="/about/">About</a></div>
    <div class="foot__col"><h4>Elsewhere</h4><a href="https://github.com/Remo1x" target="_blank" rel="noopener">GitHub</a><a href="https://x.com/Rem01x" target="_blank" rel="noopener">Twitter / X</a><a href="https://www.linkedin.com/in/rem01x/" target="_blank" rel="noopener">LinkedIn</a><a href="https://app.hackthebox.com/profile/1080501" target="_blank" rel="noopener">HackTheBox</a></div>
  </div>
  <div class="foot__bottom"><span>© ${new Date().getUTCFullYear()} SadlyRemo · Built on the approach.</span><span>参道 · designed &amp; handcrafted</span></div>
</div></footer>`;

const cmdk = () => `
<div class="cmdk" role="dialog" aria-modal="true" aria-label="Search"><div class="cmdk__panel">
  <div class="cmdk__input"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg><input type="text" placeholder="Search writeups, tags, techniques…" aria-label="Search"></div>
  <div class="cmdk__results"></div>
</div></div>`;

const loader = () => `<div class="loader"><div class="loader__torii">${TORII}</div><div class="loader__bar"></div></div>`;

function layout({ title, desc, body, active, cls = '' }) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc || '')}">
<link rel="icon" href="/naruto.jpg">${FONTS}
<link rel="stylesheet" href="/assets/sando.css">
</head><body class="${cls}">
<div class="sky"></div><div class="fog"></div><div class="grain"></div>
${loader()}${nav(active)}
${body}
${footer()}${cmdk()}
<script src="/assets/search.js"></script><script src="/assets/sando.js"></script>
</body></html>`;
}

const card = (p) => `
<a class="card" href="${p.url}"><div class="card__glow"></div>
  <div class="card__media">${p.img ? `<img src="${p.img}" alt="" loading="lazy">` : ''}
    <span class="card__cat"><span class="tag ${p.cats[0] && /exploit/i.test(p.cats[0]) ? 'tag--ember' : ''}">${esc(p.cats[0] || 'Writeup')}</span></span></div>
  <div class="card__body"><h3 class="card__title">${esc(p.title)}</h3>
    <p class="card__excerpt">${esc(p.excerpt)}</p>
    <div class="card__foot"><span>${p.dateStr}</span><span class="dot"></span><span>${esc((p.tags[0] || '').toLowerCase())}</span></div>
  </div></a>`;

/* ---------- HOME ---------- */
function pageHome() {
  const latest = posts.slice(0, 6);
  const gates = catList.map((c, i) => `
    <a class="gate" href="/categories/${c.slug}/" data-reveal data-reveal-delay="${i % 5}">
      <span class="gate__torii">${TORII}</span>
      <span class="gate__count">${String(c.posts.length).padStart(2, '0')}</span>
      <span class="gate__name">${esc(c.name.replace(/\b\w/g, m => m.toUpperCase()))}</span>
      <span class="gate__sub">${CAT_SUB[c.slug] || c.posts.length + ' writeups'}</span></a>`).join('');
  const series = posts.filter(p => p.cats.some(c => /exploit/i.test(c))).slice().reverse();
  const seriesItems = series.map((p, i) => `
    <a class="series__item" href="${p.url}"><span class="series__num">${String(i + 1).padStart(2, '0')}</span><b>${esc(p.title.replace(/ [--].*$/, '').slice(0, 46))}</b>${ARROW.replace('class="', 'class="arrow ').replace('<svg', '<svg class="arrow"')}</a>`).join('');
  const seriesImg = series[0]?.img || '/images/seh-banner.png';

  const body = `
<section class="hero">
  <div class="hero__scene" aria-hidden="true">${HERO_SVG}
    <div class="lantern" style="left:20%;top:52%"></div><div class="lantern" style="left:26%;top:60%;animation-delay:.8s"></div>
    <div class="lantern" style="left:72%;top:44%;animation-delay:1.4s"></div><div class="lantern" style="left:78%;top:50%;animation-delay:.4s"></div>
    <div class="particles" style="position:absolute;inset:0;pointer-events:none"></div>
  </div>
  <div class="wrap-wide hero__grid">
    <div class="hero__content">
      <span class="eyebrow hero__tag" data-reveal>Reverse Engineering · Exploit Development</span>
      <h1 data-reveal data-reveal-delay="1">Walk the<br><span class="em">approach.</span></h1>
      <p class="hero__sub" data-reveal data-reveal-delay="2">Field notes from the offensive edge, Active Directory, Windows internals, and exploit development, written the way a path leads to a gate: one deliberate step at a time.</p>
      <div class="hero__cta" data-reveal data-reveal-delay="3">
        <a class="btn btn--primary" href="#writeups">Read the writeups ${ARROW}</a>
        <a class="btn btn--ghost" href="/about/">Who is Remo</a>
      </div>
      <div class="hero__meta" data-reveal data-reveal-delay="4">
        <div class="stat"><b>${posts.length}</b><span>Writeups</span></div>
        <div class="stat"><b>2+</b><span>Years offensive sec</span></div>
        <div class="stat"><b>12</b><span>Certifications</span></div>
      </div>
    </div>
    <div class="hero__vk" aria-hidden="true"><div class="vkanji">攻撃者の道</div></div>
  </div>
  <div class="scroll-cue" aria-hidden="true"><span></span>scroll</div>
</section>

<section class="section" style="padding-block:clamp(2.5rem,6vw,4.5rem)">
  <div class="wrap" data-reveal style="display:grid;grid-template-columns:auto 1fr;gap:1.8rem;align-items:center">
    <img src="/naruto.jpg" alt="Remo" width="88" height="88" style="width:88px;height:88px;border-radius:20px;border:1px solid var(--line);object-fit:cover">
    <div><p style="margin:0;font-family:var(--serif);font-size:clamp(1.15rem,1rem+1vw,1.6rem);line-height:1.5;color:var(--fg)">I'm <strong style="color:var(--accent)">SadlyRemo</strong>, a penetration tester at <strong style="color:var(--accent)">ZeroSploit MEA</strong> working Active Directory, web, code review, and mobile. This is where I document the breaks.</p>
      <p style="margin:.6rem 0 0;font-family:var(--mono);font-size:.74rem;letter-spacing:.14em;color:var(--fg-dim);text-transform:uppercase">CPTS · CRTM · CRTE · CRTP · CRTO · CWEE · eWPTX · eMAPT · OSEP · <a href="/about/" style="color:var(--accent)">+ more →</a></p></div>
  </div>
</section>

<section class="section" id="writeups">
  <div class="wrap-wide">
    <div class="section-head" data-reveal><div><span class="eyebrow">最新 · Latest</span><h2>Recent writeups</h2></div>
      <p>Machines, chains, and challenges, from initial foothold to the flag.</p></div>
    <div class="grid">${latest.map(card).join('')}</div>
    <div style="text-align:center;margin-top:2.6rem" data-reveal><a class="btn btn--ghost" href="/archives/">View all ${posts.length} writeups ${ARROW}</a></div>
  </div>
</section>

<section class="section" id="districts" style="padding-top:0">
  <div class="wrap-wide"><div class="section-head" data-reveal><div><span class="eyebrow">区 · Districts</span><h2>Choose a gate</h2></div>
    <p>Every category is a district of the village, enter through its torii.</p></div>
    <div class="gates">${gates}</div></div>
</section>

<section class="section" style="padding-top:0">
  <div class="wrap-wide"><div class="series" data-reveal><div class="series__inner">
    <div class="series__text"><span class="eyebrow">連載 · Series</span>
      <h2 style="font-family:var(--serif);font-weight:600;font-size:clamp(1.6rem,1.2rem+1.6vw,2.4rem);margin:.4rem 0 .6rem;line-height:1.15">The Windows Exploit Development trilogy</h2>
      <p style="color:var(--fg-dim);max-width:40ch">A ground-up path through modern stack exploitation on Windows, read in order, or drop into any step.</p>
      <div class="series__list">${seriesItems}</div></div>
    <div class="series__media"><img src="${seriesImg}" alt="Exploit development series"></div>
  </div></div></div>
</section>`;
  return layout({ title: 'Remo, 参道 · Offensive Security Writing', desc: "SadlyRemo, penetration tester. Writeups on Active Directory, exploit development, and web security.", body, active: 'home', cls: 'is-home' });
}

/* original blue-hour hero scene (shared) */
const HERO_SVG = `<svg viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice"><defs>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0d1526"/><stop offset=".45" stop-color="#101a2e"/><stop offset="1" stop-color="#0a0e17"/></linearGradient>
<radialGradient id="glow" cx="76%" cy="14%" r="40%"><stop offset="0" stop-color="#43bfa8" stop-opacity=".38"/><stop offset=".5" stop-color="#24796b" stop-opacity=".12"/><stop offset="1" stop-color="#0a0e17" stop-opacity="0"/></radialGradient>
<linearGradient id="mtn" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#26314a"/><stop offset="1" stop-color="#141c2c"/></linearGradient>
<linearGradient id="hill1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1a2338"/><stop offset="1" stop-color="#111826"/></linearGradient>
<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a0e17" stop-opacity="0"/><stop offset="1" stop-color="#0a0e17"/></linearGradient></defs>
<rect width="1440" height="900" fill="url(#sky)"/><rect width="1440" height="900" fill="url(#glow)"/>
<g fill="#dfe7ff" opacity=".5"><circle cx="180" cy="120" r="1"/><circle cx="320" cy="80" r="1.3"/><circle cx="540" cy="150" r="1"/><circle cx="900" cy="90" r="1"/><circle cx="1120" cy="170" r="1.2"/><circle cx="1320" cy="110" r="1"/><circle cx="700" cy="60" r="1"/><circle cx="1000" cy="220" r="1"/></g>
<path d="M120 470 L360 210 Q380 195 400 210 L640 470 Z" fill="url(#mtn)"/>
<path d="M330 250 L360 210 Q380 195 400 210 L432 252 Q400 268 380 250 Q360 235 348 258 Z" fill="#cdd6ea" opacity=".9"/>
<path d="M0 520 Q300 430 620 500 T1440 470 V900 H0 Z" fill="url(#hill1)" opacity=".85"/>
<path d="M0 600 Q380 520 760 585 T1440 560 V900 H0 Z" fill="#0f1626"/>
<g fill="#0c1220" transform="translate(1015 300)"><rect x="34" y="0" width="6" height="46"/><path d="M6 60 H68 L58 44 H16 Z"/><rect x="20" y="60" width="34" height="26"/><path d="M2 100 H72 L60 84 H14 Z"/><rect x="18" y="100" width="38" height="30"/><path d="M-4 146 H78 L64 128 H10 Z"/><rect x="14" y="146" width="46" height="34"/><path d="M-8 196 H82 L68 176 H6 Z"/></g>
<path d="M0 640 Q400 600 720 640 T1440 620 V900 H0 Z" fill="#0a0e17"/>
<path d="M700 900 L620 660 L820 660 L740 900 Z" fill="#141d30" opacity=".8"/>
<g stroke="#243247" stroke-width="1.4" opacity=".5"><line x1="662" y1="740" x2="778" y2="740"/><line x1="640" y1="800" x2="800" y2="800"/><line x1="626" y1="850" x2="814" y2="850"/></g>
<g transform="translate(120 430)"><path d="M-30 40 H360 L340 6 H-10 Z" fill="#181114"/><rect x="-10" y="40" width="330" height="16" fill="#1b1315"/><rect x="30" y="52" width="26" height="330" fill="#1b1315"/><rect x="256" y="52" width="26" height="330" fill="#1b1315"/><rect x="10" y="110" width="292" height="14" fill="#1b1315"/><path d="M-30 40 H360 L340 6 H-10 Z" fill="none" stroke="#43bfa8" stroke-opacity=".18" stroke-width="2"/></g>
<rect width="1440" height="900" fill="url(#fade)" opacity=".55"/></svg>`;

/* ---------- ARTICLE ---------- */
function pageArticle(p, idx) {
  const prev = posts[idx + 1]; const next = posts[idx - 1];
  const toc = p.toc.length >= 2 ? `
    <aside class="toc-rail" aria-label="On this page"><h5>参道 · The path</h5>
      ${p.toc.map(t => `<a href="#${t.id}">${esc(t.text)}</a>`).join('')}</aside>` : '';
  const tagRow = p.tagSlugs.map(t => `<a class="pill" href="/tags/${t.slug}/">${esc(t.name)}</a>`).join('');
  const catTag = p.catSlugs[0] ? `<a class="tag tag--ember" href="/categories/${p.catSlugs[0].slug}/">${esc(p.catSlugs[0].name)}</a>` : '';
  const body = `
<article><header class="article-hero">
  ${p.img ? `<div class="article-hero__bg"><img src="${p.img}" alt=""></div>` : ''}
  <div class="wrap article-hero__inner">
    <div class="tag-row">${catTag}</div>
    <h1>${esc(p.title)}</h1>
    <div class="article-meta"><span class="author-chip"><img src="/naruto.jpg" alt="">Remo</span>
      <span class="dot"></span><span>${p.dateStr}</span><span class="dot"></span><span>${p.readMin} min read</span>
      ${p.tags[0] ? `<span class="dot"></span><span>${esc(p.tags.slice(0, 3).join(' · ').toLowerCase())}</span>` : ''}</div>
  </div></header>
<div class="progress"></div>
<div class="wrap-wide article-body">
  ${toc}
  <div class="prose">${p.html}
    <div class="tag-row" style="margin-top:2.5rem">${tagRow}</div>
    <div class="author-card"><img src="/naruto.jpg" alt="Remo"><div>
      <h4>SadlyRemo</h4>
      <p>Penetration tester focused on Active Directory, web, code review, and mobile. Ex-HackTheBox Top 5 in Egypt. Writing the breaks down, one path at a time.</p>
      <div class="certs">CRTE · CRTP · CRTO · eWPTX · eCPPT · eMAPT</div></div></div>
    <nav class="prevnext" aria-label="More writeups">
      ${prev ? `<a href="${prev.url}"><span>← Previous</span><b>${esc(prev.title)}</b></a>` : '<span></span>'}
      ${next ? `<a class="next" href="${next.url}"><span>Next →</span><b>${esc(next.title)}</b></a>` : '<span></span>'}
    </nav>
  </div>
</div></article>`;
  return layout({ title: `${p.title} · Remo`, desc: p.excerpt, body, cls: 'is-article' });
}

/* ---------- LISTING (category / tag) ---------- */
function pageListing({ kind, name, slug, list }) {
  const label = kind === 'cat' ? 'Category' : 'Tag';
  const body = `
<section class="page-hero"><div class="wrap-wide">
  <div class="crumb"><a href="/">Home</a><span>/</span><a href="/${kind === 'cat' ? 'categories' : 'tags'}/">${label === 'Category' ? 'Categories' : 'Tags'}</a><span>/</span>${esc(name)}</div>
  <span class="eyebrow">${kind === 'cat' ? '区 · District' : '札 · Tag'}</span>
  <h1>${esc(name.replace(/\b\w/g, m => m.toUpperCase()))}</h1>
  <p class="page-hero__count">${list.length} writeup${list.length === 1 ? '' : 's'}</p>
</div></section>
<section class="section listing" style="padding-top:1rem"><div class="wrap-wide">
  <div class="grid">${list.map(card).join('')}</div>
</div></section>`;
  return layout({ title: `${name} · Remo`, desc: `${list.length} writeups in ${name}.`, body, active: kind });
}

/* ---------- CATEGORIES INDEX ---------- */
function pageCatIndex() {
  const gates = catList.map((c, i) => `
    <a class="gate" href="/categories/${c.slug}/" data-reveal data-reveal-delay="${i % 5}">
      <span class="gate__torii">${TORII}</span><span class="gate__count">${String(c.posts.length).padStart(2, '0')}</span>
      <span class="gate__name">${esc(c.name.replace(/\b\w/g, m => m.toUpperCase()))}</span>
      <span class="gate__sub">${CAT_SUB[c.slug] || c.posts.length + ' writeups'}</span></a>`).join('');
  const body = `
<section class="page-hero"><div class="wrap-wide">
  <div class="crumb"><a href="/">Home</a><span>/</span>Categories</div>
  <span class="eyebrow">区 · Districts</span><h1>Categories</h1>
  <p class="page-hero__sub">Each discipline is a district of the village. Choose a gate to enter.</p>
</div></section>
<section class="section listing" style="padding-top:1rem"><div class="wrap-wide"><div class="gates">${gates}</div></div></section>`;
  return layout({ title: 'Categories · Remo', desc: 'Browse writeups by discipline.', body, active: 'cat' });
}

/* ---------- TAGS INDEX ---------- */
function pageTagIndex() {
  const cloud = tagList.map(t => `<a href="/tags/${t.slug}/">${esc(t.name)} <b>${t.posts.length}</b></a>`).join('');
  const body = `
<section class="page-hero"><div class="wrap-wide">
  <div class="crumb"><a href="/">Home</a><span>/</span>Tags</div>
  <span class="eyebrow">札 · Tags</span><h1>Tags</h1>
  <p class="page-hero__sub">${tagList.length} techniques, tools, and themes across ${posts.length} writeups.</p>
</div></section>
<section class="section listing" style="padding-top:1rem"><div class="wrap-wide"><div class="tagcloud">${cloud}</div></div></section>`;
  return layout({ title: 'Tags · Remo', desc: 'Browse writeups by tag.', body, active: 'tag' });
}

/* ---------- ARCHIVE ---------- */
function pageArchive() {
  const byYear = {};
  for (const p of posts) (byYear[p.date.getUTCFullYear()] ||= []).push(p);
  const years = Object.keys(byYear).sort((a, b) => b - a);
  const timeline = years.map(y => `
    <div class="timeline__year">${y}</div>
    ${byYear[y].map(p => `<a class="timeline__item" href="${p.url}">
      <span class="timeline__date">${MONTHS[p.date.getUTCMonth()]} ${String(p.date.getUTCDate()).padStart(2, '0')}</span>
      <span><span class="timeline__link">${esc(p.title)}</span><span class="timeline__cat">${esc(p.cats[0] || '')}</span></span></a>`).join('')}`).join('');
  const body = `
<section class="page-hero"><div class="wrap-wide">
  <div class="crumb"><a href="/">Home</a><span>/</span>Archive</div>
  <span class="eyebrow">記録 · Archive</span><h1>The full path</h1>
  <p class="page-hero__sub">Every writeup, in the order it was walked. ${posts.length} in total.</p>
</div></section>
<section class="section listing" style="padding-top:1rem"><div class="wrap"><div class="timeline">${timeline}</div></div></section>`;
  return layout({ title: 'Archive · Remo', desc: 'All writeups, chronologically.', body, active: 'arc' });
}

/* ---------- ABOUT (built from CV) ---------- */
const CV = {
  name: 'SadlyRemo', alias: 'Remo', location: 'Cairo, Egypt', email: 'rem01xcertsexpert@gmail.com',
  role: 'Penetration Tester · Instructor · Exploit-Dev',
  summary: `Dedicated penetration tester with <strong>2+ years</strong> of hands-on offensive-security experience, currently at <strong>ZeroSploit MEA</strong>. I run comprehensive assessments across web, mobile, API, source code, network, Active Directory, and Microsoft Exchange environments, and I'm ranked among the top offensive-security professionals in Egypt on Hack The Box. Passionate about exploit development and malware, with a foundation in binary exploitation and reverse engineering, and currently pursuing advanced exploit-dev certifications.`,
  stats: [['2+', 'Years offensive sec'], ['180', 'HTB machines'], ['12', 'Certifications'], ['Top 5', 'HTB · Egypt']],
  experience: [{
    role: 'Mid-Senior Penetration Tester', org: 'ZeroSploit MEA', when: 'Oct 2023 → Present', place: 'Cairo, Egypt',
    points: [
      'Penetration testing on web applications, internal networks, and Active Directory environments, identifying vulnerabilities and driving remediation.',
      'Threat modeling, vulnerability assessment, and post-exploitation across real-world client infrastructure.',
      'Specialized in manual testing, source-code review, and exploitation of logic flaws, auth bypasses, and misconfigurations.',
      'Delivered clear, professional reports with findings, PoCs, and business- and technical-facing mitigations.',
      'Contributed to Red Team simulations and improvement of the internal testing methodology.',
    ],
  }],
  education: { degree: 'B.Sc. Information Technology', school: 'Sinai University', when: '2021 → 2025',
    note: 'Final project: <strong>RAAD Framework</strong>, a custom Red Team framework to bypass AVs and execute advanced malware techniques. Graded A+ for outstanding work and innovation.' },
  certs: [
    ['OSED', 'OffSec Exploit Developer', 'In progress'], ['CWEE', 'Certified Web Exploitation Expert', ''],
    ['CWES', 'Certified Web Exploitation Specialist', ''], ['CPTS', 'Certified Penetration Testing Specialist', ''],
    ['CJCA', 'Certified Junior Cybersecurity Associate', ''], ['CRTM', 'Certified Red Team Master', ''],
    ['CRTP', 'Certified Red Team Professional', ''], ['CRTE', 'Certified Red Team Expert', ''],
    ['CRTO', 'Certified Red Team Operator', ''], ['eWPTX', 'Web App Pentester eXtreme', ''],
    ['eMAPT', 'Mobile App Pentester', ''], ['eCPPT', 'Certified Pentesting Professional', ''],
  ],
  training: [
    'OffSec, OSCP · OSWA · OSWP · OSEP (completed) · OSED (module 1)',
    'CAPE, Certified AD Pentesting Expert (80%)', 'CWPE, Certified Wi-Fi Pentesting Expert (50%)',
    'INE Certified Exploit Developer (module 1)', 'Sektor7 Malware Dev Essentials · MalDev Academy (1/3)',
    'Blackbelt Mobile Pentesting', 'OpenSecurityTraining, Intro to WinDbg & GDB',
  ],
  achievements: [
    'HackTheBox, Top 5 in Egypt · Pro Hacker · Ruby (S3/S4) · Holo (S7)',
    'HackTheBox, 180 machines · 111 challenges · ProLabs: Dante, Rastalabs, Offshore, Zephyr',
    'TryHackMe, 150+ rooms · VulnLab, 20 machines · RootMe, 50%+ server-side web',
    'CTF team 0xL4ugh, Top 3 Aswan · Top 7 FDC · Top 8 Arab WarGames',
    'Finalist, ICMTC · Black Hat MEA 2024 · CyCTF 2024',
  ],
  skills: [
    'Web / API Pentesting', 'Active Directory', 'Source-Code Review', 'Mobile (Android)', 'Exchange',
    'Network / Internal', 'Wi-Fi (WPA-Ent)', 'Binary Exploitation', 'Reverse Engineering', 'Malware Dev',
    'Red Team C2', 'CTF Design', 'Instruction',
  ],
  objective: 'To grow into a recognized exploit developer, contributing through cutting-edge vulnerability research, tool development, and real-world red team operations.',
};
function pageAbout() {
  const c = CV;
  const gh = '<svg viewBox="0 0 24 24" fill="currentColor" width="18"><path d="M12 2A10 10 0 0 0 2 12c0 4.42 2.87 8.17 6.84 9.5.5.08.66-.22.66-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.46-1.16-1.11-1.47-1.11-1.47-.9-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.6 9.6 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.16.57.67.48A10 10 0 0 0 22 12 10 10 0 0 0 12 2Z"/></svg>';
  const xi = '<svg viewBox="0 0 24 24" fill="currentColor" width="16"><path d="M18.9 2H22l-7.3 8.3L23 22h-6.6l-5.2-6.8L5.2 22H2l7.8-8.9L1.5 2h6.8l4.7 6.2L18.9 2Zm-1.2 18h1.8L7.2 3.9H5.3L17.7 20Z"/></svg>';
  const li = '<svg viewBox="0 0 24 24" fill="currentColor" width="17"><path d="M6.94 5a2 2 0 1 1-4-.02 2 2 0 0 1 4 .02ZM7 8.5H3V21h4V8.5Zm6.3 0H9.5V21h3.8v-6.6c0-3.6 4.6-3.9 4.6 0V21H22v-7.9c0-6-6.4-5.8-8.7-2.8V8.5Z"/></svg>';
  const htb = '<svg viewBox="0 0 24 24" fill="currentColor" width="16"><path d="M12 1 3 6v12l9 5 9-5V6l-9-5Zm0 2.3 6.9 3.8-6.9 4-6.9-4L12 3.3ZM5 8.6l6 3.5v7L5 15.6V8.6Zm14 0v7l-6 3.5v-7l6-3.5Z"/></svg>';

  const body = `
<section class="page-hero"><div class="wrap-wide">
  <div class="crumb"><a href="/">Home</a><span>/</span>About</div>
  <span class="eyebrow">私 · About</span><h1>Who is Remo</h1>
  <p class="page-hero__sub">${c.role.replace(/·/g, '·')}, documenting the offensive edge, one path at a time.</p>
</div></section>

<section class="section listing" style="padding-top:1rem"><div class="wrap-wide"><div class="about-grid">
  <aside class="about-card">
    <img src="/naruto.jpg" alt="Remo">
    <h2>${c.name}</h2><div class="role">Exploit Development Enthusiast</div>
    <p style="color:var(--fg-dim);font-family:var(--mono);font-size:.74rem;letter-spacing:.06em;margin:.7rem 0 0">📍 ${c.location}</p>
    <div class="about-socials">
      <a class="icon-btn" href="mailto:${c.email}" aria-label="Email"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="18"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg></a>
      <a class="icon-btn" href="https://github.com/Remo1x" target="_blank" rel="noopener" aria-label="GitHub">${gh}</a>
      <a class="icon-btn" href="https://x.com/Rem01x" target="_blank" rel="noopener" aria-label="X">${xi}</a>
      <a class="icon-btn" href="https://www.linkedin.com/in/rem01x/" target="_blank" rel="noopener" aria-label="LinkedIn">${li}</a>
      <a class="icon-btn" href="https://app.hackthebox.com/profile/1080501" target="_blank" rel="noopener" aria-label="HackTheBox">${htb}</a>
    </div>
    <div class="statgrid">${c.stats.map(s => `<div class="statgrid__i"><b>${s[0]}</b><span>${s[1]}</span></div>`).join('')}</div>
  </aside>

  <div class="prose">
    <p class="lead">${c.summary}</p>

    <h2>Experience</h2>
    ${c.experience.map(e => `<div class="exp">
      <div class="exp__head"><div><b>${e.role}</b><span class="exp__org">${e.org}</span></div><span class="exp__when">${e.when}</span></div>
      <ul>${e.points.map(p => `<li>${p}</li>`).join('')}</ul></div>`).join('')}

    <h2>Certifications</h2>
    <div class="certgrid">${c.certs.map(([k, n, s]) => `<div class="cert${s ? ' cert--wip' : ''}"><b>${k}</b><span>${n}</span>${s ? `<em>${s}</em>` : ''}</div>`).join('')}</div>

    <h2>Training &amp; Courses</h2>
    <ul>${c.training.map(t => `<li>${t}</li>`).join('')}</ul>

    <h2>Practical &amp; CTF</h2>
    <ul>${c.achievements.map(a => `<li>${a}</li>`).join('')}</ul>

    <h2>Education</h2>
    <div class="exp"><div class="exp__head"><div><b>${c.education.degree}</b><span class="exp__org">${c.education.school}</span></div><span class="exp__when">${c.education.when}</span></div>
      <p style="margin:.4rem 0 0;color:var(--fg-dim)">${c.education.note}</p></div>

    <h2>Areas of Expertise</h2>
    <div class="tag-row">${c.skills.map(s => `<span class="pill" style="cursor:default">${s}</span>`).join('')}</div>

    <blockquote style="margin-top:2.4rem"><p>${c.objective}</p></blockquote>
  </div>
</div></div></section>`;
  return layout({ title: 'About · SadlyRemo', desc: "SadlyRemo, penetration tester at ZeroSploit MEA. Experience, certifications, and offensive-security achievements.", body, active: 'about' });
}

/* ---------- 404 ---------- */
function page404() {
  const body = `<main class="err">
  <div class="hero__scene" style="position:absolute;inset:0;z-index:-1;opacity:.5" aria-hidden="true">${HERO_SVG}</div>
  <div><div class="err__kanji">迷子</div><div class="err__code">404</div>
  <h1>This path leads nowhere</h1>
  <p>The lantern you followed has gone dark. The page may have moved, or never existed on this approach.</p>
  <a class="btn btn--primary" href="/">Return to the gate ${ARROW}</a></div></main>`;
  return layout({ title: '404 · Lost on the path · Remo', desc: 'Page not found.', body });
}

/* ============================================================
   BUILD
   ============================================================ */
console.log('▸ cleaning dist');
// safety: unlink an images junction/symlink first so we never rm through it
const distImages = path.join(OUT, 'images');
try { const st = fs.lstatSync(distImages); if (st.isSymbolicLink() || st.isDirectory()) { try { fs.unlinkSync(distImages); } catch { fs.rmdirSync(distImages); } } } catch {}
rmrf(OUT); mkdir(OUT);

// assets
mkdir(path.join(OUT, 'assets'));
let css = fs.readFileSync(path.join(ROOT, 'preview/assets/css/sando.css'), 'utf8')
  + '\n' + fs.readFileSync(path.join(ROOT, 'sando/extra.css'), 'utf8');
fs.writeFileSync(path.join(OUT, 'assets/sando.css'), css);
fs.copyFileSync(path.join(ROOT, 'preview/assets/js/sando.js'), path.join(OUT, 'assets/sando.js'));

// search index
const searchIdx = posts.map(p => ({ title: p.title, url: p.url, cat: (p.cats[0] || 'Writeup'), tags: p.tags.join(' ') }));
fs.writeFileSync(path.join(OUT, 'assets/search.js'), 'window.SANDO_INDEX=' + JSON.stringify(searchIdx) + ';');

// pages
write('index.html', pageHome());
write('404.html', page404());
write('about/index.html', pageAbout());
write('archives/index.html', pageArchive());
write('categories/index.html', pageCatIndex());
write('tags/index.html', pageTagIndex());
posts.forEach((p, i) => write(`posts/${p.slug}/index.html`, pageArticle(p, i)));
catList.forEach(c => write(`categories/${c.slug}/index.html`, pageListing({ kind: 'cat', name: c.name, slug: c.slug, list: c.posts })));
tagList.forEach(t => write(`tags/${t.slug}/index.html`, pageListing({ kind: 'tag', name: t.name, slug: t.slug, list: t.posts })));

// static passthrough
fs.copyFileSync(path.join(ROOT, 'naruto.jpg'), path.join(OUT, 'naruto.jpg'));
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

// images: create a redirect note (copied separately to keep build fast)
console.log(`▸ ${posts.length} posts · ${catList.length} categories · ${tagList.length} tags`);
console.log('▸ pages written to /dist');
console.log('  (run scripts/copy-images to mirror /images into /dist/images)');

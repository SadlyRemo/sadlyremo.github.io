/* SANDŌ, interactions. Vanilla, no deps. */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---- dismiss loading screen ---- */
  const loaderEl = document.querySelector('.loader');
  if (loaderEl) {
    const hide = () => loaderEl.classList.add('done');
    if (document.readyState === 'complete') setTimeout(hide, 300);
    else addEventListener('load', () => setTimeout(hide, 300));
    setTimeout(hide, 2500); // failsafe
  }

  /* ---- theme (lantern) toggle ---- */
  const root = document.documentElement;
  const saved = localStorage.getItem('sando-theme');
  if (saved) root.setAttribute('data-theme', saved);
  $$('[data-theme-toggle]').forEach(btn => btn.addEventListener('click', () => {
    const next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    if (next === 'dark') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', 'light');
    localStorage.setItem('sando-theme', next);
  }));

  /* ---- nav scrolled state ---- */
  const nav = $('.nav');
  const onScroll = () => nav && nav.classList.toggle('is-scrolled', scrollY > 24);
  onScroll(); addEventListener('scroll', onScroll, { passive: true });

  /* ---- reveal on view ---- */
  const io = new IntersectionObserver((es) => {
    es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
  $$('[data-reveal]').forEach(el => reduce ? el.classList.add('in') : io.observe(el));

  /* ---- reading progress ---- */
  const bar = $('.progress');
  if (bar) {
    const upd = () => {
      const h = document.documentElement;
      const p = h.scrollTop / (h.scrollHeight - h.clientHeight || 1);
      bar.style.width = Math.max(0, Math.min(1, p)) * 100 + '%';
    };
    upd(); addEventListener('scroll', upd, { passive: true }); addEventListener('resize', upd);
  }

  /* ---- TOC scrollspy ---- */
  const links = $$('.toc-rail a');
  if (links.length) {
    const map = new Map();
    links.forEach(a => { const t = $(a.getAttribute('href')); if (t) map.set(t, a); });
    const spy = new IntersectionObserver((es) => {
      es.forEach(e => {
        if (e.isIntersecting) {
          links.forEach(l => l.classList.remove('is-active'));
          map.get(e.target)?.classList.add('is-active');
        }
      });
    }, { rootMargin: '-15% 0px -70% 0px', threshold: 0 });
    map.forEach((_, t) => spy.observe(t));
  }

  /* ---- copy code ---- */
  $$('.code-card__copy').forEach(btn => btn.addEventListener('click', () => {
    const code = btn.closest('.code-card').querySelector('pre').innerText;
    navigator.clipboard?.writeText(code).then(() => {
      const label = btn.querySelector('span'); const old = label.textContent;
      label.textContent = 'copied'; btn.style.color = 'var(--pine)';
      setTimeout(() => { label.textContent = old; btn.style.color = ''; }, 1400);
    });
  }));

  /* ---- mobile drawer ---- */
  const drawer = $('.drawer'), burger = $('.nav__burger');
  burger && burger.addEventListener('click', () => {
    const open = drawer.classList.toggle('open');
    document.body.style.overflow = open ? 'hidden' : '';
  });
  $$('.drawer a').forEach(a => a.addEventListener('click', () => {
    drawer.classList.remove('open'); document.body.style.overflow = '';
  }));

  /* ---- command palette ---- */
  const cmdk = $('.cmdk');
  if (cmdk) {
    const input = $('.cmdk__input input', cmdk), results = $('.cmdk__results', cmdk);
    const items = window.SANDO_INDEX || [];
    let sel = 0, view = [];
    const open = () => { cmdk.classList.add('open'); document.body.style.overflow = 'hidden'; input.value = ''; render(items); input.focus(); };
    const close = () => { cmdk.classList.remove('open'); document.body.style.overflow = ''; };
    const render = (list) => {
      view = list; sel = 0;
      results.innerHTML = list.length ? list.map((it, i) =>
        `<a class="cmdk__item${i === 0 ? ' sel' : ''}" href="${it.url}"><span class="k">${it.cat}</span><b>${it.title}</b></a>`
      ).join('') : `<div class="cmdk__empty">No path leads there, try another term.</div>`;
    };
    input && input.addEventListener('input', () => {
      const q = input.value.toLowerCase().trim();
      render(!q ? items : items.filter(it => (it.title + ' ' + it.cat + ' ' + (it.tags || '')).toLowerCase().includes(q)));
    });
    addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); cmdk.classList.contains('open') ? close() : open(); }
      if (e.key === '/' && !/input|textarea/i.test(document.activeElement.tagName) && !cmdk.classList.contains('open')) { e.preventDefault(); open(); }
      if (!cmdk.classList.contains('open')) return;
      if (e.key === 'Escape') close();
      const els = $$('.cmdk__item', results);
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, els.length - 1); }
      if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); }
      if (e.key === 'Enter' && els[sel]) { location.href = els[sel].getAttribute('href'); }
      els.forEach((el, i) => el.classList.toggle('sel', i === sel));
      els[sel]?.scrollIntoView({ block: 'nearest' });
    });
    $$('[data-cmdk-open]').forEach(b => b.addEventListener('click', open));
    cmdk.addEventListener('click', (e) => { if (e.target === cmdk) close(); });
  }

  /* ---- drifting embers / sakura on hero (canvas-free, lightweight) ---- */
  const field = $('.particles');
  if (field && !reduce) {
    const N = innerWidth < 700 ? 10 : 20;
    for (let i = 0; i < N; i++) {
      const p = document.createElement('span');
      const ember = Math.random() > .5;
      const s = 2 + Math.random() * 4;
      Object.assign(p.style, {
        position: 'absolute', left: Math.random() * 100 + '%', top: Math.random() * 100 + '%',
        width: s + 'px', height: s + 'px', borderRadius: '50%',
        background: ember ? 'rgba(127,214,196,.8)' : 'rgba(234,167,186,.6)',
        boxShadow: ember ? '0 0 8px 2px rgba(67,191,168,.4)' : 'none',
        animation: `floatUp ${8 + Math.random() * 10}s linear ${-Math.random() * 12}s infinite`,
        opacity: 0
      });
      field.appendChild(p);
    }
    const style = document.createElement('style');
    style.textContent = '@keyframes floatUp{0%{transform:translateY(20px);opacity:0}10%{opacity:1}90%{opacity:.7}100%{transform:translateY(-60vh) translateX(20px);opacity:0}}';
    document.head.appendChild(style);
  }

  /* ---- image lightbox ---- */
  const plateImgs = $$('.prose .plate img');
  if (plateImgs.length) {
    const lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.innerHTML = '<button class="lightbox__close" aria-label="Close">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' +
      '<img alt=""><div class="lightbox__hint">click anywhere or press Esc to close</div>';
    document.body.appendChild(lb);
    const lbImg = $('img', lb);
    const open = (src, alt) => { lbImg.src = src; lbImg.alt = alt || ''; lb.classList.add('open'); document.body.style.overflow = 'hidden'; };
    const close = () => { lb.classList.remove('open'); document.body.style.overflow = ''; };
    plateImgs.forEach(img => img.addEventListener('click', () => open(img.currentSrc || img.src, img.alt)));
    lb.addEventListener('click', close);
    addEventListener('keydown', (e) => { if (e.key === 'Escape' && lb.classList.contains('open')) close(); });
  }

  /* ---- year ---- */
  $$('[data-year]').forEach(el => el.textContent = new Date().getFullYear());
})();

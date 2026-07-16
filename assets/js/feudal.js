/* =============================================================================
 *  Yūrei-mura (幽霊村) — atmosphere & interaction layer
 *  Dependency-free, ~7 KB. Everything decorative is aria-hidden and
 *  pointer-events:none. Respects prefers-reduced-motion and pointer type.
 *  Loaded with `defer`, initialised at idle so it never blocks first paint.
 * ========================================================================== */
(function () {
  'use strict';

  var mm = window.matchMedia ? window.matchMedia.bind(window) : null;
  var REDUCE = mm ? mm('(prefers-reduced-motion: reduce)').matches : false;
  var FINE = mm ? mm('(pointer: fine)').matches : false;
  var SVGNS = 'http://www.w3.org/2000/svg';

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  /* ---------------------------------------------------------------------- *
   *  1. Layered background: moon · fog · mountains · houses · bamboo · torii
   * ---------------------------------------------------------------------- */
  function buildBackground() {
    if (document.querySelector('.fj-bg')) return;
    var bg = el('div', 'fj-bg');
    bg.setAttribute('aria-hidden', 'true');

    // Decorative Japanese clouds — slow horizontal drift near the dusk sky
    [['6%', 8, 62, 0.5, '38s'], ['58%', 4, 50, 0.42, '52s'], ['34%', 13, 72, 0.34, '66s']]
      .forEach(function (c, i) {
        var cl = el('div', 'fj-cloud');
        cl.style.left = c[0]; cl.style.top = c[1] + '%'; cl.style.width = c[2] + 'px';
        cl.style.opacity = c[3];
        cl.style.setProperty('--fj-cloud-dur', c[4]);
        cl.style.setProperty('--fj-leaf-delay', '-' + i * 9 + 's');
        bg.appendChild(cl);
      });

    // Layer A — far mountains + a distant torii lost in the haze (slow parallax)
    var far = el('div', 'fj-layer fj-far');
    far.style.setProperty('--p', '0.03');
    far.innerHTML =
      "<svg viewBox='0 0 1600 520' preserveAspectRatio='xMidYMax slice'>" +
      "<path style='fill:var(--fj-mountain-far)' d='M0,520 L0,300 L200,182 L360,272 L560,150 L780,250 L980,140 L1220,252 L1420,170 L1600,250 L1600,520Z'/>" +
      "<path style='fill:var(--fj-mountain)' d='M0,520 L0,384 L240,286 L470,372 L700,272 L940,360 L1180,288 L1420,372 L1600,322 L1600,520Z'/>" +
      "<g style='fill:var(--fj-torii)' opacity='0.75'>" +
      "<path d='M735,300 h132 l-9,11 h-114 z'/><rect x='752' y='316' width='98' height='6'/>" +
      "<rect x='762' y='311' width='11' height='58'/><rect x='828' y='311' width='11' height='58'/></g>" +
      '</svg>';
    bg.appendChild(far);

    // Mist between the ridges and the village
    bg.appendChild(el('div', 'fj-fog fj-fog--1'));

    // Layer B — the village itself (medium parallax)
    var village = el('div', 'fj-layer fj-village');
    village.style.setProperty('--p', '0.07');
    village.innerHTML = villageSVG();
    bg.appendChild(village);

    // Foreground drifting mist
    bg.appendChild(el('div', 'fj-fog fj-fog--2'));

    // Layer C — near: hanging paper lanterns (warm, flickering) + a swinging sign
    [[12, 21], [26, 16], [72, 18], [87, 14]].forEach(function (p, i) {
      var lan = el('div', 'fj-lantern-paper');
      lan.style.left = p[0] + '%'; lan.style.bottom = p[1] + 'vh';
      lan.style.setProperty('--fj-flicker-dur', (3.8 + i * 0.9).toFixed(1) + 's');
      lan.style.setProperty('--fj-leaf-delay', '-' + (i * 1.5).toFixed(1) + 's');
      bg.appendChild(lan);
    });
    var sign = el('div', 'fj-sign');
    sign.style.left = '46%'; sign.style.bottom = '25vh';
    sign.innerHTML = "<span class='fj-sign-rope'></span><span class='fj-sign-board'>村</span>";
    bg.appendChild(sign);

    document.body.insertBefore(bg, document.body.firstChild);

    if (!REDUCE) { buildFalling(bg); initBirds(bg); initParallax(bg); }
  }

  // The village skyline — an Edo street of rooftops, a pagoda, an arched bridge,
  // a cherry & a maple, and a wooden fence, all assembled from primitives.
  function villageSVG() {
    var base = 520, s = '';
    // sloping street of houses (varying width / height / roof)
    var houses = [
      [40, 150, 96, 40], [150, 176, 120, 52], [286, 138, 104, 44],
      [402, 200, 150, 60], [566, 120, 90, 40], [980, 130, 96, 42],
      [1088, 188, 150, 58], [1252, 150, 110, 48], [1378, 210, 140, 56],
      [1520, 120, 92, 40]
    ];
    var bodies = '', roofs = '', wins = '';
    houses.forEach(function (h) {
      var x = h[0], w = h[1], ht = h[2], rh = h[3], by = base - ht, e = 12, rw = 15;
      bodies += "<rect x='" + x + "' y='" + by + "' width='" + w + "' height='" + ht + "'/>";
      roofs += "<path d='M" + (x - e) + "," + by + " L" + (x + w + e) + "," + by +
        " L" + (x + w - rw) + "," + (by - rh) + " L" + (x + rw) + "," + (by - rh) + " Z'/>";
      roofs += "<rect x='" + (x + rw - 5) + "' y='" + (by - rh - 3) + "' width='" + (w - 2 * rw + 10) + "' height='4'/>";
      wins += "<rect class='fj-win' x='" + (x + w * 0.3).toFixed(0) + "' y='" + (by + ht * 0.34).toFixed(0) +
        "' width='" + (w * 0.4).toFixed(0) + "' height='" + (ht * 0.3).toFixed(0) + "' rx='2'/>";
    });
    // a two-tier pagoda / shrine
    var px = 690, pb = base;
    var pagoda =
      "<rect x='" + (px + 26) + "' y='" + (pb - 120) + "' width='36' height='120'/>" +
      "<path d='M" + (px - 6) + "," + (pb - 118) + " L" + (px + 94) + "," + (pb - 118) + " L" + (px + 70) + "," + (pb - 150) + " L" + (px + 18) + "," + (pb - 150) + " Z'/>" +
      "<path d='M" + (px + 4) + "," + (pb - 150) + " L" + (px + 84) + "," + (pb - 150) + " L" + (px + 64) + "," + (pb - 182) + " L" + (px + 24) + "," + (pb - 182) + " Z'/>" +
      "<rect class='fj-win' x='" + (px + 36) + "' y='" + (pb - 96) + "' width='16' height='22' rx='2'/>";
    // arched wooden bridge over a hint of river
    var bx = 812, bw = 150;
    var bridge =
      "<path d='M" + bx + "," + base + " Q" + (bx + bw / 2) + "," + (base - 46) + " " + (bx + bw) + "," + base +
      "' style='fill:none;stroke:var(--fj-house)' stroke-width='10'/>" +
      "<path d='M" + (bx + 10) + "," + (base - 12) + " Q" + (bx + bw / 2) + "," + (base - 52) + " " + (bx + bw - 10) + "," + (base - 12) +
      "' style='fill:none;stroke:var(--fj-house)' stroke-width='3'/>";
    // trees — cherry (left) and maple (right), silhouette canopies
    function tree(cx, cls, blobs) {
      var t = "<rect x='" + (cx - 4) + "' y='" + (base - 92) + "' width='8' height='92' style='fill:var(--fj-tree)'/>";
      blobs.forEach(function (b) {
        t += "<circle class='" + cls + "' cx='" + (cx + b[0]) + "' cy='" + (base - 96 + b[1]) + "' r='" + b[2] + "'/>";
      });
      return t;
    }
    var cherry = tree(636, 'fj-cherry', [[0, -14, 26], [-20, -2, 20], [20, 0, 22], [-8, -26, 18], [12, -24, 16]]);
    var maple = tree(1470, 'fj-maple', [[0, -12, 24], [-18, 2, 18], [18, -2, 20], [-6, -24, 16], [10, -22, 15]]);
    // bamboo grove — one swaying group per side (each rotates about its own base)
    function grove(stalks, delay) {
      var g = "<g class='fj-bamboo-grp' style='fill:var(--fj-tree);animation-delay:" + delay + "'>";
      stalks.forEach(function (b) {
        var x = b[0], h = b[1], top = base - h;
        g += "<rect x='" + x + "' y='" + top + "' width='7' height='" + h + "' rx='3'/>";
        for (var ny = top + 44; ny < base - 10; ny += 54) g += "<rect x='" + (x - 1) + "' y='" + ny + "' width='9' height='2'/>";
        g += "<path d='M" + (x + 6) + "," + (top + 14) + " q24,-6 32,-22 q-20,4 -32,14 z'/>";
        g += "<path d='M" + x + "," + (top + 30) + " q-24,-6 -32,-20 q20,3 32,12 z'/>";
      });
      return g + '</g>';
    }
    var bamboo = grove([[30, 300], [50, 348], [70, 288]], '0s') +
      grove([[1522, 300], [1544, 350], [1566, 286]], '-3.5s');
    // wooden fence along the very front
    var fence = "<g style='fill:var(--fj-house)'>";
    for (var fx = 0; fx <= 1600; fx += 46) fence += "<rect x='" + fx + "' y='" + (base - 34) + "' width='6' height='34'/>";
    fence += "<rect x='0' y='" + (base - 30) + "' width='1600' height='4'/><rect x='0' y='" + (base - 16) + "' width='1600' height='4'/></g>";

    s += "<svg viewBox='0 0 1600 520' preserveAspectRatio='xMidYMax slice'>";
    s += "<rect x='0' y='" + (base - 10) + "' width='1600' height='10' style='fill:var(--fj-street)'/>";
    s += bamboo + cherry + maple;
    s += "<g style='fill:var(--fj-roof)'>" + bodies + pagoda + "</g>";
    s += "<g style='fill:var(--fj-house)'>" + roofs + "</g>";
    s += bridge + fence;
    s += "<g class='fj-wins'>" + wins + "</g>";
    s += '</svg>';
    return s;
  }

  // Tiny birds occasionally crossing the dusk sky
  function initBirds(bg) {
    function flock() {
      var n = 2 + Math.floor(Math.abs(Math.sin(bg.childElementCount * 12.9898) * 43758.5) % 3);
      var top = 8 + (Date.now() % 22);
      var wrap = el('div', 'fj-birds');
      wrap.style.top = top + '%';
      var dir = (Date.now() % 2) ? 1 : -1;
      wrap.style.setProperty('--fj-bird-dir', dir);
      var inner = '';
      for (var i = 0; i < n; i++) {
        inner += "<span class='fj-bird' style='margin-left:" + (i * 16) + "px;animation-delay:" + (i * 0.12) + "s'></span>";
      }
      wrap.innerHTML = inner;
      bg.appendChild(wrap);
      setTimeout(function () { wrap.remove(); }, 14000);
      setTimeout(flock, 22000 + (Date.now() % 20000));
    }
    setTimeout(flock, 6000);
  }

  // Subtle scroll parallax — distant layers lag behind nearer ones
  function initParallax(bg) {
    var layers = bg.querySelectorAll('.fj-layer');
    var ticking = false;
    function update() {
      var y = window.scrollY || window.pageYOffset;
      for (var i = 0; i < layers.length; i++) {
        var p = parseFloat(layers[i].style.getPropertyValue('--p')) || 0;
        // subtle & bounded: nearer layers rise a touch more, but never leave view
        var shift = Math.max(-46, Math.min(46, y * p));
        layers[i].style.transform = 'translate3d(0,' + (-shift).toFixed(1) + 'px,0)';
      }
      ticking = false;
    }
    window.addEventListener('scroll', function () {
      if (!ticking) { ticking = true; requestAnimationFrame(update); }
    }, { passive: true });
  }

  // Drifting sakura petals + gold leaves + a few fireflies (pure-CSS once made)
  function buildFalling(bg) {
    var narrow = window.innerWidth < 760;
    var petals = narrow ? 6 : 11;
    var leaves = narrow ? 3 : 6;
    var embers = narrow ? 3 : 5;
    var i, n;
    var frag = document.createDocumentFragment();
    for (i = 0; i < petals; i++) {
      n = el('div', 'fj-petal');
      n.style.left = (Math.round((i / petals) * 100) + (i % 3) * 3) + '%';
      n.style.setProperty('--fj-leaf-dur', (14 + (i % 7) * 1.8).toFixed(1) + 's');
      n.style.setProperty('--fj-leaf-delay', '-' + (i * 2.1).toFixed(1) + 's');
      n.style.opacity = 0.55 + (i % 3) * 0.12;
      frag.appendChild(n);
    }
    for (i = 0; i < leaves; i++) {
      n = el('div', 'fj-leaf');
      n.style.left = (6 + Math.round((i / leaves) * 90)) + '%';
      n.style.setProperty('--fj-leaf-dur', (12 + (i % 5) * 1.7).toFixed(1) + 's');
      n.style.setProperty('--fj-leaf-delay', '-' + (i * 2.6).toFixed(1) + 's');
      n.style.setProperty('--fj-leaf-drift', (i % 2 ? 1 : -1) * (34 + (i % 5) * 16) + 'px');
      n.style.opacity = 0.45 + (i % 3) * 0.12;
      frag.appendChild(n);
    }
    for (i = 0; i < embers; i++) {
      n = el('div', 'fj-ember');
      n.style.left = (10 + (i / embers) * 80) + '%';
      n.style.setProperty('--fj-leaf-dur', (14 + (i % 4) * 3) + 's');
      n.style.setProperty('--fj-leaf-delay', '-' + (i * 2.6).toFixed(1) + 's');
      n.style.setProperty('--fj-leaf-drift', (i % 2 ? 1 : -1) * (20 + i * 8) + 'px');
      frag.appendChild(n);
    }
    // fine floating dust motes, spread across the scene
    var dust = narrow ? 5 : 9;
    for (i = 0; i < dust; i++) {
      n = el('div', 'fj-dust');
      n.style.left = (4 + (i * 37) % 92) + '%';
      n.style.bottom = (6 + (i * 29) % 66) + 'vh';
      n.style.setProperty('--fj-leaf-dur', (20 + (i % 6) * 4) + 's');
      n.style.setProperty('--fj-leaf-delay', '-' + (i * 3.3).toFixed(1) + 's');
      n.style.setProperty('--fj-leaf-drift', (i % 2 ? 1 : -1) * (12 + i * 3) + 'px');
      frag.appendChild(n);
    }
    bg.appendChild(frag);
  }

  // Replace the sidebar's generic icons with hand-drawn Japanese line icons
  function initNavIcons() {
    var TORII = "<svg viewBox='0 0 24 24'><path d='M3 6h18M4.5 9h15M6.5 6v13M17.5 6v13M3 6c1.5-1.2 3-1.2 4.5 0M16.5 6c1.5-1.2 3-1.2 4.5 0'/></svg>";
    var SCROLL = "<svg viewBox='0 0 24 24'><path d='M7 4h8a3 3 0 0 1 3 3v11a2 2 0 0 0 2 2H9a3 3 0 0 1-3-3V6M6 6a2 2 0 1 0 0 4M10 9h5M10 13h5'/></svg>";
    var TAG = "<svg viewBox='0 0 24 24'><path d='M4 4h7l9 9-7 7-9-9z'/><circle cx='8' cy='8' r='1.2'/></svg>";
    var TEMPLE = "<svg viewBox='0 0 24 24'><path d='M3 9l9-5 9 5M4 9v10M20 9v10M9 9v10M15 9v10M3 21h18M6.5 9v10M17.5 9v10'/></svg>";
    var LANTERN = "<svg viewBox='0 0 24 24'><ellipse cx='12' cy='12' rx='5' ry='6.5'/><path d='M9 5.6h6M9 18.4h6M12 3.6v2M12 18.4v2M7.5 12h9'/></svg>";
    var map = [
      { re: /categor/i, svg: SCROLL },
      { re: /tags/i, svg: TAG },
      { re: /archive/i, svg: TEMPLE },
      { re: /about/i, svg: LANTERN },
      { re: /^\/(index\.html)?$/, svg: TORII }
    ];
    var links = document.querySelectorAll('#sidebar .nav-link');
    for (var j = 0; j < links.length; j++) {
      var a = links[j], href = a.getAttribute('href') || '', hit = null;
      for (var k = 0; k < map.length; k++) { if (map[k].re.test(href)) { hit = map[k]; break; } }
      var ico = a.querySelector('i');
      if (hit && ico) { ico.className = 'fj-navicon'; ico.innerHTML = hit.svg; }
    }
  }

  /* ---------------------------------------------------------------------- *
   *  2. Cursor glow trail + click particles (fine pointers, motion allowed)
   * ---------------------------------------------------------------------- */
  function initCursor() {
    var glow = el('div', 'fj-cursor-glow');
    glow.setAttribute('aria-hidden', 'true');
    document.body.appendChild(glow);
    var x = 0, y = 0, shown = false, raf = 0;
    function move(e) {
      x = e.clientX; y = e.clientY;
      if (!shown) { glow.style.opacity = '1'; shown = true; }
      if (!raf) raf = requestAnimationFrame(function () {
        raf = 0;
        glow.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
      });
    }
    window.addEventListener('mousemove', move, { passive: true });
    document.addEventListener('mouseleave', function () { glow.style.opacity = '0'; shown = false; });

    // click particles — a small burst of lavender / sakura / gold motes
    var live = 0;
    var hues = ['var(--fj-purple-soft)', 'var(--fj-sakura)', 'var(--fj-gold)'];
    window.addEventListener('pointerdown', function (e) {
      if (live > 40) return;
      var count = 8, i, p, ang, dist;
      for (i = 0; i < count; i++) {
        p = el('div', 'fj-particle');
        p.style.left = e.clientX + 'px';
        p.style.top = e.clientY + 'px';
        p.style.background = hues[i % hues.length];
        document.body.appendChild(p);
        live++;
        ang = (Math.PI * 2 * i) / count + Math.random() * 0.5;
        dist = 22 + Math.random() * 26;
        (function (node) {
          var anim = node.animate(
            [
              { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
              {
                transform: 'translate(calc(-50% + ' + Math.cos(ang) * dist + 'px),calc(-50% + ' +
                  Math.sin(ang) * dist + 'px)) scale(0)',
                opacity: 0
              }
            ],
            { duration: 620 + Math.random() * 240, easing: 'cubic-bezier(0.22,0.61,0.36,1)' }
          );
          anim.onfinish = function () { node.remove(); live--; };
        })(p);
      }
    }, { passive: true });
  }

  // Slim top loading bar: a brief fill flourish on load, and a progress
  // sweep while navigating away.
  function initProgress() {
    if (REDUCE) return;
    var bar = el('div');
    bar.id = 'fj-progress';
    bar.setAttribute('aria-hidden', 'true');
    document.body.appendChild(bar);
    requestAnimationFrame(function () {
      bar.classList.add('on');
      bar.style.width = '100%';
      setTimeout(function () {
        bar.classList.remove('on');
        setTimeout(function () { bar.style.width = '0'; }, 320);
      }, 480);
    });
    window.addEventListener('beforeunload', function () {
      bar.style.transition = 'none';
      bar.style.width = '0';
      bar.classList.add('on');
      requestAnimationFrame(function () {
        bar.style.transition = 'width 8s cubic-bezier(0.1,0.7,0.1,1)';
        bar.style.width = '88%';
      });
    });
  }

  // brief rotating-shuriken cursor while a navigation is in flight
  function initLoadingCursor() {
    window.addEventListener('beforeunload', function () {
      document.documentElement.classList.add('fj-loading');
    });
  }

  // Reading progress as an ink brush stroke down the right margin
  function initScrollBrush() {
    if (REDUCE) return;
    var wrap = el('div');
    wrap.id = 'fj-scroll';
    wrap.setAttribute('aria-hidden', 'true');
    wrap.innerHTML = "<span class='fj-scroll-fill'></span><span class='fj-scroll-tip'></span>";
    document.body.appendChild(wrap);
    var fill = wrap.querySelector('.fj-scroll-fill');
    var tip = wrap.querySelector('.fj-scroll-tip');
    var ticking = false;
    function update() {
      var doc = document.documentElement;
      var max = doc.scrollHeight - doc.clientHeight;
      var pct = max > 0 ? Math.min(1, (window.scrollY || 0) / max) : 0;
      fill.style.transform = 'scaleY(' + pct.toFixed(4) + ')';
      tip.style.top = (pct * 100) + '%';
      wrap.style.opacity = pct > 0.01 && pct < 0.995 ? '1' : '0';
      ticking = false;
    }
    window.addEventListener('scroll', function () {
      if (!ticking) { ticking = true; requestAnimationFrame(update); }
    }, { passive: true });
    update();
  }

  // Shoji (sliding paper-door) reveal: two paper panels part on each arrival.
  // Runs early (before idle) so the panels cover before first paint.
  function initShoji() {
    if (REDUCE || document.getElementById('fj-shoji')) return;
    var sh = el('div');
    sh.id = 'fj-shoji';
    sh.setAttribute('aria-hidden', 'true');
    sh.innerHTML = "<span class='fj-shoji-panel fj-shoji-l'></span><span class='fj-shoji-panel fj-shoji-r'></span>";
    document.body.appendChild(sh);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        sh.classList.add('open');
        setTimeout(function () { sh.parentNode && sh.remove(); }, 760);
      });
    });
  }

  // Intro loader — a brush paints an ensō (円相) once per session, then fades
  function initIntro() {
    if (REDUCE) return;
    try { if (sessionStorage.getItem('fj-seen')) return; sessionStorage.setItem('fj-seen', '1'); }
    catch (e) {}
    var intro = el('div');
    intro.id = 'fj-intro';
    intro.setAttribute('aria-hidden', 'true');
    intro.innerHTML =
      "<svg viewBox='0 0 120 120'><path class='fj-enso' d='M92 32 A44 44 0 1 0 96 74' " +
      "fill='none' stroke='var(--fj-purple-soft)' stroke-width='7' stroke-linecap='round'/></svg>";
    document.body.appendChild(intro);
    var done = false;
    function finish() {
      if (done) return; done = true;
      intro.classList.add('fade');
      setTimeout(function () { intro.remove(); }, 700);
    }
    requestAnimationFrame(function () { intro.classList.add('draw'); });
    setTimeout(finish, 1500);
    window.addEventListener('load', function () { setTimeout(finish, 400); });
  }

  /* ---------------------------------------------------------------------- *
   *  3. Optional ambient mode — procedural wind + distant bell (Web Audio).
   *     Muted by default, never autoplays: only starts on the user's click.
   * ---------------------------------------------------------------------- */
  function initAmbient() {
    var btn = el('button', null,
      "<svg class='fj-ambient-wave' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.7' stroke-linecap='round'>" +
      "<path d='M4 12 Q7 5 10 12 T16 12 T22 12'/><path d='M4 17 Q8 13 12 17 T20 17' opacity='0.6'/></svg>");
    btn.id = 'fj-ambient';
    btn.type = 'button';
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-label', 'Toggle ambient village sounds');
    btn.title = 'Ambient sounds (off)';
    document.body.appendChild(btn);

    var ctx = null, master = null, nodes = [], bellTimer = 0, on = false;

    function makeNoise(context) {
      var len = context.sampleRate * 2, buf = context.createBuffer(1, len, context.sampleRate);
      var d = buf.getChannelData(0), last = 0, i;
      for (i = 0; i < len; i++) {
        var white = Math.random() * 2 - 1;
        last = (last + 0.02 * white) / 1.02;   // brown-ish noise
        d[i] = last * 3.2;
      }
      return buf;
    }

    function startWind() {
      var src = ctx.createBufferSource();
      src.buffer = makeNoise(ctx);
      src.loop = true;
      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 480; lp.Q.value = 0.6;
      var gustLfo = ctx.createOscillator(); gustLfo.frequency.value = 0.06;
      var gustGain = ctx.createGain(); gustGain.gain.value = 260;
      gustLfo.connect(gustGain).connect(lp.frequency);
      var g = ctx.createGain(); g.gain.value = 0.10;
      src.connect(lp).connect(g).connect(master);
      src.start(); gustLfo.start();
      nodes.push(src, gustLfo);
    }

    function bell() {
      if (!on) return;
      var t = ctx.currentTime, g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.14, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 4.2);
      g.connect(master);
      [1, 2.01, 2.76, 3.99].forEach(function (mult, i) {
        var o = ctx.createOscillator();
        o.type = 'sine'; o.frequency.value = 146 * mult;
        var og = ctx.createGain(); og.gain.value = 1 / (i + 1.5);
        o.connect(og).connect(g); o.start(t); o.stop(t + 4.4);
      });
      bellTimer = setTimeout(bell, 16000 + Math.random() * 22000);
    }

    function enable() {
      if (!ctx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        ctx = new AC();
        master = ctx.createGain(); master.gain.value = 0.0;
        master.connect(ctx.destination);
        startWind();
      }
      ctx.resume && ctx.resume();
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setTargetAtTime(0.9, ctx.currentTime, 1.2);
      bellTimer = setTimeout(bell, 4000);
      on = true;
      btn.setAttribute('aria-pressed', 'true'); btn.title = 'Ambient sounds (on)';
      try { localStorage.setItem('fj-ambient', '1'); } catch (e) {}
    }
    function disable() {
      on = false;
      if (master) master.gain.setTargetAtTime(0.0, ctx.currentTime, 0.6);
      clearTimeout(bellTimer);
      btn.setAttribute('aria-pressed', 'false'); btn.title = 'Ambient sounds (off)';
      try { localStorage.setItem('fj-ambient', '0'); } catch (e) {}
    }
    btn.addEventListener('click', function () {
      if (on) disable(); else enable();
    });
    // never autoplay — we do NOT auto-enable even if previously on; we only
    // hint the remembered state so the first click resumes it intentionally.
  }

  /* ---------------------------------------------------------------------- */
  function init() {
    buildBackground();
    initNavIcons();
    if (FINE && !REDUCE) initCursor();
    initProgress();
    initScrollBrush();
    initLoadingCursor();
    initAmbient();
  }
  function boot() {
    // visual transitions run immediately (before idle) so they cover first paint
    initShoji();
    initIntro();
    var ric = window.requestIdleCallback || function (f) { return setTimeout(f, 250); };
    ric(init, { timeout: 1500 });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

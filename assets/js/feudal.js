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

    // Layer 7 — moon
    bg.appendChild(el('div', 'fj-moon'));

    // Layer 2 — fog bands
    bg.appendChild(el('div', 'fj-fog fj-fog--1'));
    bg.appendChild(el('div', 'fj-fog fj-fog--2'));

    // Layer 6 — big faint torii, behind the ridge
    var torii = el('div', 'fj-torii-bg');
    torii.style.cssText =
      'left:50%;bottom:16vh;width:min(320px,46vw);height:38vh;transform:translateX(-50%)';
    torii.innerHTML =
      "<svg viewBox='0 0 200 200' preserveAspectRatio='xMidYMax meet' style='width:100%;height:100%'>" +
      "<g fill='none' stroke='var(--fj-torii-edge)' stroke-width='4'>" +
      "<path d='M10 44 L190 44 L176 58 L24 58 Z' fill='var(--fj-torii)'/>" +
      "<rect x='30' y='68' width='140' height='9' fill='var(--fj-torii)'/>" +
      "<rect x='52' y='58' width='16' height='132' fill='var(--fj-torii)'/>" +
      "<rect x='132' y='58' width='16' height='132' fill='var(--fj-torii)'/>" +
      '</g></svg>';
    bg.appendChild(torii);

    // Layers 3-5 — mountains, houses, bamboo
    var scene = el('div', 'fj-silhouette');
    scene.innerHTML =
      "<svg viewBox='0 0 1440 600' preserveAspectRatio='xMidYMax slice'>" +
      // far ridge
      "<path style='fill:var(--fj-mountain-far)' d='M0,600 L0,360 L180,250 L340,330 L520,206 L700,300 L880,196 L1080,292 L1260,220 L1440,300 L1440,600 Z'/>" +
      // near ridge
      "<path style='fill:var(--fj-mountain)' d='M0,600 L0,452 L220,330 L430,430 L640,318 L860,420 L1080,338 L1300,430 L1440,382 L1440,600 Z'/>" +
      // village houses (pitched roofs w/ upturned eaves) sitting on the near ridge
      "<g style='fill:var(--fj-house)'>" +
      "<path d='M560,470 q54,-40 108,0 l-12,7 q-42,-26 -84,0 Z'/>" +
      "<path d='M636,486 q46,-34 92,0 l-10,6 q-36,-22 -72,0 Z'/>" +
      "<path d='M700,462 q60,-44 120,0 l-13,7 q-47,-28 -94,0 Z'/>" +
      "<rect x='592' y='474' width='44' height='34'/>" +
      "<rect x='726' y='466' width='60' height='42'/>" +
      '</g>' +
      // bamboo, left & right edges
      "<g style='fill:var(--fj-bamboo)' opacity='0.85'>" +
      "<rect x='24' y='120' width='7' height='480'/><rect x='44' y='170' width='6' height='430'/><rect x='62' y='96' width='7' height='504'/>" +
      "<rect x='1372' y='140' width='7' height='460'/><rect x='1392' y='100' width='6' height='500'/><rect x='1410' y='180' width='7' height='420'/>" +
      '</g></svg>';
    bg.appendChild(scene);

    // Layer 8b — warm lantern halos flanking the village
    var lpos = [[18, 24], [80, 20], [40, 30]];
    lpos.forEach(function (p, i) {
      var lan = el('div', 'fj-lantern');
      lan.style.left = p[0] + '%';
      lan.style.bottom = p[1] + 'vh';
      lan.style.setProperty('--fj-flicker-dur', (4.5 + i * 1.3).toFixed(1) + 's');
      lan.style.setProperty('--fj-leaf-delay', '-' + (i * 1.9).toFixed(1) + 's');
      bg.appendChild(lan);
    });

    document.body.insertBefore(bg, document.body.firstChild);

    if (!REDUCE) buildFalling(bg);
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
    bg.appendChild(frag);
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

  // brief rotating-shuriken cursor while a navigation is in flight
  function initLoadingCursor() {
    window.addEventListener('beforeunload', function () {
      document.documentElement.classList.add('fj-loading');
    });
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
    if (FINE && !REDUCE) initCursor();
    initLoadingCursor();
    initAmbient();
  }
  function boot() {
    var ric = window.requestIdleCallback || function (f) { return setTimeout(f, 250); };
    ric(init, { timeout: 1500 });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

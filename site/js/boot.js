'use strict';
// Boot (loads last): the first load, the background refreshes, the ember field, and idling when nobody is looking.

// Initial load, then keep both data sets fresh in the background for as
// long as the tab stays open (see STANDINGS_REFRESH_MS / TIMERS_REFRESH_MS).
placeRails();
document.querySelectorAll('.rail-swap').forEach((btn) => {
  btn.addEventListener('click', () => swapRails(btn));
});
showStandingsSkeleton(standingsGridNA);
showStandingsSkeleton(standingsGridEU);
refreshStandings();
fetchTimers();
setInterval(updateRelinkBanner, 60000); // ticks the countdown display only
startPeeking(); // /api ahead of the board: load it now (js/standings.js)
schedulePeriodicRefresh(refreshStandings, STANDINGS_REFRESH_MS);
schedulePeriodicRefresh(fetchTimers, TIMERS_REFRESH_MS);

// Embers drifting up the page: 46 of them, one in four cyan instead of warm, each
// with its own column, duration and sideways drift. One canvas, not an element per
// ember (each element is its own compositor layer and draw call). The cost: the
// timing curves below are the CSS keyframes written out by hand, and pausing while
// nobody is watching is this file's job.
const emberField = (function () {
  const canvas = document.getElementById('fxEmbers');
  if (!canvas || !canvas.getContext) return { start() {}, stop() {}, blast() {} };
  const ctx = canvas.getContext('2d');

  const WARM = { core: '#ffb765', glow: '255,150,60' };
  const COLD = { core: '#9fe6ff', glow: '127,214,242' };
  // The glow's shape: sigma is the blur's standard deviation, spread how far
  // the lit disc grows before blurring, alpha how strong the halo is.
  const GLOW = { sigma: 3.5, spread: 1, alpha: .75 };
  // The wind. `eddy` is how wide a gust is in pixels, `churn` how fast
  // the field itself changes, `push` how hard it shoves, `drag` how much
  // sideways speed survives a second.
  // `gust` is the exponent that makes it long calm, brief shove: the noise
  // is raised to it, so small values collapse. At 1 it is an even breeze,
  // and push is large to compensate because interpolated noise only reaches
  // about a third of the way out.
  const WIND = { eddy: 220, churn: .08, push: 280, gust: 4, drag: .45 };

  // Value noise: a lattice of hashed numbers with smooth interpolation. All that
  // matters is that neighbouring samples agree, so two embers in the same patch of
  // air drift together; a sum of sines cannot fake that.
  function hash(x, y, z) {
    let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1274126177);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 2147483648 - 1;
  }
  function noise3(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const s = t => t * t * (3 - 2 * t);
    const xf = s(x - xi), yf = s(y - yi), zf = s(z - zi);
    let v = 0;
    for (let i = 0; i < 8; i++) {
      const dx = i & 1, dy = (i >> 1) & 1, dz = (i >> 2) & 1;
      v += hash(xi + dx, yi + dy, zi + dz) *
           (dx ? xf : 1 - xf) * (dy ? yf : 1 - yf) * (dz ? zf : 1 - zf);
    }
    return v;
  }
  const PAD = 14;   // room for the glow, which reaches 8px past the dot
  // The sprite is built at the backing store's scale, so drawing it is 1:1.
  // Anything higher is a shrink on every draw. Set from resize().
  let SS = 1;

  // The halo, and only the halo, rasterised once per colour and size. The core is
  // drawn live in put(): an ember is at two thirds of its size when brightest, and
  // a bitmap shrunk by a third loses that peak.
  //
  // blur(3.5px) and not 7: a box-shadow radius is twice the standard deviation,
  // and ctx.filter takes the deviation. Not shadowBlur: the spec leaves the
  // algorithm and the meaning of the number to the engine.
  //
  // CAN_BLUR because Safari has never shipped ctx.filter (desktop or iOS). The
  // assignment fails silently there and the halo is a hard-edged disc, so it is
  // set and read back rather than trusted.
  const CAN_BLUR = (() => {
    const c = document.createElement('canvas').getContext('2d');
    c.filter = 'blur(4px)';
    return c.filter === 'blur(4px)';
  })();

  function sprite(colour, size) {
    const d = (size + PAD * 2) * SS;
    const s = document.createElement('canvas');
    s.width = d; s.height = d;
    const c = s.getContext('2d');
    const m = d / 2;
    const r = (size / 2 + GLOW.spread) * SS;
    if (CAN_BLUR) {
      c.filter = 'blur(' + (GLOW.sigma * SS) + 'px)';
      c.fillStyle = 'rgba(' + colour.glow + ',' + GLOW.alpha + ')';
      c.beginPath();
      c.arc(m, m, r, 0, Math.PI * 2);
      c.fill();
    } else {
      c.fillStyle = blob(c, m, r, colour);
      c.fillRect(0, 0, d, d);
    }
    return s;
  }
  // The same halo, drawn instead of blurred.
  //
  // When the disc is about as wide as the blur (2.5px against 3.5), a blurred disc
  // is indistinguishable from a Gaussian blob carrying the disc's ink. Variances
  // add, so the blob's width is sqrt(sigma^2 + r^2/4); the worst gap from the real
  // convolution is under one step of the canvas's 0-255 alpha. The min() covers a
  // disc much wider than the blur, which this file does not have. 17 stops because
  // a gradient runs straight lines between them.
  function blob(c, m, r, colour) {
    const sd = Math.sqrt(GLOW.sigma * SS * (GLOW.sigma * SS) + r * r / 4);
    const peak = Math.min(GLOW.alpha, GLOW.alpha * r * r / (2 * sd * sd));
    const g = c.createRadialGradient(m, m, 0, m, m, m);
    for (let i = 0; i <= 16; i++) {
      const x = m * i / 16;
      g.addColorStop(i / 16, 'rgba(' + colour.glow + ',' +
        (peak * Math.exp(-x * x / (2 * sd * sd))).toFixed(4) + ')');
    }
    return g;
  }
  // Three quarters of the dot's own radius: it matches the CSS .ember core's
  // half-brightness points in all three phases (a full radius is half again too
  // wide). The same number serves the cold ones.
  function look(colour, size) {
    return { halo: sprite(colour, size), core: colour.core,
             r: size / 2 * .75 };
  }
  const LOOK = { rise: {}, blast: {} };
  function rebuild() {
    LOOK.rise.warm = look(WARM, 3);
    LOOK.rise.cold = look(COLD, 3);
    LOOK.blast.warm = look(WARM, 4);
    LOOK.blast.cold = look(COLD, 4);
  }
  // cubic-bezier, solved the way the CSS engine solves it. Only the blast
  // needs one; the standing field is linear.
  function bezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    return function (p) {
      let t = p;
      for (let i = 0; i < 6; i++) {
        const err = ((ax * t + bx) * t + cx) * t - p;
        if (Math.abs(err) < 1e-4) break;
        const slope = (3 * ax * t + 2 * bx) * t + cx;
        t -= err / slope;
      }
      return ((ay * t + by) * t + cy) * t;
    };
  }
  const BLAST_EASE = bezier(.08, .72, .3, 1);

  const rising = [];
  for (let i = 0; i < 46; i++) {
    rising.push({
      x: Math.random(),                          // fraction of the width
      dur: 14 + Math.random() * 16,
      // Starts each one mid-flight, so the field is populated on load instead of rising all at once.
      phase: Math.random() * 26,
      drift: Math.round(Math.random() * 90 - 45),
      // Where the wind has carried it so far, and how fast it is being
      // carried. Both are wiped when it restarts at the bottom.
      ox: 0, vx: 0, was: 0,
      cold: i % 4 === 0,
    });
  }
  const blasting = [];

  let W = 0, H = 0;
  const dirty = [];

  function resize() {
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    // No cap: zoom raises devicePixelRatio and shrinks the CSS viewport by the
    // same factor, so clientWidth * ratio is the screen's own pixels whatever the
    // zoom. A cap hands back fewer pixels than the display has.
    const scale = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * scale);
    canvas.height = Math.round(H * scale);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.imageSmoothingQuality = 'high';   // resets with the backing store
    SS = scale;
    rebuild();                            // sprites follow the scale
    dirty.length = 0;
    ctx.clearRect(0, 0, W, H);
  }

  // Only what was painted last frame gets cleared, never the viewport.
  function put(l, cx, cy, k, alpha) {
    const d = (l.halo.width / SS) * k;
    const x = cx - d / 2, y = cy - d / 2;
    ctx.globalAlpha = alpha;
    ctx.drawImage(l.halo, x, y, d, d);
    // Drawn, not scaled from a bitmap: see the halo above.
    ctx.beginPath();
    ctx.arc(cx, cy, l.r * k, 0, Math.PI * 2);
    ctx.fillStyle = l.core;
    ctx.fill();
    dirty.push([x - 2, y - 2, d + 4, d + 4]);
  }

  function draw(dt) {
    for (let i = 0; i < dirty.length; i++) {
      ctx.clearRect(dirty[i][0], dirty[i][1], dirty[i][2], dirty[i][3]);
    }
    dirty.length = 0;

    for (const e of rising) {
      const p = ((clock + e.phase) % e.dur) / e.dur;
      // ember-rise: opacity 0 -> .85 at 12% -> .5 at 70% -> 0. The
      // transform has ends only, so it runs straight across.
      const a = p < .12 ? (p / .12) * .85
              : p < .70 ? .85 - ((p - .12) / .58) * .35
              :           .50 - ((p - .70) / .30) * .50;
      const y = H + 10.5 - H * 1.02 * p;      // bottom:-12px, then -102vh
      const x = e.x * W + 1.5 + e.drift * p;

      if (p < e.was) { e.ox = 0; e.vx = 0; }   // back at the bottom
      e.was = p;
      if (dt) {
        // Read the wind where this ember actually is, so two of them in
        // the same gust go the same way. Force, not position: it has to
        // be got moving, and then keeps moving after the gust passes.
        const n = noise3((x + e.ox) / WIND.eddy, y / WIND.eddy, clock * WIND.churn);
        // Not scaled by how far up it is: the ember is brightest barely off the
        // bottom, where it is most looked at. It starts from a standstill, so nothing jumps.
        const f = n < 0 ? -Math.pow(-n, WIND.gust) : Math.pow(n, WIND.gust);
        e.vx += f * WIND.push * dt;
        e.vx *= Math.pow(WIND.drag, dt);
        e.ox += e.vx * dt;
      }
      if (a <= 0) continue;
      put(e.cold ? LOOK.rise.cold : LOOK.rise.warm,
          x + e.ox, y, .6 + p * .55, a);
    }

    for (let i = blasting.length - 1; i >= 0; i--) {
      const e = blasting[i];
      const p = (clock - e.born) / 2;
      if (p >= 1) { blasting.splice(i, 1); continue; }
      if (p < 0) continue;
      // ember-blast. The easing is per interval, the way CSS applies it:
      // the flash up to 7% is one, the fade after it another. The
      // transform has ends only, so it eases across the whole run.
      const a = p < .07 ? BLAST_EASE(p / .07)
                        : 1 - BLAST_EASE((p - .07) / .93);
      if (a <= 0) continue;
      const t = BLAST_EASE(p);
      put(e.cold ? LOOK.blast.cold : LOOK.blast.warm,
          e.x * W + 2 + e.drift * t,
          H + 10 - H * 1.08 * t,
          .5 + t * .85, a);
    }
  }

  // The fastest ember climbs under two pixels a frame at 60. On Windows Chromium
  // times its frames by the primary monitor's vblank (ui/gl/vsync_thread_win_dxgi.cc),
  // so a window on a 60Hz screen beside a 144Hz primary is asked to draw 144 times a
  // second and shown 60. This draws every frame at 60Hz and every second frame at 144.
  const MIN_FRAME_MS = 1000 / 85;

  // An infinite CSS animation makes the page draw a frame at every beat of the
  // monitor, and a video in another window stutters with it. So the looping ones are
  // paused here and moved on by these frames: the page draws only when the embers do
  // (frames.spec.mjs). Not the loading indicators, which turn under reduced motion
  // too. Paused through the API they no longer follow animation-play-state, so the
  // stopped clock is what holds them still while away or under reduced motion
  // (embers.spec.mjs); handed back to CSS they would restart.
  const driven = new Set();
  let sweepDue = false, sinceSweep = 0;
  function adopt() {
    sweepDue = false; sinceSweep = 0;
    if (!document.getAnimations) return;
    for (const a of document.getAnimations()) {
      if (driven.has(a) || a.playState !== 'running' || !a.effect) continue;
      const t = a.effect.target;
      if (!t || !t.isConnected || t.closest('.spinner, .btn-pips')) continue;
      if (a.effect.getComputedTiming().iterations !== Infinity) continue;
      a.pause();
      driven.add(a);
    }
  }
  // An element rebuilt starts its animations again; animationstart asks for a sweep.
  // It can fail to come (embers.spec.mjs holds it back), hence one a second too.
  function moveLooping(dt) {
    sinceSweep += dt;
    if (sweepDue || sinceSweep >= 1) adopt();
    for (const a of driven) {
      const t = a.effect && a.effect.target;
      // A CSS animation whose rule went away is idle, its currentTime null: moved on, it would come back.
      if (!t || !t.isConnected || a.currentTime === null) { driven.delete(a); continue; }
      a.currentTime += dt * 1000;
    }
  }
  document.addEventListener('animationstart', () => { sweepDue = true; }, true);

  let clock = 0, last = 0, running = false, frameId = 0;
  // Stopped for reduced motion only: a blast may run the field until its sparks end.
  let blastMayRun = false, settling = false;
  function frame(now) {
    frameId = requestAnimationFrame(frame);
    if (now - last < MIN_FRAME_MS) return;   // clock waits too, so no skip
    const dt = (now - last) / 1000;
    clock += dt;
    last = now;
    draw(dt);
    // A blast under reduced motion runs the embers only.
    if (!settling) moveLooping(dt);
    if (settling && !blasting.length) stop(true);
  }

  resize();
  draw();
  // One per frame: dragging a window edge fires resize continuously, and each call
  // reallocates the whole backing store and rasterises the four sprites again.
  let resizeQueued = false;
  window.addEventListener('resize', () => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => { resizeQueued = false; resize(); });
  });

  function stop(blastOk) {
    running = false; settling = false; blastMayRun = !!blastOk;
    cancelAnimationFrame(frameId);
  }

  return {
    start() {
      settling = false; blastMayRun = false; sweepDue = true;
      if (running) return;
      running = true;
      last = performance.now();
      frameId = requestAnimationFrame(frame);
    },
    // The clock stops with it, so coming back carries on instead of jumping forward.
    stop,
    blast() {
      if (!running && blastMayRun) {
        running = settling = true;
        last = performance.now();
        frameId = requestAnimationFrame(frame);
      }
      for (let i = 0; i < 12; i++) {
        blasting.push({
          x: Math.random(),
          born: clock + Math.random() * .25,
          drift: Math.round(Math.random() * 160 - 80),
          cold: i % 3 === 0,
        });
      }
    },
  };
})();

// Ambient animation is for when someone is looking, and a second monitor
// is the case that matters: the page is still visible, so
// visibilitychange never fires and the field would draw forever. Focus is
// what distinguishes "on screen" from "being watched".
(function idleWhenUnwatched() {
  const root = document.documentElement;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const update = () => {
    const away = document.visibilityState === 'hidden' || !document.hasFocus();
    root.classList.toggle('is-idle', away);
    if (away) emberField.stop();
    else if (reduced.matches) emberField.stop(true);
    else emberField.start();
  };
  reduced.addEventListener('change', update);
  window.addEventListener('focus', update);
  window.addEventListener('blur', update);
  document.addEventListener('visibilitychange', update);
  update();
})();

// Bound here, last, so an early click or key press finds everything it calls.
runBtn.addEventListener('click', run);
// The button disables itself during a run; the shortcut must not start a second one that wipes the first one's rows.
guildInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.ctrlKey && !runBtn.disabled) run();
});
document.addEventListener('pointerdown', onPointerDown, { passive: true });

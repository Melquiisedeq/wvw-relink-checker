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
setInterval(updateRelinkBanner, 60000); // countdown display, and the pace of the teams notice's reads
startPeeking(); // /api ahead of the board: load it now (js/standings.js)
standingsTick = schedulePeriodicRefresh(refreshStandings, STANDINGS_REFRESH_MS);
schedulePeriodicRefresh(fetchTimers, TIMERS_REFRESH_MS);

// Embers on one canvas. The timing curves below are the CSS keyframes written out by hand,
// and pausing while nobody is watching is this file's job.
const emberField = (function () {
  const canvas = document.getElementById('fxEmbers');
  if (!canvas || !canvas.getContext) return { start() {}, stop() {}, blast() {}, nextFrame: (cb) => requestAnimationFrame(cb) };
  const ctx = canvas.getContext('2d');

  const WARM = { core: '#ffb765', glow: '255,150,60' };
  const COLD = { core: '#9fe6ff', glow: '127,214,242' };
  // The glow's shape: sigma is the blur's standard deviation, spread how far
  // the lit disc grows before blurring, alpha how strong the halo is.
  const GLOW = { sigma: 3.5, spread: 1, alpha: .75 };
  // The wind: `eddy` gust width in px, `churn` how fast the field changes, `push` shove strength,
  // `drag` sideways speed kept per second, `gust` the exponent on the noise (long calm, brief shove).
  const WIND = { eddy: 220, churn: .08, push: 280, gust: 4, drag: .45 };

  // Value noise: neighbouring samples agree, so two embers in the same patch of air drift together.
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

  // The halo only, rasterised once per colour and size; the core is drawn live in put().
  // The core stays live: brightest at two thirds of its size, a bitmap shrunk by a third loses that peak. Not shadowBlur: the spec leaves its algorithm to the engine.
  // blur(3.5px), not 7: ctx.filter takes the standard deviation, a box-shadow radius is twice it.
  // CAN_BLUR is set and read back: where ctx.filter is unsupported the assignment fails silently.
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
  // The same halo, drawn instead of blurred: a Gaussian blob of width sqrt(sigma^2 + r^2/4) carrying the disc's ink.
  // Valid while the disc is about as wide as the blur; 17 stops because a gradient runs straight lines between them.
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
  // Three quarters of the dot's own radius: matches the CSS .ember core's half-brightness points.
  function look(colour, size) {
    return { halo: sprite(colour, size), core: colour.core, colour,
             r: size / 2 * .75 };
  }
  const LOOK = { rise: {}, blast: {} };
  function rebuild() {
    LOOK.rise.warm = look(WARM, 3);
    LOOK.rise.cold = look(COLD, 3);
    LOOK.blast.warm = look(WARM, 4);
    LOOK.blast.cold = look(COLD, 4);
  }
  // cubic-bezier as CSS solves it.
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

  // The surge after a blast: brightness(1 + 1.5a) saturate(1 + .3a) painted into the embers, while
  // css/base.css lifts the canvas. Each halo is one colour under an alpha mask, so recolouring it
  // (source-in) is the filter exactly; the core is a flat fill. The timing is .fx-embers.surge's.
  const SURGE_S = 2.8;
  const SURGE_EASE = bezier(.15, .8, .35, 1);
  // The Filter Effects matrices, brightness then saturate, each step clamped.
  function surgeRgb(rgb, a) {
    const k = 1 + 1.5 * a, s = 1 + .3 * a;
    const c = (v) => Math.min(255, Math.max(0, v));
    const [r, g, b] = rgb.map((v) => c(v * k));
    return [
      c((.213 + .787 * s) * r + (.715 - .715 * s) * g + (.072 - .072 * s) * b),
      c((.213 - .213 * s) * r + (.715 + .285 * s) * g + (.072 - .072 * s) * b),
      c((.213 - .213 * s) * r + (.715 - .715 * s) * g + (.072 + .928 * s) * b),
    ].map(Math.round).join(',');
  }
  const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  // surgeAt is the clock when the surge began, -1 with none; surgeKey its strength this frame, in 256ths.
  let surgeAt = -1, surgeKey = 0;
  const surgedCopy = new WeakMap();   // look -> its copy at the strength last asked for
  function surged(l) {
    if (!surgeKey) return l;
    let s = surgedCopy.get(l);
    if (!s) {
      const halo = document.createElement('canvas');
      halo.width = l.halo.width; halo.height = l.halo.height;
      s = { halo, core: l.core, r: l.r, key: 0 };
      surgedCopy.set(l, s);
    }
    if (s.key !== surgeKey) {
      s.key = surgeKey;
      const a = surgeKey / 256, c = s.halo.getContext('2d');
      c.globalCompositeOperation = 'copy';
      c.drawImage(l.halo, 0, 0);
      c.globalCompositeOperation = 'source-in';
      c.fillStyle = 'rgb(' + surgeRgb(l.colour.glow.split(',').map(Number), a) + ')';
      c.fillRect(0, 0, s.halo.width, s.halo.height);
      s.core = 'rgb(' + surgeRgb(hexRgb(l.core), a) + ')';
    }
    return s;
  }

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
    // No cap on the ratio: it would hand back fewer pixels than the display has.
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
    l = surged(l);
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

    surgeKey = 0;
    if (surgeAt >= 0) {
      const p = (clock - surgeAt) / SURGE_S;
      // Eased per interval, as CSS does: the flare up to 7%, the settle after it.
      if (p >= 1) surgeAt = -1;
      else surgeKey = Math.round(256 * (p < .07 ? SURGE_EASE(p / .07) : 1 - SURGE_EASE((p - .07) / .93)));
    }

    for (const e of rising) {
      const p = ((clock + e.phase) % e.dur) / e.dur;
      // ember-rise: opacity 0 -> .9 at 10% -> .7 at 82% -> 0 at the top, so it
      // holds its glow most of the way up and goes out only near the end. The
      // transform has ends only, so it runs straight across.
      const a = p < .10 ? p / .10 * .9
              : p < .82 ? .9 - (p - .10) / .72 * .2
              :           .7 * (1 - (p - .82) / .18);
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

  // Caps the draw rate. 85 sits between 60 and 144: every frame is drawn at 60 Hz, every second one at 144 Hz (Windows Chromium times frames by the primary monitor's vblank, ui/gl/vsync_thread_win_dxgi.cc).
  const MIN_FRAME_MS = 1000 / 85;

  // Every animation and transition on the page, CSS or element.animate, is paused here and moved
  // on by these frames, so the page draws only when the embers do (frames.spec.mjs). Paused through
  // the API they no longer follow animation-play-state, so the stopped clock is what holds the
  // looping ones still under reduced motion (embers.spec.mjs); play() would set them moving there.
  // The run-once ones and the loading indicators play under reduced motion and in a hidden tab, so
  // a stop hands them back. element.animate fires no event: every frame sweeps.
  const driven = new Set();
  const runsOnce = (a) => a.effect.getComputedTiming().iterations !== Infinity;
  const handedBack = (a) => runsOnce(a) || !!a.effect.target.closest('.spinner, .btn-pips');
  function adopt() {
    if (!document.getAnimations) return;
    for (const a of document.getAnimations()) {
      if (driven.has(a) || a.playState !== 'running' || !a.effect) continue;
      a.pause();
      driven.add(a);
    }
  }
  function moveAnimations(dt) {
    for (const a of driven) {
      const t = a.effect && a.effect.target;
      // A CSS animation whose rule went away is idle, its currentTime null: moved on, it would come back.
      if (!t || !t.isConnected || a.currentTime === null) { driven.delete(a); continue; }
      // Paused past its end it never finishes: no animationend, .finished never settles.
      if (runsOnce(a) && Number(a.currentTime) + dt * 1000 >= a.effect.getComputedTiming().endTime) {
        a.finish();
        driven.delete(a);
        continue;
      }
      a.currentTime += dt * 1000;
    }
    // After the move: the style it flushes is the one this frame draws.
    adopt();
  }
  function handBack() {
    for (const a of driven) {
      if (!a.effect || !a.effect.target || !handedBack(a)) continue;
      driven.delete(a);
      if (a.playState === 'paused') a.play();
    }
  }

  // Callbacks for the next frame of embers, with its timestamp (requestAnimationFrame's time base).
  const waiting = [];
  function nextFrame(cb) {
    if (running && !settling) waiting.push(cb);
    else requestAnimationFrame(cb);
  }

  let clock = 0, last = 0, running = false, frameId = 0;
  // Stopped for reduced motion only: a blast may run the field until its sparks and its surge end.
  let blastMayRun = false, settling = false;
  function frame(now) {
    frameId = requestAnimationFrame(frame);
    if (now - last < MIN_FRAME_MS) return;   // clock waits too, so no skip
    const dt = (now - last) / 1000;
    clock += dt;
    last = now;
    for (const cb of waiting.splice(0)) cb(now);
    draw(dt);
    // A blast under reduced motion runs the embers only.
    if (!settling) moveAnimations(dt);
    if (settling && !blasting.length && surgeAt < 0) stop(true);
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
    // A surge cut short is dropped, so a field left standing still is not left brightened.
    if (surgeAt >= 0) { surgeAt = -1; draw(); }
    handBack();
    for (const cb of waiting.splice(0)) requestAnimationFrame(cb);
  }

  return {
    start() {
      settling = false; blastMayRun = false;
      if (running) return;
      running = true;
      last = performance.now();
      frameId = requestAnimationFrame(frame);
    },
    // The clock stops with it, so coming back carries on instead of jumping forward.
    stop,
    nextFrame,
    blast() {
      if (!running && blastMayRun) {
        running = settling = true;
        last = performance.now();
        frameId = requestAnimationFrame(frame);
      }
      surgeAt = clock;
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

// Ambient animation stops only with the tab hidden, like the data polls: a page left visible on a
// second monitor, the focus in another window, is still being watched.
(function idleWhenUnwatched() {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const update = () => {
    if (document.visibilityState === 'hidden') emberField.stop();
    else if (reduced.matches) emberField.stop(true);
    else emberField.start();
  };
  reduced.addEventListener('change', update);
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

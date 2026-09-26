'use strict';
// ---------------------------------------------------------------------
// Boot
// Kicks off the first load, starts the background refreshes, runs the
// ember field and idles the page when nobody is looking. Loads last.
// ---------------------------------------------------------------------

// Initial load, then keep both data sets fresh in the background for as
// long as the tab stays open (see STANDINGS_REFRESH_MS / TIMERS_REFRESH_MS).
showStandingsSkeleton(standingsGridNA);
showStandingsSkeleton(standingsGridEU);
refreshStandings();
fetchTimers();
setInterval(updateRelinkBanner, 60000); // ticks the countdown display only
schedulePeriodicRefresh(refreshStandings, STANDINGS_REFRESH_MS);
schedulePeriodicRefresh(fetchTimers, TIMERS_REFRESH_MS);

// Embers drifting up the page: 46 of them, one in four cyan instead of
// warm, each with its own column, duration and sideways drift so the
// field never resolves into a visible loop.
//
// One canvas, where this used to be 46 elements. Every animated element
// became its own compositor layer and its own draw call, and a trace put
// the GPU process main thread at 98.6% with them running against 4.4%
// with them hidden - that 4.4% being the whole rest of the page.
//
// What it costs is the clock. CSS was running these, so the timing curves
// below are the keyframes written out by hand, and pausing while nobody
// is watching is now something this has to do for itself.
const emberField = (function () {
  const canvas = document.getElementById('fxEmbers');
  if (!canvas || !canvas.getContext) return { start() {}, stop() {}, blast() {} };
  const ctx = canvas.getContext('2d');

  const WARM = { core: '#ffb765', glow: '255,150,60' };
  const COLD = { core: '#9fe6ff', glow: '127,214,242' };
  // The glow's shape, kept in one place so it can be turned from the
  // console against the real thing rather than guessed at. sigma is the
  // blur's standard deviation, spread how far the lit disc is grown
  // before blurring, alpha how strong the halo is - the three numbers
  // box-shadow 0 0 7px 1px encodes.
  // What box-shadow 0 0 7px 1px encodes: a halo blurred with a standard
  // deviation of half the 7px radius, over the dot grown by the 1px
  // spread, at the shadow colour's own alpha.
  const GLOW = { sigma: 3.5, spread: 1, alpha: .75 };
  // The wind. `eddy` is how wide a gust is in pixels, `churn` how fast the
  // field itself changes, `push` how hard it shoves, `drag` how much
  // sideways speed survives a second - which is what gives an ember the
  // feel of having mass rather than being placed.
  // `gust` is what keeps this from being a fan pointed at the screen.
  // A noise field hands out roughly even energy everywhere, so raising
  // push alone just makes everything restless at once. Raised to a power
  // first, the small values collapse towards nothing and only the rare
  // large ones survive - long calm, brief shove, which is what air
  // actually does. At 1 it is the even breeze again.
  //
  // push is sized against what the noise really delivers: interpolating
  // eight hashed values lands around a third of the way out, and a third
  // cubed is a fortieth, so the number has to be large for the quiet
  // stretches to stay quiet and the gusts to still move something.
  const WIND = { eddy: 220, churn: .08, push: 280, gust: 4, drag: .45 };

  // Value noise: a lattice of hashed numbers with smooth interpolation
  // between them. Not as good as Perlin and it does not need to be - the
  // whole point is only that neighbouring samples agree, so two embers in
  // the same patch of air drift together instead of each doing its own
  // private wobble. That agreement is what a sum of sines cannot fake.
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
  // The sprite is built at the backing store's scale, so drawing it at
  // rest is 1:1 and no resampling happens at all. Anything higher is not
  // headroom, it is a shrink on every single draw, and shrinking is the
  // one thing canvas does badly. Set from resize(), which is also where
  // the scale it follows is decided.
  let SS = 1;

  // One ember, glow and core together, rasterised once per colour and
  // size. Together is the point: CSS composites the box-shadow and the
  // background into a group and fades the group, so the core stays its
  // own pure colour the whole way. Drawing the two separately at the
  // same alpha lets the core blend with its own halo and come out a
  // duller orange, which is what stopped it reading as a spark.
  //
  // blur(3.5px) and not 7: a box-shadow radius is twice the standard
  // deviation, and ctx.filter is the CSS filter path, which takes the
  // deviation. shadowBlur was the wrong tool for this - the spec leaves
  // both the algorithm and the meaning of the number to the engine.
  function sprite(colour, size) {
    const d = (size + PAD * 2) * SS;
    const s = document.createElement('canvas');
    s.width = d; s.height = d;
    const c = s.getContext('2d');
    const m = d / 2;
    c.filter = 'blur(' + (GLOW.sigma * SS) + 'px)';
    c.fillStyle = 'rgba(' + colour.glow + ',' + GLOW.alpha + ')';
    c.beginPath();
    c.arc(m, m, (size / 2 + GLOW.spread) * SS, 0, Math.PI * 2);
    c.fill();
    return s;
  }
  // Three quarters of the dot's own radius, which is not a taste call:
  // rendering the real .ember beside this one and measuring both, the
  // CSS core falls to half brightness at .80, 1.00 and 1.40 px across
  // the three phases worth measuring, and .75 reproduces all three
  // exactly. A full radius came out half again too wide - which is the
  // "slightly bigger and blurrier" that was visible and unexplained for
  // a long time. The halo needed nothing: its profile already matched to
  // within a couple of points at every distance.
  //
  // The same number serves the cold ones. Their colours differ, their
  // geometry does not, and the CSS pair measure identically.
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
        if (Math.abs(slope) < 1e-6) break;
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
      // Was a negative animation-delay: it starts each one mid-flight, so
      // the field is populated on load instead of rising all at once.
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
    // No cap, and capping was never the saving it looked like. Zoom raises
    // devicePixelRatio and shrinks the CSS viewport by the same factor, so
    // clientWidth * ratio comes to the screen's own pixels whatever the
    // zoom - 381css x 5 and 1524css x 1.25 are both 1905. A cap does not
    // buy fewer pixels, it just hands back fewer than the display has,
    // and the browser stretches the difference. At 400% that was a third
    // of the real resolution, and everything drawn here went soft.
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
  // Fifty sprites of about 30px against 3.7 million pixels is the whole
  // difference between this being worth doing and not.
  function put(l, cx, cy, k, alpha) {
    const d = (l.halo.width / SS) * k;
    const x = cx - d / 2, y = cy - d / 2;
    ctx.globalAlpha = alpha;
    ctx.drawImage(l.halo, x, y, d, d);
    // Drawn, not scaled from a bitmap. An ember is at .666 of its size at
    // the moment it is brightest, and a bitmap shrunk by a third loses
    // exactly the peak that makes a spark read as one.
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
        // the same gust go the same way. Force, not position: what makes
        // it look like something being blown rather than something drawn
        // along a wavy line is that it has to be got moving, and then
        // keeps moving after the gust has passed.
        const n = noise3((x + e.ox) / WIND.eddy, y / WIND.eddy, clock * WIND.churn);
        // Not scaled by how far up it is: the ember is at its brightest
        // barely off the bottom, and holding the wind back until later
        // was keeping it calm exactly where it is most looked at. It
        // starts from a standstill anyway, so nothing jumps.
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

  // The fastest ember climbs about 105px a second, which is under two
  // pixels a frame at 60 - slow enough that drawing it more often cannot
  // show anything an eye could catch. Chromium drives frames at the rate
  // of the fastest display attached, so a window sitting on a 60Hz screen
  // next to a 144Hz one is asked to draw 144 times a second and shown 60
  // of them (crbug 40386822). This number draws every frame at 60Hz and
  // every second frame at 144, which is the waste and nothing else.
  const MIN_FRAME_MS = 1000 / 85;

  let clock = 0, last = 0, running = false;
  function frame(now) {
    if (!running) return;
    requestAnimationFrame(frame);
    if (now - last < MIN_FRAME_MS) return;   // clock waits too, so no skip
    const dt = (now - last) / 1000;
    clock += dt;
    last = now;
    draw(dt);
  }

  resize();
  draw();
  window.addEventListener('resize', resize);

  return {
    start() {
      if (running) return;
      running = true;
      last = performance.now();
      requestAnimationFrame(frame);
    },
    // The clock stops with it, so coming back carries on from where it
    // was rather than jumping forward by however long you were away.
    stop() { running = false; },
    blast() {
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
  const update = () => {
    const away = document.visibilityState === 'hidden' || !document.hasFocus();
    root.classList.toggle('is-idle', away);
    if (away) emberField.stop(); else emberField.start();
  };
  window.addEventListener('focus', update);
  window.addEventListener('blur', update);
  document.addEventListener('visibilitychange', update);
  update();
})();

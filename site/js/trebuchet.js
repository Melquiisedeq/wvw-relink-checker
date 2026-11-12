'use strict';
// The siege engine: the trebuchet in the corner, the round it throws, and
// everything that burns, sparks or shatters. Pure decoration.
//
// Numbers taken off the two cutouts: pivot boss (67,10) in the frame image, beam
// axle (200,37) in its own, sling head 178px along the beam from the axle.
// slingTip() reads the launch point off the sling so beam and fireball cannot drift apart.
const trebuchet = document.getElementById('trebuchet');
const trebArm = document.getElementById('trebArm');

// Beam angles. Negative: counterweight raised (waiting to fire); +128: end of the throw.
const ARM_REST = -34;
const ARM_COCKED = -46;
const ARM_RELEASED = 128;
// How long the beam takes to come over. Mirrored in trebuchet.css.
const SWING_MS = 170;
const trebSling = document.getElementById('trebSling');

let armAngle = ARM_REST;

function setArm(deg) {
  armAngle = deg;
  trebArm.style.transform = `rotate(${deg}deg)`;
}

// The sling in screen coordinates, read off the marker so traverse and rotation are
// in it; a fixed corner when the machine is hidden.
function slingTip() {
  const r = trebSling.getBoundingClientRect();
  const box = trebuchet.getBoundingClientRect();
  if (!box.width) {
    return { x: 46, y: window.innerHeight - 46 };
  }
  return { x: r.left, y: r.top };
}

function followSling(el) {
  let live = true;
  const step = () => {
    if (!live || !el.isConnected) return;
    const p = slingTip();
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    emberField.nextFrame(step);
  };
  emberField.nextFrame(step);
  return () => { live = false; };
}

let aimQueued = false, aimX = 0, aimY = 0;

function applyAim() {
  aimQueued = false;
  if (trebuchet.classList.contains('firing')) return;
  const w = window.innerWidth || 1, h = window.innerHeight || 1;
  const fx = Math.min(1, Math.max(0, aimX / w));
  const fy = Math.min(1, Math.max(0, aimY / h));
  trebuchet.style.setProperty('--yaw', `${(fx * 7 - 2).toFixed(1)}deg`);
  // A shallow range: past a point it stops reading as aiming.
  if (!trebuchet.classList.contains('cocking')) {
    setArm(ARM_REST - (1 - fy) * 9);
  }
}

window.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') return;
  aimX = e.clientX; aimY = e.clientY;
  if (!aimQueued) { aimQueued = true; requestAnimationFrame(applyAim); }
}, { passive: true });

setArm(ARM_REST);

let trebResetTimer = null;
function fireTrebuchet() {
  clearTimeout(trebResetTimer);
  trebuchet.classList.remove('cocking', 'resetting');
  trebuchet.classList.add('firing');
  void trebuchet.offsetWidth;
  setArm(ARM_RELEASED);

  trebResetTimer = setTimeout(() => {
    trebuchet.classList.remove('firing');
    trebuchet.classList.add('resetting');
    setArm(ARM_REST);
    trebResetTimer = setTimeout(() => {
      trebuchet.classList.remove('resetting');
      applyAim();
    }, 1000);
  }, SWING_MS + 40);
}

// Same clock as the round gathering in the sling.
function cockTrebuchet() {
  clearTimeout(trebResetTimer);
  trebuchet.classList.remove('firing', 'resetting');
  trebuchet.classList.add('cocking');
  setArm(ARM_COCKED);
}

const SHOT_MS = 340;   // mirrored in click.css

function arcRise(dx, dy) {
  return Math.min(280, Math.max(60, Math.hypot(dx, dy) * 0.28));
}

// One segment per frame from the previous position, read off the live element so
// the trail cannot drift from its head.
function trailFrom(ball, untilMs, big, power) {
  // How heavily it burns; the finale passes the size the round charged to.
  const heat = Math.max(1, power || 1);
  const size = big ? ' flame-seg--big' : '';
  const life = big ? 360 : 280;
  const head = document.createElement('div');
  head.className = `flame-head${big ? ' flame-head--big' : ''}`;
  document.body.appendChild(head);

  const stop = performance.now() + untilMs;
  let px = null, py = null, lastShed = 0;

  const step = (now) => {
    if (now > stop || !ball.isConnected) {
      head.style.opacity = '0';
      setTimeout(() => head.remove(), 260);
      return;
    }

    const r = ball.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    head.style.transform = `translate(${x}px, ${y}px)`;
    head.style.opacity = '1';

    if (px !== null) {
      const dx = x - px, dy = y - py;
      const speed = Math.hypot(dx, dy);
      if (speed > 0.3) {
        const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
        // Overlapped a little past the gap, or the seams show where the round moves fastest.
        const len = speed + (big ? 10 : 6);
        layFlame(px, py, angle, len, `flame-seg${size}`, life);
        layFlame(px, py, angle, len, `flame-seg flame-seg--hot${size}`, life);

        if (now - lastShed > Math.max(12, 26 / heat)) {
          lastShed = now;
          shedSmoke(x, y, heat);
          const sparks = Math.round((big ? 1.6 : 0.7) * heat);
          for (let i = 0; i < sparks; i++) shedSpark(x, y, heat);
        }
      }
    }
    px = x; py = y;
    emberField.nextFrame(step);
  };
  emberField.nextFrame(step);
}

function layFlame(x, y, angle, len, cls, life) {
  const seg = document.createElement('div');
  seg.className = cls;
  seg.style.width = `${len}px`;
  seg.style.transform = `translate(${x}px, ${y}px) rotate(${angle}deg)`;
  seg.innerHTML = '<i></i>';
  document.body.appendChild(seg);
  setTimeout(() => seg.remove(), life);
}

function shedSmoke(x, y, heat) {
  const puff = document.createElement('div');
  puff.className = 'trail-smoke';
  const size = Math.round(15 * heat);
  puff.style.width = puff.style.height = `${size}px`;
  puff.style.margin = `${-size / 2}px 0 0 ${-size / 2}px`;
  puff.style.left = `${x}px`;
  puff.style.top = `${y}px`;
  puff.style.setProperty('--sx', `${Math.round(Math.random() * 30 - 15)}px`);
  puff.style.setProperty('--sy', `${Math.round(-18 - Math.random() * 26)}px`);
  document.body.appendChild(puff);
  setTimeout(() => puff.remove(), 1200);
}

function shedSpark(x, y, heat) {
  const spark = document.createElement('div');
  spark.className = 'trail-spark';
  spark.style.left = `${x}px`;
  spark.style.top = `${y}px`;
  const angle = Math.random() * Math.PI * 2;
  const distance = (14 + Math.random() * 40) * heat;
  spark.style.setProperty('--sx', `${Math.round(Math.cos(angle) * distance)}px`);
  spark.style.setProperty('--sy', `${Math.round(Math.sin(angle) * distance)}px`);
  spark.style.animationDelay = `${(Math.random() * 0.08).toFixed(2)}s`;
  document.body.appendChild(spark);
  setTimeout(() => spark.remove(), 760);
}

function bloomAt(x, y) {
  const core = document.createElement('div');
  core.className = 'shot-bloom';
  core.style.left = `${x}px`;
  core.style.top = `${y}px`;
  document.body.appendChild(core);
  setTimeout(() => core.remove(), 520);

  const LOBES = 4;
  for (let i = 0; i < LOBES; i++) {
    const lobe = document.createElement('div');
    lobe.className = 'bloom-lobe';
    const size = Math.round(26 + Math.random() * 28);
    lobe.style.width = lobe.style.height = `${size}px`;
    lobe.style.margin = `${-size / 2}px 0 0 ${-size / 2}px`;
    lobe.style.left = `${x}px`;
    lobe.style.top = `${y}px`;
    const angle = (i / LOBES) * Math.PI * 2 + Math.random() * 0.9;
    const distance = 8 + Math.random() * 22;
    lobe.style.setProperty('--bx', `${Math.round(Math.cos(angle) * distance)}px`);
    lobe.style.setProperty('--by', `${Math.round(Math.sin(angle) * distance)}px`);
    lobe.style.animationDelay = `${(Math.random() * 0.05).toFixed(2)}s`;
    document.body.appendChild(lobe);
    setTimeout(() => lobe.remove(), 600);
  }

  const RAYS = 7;
  for (let i = 0; i < RAYS; i++) {
    const ray = document.createElement('div');
    ray.className = 'bloom-ray';
    ray.style.left = `${x}px`;
    ray.style.top = `${y}px`;
    ray.style.width = `${Math.round(30 + Math.random() * 42)}px`;
    ray.style.setProperty('--a', `${((i / RAYS) * 360 + Math.random() * 26).toFixed(1)}deg`);
    ray.style.animationDelay = `${(Math.random() * 0.04).toFixed(2)}s`;
    document.body.appendChild(ray);
    setTimeout(() => ray.remove(), 400);
  }
}

// Bound in boot.js, once emberField exists.
function onPointerDown(e) {
  if (e.pointerType === 'touch') return;
  // No round at Check: it launches its own at the crest.
  if (e.target.closest && e.target.closest('#runBtn')) return;
  // Nothing is thrown while a popover is up.
  if (activeTrigger) return;

  fireTrebuchet();
  const mx = e.clientX, my = e.clientY;

  // Thrown when the beam gets over the top, so the round leaves the sling.
  setTimeout(() => {
    const from = slingTip();
    const shot = document.createElement('div');
    shot.className = 'siege-shot';
    shot.innerHTML = '<i></i>';
    shot.style.left = `${from.x}px`;
    shot.style.top = `${from.y}px`;
    const dx = mx - from.x, dy = my - from.y;
    shot.style.setProperty('--dx', `${Math.round(dx)}px`);
    shot.firstChild.style.setProperty('--dy', `${Math.round(dy)}px`);
    shot.firstChild.style.setProperty('--rise', `${Math.round(arcRise(dx, dy))}px`);
    document.body.appendChild(shot);
    trailFrom(shot.firstChild, SHOT_MS);
    setTimeout(() => shot.remove(), SHOT_MS);

    setTimeout(() => bloomAt(mx, my), SHOT_MS);
  }, SWING_MS);
}

function sparkFromButton() {
  const r = runBtn.getBoundingClientRect();
  if (r.width === 0) return;
  for (let i = 0; i < 14; i++) {
    const spark = document.createElement('div');
    spark.className = 'btn-spark';
    spark.style.left = `${r.left + Math.random() * r.width}px`;
    spark.style.top = `${r.top + Math.random() * r.height}px`;
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
    const distance = 30 + Math.random() * 70;
    spark.style.setProperty('--sx', `${Math.round(Math.cos(angle) * distance)}px`);
    spark.style.setProperty('--sy', `${Math.round(Math.sin(angle) * distance)}px`);
    spark.style.animationDelay = `${(Math.random() * 0.12).toFixed(2)}s`;
    document.body.appendChild(spark);
    setTimeout(() => spark.remove(), 900);
  }
}

// The finale: the crest appears, a heavy round gathers, is lobbed into the crest,
// the crest splits. The wind-up is not on the click: a round launched then would
// hang waiting for the API.
const CHARGE_FORM_MS = 460;   // the round taking shape, mirrored in impact.css
const CHARGE_SWELL_MS = 6000; // and then gathering, ditto
const FLIGHT_MS = 560;        // sling to crest, ditto

let chargeBall = null;
let chargeStartedAt = 0;
let stopFollowing = null;

// html.finale: the cards' backdrop blur is off from the round's wind-up to FINALE_TAIL_MS after the break
// (css/controls.css). Off is always reached: finish() in run.js plays the finale on every outcome.
const FINALE_TAIL_MS = 1700;
let finaleTimer = 0;
function finaleOn() {
  clearTimeout(finaleTimer);
  document.documentElement.classList.add('finale');
}
function finaleOff() {
  clearTimeout(finaleTimer);
  finaleTimer = setTimeout(() => document.documentElement.classList.remove('finale'), FINALE_TAIL_MS);
}

// The crest's glow, painted once into the overlay's canvases (index.html, css/impact.css):
// the glow a CSS drop-shadow gives, same blur and colour, as a picture the compositor only
// moves. The shield's outline and the crack's lines are read off the overlay's own SVG.
const CREST_GLOW_PAD = 64;
const CREST_GLOW_BOX = 200 + 2 * CREST_GLOW_PAD;
// Mirrors the halves' clip-path polygons in css/impact.css, in % of the 200px stack.
const CREST_CUTS = {
  l: [[50, 0], [46, 18], [54, 33], [45, 48], [52, 64], [46, 80], [50, 100], [0, 100], [0, 0]],
  r: [[50, 0], [100, 0], [100, 100], [50, 100], [46, 80], [52, 64], [45, 48], [54, 33], [46, 18]],
};
// The 160x190 artwork at 150px wide, centred in the 200px stack.
const CREST_K = 150 / 160;
const CREST_TOP = 100 - (190 * CREST_K) / 2;

function glowCanvas(cv, r) {
  cv.width = cv.height = Math.round(CREST_GLOW_BOX * r);
  const ctx = cv.getContext('2d');
  ctx.scale(r, r);
  return ctx;
}
// Only the shadow of src: the picture is drawn far off the canvas and its shadow offset
// back, so what lands is the blur alone, like a drop-shadow behind its element.
function shadowOnly(ctx, src, color, blur, r) {
  const far = 4000;
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = blur * r;
  ctx.shadowOffsetX = far * r;
  ctx.drawImage(src, -far, 0, CREST_GLOW_BOX, CREST_GLOW_BOX);
  ctx.restore();
}
function toArtwork(ctx) {
  ctx.translate(CREST_GLOW_PAD + 25, CREST_GLOW_PAD + CREST_TOP);
  ctx.scale(CREST_K, CREST_K);
}
function drawShield(ctx, cut) {
  const outline = impactOverlay.querySelector('.impact-crest > path');
  ctx.save();
  if (cut) {
    ctx.beginPath();
    for (const [x, y] of cut) ctx.lineTo(CREST_GLOW_PAD + x * 2, CREST_GLOW_PAD + y * 2);
    ctx.closePath();
    ctx.clip();
  }
  toArtwork(ctx);
  const path = new Path2D(outline.getAttribute('d'));
  ctx.fillStyle = ctx.strokeStyle = '#000';
  ctx.lineWidth = Number(outline.getAttribute('stroke-width'));
  ctx.fill(path);
  ctx.stroke(path);
  ctx.restore();
}
function shieldGlow(sel, cut) {
  return (r) => {
    const scratch = document.createElement('canvas');
    drawShield(glowCanvas(scratch, r), cut);
    shadowOnly(glowCanvas(impactOverlay.querySelector(sel), r), scratch, 'rgba(140,224,255,.9)', 26, r);
  };
}
// Two shadows in a chain: the second one shadows the first and the lines. One step each.
let crackFirst = null;
function crackInner(r) {
  const scratch = document.createElement('canvas');
  const lines = glowCanvas(scratch, r);
  toArtwork(lines);
  lines.strokeStyle = '#fff';
  lines.lineCap = lines.lineJoin = 'round';
  for (const p of impactOverlay.querySelectorAll('.crest-crack path')) {
    lines.lineWidth = Number(p.getAttribute('stroke-width'));
    lines.stroke(new Path2D(p.getAttribute('d')));
  }
  crackFirst = document.createElement('canvas');
  const first = glowCanvas(crackFirst, r);
  shadowOnly(first, scratch, 'rgba(214,248,255,.95)', 10, r);
  first.setTransform(1, 0, 0, 1, 0, 0);
  first.drawImage(scratch, 0, 0);
}
function crackOuter(r) {
  const out = glowCanvas(impactOverlay.querySelector('.crest-fracture .crest-glow'), r);
  shadowOnly(out, crackFirst, 'rgba(127,214,242,.8)', 24, r);
  out.setTransform(1, 0, 0, 1, 0, 0);
  out.drawImage(crackFirst, 0, 0);
  crackFirst = null;
}
// Painted one step per idle callback after the page has loaded, so neither the load nor
// a click pays for it; startCharge() paints whatever is still missing. Shadows are drawn
// in device pixels, so the canvases carry the screen's scale (up to 2).
const crestGlowSteps = [
  shieldGlow('.crest-glow--whole', null),
  shieldGlow('.crest-side--l .crest-glow', CREST_CUTS.l),
  shieldGlow('.crest-side--r .crest-glow', CREST_CUTS.r),
  crackInner,
  crackOuter,
];
let crestGlowScale = 0;
function paintCrestGlow() {
  const step = crestGlowSteps.shift();
  if (!step) return false;
  crestGlowScale = crestGlowScale || Math.min(2, window.devicePixelRatio || 1);
  step(crestGlowScale);
  return true;
}
const whenIdle = (cb) => (window.requestIdleCallback ? requestIdleCallback(cb, { timeout: 300 }) : setTimeout(cb, 50));
function paintCrestGlowIdle() {
  if (paintCrestGlow()) whenIdle(paintCrestGlowIdle);
}
window.addEventListener('load', () => whenIdle(paintCrestGlowIdle), { once: true });

// Called on the click: the round gathers for as long as the API takes.
function startCharge() {
  while (paintCrestGlow());
  finaleOn();
  const ball = document.createElement('div');
  ball.className = 'siege-charge charging';
  ball.innerHTML = '<i><b></b></i>';
  document.body.appendChild(ball);
  chargeBall = ball;
  chargeStartedAt = performance.now();
  cockTrebuchet();
  stopFollowing = followSling(ball);
}

// Held back only if the answer beat the wind-up. The round is taken off the globals
// now: a Check pressed while the launch waits starts a new one that must not be launched in its place.
function playFinale() {
  const waited = performance.now() - chargeStartedAt;
  const ball = chargeBall;
  const startedAt = chargeStartedAt;
  const follower = stopFollowing;
  chargeBall = null;
  stopFollowing = null;
  setTimeout(() => launchCharge(ball, startedAt, follower), Math.max(0, CHARGE_FORM_MS - waited));
}

function launchCharge(ball, startedAt, letGo) {
  finaleOn();
  // Computed on the CSS swell's linear ramp, not read off the element: a running
  // animation's matrix is a frame behind.
  const swelled = performance.now() - startedAt - CHARGE_FORM_MS;
  const t = Math.min(1, Math.max(0, swelled / CHARGE_SWELL_MS));
  const grown = 1 + t * 1.4;
  ball.style.setProperty('--grow', grown.toFixed(3));

  fireTrebuchet();

  setTimeout(() => {
    letGo();
    const from = slingTip();
    ball.style.left = `${from.x}px`;
    ball.style.top = `${from.y}px`;

    impactOverlay.classList.remove('play', 'broken');
    pageEl.classList.remove('struck');
    void impactOverlay.offsetWidth;
    impactOverlay.classList.add('play');

    const arc = ball.querySelector('i');
    ball.classList.remove('charging');
    ball.classList.add('flying');
    const dx = window.innerWidth / 2 - from.x;
    const dy = window.innerHeight / 2 - from.y;
    ball.style.setProperty('--dx', `${Math.round(dx)}px`);
    arc.style.setProperty('--dy', `${Math.round(dy)}px`);
    arc.style.setProperty('--rise', `${Math.round(arcRise(dx, dy))}px`);
    trailFrom(arc, FLIGHT_MS, true, grown);

    setTimeout(() => {
      ball.remove();
      breakCrest();
    }, FLIGHT_MS);
  }, SWING_MS);
}

function breakCrest() {
  impactOverlay.classList.add('broken');
  // No bloomAt: a clean disc of light makes the impact look circular.
  spawnBlast();
  spawnImpactShards();
  spawnEmberBlast();

  pageEl.classList.remove('struck');
  void pageEl.offsetWidth;
  pageEl.classList.add('struck');
  setTimeout(() => pageEl.classList.remove('struck'), 600);

  setTimeout(() => impactOverlay.classList.remove('play', 'broken'), 1200);
  finaleOff();
}

function spawnEmberBlast() {
  const host = document.getElementById('fxEmbers');
  if (!host) return;

  host.classList.remove('surge');
  void host.offsetWidth;
  host.classList.add('surge');
  setTimeout(() => host.classList.remove('surge'), 2900);

  emberField.blast();
}

function spawnBlast() {
  const host = impactOverlay.querySelector('.crest-blast').parentNode;
  for (const old of host.querySelectorAll('.blast-lobe, .blast-ray')) old.remove();

  const LOBES = 7;
  for (let i = 0; i < LOBES; i++) {
    const lobe = document.createElement('div');
    lobe.className = 'blast-lobe';
    const size = Math.round(74 + Math.random() * 96);
    lobe.style.width = lobe.style.height = `${size}px`;
    lobe.style.margin = `${-size / 2}px 0 0 ${-size / 2}px`;
    const angle = (i / LOBES) * Math.PI * 2 + Math.random() * 0.8;
    const distance = 26 + Math.random() * 86;
    lobe.style.setProperty('--bx', `${Math.round(Math.cos(angle) * distance)}px`);
    lobe.style.setProperty('--by', `${Math.round(Math.sin(angle) * distance)}px`);
    lobe.style.animationDelay = `${(Math.random() * 0.07).toFixed(2)}s`;
    host.appendChild(lobe);
  }

  const RAYS = 12;
  for (let i = 0; i < RAYS; i++) {
    const ray = document.createElement('div');
    ray.className = 'blast-ray';
    const angle = (i / RAYS) * 360 + Math.random() * 22;
    ray.style.width = `${Math.round(120 + Math.random() * 190)}px`;
    ray.style.setProperty('--a', `${angle.toFixed(1)}deg`);
    ray.style.animationDelay = `${(Math.random() * 0.06).toFixed(2)}s`;
    host.appendChild(ray);
  }
}

function spawnImpactShards() {
  for (const old of impactOverlay.querySelectorAll('.impact-shard')) old.remove();

  const COUNT = 22;
  for (let i = 0; i < COUNT; i++) {
    const shard = document.createElement('div');
    shard.className = i % 3 === 0 ? 'impact-shard impact-shard--cold' : 'impact-shard';
    const angle = (i / COUNT) * Math.PI * 2 + Math.random() * 0.4;
    const distance = 120 + Math.random() * 180;
    shard.style.setProperty('--sx', `${Math.round(Math.cos(angle) * distance)}px`);
    shard.style.setProperty('--sy', `${Math.round(Math.sin(angle) * distance)}px`);
    shard.style.animationDelay = `${(Math.random() * 0.1).toFixed(2)}s`;
    impactOverlay.appendChild(shard);
  }
}

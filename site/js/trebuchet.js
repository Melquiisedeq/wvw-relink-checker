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
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
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
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
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

// Called on the click: the round gathers for as long as the API takes.
function startCharge() {
  cancelCharge();
  const ball = document.createElement('div');
  ball.className = 'siege-charge charging';
  ball.innerHTML = '<i><b></b></i>';
  document.body.appendChild(ball);
  chargeBall = ball;
  chargeStartedAt = performance.now();
  cockTrebuchet();
  stopFollowing = followSling(ball);
}

function cancelCharge() {
  if (stopFollowing) { stopFollowing(); stopFollowing = null; }
  if (chargeBall) chargeBall.remove();
  chargeBall = null;
}

// Held back only if the answer beat the wind-up.
function playFinale() {
  const waited = performance.now() - chargeStartedAt;
  setTimeout(launchCharge, Math.max(0, CHARGE_FORM_MS - waited));
}

function launchCharge() {
  const ball = chargeBall;
  chargeBall = null;

  if (!ball) {
    impactOverlay.classList.remove('play', 'broken');
    void impactOverlay.offsetWidth;
    impactOverlay.classList.add('play');
    breakCrest();
    return;
  }

  // Computed on the CSS swell's linear ramp, not read off the element: a running
  // animation's matrix is a frame behind.
  const swelled = performance.now() - chargeStartedAt - CHARGE_FORM_MS;
  const t = Math.min(1, Math.max(0, swelled / CHARGE_SWELL_MS));
  const grown = 1 + t * 1.4;
  ball.style.setProperty('--grow', grown.toFixed(3));

  fireTrebuchet();

  setTimeout(() => {
    if (stopFollowing) { stopFollowing(); stopFollowing = null; }
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

'use strict';
// ---------------------------------------------------------------------
// The siege engine
// The trebuchet in the corner, the round it throws, and everything
// that burns, sparks or shatters. Pure decoration.
//
// Measured off the two cutouts rather than guessed: the frame's pivot
// boss sits at (67,10) in its image, the beam's axle at (200,37) in its
// own, and the sling head is 178px along the beam from that axle.
// Everything else is those three numbers plus trigonometry - see
// slingTip(), which reads the launch point off the sling itself so the
// beam and the fireball cannot drift apart.
// ---------------------------------------------------------------------
const trebuchet = document.getElementById('trebuchet');
const trebArm = document.getElementById('trebArm');

// Beam angles. Negative puts the throwing head down and behind with the
// counterweight raised, which is a trebuchet waiting to fire; +128 is
// the end of the throw, beam over the top and pointing up-range.
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

// Where the sling is right now, in screen coordinates. Measured off the
// marker rather than recomputed, so the traverse of the frame and the
// rotation of the beam are both already in it. Falls back to the old
// fixed corner when the machine is hidden, which it is on any window
// too narrow to have room for it.
function slingTip() {
  const r = trebSling.getBoundingClientRect();
  const box = trebuchet.getBoundingClientRect();
  if (!box.width) {
    return { x: 46, y: window.innerHeight - 46 };
  }
  return { x: r.left, y: r.top };
}

// Pins an element to the sling until cancelled, so a round riding the
// beam goes round with it instead of waiting at the launch point.
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

// Aim: the frame traverses towards the pointer and the beam takes the
// elevation, which is how the machine actually points.
let aimQueued = false, aimX = 0, aimY = 0;

function applyAim() {
  aimQueued = false;
  if (trebuchet.classList.contains('firing')) return;
  const w = window.innerWidth || 1, h = window.innerHeight || 1;
  const fx = Math.min(1, Math.max(0, aimX / w));
  const fy = Math.min(1, Math.max(0, aimY / h));
  trebuchet.style.setProperty('--yaw', `${(fx * 7 - 2).toFixed(1)}deg`);
  // Higher in the window means more elevation, so the beam hauls back
  // further. A shallow range: past a point it stops reading as aiming.
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

// Hauling back while a check runs, on the same clock as the round
// gathering in the sling.
function cockTrebuchet() {
  clearTimeout(trebResetTimer);
  trebuchet.classList.remove('firing', 'resetting');
  trebuchet.classList.add('cocking');
  setArm(ARM_COCKED);
}

const SHOT_MS = 340;   // mirrored in click.css

// How high the round arcs over the straight line to its target. Scaled
// to the distance, so a flick across the corner is a short toss and a
// shot across the window is a lob, and clamped at both ends so neither
// extreme turns silly.
function arcRise(dx, dy) {
  return Math.min(280, Math.max(60, Math.hypot(dx, dy) * 0.28));
}

// Lays the flame down along the path the round actually travels: one
// segment per frame, from the previous position to the current one.
// Position is measured off the live element rather than recomputed from
// the curve, so the trail can never drift away from its own head.
function trailFrom(ball, untilMs, big, power) {
  // How heavily it burns. The finale passes the size the round actually
  // charged to, so a long wait does not just throw a bigger stone - it
  // throws one that smokes and sheds in proportion.
  const heat = Math.max(1, power || 1);
  const size = big ? ' flame-seg--big' : '';
  // Roughly half the flight, so the tail trails the round instead of
  // recording the whole path behind it.
  const life = big ? 360 : 280;
  const head = document.createElement('div');
  head.className = `flame-head${big ? ' flame-head--big' : ''}`;
  document.body.appendChild(head);

  const stop = performance.now() + untilMs;
  let px = null, py = null, lastShed = 0;

  const step = (now) => {
    if (now > stop || !ball.isConnected) {
      // The head goes out, but the segments already on the page live out
      // their own animations - which is what leaves the trail hanging in
      // the air for a moment after the round is gone.
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
        // Overlapped a little past the gap, or the segments show their
        // seams on the frames where the round moves fastest.
        const len = speed + (big ? 10 : 6);
        layFlame(px, py, angle, len, `flame-seg${size}`, life);
        layFlame(px, py, angle, len, `flame-seg flame-seg--hot${size}`, life);

        // Shed roughly every other frame at rest, closer to every frame
        // for a heavy round. One puff per frame is wasteful for a small
        // one and too sparse for a large one, so the gap scales too.
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

// Dropped at the round's position and then left alone: it drifts up and
// out while the round carries on, which is what puts distance between
// the flame and its own smoke.
function shedSmoke(x, y, heat) {
  const puff = document.createElement('div');
  puff.className = 'trail-smoke';
  const size = Math.round(15 * (heat || 1));
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
  const distance = (14 + Math.random() * 40) * (heat || 1);
  spark.style.setProperty('--sx', `${Math.round(Math.cos(angle) * distance)}px`);
  spark.style.setProperty('--sy', `${Math.round(Math.sin(angle) * distance)}px`);
  spark.style.animationDelay = `${(Math.random() * 0.08).toFixed(2)}s`;
  document.body.appendChild(spark);
  setTimeout(() => spark.remove(), 760);
}

// The small version of the shield blast: same three parts, a size down
// and a beat quicker, because this one has to be over before it starts
// competing with whatever was actually clicked.
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

document.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') return;
  // Check gets no round thrown at it. It is about to launch one of its
  // own at the crest, and two rounds crossing over the same button in
  // opposite directions reads as a mistake rather than an effect.
  if (e.target.closest && e.target.closest('#runBtn')) return;
  // Nothing gets thrown while a popover is up. Reading a guild list or
  // panning a map is work, and work should not have artillery going off
  // over the top of it - and a click inside the popover would launch
  // from behind it anyway.
  if (activeTrigger) return;

  fireTrebuchet();
  const mx = e.clientX, my = e.clientY;

  // Thrown when the beam gets over the top, not on the click, so the
  // round leaves the sling instead of appearing beside it. The delay is
  // the swing and nothing more - short enough that the click still
  // reads as instant.
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

    // Lands on impact, not on the throw, so the whole thing reads as one
    // event: the round arrives, it goes off, the ground is marked.
    setTimeout(() => bloomAt(mx, my), SHOT_MS);
  }, SWING_MS);
}, { passive: true });

// Sparks off the Check button the moment a run starts. Immediate, small,
// and over before the first request comes back - this is the receipt for
// the click, not the payoff for the result.
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

// The finale, in four beats: the crest appears, a heavy round gathers in
// the corner, it is lobbed into the crest, and the crest splits. The
// wind-up has to happen here and not on the click, because a check takes
// an unknown amount of time - a round launched on the click would hang
// in the air waiting for the API.
const CHARGE_FORM_MS = 460;   // the round taking shape, mirrored in impact.css
const CHARGE_SWELL_MS = 6000; // and then gathering, ditto
const FLIGHT_MS = 560;        // sling to crest, ditto

let chargeBall = null;
let chargeStartedAt = 0;
let stopFollowing = null;

// Called on the click, not on the answer. The round gathers for exactly
// as long as the API takes, so the wait reads as the machine loading
// rather than as the page doing nothing.
function startCharge() {
  cancelCharge();
  const ball = document.createElement('div');
  ball.className = 'siege-charge charging';
  ball.innerHTML = '<i><b></b></i>';
  document.body.appendChild(ball);
  chargeBall = ball;
  chargeStartedAt = performance.now();
  cockTrebuchet();
  // It loads in the sling and rides the beam from there - including all
  // the way round on the throw.
  stopFollowing = followSling(ball);
}

function cancelCharge() {
  if (stopFollowing) { stopFollowing(); stopFollowing = null; }
  if (chargeBall) chargeBall.remove();
  chargeBall = null;
}

// Held back only if the answer beat the wind-up; a cached run would
// otherwise fire a round that had not finished forming.
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

  // How big the round got, on the same linear ramp the CSS swell uses.
  // Computed rather than read back off the element: reading a running
  // animation's matrix put the flight one frame behind the wind-up and
  // the round visibly dropped a size at the moment it was thrown.
  const swelled = performance.now() - chargeStartedAt - CHARGE_FORM_MS;
  const t = Math.min(1, Math.max(0, swelled / CHARGE_SWELL_MS));
  const grown = 1 + t * 1.4;
  ball.style.setProperty('--grow', grown.toFixed(3));

  fireTrebuchet();

  // Let go at the top of the swing. Until then the round is still in the
  // sling and being carried round by followSling, which is the whole
  // reason the throw reads as a throw.
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
  // No bloomAt here any more: a clean disc of light on top of the blast
  // was most of what made the impact look circular. The mouse click
  // keeps it, because there it IS just a light.
  spawnBlast();
  spawnImpactShards();
  spawnEmberBlast();

  pageEl.classList.remove('struck');
  void pageEl.offsetWidth;
  pageEl.classList.add('struck');
  setTimeout(() => pageEl.classList.remove('struck'), 600);

  setTimeout(() => impactOverlay.classList.remove('play', 'broken'), 1200);
}

// The impact reaching the background: the standing ember field lifts
// and flares, and a handful of new ones are thrown up from the bottom
// edge and burn out on the way.
function spawnEmberBlast() {
  const host = document.getElementById('fxEmbers');
  if (!host) return;

  host.classList.remove('surge');
  void host.offsetWidth;
  host.classList.add('surge');
  setTimeout(() => host.classList.remove('surge'), 2900);

  for (let i = 0; i < 12; i++) {
    const ember = document.createElement('span');
    ember.className = i % 3 === 0 ? 'ember ember--cold ember--blast' : 'ember ember--blast';
    ember.style.left = `${Math.random() * 100}%`;
    ember.style.animationDelay = `${(Math.random() * 0.25).toFixed(2)}s`;
    ember.style.setProperty('--drift', `${Math.round(Math.random() * 160 - 80)}px`);
    host.appendChild(ember);
    setTimeout(() => ember.remove(), 2400);
  }
}

// The irregular half of the explosion, rebuilt every time so the shape
// is never the same twice.
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
    // Evenly spread heading plus a wobble, so they cover the circle
    // without ever landing on a tidy rosette.
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

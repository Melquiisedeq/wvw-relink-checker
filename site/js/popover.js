'use strict';
// Popover system: one popover at a time, near its trigger, closed on Escape, outside click and scroll.

let activePopover = null;
let activeTrigger = null;
let activeBackdrop = null;
// The page's other top-level nodes, made inert while the backdrop stands (the popover and the backdrop live in <body> beside them).
let inertBehind = [];
// Used by maps.js, declared here because closePopover runs on Escape and on
// a resize before maps.js has loaded.
let mapPollTimer = null;
// Set while a tier's maps are open: pulls at once if the last pull is a poll interval
// old, so a hidden tab does not come back showing a stale map.
let mapCatchUp = null;
// Set while a tier's maps are open: reads the map's match at once if /api/latest
// (js/standings.js, peekLatest) or a late copy (js/api.js, offerLate) shows its id further along.
let mapAhead = null;
// Separate from the poll: repaints only what ages by the second (the tick in js/maps.js).
let mapTickTimer = null;

function closePopover(byClick = false) {
  const trigger = activeTrigger;
  // Checked before the node is removed: removal moves focus to <body>. Focus
  // already on <body> (a pick that rebuilt what held it) counts as inside,
  // except after a click on an empty part of a page the popover did not hold:
  // the click put it there.
  const bodyIsInside = !byClick || !!activeBackdrop;
  const hadFocusInside = !!activePopover && (activePopover.contains(document.activeElement) || (bodyIsInside && document.activeElement === document.body));

  // Before focus goes back: an inert trigger cannot take it.
  releasePage();
  if (activePopover) activePopover.remove();
  if (activeBackdrop) activeBackdrop.remove();
  if (trigger) {
    trigger.classList.remove('active');
    trigger.setAttribute('aria-expanded', 'false');
    if (hadFocusInside) trigger.focus({ preventScroll: true });
  }
  activePopover = null;
  activeTrigger = null;
  activeBackdrop = null;
  clearInterval(mapPollTimer);
  mapPollTimer = null;
  clearInterval(mapTickTimer);
  mapTickTimer = null;
  mapCatchUp = null;
  mapAhead = null;
  // Deferred: opening another popover right after must not find a load under it.
  if (trigger) setTimeout(() => { if (!activeTrigger && !readOwed()) peekSoon(); }, 0);
}

function holdPage(popover) {
  popover.setAttribute('aria-modal', 'true');
  inertBehind = [...document.body.children].filter(el => el !== popover && el !== activeBackdrop && !el.inert);
  for (const el of inertBehind) el.inert = true;
}

function releasePage() {
  for (const el of inertBehind) el.inert = false;
  inertBehind = [];
  if (activePopover) activePopover.removeAttribute('aria-modal');
}

// Gives every popover a role, a reachable focus target and a way back to the trigger.
// `render` receives the empty element; returns null when the call only toggled an open popover shut.
function openPopover(triggerEl, label, render, extraClass) {
  if (activeTrigger === triggerEl) { closePopover(); return null; }
  closePopover();

  activeTrigger = triggerEl;
  triggerEl.classList.add('active');
  triggerEl.setAttribute('aria-expanded', 'true');

  const popover = document.createElement('div');
  popover.className = `info-popover ${extraClass}`;
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', label);
  popover.tabIndex = -1;
  document.body.appendChild(popover);
  activePopover = popover;

  render(popover);
  positionPopover(popover, triggerEl);
  popover.focus({ preventScroll: true });
  return popover;
}

function markPopoverTrigger(btn) {
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.setAttribute('aria-expanded', 'false');
}

// Toggles the guild-list popover between anchored and a centered "expanded" modal
// with its own backdrop (screenshots).
function setPopoverExpanded(popover, triggerEl, expand) {
  popover.classList.toggle('info-popover--expanded', expand);
  const expandBtn = popover.querySelector('.info-popover-expand');
  if (expandBtn) {
    expandBtn.innerHTML = expand ? EXPAND_ICON_COLLAPSE : EXPAND_ICON_EXPAND;
    expandBtn.setAttribute('aria-label', expand ? 'Shrink back to normal size' : 'Expand for a full-list screenshot');
    expandBtn.title = expandBtn.getAttribute('aria-label');
  }
  if (expand) {
    if (!activeBackdrop) {
      const backdrop = document.createElement('div');
      backdrop.className = 'info-popover-backdrop';
      document.body.insertBefore(backdrop, popover);
      activeBackdrop = backdrop;
      holdPage(popover);
    }
  } else {
    if (activeBackdrop) { releasePage(); activeBackdrop.remove(); activeBackdrop = null; }
    positionPopover(popover, triggerEl);
  }

  const grid = popover.querySelector('.alliance-grid');
  if (grid && popover.__allianceData) layoutAllianceGrid(grid, popover.__allianceData, expand);
}

// A press that starts inside and is released outside (selecting a guild name) lands its
// click on the common ancestor, outside the popover: it must not close it.
let pressStartedInside = false;
document.addEventListener('pointerdown', (e) => {
  pressStartedInside = !!activePopover && activePopover.contains(e.target);
}, true);
// Read and cleared in capture: a button inside that stops propagation never lets the
// click reach the bubbling listener, and a stale flag would swallow a keyboard click.
let clickFromInside = false;
document.addEventListener('click', () => {
  clickFromInside = pressStartedInside;
  pressStartedInside = false;
}, true);
document.addEventListener('click', (e) => {
  if (clickFromInside) return;
  if (activePopover && !activePopover.contains(e.target) && e.target !== activeTrigger) {
    closePopover(true);
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePopover();
});

function getViewportSize() {
  if (window.visualViewport) {
    return { width: window.visualViewport.width, height: window.visualViewport.height };
  }
  return { width: window.innerWidth, height: window.innerHeight };
}

function positionPopover(popover, triggerEl) {
  const rect = triggerEl.getBoundingClientRect();
  const { width: vw, height: vh } = getViewportSize();
  const maxLeft = vw - popover.offsetWidth - 12;
  const left = Math.max(12, Math.min(rect.left, maxLeft));
  const spaceBelow = vh - rect.bottom;
  const fitsBelow = spaceBelow >= popover.offsetHeight + 12;
  const top = fitsBelow ? rect.bottom + 6 : rect.top - popover.offsetHeight - 6;
  popover.style.left = `${left}px`;
  popover.style.top = `${Math.max(12, Math.min(top, vh - popover.offsetHeight - 12))}px`;
}

function closeUnlessExpanded() {
  if (activePopover && activePopover.classList.contains('info-popover--expanded')) {
    const grid = activePopover.querySelector('.alliance-grid');
    if (grid && activePopover.__allianceData) {
      layoutAllianceGrid(grid, activePopover.__allianceData, true);
    }
    return;
  }
  closePopover();
}
// Page scroll never reaches visualViewport's scroll event, so this follows it. Not
// wired to closeUnlessExpanded: that re-runs layoutAllianceGrid, reshuffling the
// alliance columns on every scroll tick.
function repositionOnScroll() {
  if (!activePopover || !activeTrigger) return;
  if (activePopover.classList.contains('info-popover--expanded')) return; // centred, follows nothing

  const rect = activeTrigger.getBoundingClientRect();
  const { height: vh } = getViewportSize();
  // Anchor scrolled out of sight: clamping would strand the popover against an edge.
  if (rect.bottom < 0 || rect.top > vh) { closePopover(); return; }
  positionPopover(activePopover, activeTrigger);
}

// visualViewport resize also fires for things that are not real resizes; only a
// genuine size change may close a popover being read.
let lastViewportSize = getViewportSize();
let lastViewportScale = window.visualViewport ? window.visualViewport.scale : 1;
let lastInnerSize = { width: window.innerWidth, height: window.innerHeight };
function onViewportResize() {
  const size = getViewportSize();
  const scale = window.visualViewport ? window.visualViewport.scale : 1;
  const inner = { width: window.innerWidth, height: window.innerHeight };
  // A pinch rescales visualViewport but not the layout viewport (innerWidth/Height).
  const zoomed = scale !== lastViewportScale &&
                 Math.abs(inner.width - lastInnerSize.width) <= 2 &&
                 Math.abs(inner.height - lastInnerSize.height) <= 2;
  lastViewportScale = scale;
  lastInnerSize = inner;
  const changed = !zoomed && (Math.abs(size.width - lastViewportSize.width) > 2 ||
                              Math.abs(size.height - lastViewportSize.height) > 2);
  lastViewportSize = size;
  if (changed) closeUnlessExpanded();
}

window.addEventListener('scroll', repositionOnScroll, { passive: true });
window.addEventListener('resize', onViewportResize);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', onViewportResize);
  window.visualViewport.addEventListener('scroll', repositionOnScroll);
}


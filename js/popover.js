'use strict';
// ---------------------------------------------------------------------
// Popover system
// One popover at a time, positioned near its trigger, closed on Escape,
// on outside click and on scroll. Shared by every popover on the page.
// ---------------------------------------------------------------------

// outside click or Escape.
let activePopover = null;
let activeTrigger = null;
let activeBackdrop = null;

function closePopover() {
  const trigger = activeTrigger;
  // Checked before the node is removed, since removing it moves focus to
  // <body> and the answer would always be "no" afterwards.
  const hadFocusInside = !!activePopover && activePopover.contains(document.activeElement);

  if (activePopover) activePopover.remove();
  if (activeBackdrop) activeBackdrop.remove();
  if (trigger) {
    trigger.classList.remove('active');
    trigger.setAttribute('aria-expanded', 'false');
    // Only reclaim focus if it was actually inside what just closed.
    // Closing by clicking somewhere else must not yank the caret back.
    if (hadFocusInside) trigger.focus({ preventScroll: true });
  }
  activePopover = null;
  activeTrigger = null;
  activeBackdrop = null;
  clearInterval(mapPollTimer);
  mapPollTimer = null;
}

// Every icon opened its popover with the same twelve lines of bookkeeping,
// and all four skipped the parts keyboard users need: a role, a reachable
// focus target, and a way back to the trigger. One place to get it right.
// `render` receives the empty popover element. Returns null when the call
// merely toggled an already-open popover shut.
function openPopover(triggerEl, label, render, extraClass) {
  if (activeTrigger === triggerEl) { closePopover(); return null; }
  closePopover();

  activeTrigger = triggerEl;
  triggerEl.classList.add('active');
  triggerEl.setAttribute('aria-expanded', 'true');

  const popover = document.createElement('div');
  popover.className = extraClass ? `info-popover ${extraClass}` : 'info-popover';
  popover.setAttribute('role', 'dialog');
  if (label) popover.setAttribute('aria-label', label);
  popover.tabIndex = -1;
  document.body.appendChild(popover);
  activePopover = popover;

  render(popover);
  positionPopover(popover, triggerEl);
  popover.focus({ preventScroll: true });
  return popover;
}

// Marks a button as opening a popover, so assistive tech announces it as a
// disclosure rather than a plain button.
function markPopoverTrigger(btn) {
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.setAttribute('aria-expanded', 'false');
}

// Toggles the guild-list popover between its anchored form and a
// centered "expanded" modal for screenshots. Expanded mode gets its own
// backdrop and stops following the trigger element.
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
    }
  } else {
    if (activeBackdrop) { activeBackdrop.remove(); activeBackdrop = null; }
    positionPopover(popover, triggerEl);
  }

  const grid = popover.querySelector('.alliance-grid');
  if (grid && popover.__allianceData) layoutAllianceGrid(grid, popover.__allianceData, expand);
}

document.addEventListener('click', (e) => {
  if (activePopover && !activePopover.contains(e.target) && e.target !== activeTrigger) {
    closePopover();
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
// Page scroll never reaches visualViewport's scroll event, so an anchored
// popover used to sit frozen on screen while the icon it belongs to
// scrolled out from under it.
//
// Deliberately NOT wired to closeUnlessExpanded: that function re-runs
// layoutAllianceGrid, which would reshuffle the alliance columns on every
// scroll tick and wreck the expanded screenshot view. Scrolling changes no
// widths, so there is genuinely no layout to recompute here - only a
// position to follow.
function repositionOnScroll() {
  if (!activePopover || !activeTrigger) return;
  if (activePopover.classList.contains('info-popover--expanded')) return; // centred, follows nothing

  const rect = activeTrigger.getBoundingClientRect();
  const { height: vh } = getViewportSize();
  // Anchor scrolled out of sight: there is nothing left to point at, and
  // clamping would leave the popover stranded against an edge.
  if (rect.bottom < 0 || rect.top > vh) { closePopover(); return; }
  positionPopover(activePopover, activeTrigger);
}

// visualViewport fires "resize" for plenty of things that are not really
// resizes - a scrollbar appearing as content loads, a mobile URL bar
// sliding, a pinch settling. Acting on those snaps a popover shut while
// it is still being read, so this only reacts to a genuine size change.
let lastViewportSize = getViewportSize();
function onViewportResize() {
  const size = getViewportSize();
  const changed = Math.abs(size.width - lastViewportSize.width) > 2 ||
                  Math.abs(size.height - lastViewportSize.height) > 2;
  lastViewportSize = size;
  if (changed) closeUnlessExpanded();
}

window.addEventListener('scroll', repositionOnScroll, { passive: true });
window.addEventListener('resize', onViewportResize);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', onViewportResize);
  window.visualViewport.addEventListener('scroll', repositionOnScroll);
}


'use strict';
// LAB (never merged). Design B, "Buttons in view": every button the board already has is
// given a body and a word. The site's own buttons stay the click targets (each chip's
// button covers the chip), so the site keeps opening, placing and closing its popovers.
// The board repaints live: patchStandingSide writes into the same nodes, so a wrapped
// card keeps its chips; a rebuilt card arrives bare and is wrapped again here.

const LAB_B_FULL_Q = window.matchMedia('(max-width: 599px)');
const LAB_B_ARROW = ['M9 6l6 6l-6 6'];

// "Skirmish 1.5k": the label and the value it names move into one chip. The value keeps
// its number as its first text node and its button after it (setLeadText relies on both).
function labBChips(stats) {
  if (stats.querySelector(':scope > .lab-b-chip')) return;
  for (const label of [...stats.querySelectorAll(':scope > .stat-label')]) {
    const value = label.nextElementSibling;
    if (!value || !value.classList.contains('stat-value')) continue;
    const btn = value.querySelector('button');
    const chip = labEl('span', 'lab-b-chip');
    label.before(chip);
    chip.append(label, value);
    if (btn) {
      chip.classList.add('lab-b-chip-opens');
      btn.appendChild(labIcon(LAB_B_ARROW, 12)).classList.add('lab-b-arrow');
    }
  }
}

function labBGuilds(btn) {
  if (btn.querySelector('.lab-b-guilds-label')) return;
  btn.appendChild(labEl('span', 'lab-b-guilds-label', 'Guilds'));
}

function labBTierTitle(title) {
  if (title.querySelector('.lab-b-stats')) return;
  const stats = labEl('button', 'lab-b-stats');
  stats.type = 'button';
  stats.disabled = true;
  stats.title = 'Tier stats arrive in a later step';
  stats.append(labEl('span', 'lab-b-stats-label', 'Stats'), labEl('span', 'lab-b-soon', 'E4'));
  const maps = title.querySelector('.tier-map-btn');
  if (maps) maps.before(stats);
  else title.appendChild(stats);
}

function labBAfterStandings(gridEl) {
  for (const stats of gridEl.querySelectorAll('.standing-side > .standing-side-stats')) labBChips(stats);
  for (const btn of gridEl.querySelectorAll('.standing-side-top > .server-guilds-btn')) labBGuilds(btn);
  for (const title of gridEl.querySelectorAll('.standing-match > .standing-match-title')) labBTierTitle(title);
}

// Under 600 px the guild list and the maps take the whole screen. Both draw their own
// header with a close button once loaded; while loading, or after a failed load, there
// is none, and this one stands in (the popover rewrites its content, hence the watch).
function labBCloseIfMissing(popover) {
  if (popover.querySelector('.info-popover-close')) return;
  const x = labEl('button', 'info-popover-close lab-b-close');
  x.type = 'button';
  x.setAttribute('aria-label', 'Close');
  x.appendChild(labIcon(LAB_CROSS, 20));
  x.addEventListener('click', (e) => { e.stopPropagation(); closePopover(); });
  popover.prepend(x);
}

function labBAfterPopoverOpen(popover) {
  const big = popover.classList.contains('info-popover--guilds') || popover.classList.contains('info-popover--maps');
  if (!big || !LAB_B_FULL_Q.matches) return;
  popover.classList.add('lab-b-full');
  labBCloseIfMissing(popover);
  new MutationObserver(() => labBCloseIfMissing(popover)).observe(popover, { childList: true });
}

LAB_DESIGNS.b = {
  afterStandings: labBAfterStandings,
  afterPopoverOpen: labBAfterPopoverOpen,
};

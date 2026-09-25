'use strict';
// ---------------------------------------------------------------------
// Popover building blocks
// Figure cards, section headings, bar rows and notes. These exist so
// the data popovers cannot drift into three different looks.
// ---------------------------------------------------------------------

const MAP_LABELS = Object.freeze({
  Center: 'EBG', RedHome: 'RBL', BlueHome: 'BBL', GreenHome: 'GBL'
});
const MAP_LABEL_CLASS = Object.freeze({
  Center: 'map-kd-label--ebg', RedHome: 'map-kd-label--rbl',
  BlueHome: 'map-kd-label--bbl', GreenHome: 'map-kd-label--gbl'
});
// A figure card is a label over a number; a bar row is a label, a
// proportion, a number and its share.
function popFigure(label, value, tone) {
  const box = document.createElement('div');
  box.className = `pop-figure${tone ? ` pop-figure--${tone}` : ''}`;
  const l = document.createElement('span');
  l.className = 'pop-figure-label';
  l.textContent = label;
  const v = document.createElement('b');
  v.className = 'pop-figure-value';
  v.textContent = value;
  box.appendChild(l);
  box.appendChild(v);
  return box;
}

function popSection(title, aside) {
  const el = document.createElement('div');
  el.className = 'pop-section';
  el.appendChild(document.createTextNode(title));
  if (aside !== undefined) {
    const a = document.createElement('span');
    a.textContent = aside;
    el.appendChild(a);
  }
  return el;
}

// `fraction` fills the track, `label` names the row, `value` and `pct`
// sit at the right. labelClass lets a map row keep its map colour.
function popBarRow(label, labelClass, fraction, value, pct, fillClass) {
  const row = document.createElement('div');
  row.className = 'pop-bar-row';
  const l = document.createElement('span');
  l.className = `pop-bar-label ${labelClass || ''}`.trim();
  l.textContent = label;
  const track = document.createElement('span');
  track.className = 'pop-bar-track';
  const fill = document.createElement('span');
  fill.className = `pop-bar-fill ${fillClass || ''}`.trim();
  fill.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  track.appendChild(fill);
  const v = document.createElement('span');
  v.className = 'pop-bar-value';
  v.textContent = value;
  row.appendChild(l);
  row.appendChild(track);
  row.appendChild(v);
  if (pct !== undefined) {
    const pc = document.createElement('span');
    pc.className = 'pop-bar-pct';
    pc.textContent = pct;
    row.appendChild(pc);
  }
  return row;
}

// Every data popover opens the same way.
function popHeader(popover, title) {
  const header = document.createElement('div');
  header.className = 'info-popover-header';
  const t = document.createElement('span');
  t.textContent = title;
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'info-popover-close';
  closeBtn.textContent = '\u00d7';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.addEventListener('click', closePopover);
  header.appendChild(t);
  header.appendChild(closeBtn);
  popover.appendChild(header);
}

function popNote(text) {
  const note = document.createElement('p');
  note.className = 'activity-note';
  note.textContent = text;
  return note;
}

const MAP_ORDER = ['Center', 'GreenHome', 'BlueHome', 'RedHome'];


'use strict';
// Popover building blocks (figure cards, headings, bar rows, notes): the data popovers share one look.

const MAP_LABELS = Object.freeze({
  Center: 'EBG', RedHome: 'RBL', BlueHome: 'BBL', GreenHome: 'GBL'
});
const MAP_LABEL_CLASS = Object.freeze({
  Center: 'map-kd-label--ebg', RedHome: 'map-kd-label--rbl',
  BlueHome: 'map-kd-label--bbl', GreenHome: 'map-kd-label--gbl'
});
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

// A heading with the column words on the same line (two lines leave a band of empty
// space); each word keeps its column's width, so it lands on what it names.
function popSection(title, cells) {
  const el = document.createElement('div');
  el.className = 'pop-section';
  el.appendChild(popCell('pop-section-title', title));
  for (const cell of cells) el.appendChild(cell);
  return el;
}

function popCell(className, text) {
  const el = document.createElement('span');
  el.className = className;
  if (text) el.textContent = text;
  return el;
}

// One place builds a row label, so bar rows and the total row line up by construction.
function popBarLabel(text, labelClass) {
  const el = document.createElement('span');
  el.className = `pop-bar-label ${labelClass || ''}`.trim();
  el.textContent = text;
  return el;
}

function popBarRow(label, labelClass, fraction, value, pct, fillClass) {
  const row = document.createElement('div');
  row.className = 'pop-bar-row';
  const l = popBarLabel(label, labelClass);
  const track = document.createElement('span');
  track.className = 'pop-bar-track';
  const fill = document.createElement('span');
  fill.className = `pop-bar-fill ${fillClass}`;
  fill.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  track.appendChild(fill);
  const v = document.createElement('span');
  v.className = 'pop-bar-value';
  v.textContent = value;
  row.appendChild(l);
  row.appendChild(track);
  row.appendChild(v);
  const pc = document.createElement('span');
  pc.className = 'pop-bar-pct';
  pc.textContent = pct;
  row.appendChild(pc);
  return row;
}

// The total row, on the same grid. The track slot is kept and emptied, not dropped:
// that holds the columns in place.
function popBarTotal(label, labelClass, value) {
  const row = document.createElement('div');
  row.className = 'pop-bar-row pop-bar-total';
  const track = document.createElement('span');
  track.className = 'pop-bar-track';
  const v = document.createElement('span');
  v.className = 'pop-bar-value';
  v.textContent = value;
  const pc = document.createElement('span');
  pc.className = 'pop-bar-pct';
  row.appendChild(popBarLabel(label, labelClass));
  row.appendChild(track);
  row.appendChild(v);
  row.appendChild(pc);
  return row;
}

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


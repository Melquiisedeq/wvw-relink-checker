// What the screen's right edge cuts off: the innermost elements whose right side is past
// innerWidth, unless an ancestor that clips (overflow) or is fixed sits inside the screen
// itself and hides them. scrollWidth cannot say: html,body{overflow-x:clip} keeps it at the
// screen's width. The walk stops at body.
export const pastEdge = () => {
  const clips = e => {
    for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if ((cs.overflowX !== 'visible' || cs.position === 'fixed') && p.getBoundingClientRect().right <= innerWidth + 0.5) return true;
    }
    return false;
  };
  const name = e => {
    const c = String(e.className?.baseVal ?? e.className).trim().split(/\s+/).filter(Boolean).slice(0, 2);
    return e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + c.map(x => '.' + x).join('');
  };
  const past = [...document.body.querySelectorAll('*')].filter(e => {
    const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
    return r.width > 0 && r.right > innerWidth + 0.5 && cs.position !== 'fixed' && cs.display !== 'none'
      && !clips(e) && ![...e.children].some(c => c.getBoundingClientRect().right > innerWidth + 0.5);
  });
  return { inner: innerWidth,
    past: past.slice(0, 5).map(e => { const r = e.getBoundingClientRect(); return `${name(e)} ${Math.round(r.width)} px wide, right ${Math.round(r.right)} > ${innerWidth}`; }) };
};

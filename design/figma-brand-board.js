// Domi — Figma foundations. Run with the Figma MCP `use_figma` tool against the product design file.
// Creates: colour variables (Light + Dark collections), text styles, logo components and a brand board.
// Safe to re-run: collections, variables and styles are reused by name.

// ---------- Fonts ----------
const fonts = await figma.listAvailableFontsAsync();
const has = (f, s) => fonts.some(x => x.fontName.family === f && x.fontName.style === s);
const pick = (fam, styles, fb) => { for (const s of styles) if (has(fam, s)) return { family: fam, style: s }; return fb; };
const F = {
  display: pick('Instrument Serif', ['Regular'], { family: 'Inter', style: 'Regular' }),
  body: pick('Plus Jakarta Sans', ['Regular'], { family: 'Inter', style: 'Regular' }),
  med: pick('Plus Jakarta Sans', ['Medium'], { family: 'Inter', style: 'Medium' }),
  semi: pick('Plus Jakarta Sans', ['SemiBold', 'Semi Bold'], { family: 'Inter', style: 'Semi Bold' }),
  bold: pick('Plus Jakarta Sans', ['Bold'], { family: 'Inter', style: 'Bold' }),
  mono: pick('JetBrains Mono', ['Medium', 'Regular'], { family: 'Inter', style: 'Regular' }),
};
await Promise.all(Object.values(F).map(f => figma.loadFontAsync(f)));

// ---------- Colour variables ----------
const hex = h => { h = h.replace('#', ''); return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255 }; };
const cols = await figma.variables.getLocalVariableCollectionsAsync();
const getCol = (name) => { let c = cols.find(x => x.name === name); if (!c) c = figma.variables.createVariableCollection(name); c.renameMode(c.modes[0].modeId, name.includes('Dark') ? 'Dark' : 'Light'); return c; };
const colL = getCol('Domi colour');
const colD = getCol('Domi colour · Dark');
const SURF = ['FRAME_FILL', 'SHAPE_FILL'], TEXTS = ['TEXT_FILL', 'SHAPE_FILL', 'STROKE_COLOR'], ANY = ['ALL_FILLS', 'STROKE_COLOR'];
const TOKENS = [
  ['bg/canvas', '#F4F6F3', '#0E1513', SURF], ['bg/surface', '#FFFFFF', '#151E1B', SURF], ['bg/subtle', '#EBEFEA', '#1C2723', SURF],
  ['text/primary', '#15241F', '#E7EEEA', TEXTS], ['text/muted', '#5C6B65', '#95A59F', TEXTS], ['border/default', '#DCE3DE', '#26332E', ['STROKE_COLOR', 'SHAPE_FILL']],
  ['brand/forest', '#1E4D40', '#7CC3A6', ANY], ['brand/on-forest', '#FFFFFF', '#0E1513', ANY], ['brand/forest-soft', '#DCEAE3', '#1D3A31', ANY],
  ['brand/apricot', '#E07B4F', '#F09A72', ANY], ['brand/apricot-soft', '#FBE7DC', '#3A251A', ANY], ['brand/apricot-ink', '#8A3D1C', '#F6C1A6', ANY],
  ['status/ok', '#2F7A4F', '#6CC592', ANY], ['status/ok-soft', '#DDF0E4', '#1C3527', ANY],
  ['status/warn', '#A86A12', '#E6B058', ANY], ['status/warn-soft', '#F8ECD3', '#3A2E17', ANY],
  ['status/crit', '#B4443A', '#EE7F74', ANY], ['status/crit-soft', '#F7DEDA', '#3F2220', ANY],
  ['audio/right', '#C2413A', '#F07B72', ANY], ['audio/left', '#2E5FA8', '#86AAF0', ANY],
];
const all = await figma.variables.getLocalVariablesAsync('COLOR');
const find = (col, name) => all.find(v => v.variableCollectionId === col.id && v.name === name);
const V = {}, VD = {};
for (const [name, l, d, scopes] of TOKENS) {
  const v = find(colL, name) || figma.variables.createVariable(name, colL, 'COLOR'); v.scopes = scopes; v.setValueForMode(colL.modes[0].modeId, hex(l)); v.description = 'Dark: ' + d; V[name] = v;
  const vd = find(colD, name) || figma.variables.createVariable(name, colD, 'COLOR'); vd.scopes = scopes; vd.setValueForMode(colD.modes[0].modeId, hex(d)); VD[name] = vd;
}
const bind = (vars) => (tok, opacity) => { const p = figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }, 'color', vars[tok]); if (opacity != null) p.opacity = opacity; return p; };
const paint = bind(V), paintD = bind(VD);

// ---------- Text styles ----------
const existingStyles = Object.fromEntries((await figma.getLocalTextStylesAsync()).map(s => [s.name, s]));
const STYLE_DEFS = [
  ['Display/XL', F.display, 56, 105, 0], ['Display/L', F.display, 40, 110, 0], ['Display/M', F.display, 28, 115, 0], ['Number/L', F.display, 44, 100, 0],
  ['Heading/M', F.semi, 18, 135, -1], ['Heading/S', F.semi, 15, 140, 0], ['Body/M', F.body, 15, 155, 0], ['Body/S', F.body, 13, 150, 0],
  ['Label/M', F.semi, 13, 130, 0], ['Label/Caps', F.bold, 11, 130, 8], ['Mono/S', F.mono, 12, 130, 0],
];
const TS = {};
for (const [name, font, size, lh, ls] of STYLE_DEFS) {
  const s = existingStyles[name] || figma.createTextStyle();
  s.name = name; s.fontName = font; s.fontSize = size; s.lineHeight = { unit: 'PERCENT', value: lh }; s.letterSpacing = { unit: 'PERCENT', value: ls };
  TS[name] = s;
}

// ---------- Helpers ----------
function T(str, style, tok = 'text/primary', o = {}) {
  const t = figma.createText(); t.textStyleId = TS[style].id; t.characters = str; t.fills = [(o.p || paint)(tok)]; t.name = o.name || str.slice(0, 32);
  if (o.w) { t.resize(o.w, t.height); t.textAutoResize = 'HEIGHT'; }
  return t;
}
function AL(dir, o = {}) {
  const pf = o.p || paint;
  const f = figma.createAutoLayout(dir === 'h' ? 'HORIZONTAL' : 'VERTICAL');
  f.fills = o.fill ? [pf(o.fill)] : [];
  if (o.gap != null) f.itemSpacing = o.gap;
  if (o.pad != null) { const p = Array.isArray(o.pad) ? (o.pad.length === 2 ? [o.pad[0], o.pad[1], o.pad[0], o.pad[1]] : o.pad) : [o.pad, o.pad, o.pad, o.pad]; [f.paddingTop, f.paddingRight, f.paddingBottom, f.paddingLeft] = p; }
  if (o.r != null) f.cornerRadius = o.r;
  if (o.stroke) { f.strokes = [pf(o.stroke)]; f.strokeWeight = 1; }
  if (o.name) f.name = o.name;
  if (o.align) f.counterAxisAlignItems = o.align;
  if (o.justify) f.primaryAxisAlignItems = o.justify;
  if (o.w) { f.resize(o.w, Math.max(1, f.height)); if (f.layoutMode === 'VERTICAL') f.counterAxisSizingMode = 'FIXED'; else f.primaryAxisSizingMode = 'FIXED'; }
  return f;
}
const add = (p, c, fillW) => { p.appendChild(c); if (fillW) c.layoutSizingHorizontal = 'FILL'; return c; };

// ---------- Logo (same geometry as public/logo.svg) ----------
const MARK_SVG = '<svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="16" fill="#1E4D40"/><path d="M13 31 L32 15 L51 31" stroke="#E07B4F" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M21.4 39.4 A15 15 0 0 1 42.6 39.4" stroke="#FFFFFF" stroke-width="4" stroke-linecap="round"/><path d="M26.3 44.3 A8 8 0 0 1 37.7 44.3" stroke="#FFFFFF" stroke-width="4" stroke-linecap="round"/><circle cx="32" cy="49.5" r="2.8" fill="#FFFFFF"/></svg>';
function makeMark(size, pf = paint) {
  const m = figma.createNodeFromSvg(MARK_SVG); m.name = 'Domi mark'; m.fills = [];
  const kids = m.children;
  if (kids[0] && 'fills' in kids[0]) kids[0].fills = [pf('brand/forest')];
  if (kids[1] && 'strokes' in kids[1]) kids[1].strokes = [pf('brand/apricot')];
  for (const k of kids.slice(2, 4)) if ('strokes' in k) k.strokes = [pf('brand/on-forest')];
  if (kids[4] && 'fills' in kids[4]) kids[4].fills = [pf('brand/on-forest')];
  m.resize(size, size);
  return m;
}
function fillLockup(node, pf) {
  node.appendChild(makeMark(40, pf));
  const words = AL('v', { gap: 2, p: pf });
  const wm = T('Domi', 'Display/M', 'text/primary', { name: 'Wordmark', p: pf }); wm.fontSize = 30; wm.lineHeight = { unit: 'PERCENT', value: 95 };
  words.appendChild(wm);
  const tag = T('HEARING AT HOME', 'Label/Caps', 'brand/apricot', { name: 'Tagline', p: pf }); tag.fontSize = 9; tag.letterSpacing = { unit: 'PERCENT', value: 18 };
  words.appendChild(tag);
  node.appendChild(words);
}
function lockupComponent(name, pf) {
  const c = figma.createComponent(); c.name = name;
  c.layoutMode = 'HORIZONTAL'; c.primaryAxisSizingMode = 'AUTO'; c.counterAxisSizingMode = 'AUTO'; c.itemSpacing = 12; c.counterAxisAlignItems = 'CENTER'; c.fills = [];
  fillLockup(c, pf);
  return c;
}
const lockup = lockupComponent('Logo / Lockup', paint);
lockup.description = 'Primary logo lockup: mark + "Domi" wordmark + tagline. Placeholder brand for the demo; swap the wordmark for the practice name.';
const lockupDark = lockupComponent('Logo / Lockup on dark', paintD);
lockupDark.description = 'Logo lockup bound to the dark palette, for dark surfaces.';

// ---------- Brand board ----------
const board = AL('v', { fill: 'bg/canvas', gap: 48, pad: 64, name: 'Brand & tokens', w: 1600 });
board.x = 0; board.y = 0;
const head = AL('v', { gap: 8 });
head.appendChild(T('BRAND & DESIGN TOKENS', 'Label/Caps', 'brand/apricot'));
head.appendChild(T('Domi', 'Display/XL'));
head.appendChild(T('Placeholder identity for the demo. The mark is a roof over sound waves: hearing care that comes to the patient’s home. Colours are variables in two matching collections, Light and Dark.', 'Body/M', 'text/muted', { w: 760 }));
add(board, head);

const logoRow = AL('h', { gap: 24, name: 'Logo row' });
const lightCard = AL('v', { fill: 'bg/surface', r: 24, pad: 40, gap: 16, stroke: 'border/default', name: 'Logo on light', w: 440 });
lightCard.appendChild(T('PRIMARY LOCKUP', 'Label/Caps', 'text/muted'));
lightCard.appendChild(lockup);
const darkCard = AL('v', { fill: 'bg/canvas', r: 24, pad: 40, gap: 16, name: 'Logo on dark', w: 440, p: paintD });
darkCard.appendChild(T('ON DARK', 'Label/Caps', 'text/muted', { p: paintD }));
darkCard.appendChild(lockupDark);
const iconCard = AL('h', { fill: 'bg/surface', r: 24, pad: 40, gap: 28, stroke: 'border/default', align: 'MAX', name: 'Mark sizes' });
for (const s of [96, 48, 32, 20]) { const g = AL('v', { gap: 10, align: 'CENTER' }); g.appendChild(makeMark(s)); g.appendChild(T(s + ' px', 'Mono/S', 'text/muted')); iconCard.appendChild(g); }
logoRow.appendChild(lightCard); logoRow.appendChild(darkCard); logoRow.appendChild(iconCard);
add(board, logoRow);

const colSec = AL('v', { gap: 16, name: 'Colour' });
colSec.appendChild(T('Colour', 'Display/M'));
const grid = AL('h', { gap: 16, name: 'Swatches' }); grid.layoutWrap = 'WRAP'; grid.counterAxisSpacing = 16;
grid.resize(1472, 10); grid.primaryAxisSizingMode = 'FIXED';
for (const [name, l, d] of TOKENS) {
  const sw = AL('v', { fill: 'bg/surface', r: 16, pad: 10, gap: 8, stroke: 'border/default', name: 'Swatch ' + name, w: 170 });
  const chips = AL('h', { gap: 0, r: 10, name: 'Light | Dark' }); chips.clipsContent = true; chips.strokes = [paint('border/default')]; chips.strokeWeight = 1;
  for (const pf of [paint, paintD]) { const c = figma.createRectangle(); c.resize(75, 56); c.fills = [pf(name)]; chips.appendChild(c); }
  sw.appendChild(chips);
  sw.appendChild(T(name, 'Label/M'));
  sw.appendChild(T(l + '  ·  ' + d, 'Mono/S', 'text/muted'));
  grid.appendChild(sw);
}
colSec.appendChild(grid);
add(board, colSec);

const typeSec = AL('v', { gap: 16, name: 'Type' });
typeSec.appendChild(T('Type', 'Display/M'));
const typeCard = AL('v', { fill: 'bg/surface', r: 24, pad: 40, gap: 18, stroke: 'border/default', w: 1472 });
const spec = [
  ['Display/XL', 'Today across the team'], ['Display/L', 'Morning, Amira'], ['Display/M', 'Filling the 11:00 slot'], ['Number/L', '£170'],
  ['Heading/M', 'Margaret Holt · Hearing aid fitting'], ['Body/M', 'A home visit has opened up today at 11:00. The first person to reply YES gets it.'],
  ['Body/S', '14 Ash Grove, LS6 · Hard of hearing: text, don’t call'], ['Label/Caps', 'WAITING LIST'], ['Mono/S', '10:20  11:00–12:15  07700 900533'],
];
for (const [style, sample] of spec) {
  const row = AL('h', { gap: 32, align: 'CENTER' });
  const lab = T(style + '  ·  ' + TS[style].fontName.family + ' ' + TS[style].fontSize, 'Mono/S', 'text/muted'); lab.resize(300, lab.height); lab.textAutoResize = 'HEIGHT';
  row.appendChild(lab); row.appendChild(T(sample, style));
  typeCard.appendChild(row);
}
typeSec.appendChild(typeCard);
add(board, typeSec);

await board.screenshot({ scale: 0.5 });
return { boardId: board.id, lockupId: lockup.id, lockupDarkId: lockupDark.id, fonts: F, tokens: Object.keys(V).length, textStyles: Object.keys(TS).length };

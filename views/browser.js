/**
 * The Browser's tab: the toolbar over the tab's web page, which Hearthscale
 * draws in the view's `web` slot and the view drives over the bridge. The
 * toolbar has back, forward and reload, the address, annotate and the
 * menu; the find bar and the device toolbar open under it. A menu, a
 * popover or the annotations the view draws cover the page, so they draw
 * over it, and the page shows through where the view draws nothing.
 *
 * A tab may show one of the Browser's own pages in place of a web page:
 * History, Downloads or Browser settings. The settings, the history and
 * the downloads live in the app's store, which the backend reads too.
 */
import {
  App,
  McpUiMessageResultSchema as Answer,
  PostMessageTransport,
} from '@modelcontextprotocol/ext-apps';

/** The zoom ladder a browser offers, so the steps land on round numbers
 *  rather than on powers of the zoom level. */
const ZOOM_STEPS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
];

/** The distance of a popup from its mark, and from the edges it stays in. */
const OFFSET = 6;
const PAD = 8;

/** This machine by name or address, with an optional port and path. */
const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])(:\d+)?([/?#]|$)/i;
/** A host with a port, with an optional path. */
const HOST_PORT = /^[^/?#]+:\d+([/?#]|$)/;

/** The most pages the history keeps, newest first. */
const HISTORY_MAX = 2000;
/** The most downloads the Downloads page keeps. */
const DOWNLOADS_MAX = 200;
/** How long the history and the downloads gather before they are kept. */
const KEEP_MS = 1500;

/** What the settings hold before the person changes them. */
const DEFAULT_SETTINGS = {
  agent: true,
  fullUrl: false,
  askDownloads: false,
  shots: true,
  passwords: true,
};

/** The screens the device toolbar draws a page at. */
const DEVICES = [
  { name: 'iPhone 14', width: 390, height: 844, scale: 3, mobile: true },
  { name: 'Pixel 7', width: 412, height: 915, scale: 2.625, mobile: true },
  { name: 'iPad Air', width: 820, height: 1180, scale: 2, mobile: true },
  { name: 'Laptop', width: 1280, height: 800, scale: 1, mobile: false },
];

/** The Browser's own pages, by the name a tab keeps. */
const PAGES = {
  history: 'History',
  downloads: 'Downloads',
  passwords: 'Passwords and autofill',
  settings: 'Browser settings',
};

const SHEET = `
html, body { height: 100%; overflow: hidden; }
.browser-root { height: 100%; display: flex; flex-direction: column; }
.browser-glyph { display: block; flex: none; width: 1em; height: 1em; line-height: 1; }
.hs-shell :is(.hs-hovbox, .hs-hovbox-ink):active > .browser-glyph { transform: var(--press); opacity: var(--press-fade); }
.browser-area { position: relative; flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; }
.browser-area > .hs-browser-page-slot { flex: none; align-self: stretch; width: 100%; }
.browser-area[data-device='true'] > .hs-browser-page-slot { align-self: center; outline: var(--bw) solid var(--tipline); }
.browser-own { flex: 1; min-height: 0; }
.browser-row-time { flex: none; width: calc(var(--space) * 16); font-size: var(--fs-sm); color: var(--dim); font-variant-numeric: tabular-nums; }
.browser-row-host { font-size: var(--fs-sm); color: var(--mut); }
.browser-row { cursor: pointer; }
.browser-own .hs-info-row .hs-setting-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.browser-actions { display: flex; gap: var(--gap-label); flex: none; }
.hs-empty-view > .browser-glyph { color: var(--dim); margin-bottom: var(--space); }
.browser-notes { position: absolute; cursor: crosshair; }
.browser-mark { position: absolute; pointer-events: none; border: 2px solid var(--accent); border-radius: var(--r-sm); background: color-mix(in srgb, var(--accent) 12%, transparent); }
.browser-pin { position: absolute; min-width: calc(var(--space) * 5); height: calc(var(--space) * 5); padding: 0 calc(var(--space) * 1.25); border-radius: var(--r-pill); background: var(--accent); color: var(--accent-ink); font-size: var(--fs-cap); font-weight: var(--fw-strong); display: grid; place-items: center; transform: translate(-50%, -50%); pointer-events: none; }
.browser-note { position: absolute; width: calc(var(--space) * 65); }
.browser-note .hs-panel-field { width: 100%; height: calc(var(--space) * 7.5); padding: 0 calc(var(--space) * 2.25); box-sizing: border-box; }
`;

const app = new App({ name: 'Browser', version: '2.0.3' }, {}, { autoResize: false });

/** One request of the host, its result whole. */
const call = (method, params = {}) => app.request({ method, params }, Answer);

/** A request whose failure changes nothing on the page. */
const quietly = (method, params) => call(method, params).catch(() => null);

// ---------- Addresses ----------

/** The address as a page is known by: the host alone, which is what a
 *  person reads an address bar for. */
function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** The page a typed line opens: an address with a scheme as typed, this
 *  machine over `http:`, another host over `https:`, and any other text
 *  as a search. */
function addressOf(typed) {
  if (/^[a-z]+:\/\//i.test(typed)) return typed;
  if (!typed.includes(' ')) {
    if (LOOPBACK.test(typed)) return `http://${typed}`;
    if (typed.includes('.') || HOST_PORT.test(typed)) return `https://${typed}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(typed)}`;
}

// ---------- Elements ----------

/** An element with its classes, attributes, handlers and children. */
function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (name === 'class') node.className = value;
    else if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else if (name === 'style') Object.assign(node.style, value);
    else node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  }
  return node;
}

/** A Remix Icon by its remixicon.com name, at a size in pixels. */
function glyph(name, size, extra = '', style = {}) {
  return el('i', {
    class: `ri-${name} hs-glyph browser-glyph${extra ? ` ${extra}` : ''}`,
    style: { fontSize: `${size}px`, ...style },
    'aria-hidden': 'true',
  });
}

/** The square button of the toolbar rows. */
function stripButton(onclick, mark) {
  return el('span', { class: 'hs-hovbox-ink hs-tipwrap hs-inkdim hs-panel-button', onclick }, mark);
}

/** A button of the kit, with its words and an optional mark. */
function button(label, onclick, variant = 'secondary', mark = null) {
  return el(
    'button',
    { type: 'button', class: 'hs-button', 'data-variant': variant, 'data-size': 'sm', onclick },
    mark,
    label,
  );
}

/** Shows a part, or takes it out of the layout. */
function shown(node, on) {
  node.style.display = on ? '' : 'none';
}

/** The words of a refusal. */
const wordsOf = (e) => (e instanceof Error ? e.message : String(e));

// ---------- State ----------

const state = {
  /** The tab's page as the host tells it. */
  page: { url: null, title: '', loading: false, canGoBack: false, canGoForward: false, zoom: 1 },
  /** The tab has a page: one it showed, or one asked for. */
  loaded: false,
  /** The Browser's own page the tab shows, or `web` for its web page. */
  mode: 'web',
  settings: { ...DEFAULT_SETTINGS },
  editing: false,
  /** The pointer is over the address. */
  reaching: false,
  /** The open popup: its kind, its mark, its element as drawn now, and
   *  the call that stops its watch of the pointer. */
  popup: null,
  /** The tip under the pointer: its mark and its words. */
  tip: null,
  finding: false,
  findText: '',
  found: { active: 0, total: 0 },
  /** The screen the device toolbar draws the page at, or null. */
  device: null,
  rotated: false,
  /** The person's notes on the page while annotating, or null. */
  notes: null,
  /** The downloads this tab's pages started since the view loaded. */
  mine: new Set(),
  /** The downloads as the host last told them, by id. */
  live: new Map(),
  history: [],
  downloads: [],
  historyQuery: '',
  /** The accounts the keychain keeps passwords for. */
  logins: [],
  /** The password a page's form sent, which the person may keep. */
  offer: null,
  /** The words of the last import of passwords. */
  imported: '',
  /** Whether Hearthscale blocks ads in the person's browser; null while
   *  this app is not the person's browser. */
  adBlocking: null,
  /** Whether the person's browser draws its pages dark; null while this
   *  app is not the person's browser. */
  darkPages: null,
};

// ---------- The store ----------

/** One value of the app's store; null where it holds none. */
async function stored(key) {
  const answer = await quietly('hearthscale/store/get', { key });
  return answer?.value ?? null;
}

/** The settings, read again: another tab may have changed them. */
async function readSettings() {
  const value = await stored('settings');
  state.settings = { ...DEFAULT_SETTINGS, ...(value && typeof value === 'object' ? value : {}) };
  void quietly('hearthscale/web/downloads', { ask: state.settings.askDownloads });
}

async function setSetting(key, value) {
  await readSettings();
  state.settings = { ...state.settings, [key]: value };
  await quietly('hearthscale/store/set', { key: 'settings', value: state.settings });
  if (key === 'askDownloads') void quietly('hearthscale/web/downloads', { ask: value });
  update();
}

/** Pages to add to the history and downloads to keep, gathered so a
 *  burst of changes writes once. */
const pending = { history: [], downloads: new Map() };
let keepTimer = null;

function keepSoon() {
  clearTimeout(keepTimer);
  keepTimer = setTimeout(() => void keep(), KEEP_MS);
}

async function keep() {
  if (pending.history.length) {
    const added = pending.history.splice(0);
    const history = (await stored('history')) ?? [];
    for (const entry of added) {
      if (history[0]?.url === entry.url) history[0] = { ...history[0], ...entry };
      else history.unshift(entry);
    }
    state.history = history.slice(0, HISTORY_MAX);
    await quietly('hearthscale/store/set', { key: 'history', value: state.history });
  }
  if (pending.downloads.size) {
    const changed = [...pending.downloads.values()];
    pending.downloads.clear();
    const downloads = (await stored('downloads')) ?? [];
    for (const d of changed) {
      const at = downloads.findIndex((x) => x.id === d.id);
      if (at === -1) downloads.unshift(d);
      else downloads[at] = { ...downloads[at], ...d };
    }
    state.downloads = downloads.slice(0, DOWNLOADS_MAX);
    await quietly('hearthscale/store/set', { key: 'downloads', value: state.downloads });
  }
  if (state.mode !== 'web') drawOwn();
}

/** A page the tab showed joins the history once it has loaded. */
let lastKept = null;
function record(page) {
  if (state.mode !== 'web' || page.loading || !page.url) return;
  if (lastKept?.url === page.url && lastKept.title === page.title) return;
  lastKept = { url: page.url, title: page.title };
  pending.history.push({ url: page.url, title: page.title, at: Date.now() });
  keepSoon();
}

// ---------- The page ----------

/** Opens what the address field holds. */
function go() {
  const raw = input.value.trim();
  if (!raw) return;
  navigate(addressOf(raw));
}

function navigate(url) {
  state.loaded = true;
  void quietly('hearthscale/web/navigate', { url });
}

/** Opens one of the Browser's own pages, or a web page, in a new tab. */
function openTab(params) {
  void quietly('hearthscale/web/open-tab', params);
}

/** The page lies under the view while a popup or the notes lie over it. */
function cover() {
  if (!connected) return;
  void quietly('hearthscale/web/cover', { covered: state.popup !== null || state.notes !== null });
}

function openPopup(kind, anchor) {
  state.popup?.release();
  state.popup = { kind, anchor, box: null, release: null };
  cover();
  update();
  state.popup.release = safeTriangle(anchor, () => state.popup.box, closePopup);
}

function closePopup() {
  if (state.popup === null) return;
  state.popup.release();
  state.popup = null;
  cover();
  update();
}

function applyZoom(factor) {
  void quietly('hearthscale/web/zoom', { factor });
}

function stepZoom(dir) {
  const at = ZOOM_STEPS.findIndex((f) => Math.abs(f - state.page.zoom) < 0.001);
  const from = at === -1 ? ZOOM_STEPS.indexOf(1) : at;
  applyZoom(ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, from + dir))]);
}

/** A find with no text is a stop: the page keeps a highlight otherwise. */
function find(text) {
  state.findText = text;
  if (!text) state.found = { active: 0, total: 0 };
  void quietly('hearthscale/web/find', { text });
  updateFindCount();
}

function stepFind(forward) {
  if (state.findText) {
    void quietly('hearthscale/web/find', { text: state.findText, forward, next: true });
  }
}

function openFind() {
  state.finding = true;
  update();
  findInput.focus();
}

function closeFind() {
  state.finding = false;
  state.findText = '';
  findInput.value = '';
  state.found = { active: 0, total: 0 };
  void quietly('hearthscale/web/find', { text: '' });
  update();
}

/** The picture of the page, saved where the person picks. */
async function screenshot() {
  const answer = await quietly('hearthscale/web/capture');
  if (!answer?.png) return;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const name = `${hostOf(state.page.url ?? 'page')} ${stamp}.png`;
  await app
    .downloadFile({
      contents: [
        {
          type: 'resource',
          resource: {
            uri: `file:///${encodeURIComponent(name)}`,
            mimeType: 'image/png',
            blob: answer.png,
          },
        },
      ],
    })
    .catch(() => {});
}

// ---------- The device toolbar ----------

/** The screen the page is drawn at now, turned when rotated. */
function screen() {
  const d = state.device;
  if (!d) return null;
  return state.rotated ? { ...d, width: d.height, height: d.width } : d;
}

/** Sizes the page's place to the device, whole inside the area. */
function layDevice() {
  const d = screen();
  area.dataset.device = String(d !== null);
  if (!d) {
    slot.style.width = '';
    slot.style.height = '';
    return;
  }
  const r = area.getBoundingClientRect();
  const fit = Math.min(1, (r.width - 2 * PAD) / d.width, (r.height - 2 * PAD) / d.height);
  slot.style.width = `${Math.floor(d.width * fit)}px`;
  slot.style.height = `${Math.floor(d.height * fit)}px`;
}

/** Tells the host the screen once the page lies on its new place. */
async function applyDevice() {
  layDevice();
  await reserve();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const d = screen();
  await quietly('hearthscale/web/device', {
    device: d && { width: d.width, height: d.height, scale: d.scale, mobile: d.mobile },
  });
}

function setDevice(device) {
  state.device = device;
  if (!device) state.rotated = false;
  update();
  void applyDevice();
}

// ---------- Annotate ----------

let hovered = null;
let hoverAsk = 0;

/** Starts or ends the notes on the page. */
function setAnnotating(on) {
  state.notes = on ? { list: [], open: null } : null;
  hovered = null;
  cover();
  update();
  drawNotes();
}

/** The element under the pointer at a point of the page. */
async function inspect(x, y) {
  const answer = await quietly('hearthscale/web/inspect', { x, y });
  return answer?.element ?? null;
}

/** The notes as the agent reads them, as chips above the composer. */
async function sendNotes() {
  const notes = state.notes?.list.filter((n) => n.comment.trim()) ?? [];
  if (notes.length === 0) {
    setAnnotating(false);
    return;
  }
  const { url, title } = state.page;
  const lines = notes.map(
    (n, i) =>
      `${i + 1}. On ${n.element.selector}${n.element.text ? ` ("${n.element.text}")` : ''}: ${n.comment.trim()}`,
  );
  const content = [
    {
      type: 'text',
      text: `The person's notes on the page "${title}" at ${url}:\n${lines.join('\n')}`,
      _meta: { 'openai/title': `Notes on ${hostOf(url ?? '')}` },
    },
  ];
  if (state.settings.shots) {
    const picture = await notesPicture(notes);
    if (picture) content.push({ type: 'image', data: picture, mimeType: 'image/png' });
  }
  await app.updateModelContext({ content }).catch(() => {});
  setAnnotating(false);
}

/** The page's picture with each note's element boxed and numbered. */
async function notesPicture(notes) {
  const answer = await quietly('hearthscale/web/capture');
  if (!answer?.png) return null;
  const image = new Image();
  image.src = `data:image/png;base64,${answer.png}`;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const g = canvas.getContext('2d');
  g.drawImage(image, 0, 0);
  const r = slot.getBoundingClientRect();
  const k = image.naturalWidth / r.width;
  const ink = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  g.lineWidth = 3 * k;
  g.strokeStyle = ink;
  g.fillStyle = ink;
  g.font = `bold ${14 * k}px system-ui, sans-serif`;
  notes.forEach((n, i) => {
    const b = n.element.box;
    g.strokeRect(b.x * k, b.y * k, b.width * k, b.height * k);
    g.fillText(String(i + 1), b.x * k + 4 * k, Math.max(16 * k, b.y * k - 4 * k));
  });
  return canvas.toDataURL('image/png').split(',')[1];
}

/** The layer of the notes over the page: the element under the pointer
 *  boxed, each note numbered at its element, the open note's field. */
const notesLayer = el('div', {
  class: 'browser-notes',
  onmousemove: (e) => {
    if (!state.notes || state.notes.open) return;
    const r = notesLayer.getBoundingClientRect();
    const ask = ++hoverAsk;
    void inspect(e.clientX - r.left, e.clientY - r.top).then((element) => {
      if (ask !== hoverAsk || !state.notes) return;
      hovered = element;
      drawNotes();
    });
  },
  onmouseleave: () => {
    hovered = null;
    drawNotes();
  },
  onclick: async (e) => {
    if (!state.notes || state.notes.open) return;
    const r = notesLayer.getBoundingClientRect();
    const element = await inspect(e.clientX - r.left, e.clientY - r.top);
    if (!element || !state.notes) return;
    const note = { element, comment: '' };
    state.notes.list.push(note);
    state.notes.open = note;
    hovered = null;
    drawNotes();
  },
});

function drawNotes() {
  notesLayer.replaceChildren();
  shown(notesLayer, state.notes !== null);
  if (!state.notes) return;
  const r = slot.getBoundingClientRect();
  const a = root.getBoundingClientRect();
  Object.assign(notesLayer.style, {
    left: `${r.left - a.left}px`,
    top: `${r.top - a.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  });
  const boxOf = (b) => ({
    left: `${b.x}px`,
    top: `${b.y}px`,
    width: `${b.width}px`,
    height: `${b.height}px`,
  });
  if (hovered) notesLayer.append(el('div', { class: 'browser-mark', style: boxOf(hovered.box) }));
  state.notes.list.forEach((n, i) => {
    notesLayer.append(
      el('div', { class: 'browser-mark', style: boxOf(n.element.box) }),
      el(
        'div',
        {
          class: 'browser-pin',
          style: { left: `${n.element.box.x}px`, top: `${n.element.box.y}px` },
        },
        String(i + 1),
      ),
    );
  });
  const open = state.notes.open;
  if (open) {
    const b = open.element.box;
    const field = el('input', {
      class: 'hs-in hs-panel-field',
      placeholder: 'Your note',
      onkeydown: (e) => {
        if (e.key === 'Enter') {
          open.comment = field.value;
          if (!open.comment.trim()) state.notes.list = state.notes.list.filter((n) => n !== open);
          state.notes.open = null;
          drawNotes();
          update();
        } else if (e.key === 'Escape') {
          e.stopPropagation();
          state.notes.list = state.notes.list.filter((n) => n !== open);
          state.notes.open = null;
          drawNotes();
          update();
        }
      },
    });
    const note = el('div', { class: 'browser-note' }, field);
    notesLayer.append(note);
    const size = note.getBoundingClientRect();
    note.style.left = `${Math.max(PAD, Math.min(b.x, r.width - size.width - PAD))}px`;
    note.style.top = `${Math.min(b.y + b.height + OFFSET, r.height - size.height - PAD)}px`;
    queueMicrotask(() => field.focus());
  }
}

// ---------- The toolbar ----------

const backMark = glyph('arrow-left-line', 17);
const forwardMark = glyph('arrow-right-line', 17);
const back = stripButton(() => void quietly('hearthscale/web/go', { to: 'back' }), backMark);
const forward = stripButton(
  () => void quietly('hearthscale/web/go', { to: 'forward' }),
  forwardMark,
);
const reload = stripButton(
  () => void quietly('hearthscale/web/go', { to: 'reload' }),
  glyph('refresh-line', 16),
);
const kebab = stripButton(
  () => (state.popup?.kind === 'menu' ? closePopup() : openPopup('menu', kebab)),
  glyph('more-2-fill', 14),
);
const annotate = stripButton(() => setAnnotating(state.notes === null), glyph('markup-line', 16));
annotate.addEventListener('mouseenter', () => {
  state.tip = { anchor: annotate, text: 'Annotate for the agent' };
  drawPopups();
});
annotate.addEventListener('mouseleave', () => {
  state.tip = null;
  drawPopups();
});
const downloadsButton = stripButton(
  () => openTab({ state: { page: 'downloads' } }),
  glyph('download-2-line', 16),
);

const siteButton = el(
  'span',
  {
    class: 'hs-hovbox-ink hs-inkmut hs-site-button',
    onclick: () => (state.popup?.kind === 'site' ? closePopup() : openPopup('site', siteButton)),
  },
  glyph('equalizer-fill', 15),
);
const siteAnchor = el('span', { class: 'hs-browser-site-anchor' }, siteButton);

const input = el('input', {
  class: 'hs-in hs-urlin',
  placeholder: 'Enter a URL',
  onfocus: () => input.select(),
  onblur: () => {
    if (!state.editing) return;
    state.editing = false;
    update();
  },
  onkeydown: (e) => {
    if (e.key === 'Enter') {
      go();
      state.editing = false;
      update();
    } else if (e.key === 'Escape') {
      input.value = state.page.url ?? '';
      state.editing = false;
      update();
    }
  },
});

const pageTitle = el('span', {
  class: 'hs-browser-page-title',
  onclick: () => {
    if (state.mode !== 'web') return;
    input.value = state.page.url ?? '';
    state.editing = true;
    update();
    input.focus();
  },
});

const placeholder = el('span', { class: 'hs-urlph' }, 'Enter a URL');
const goMark = el('span', { class: 'hs-urlgo hs-address-go' }, glyph('arrow-right-up-line', 12));

const outside = el(
  'span',
  {
    class: 'hs-hovbox-ink hs-browser-menu-button',
    onclick: () => openOutside(),
    onmouseenter: () => {
      state.tip = { anchor: outside, text: 'Open in your browser' };
      drawPopups();
    },
    onmouseleave: () => {
      state.tip = null;
      drawPopups();
    },
  },
  glyph('arrow-right-up-line', 13),
);

/** Whether the page's address is one the host opens in the person's own
 *  browser: the host's `ui/open-link` opens `https:` addresses alone. */
const openable = () => /^https:\/\//i.test(state.page.url ?? '');

function openOutside() {
  if (openable()) void app.openLink({ url: state.page.url }).catch(() => {});
}

// A page's address is furniture until it is reached for: it rests bare
// and centred, and becomes a field with the site's own controls only under
// the pointer. A blank tab is always a field.
const address = el(
  'span',
  {
    onmouseenter: () => {
      state.reaching = state.mode === 'web';
      update();
    },
    onmouseleave: () => {
      state.reaching = false;
      if (state.tip?.anchor === outside) state.tip = null;
      update();
    },
  },
  siteAnchor,
  input,
  pageTitle,
  placeholder,
  goMark,
  outside,
);

const toolbar = el(
  'div',
  { class: 'hs-browser-toolbar' },
  back,
  forward,
  reload,
  address,
  downloadsButton,
  annotate,
  kebab,
);

// ---------- The find bar ----------

const findInput = el('input', {
  class: 'hs-in hs-panel-field hs-panel-find',
  placeholder: 'Find in page',
  oninput: () => find(findInput.value),
  onkeydown: (e) => {
    if (e.key === 'Enter') stepFind(!e.shiftKey);
    else if (e.key === 'Escape') closeFind();
  },
});
const findCount = el('span', { class: 'hs-find-count' });

function updateFindCount() {
  const { findText, found } = state;
  findCount.textContent = findText ? `${found.active}/${found.total}` : '';
}

const findBar = el(
  'div',
  { class: 'hs-find-bar' },
  findInput,
  findCount,
  stripButton(
    () => stepFind(false),
    glyph('arrow-down-s-line', 12, '', { transform: 'rotate(180deg)' }),
  ),
  stripButton(() => stepFind(true), glyph('arrow-down-s-line', 12)),
  stripButton(closeFind, glyph('close-line', 10)),
);

// ---------- The device bar and the notes bar ----------

const devicePicker = el('span', {
  class: 'hs-hovbox-ink hs-inkmut hs-panel-picker',
  onclick: () =>
    state.popup?.kind === 'device' ? closePopup() : openPopup('device', devicePicker),
});
const deviceSize = el('span', { class: 'hs-find-count' });
const deviceBar = el(
  'div',
  { class: 'hs-find-bar' },
  devicePicker,
  deviceSize,
  el('span', { class: 'hs-flex-spacer' }),
  stripButton(
    () => {
      state.rotated = !state.rotated;
      update();
      void applyDevice();
    },
    glyph('anticlockwise-2-line', 14),
  ),
  stripButton(() => setDevice(null), glyph('close-line', 10)),
);

const notesCount = el('span', { class: 'hs-find-count' });
const notesBar = el(
  'div',
  { class: 'hs-find-bar' },
  glyph('markup-line', 14, 'hs-inkdim'),
  el('span', { class: 'hs-flex-spacer' }, 'Annotate'),
  notesCount,
  button('Add to chat', () => void sendNotes(), 'primary'),
  stripButton(() => setAnnotating(false), glyph('close-line', 10)),
);

// ---------- The page's place ----------

/** Where the page lies. */
const slot = el('div', { class: 'hs-browser-page-slot' });
const area = el('div', { class: 'browser-area' }, slot);

/** The start of a tab with no page. */
const blank = el(
  'div',
  { class: 'hs-rview hs-panel-empty-view' },
  el(
    'div',
    { class: 'hs-panel-empty-content' },
    glyph('global-line', 40, 'hs-panel-dim-icon'),
    el('span', { class: 'hs-panel-empty-title' }, 'Start browsing'),
    el('span', { class: 'hs-panel-empty-sub' }, 'Enter a URL to open a page'),
  ),
);

// ---------- The Browser's own pages ----------

const own = el('div', { class: 'hs-scroll hs-settings-scroll browser-own' });
const historySearch = el('input', {
  class: 'hs-in hs-urlin',
  'aria-label': 'Search history',
  placeholder: 'Search history',
  oninput: () => {
    state.historyQuery = historySearch.value;
    drawOwn();
  },
});
const historySearchField = el(
  'label',
  { class: 'hs-url hs-settings-search' },
  glyph('search-line', 12),
  historySearch,
  el('span', { class: 'hs-urlph hs-ph-icon', 'aria-hidden': 'true' }, 'Search history'),
);

const timeOf = (at) =>
  new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const dayOf = (at) =>
  new Date(at).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

function section(label, first = false) {
  return el(
    'div',
    { class: 'hs-settings-section', 'data-first': String(first) },
    el('span', {}, label),
  );
}

function toggleRow(title, key) {
  const on = state.settings[key] === true;
  return el(
    'div',
    { class: 'hs-setrow hs-toggle-row' },
    el(
      'span',
      { class: 'hs-setting-label' },
      el(
        'span',
        { class: 'hs-setting-label-line' },
        el('span', { class: 'hs-setting-title' }, title),
      ),
    ),
    el(
      'button',
      {
        type: 'button',
        role: 'switch',
        class: 'hs-tog',
        'aria-checked': String(on),
        'aria-label': title,
        'data-on': String(on),
        onclick: () => void setSetting(key, !on),
      },
      el('span', { class: 'hs-toggle-thumb' }),
    ),
  );
}

function actionRow(title, label, onclick) {
  return el(
    'div',
    { class: 'hs-setrow hs-info-row' },
    el(
      'span',
      { class: 'hs-setting-label' },
      el(
        'span',
        { class: 'hs-setting-label-line' },
        el('span', { class: 'hs-setting-title' }, title),
      ),
    ),
    button(label, onclick),
  );
}

function historyPage() {
  const query = state.historyQuery.trim().toLowerCase();
  const rows = state.history.filter(
    (h) => !query || h.title.toLowerCase().includes(query) || h.url.toLowerCase().includes(query),
  );
  const parts = [el('span', { class: 'hs-settings-title' }, 'History'), historySearchField];
  if (rows.length === 0) {
    parts.push(el('div', { class: 'hs-empty-view' }, glyph('history-line', 30), 'No pages yet'));
  }
  let day = null;
  let card = null;
  for (const h of rows) {
    const d = dayOf(h.at);
    if (d !== day) {
      day = d;
      card = el('div', { class: 'hs-settings-card' });
      parts.push(section(d, parts.length === 2), card);
    }
    card.append(
      el(
        'div',
        {
          class: 'hs-setrow hs-info-row hs-hovbox-ink browser-row',
          onclick: () => {
            setMode('web');
            navigate(h.url);
          },
        },
        el('span', { class: 'browser-row-time' }, timeOf(h.at)),
        el(
          'span',
          { class: 'hs-setting-label' },
          el('span', { class: 'hs-setting-title' }, h.title || hostOf(h.url)),
          el('span', { class: 'browser-row-host' }, hostOf(h.url)),
        ),
        stripButton(
          async (e) => {
            e.stopPropagation();
            const history = ((await stored('history')) ?? []).filter(
              (x) => !(x.url === h.url && x.at === h.at),
            );
            state.history = history;
            await quietly('hearthscale/store/set', { key: 'history', value: history });
            drawOwn();
          },
          glyph('close-line', 10),
        ),
      ),
    );
  }
  return parts;
}

/** A number of bytes in the unit that reads best: "16 bytes", "3.3 KB",
 *  "2.3 MB", "1.5 GB". */
function sizeWords(bytes) {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = bytes / 1024;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit += 1;
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[unit]}`;
}

/** The words of a download's state, as its row shows them. */
function downloadWords(d) {
  if (d.state === 'progressing')
    return d.total ? `${sizeWords(d.received)} of ${sizeWords(d.total)}` : sizeWords(d.received);
  if (d.state === 'completed') return d.total ? sizeWords(d.total) : 'Done';
  if (d.state === 'cancelled') return 'Cancelled';
  return 'Failed';
}

function downloadsPage() {
  const parts = [el('span', { class: 'hs-settings-title' }, 'Downloads')];
  const rows = state.downloads.map((d) => ({ ...d, ...(state.live.get(d.id) ?? {}) }));
  if (rows.length === 0) {
    parts.push(
      el('div', { class: 'hs-empty-view' }, glyph('download-2-line', 30), 'No downloads yet'),
    );
    return parts;
  }
  const card = el('div', { class: 'hs-settings-card' });
  for (const d of rows) {
    const act = (action) => () => void quietly('hearthscale/web/download', { id: d.id, action });
    card.append(
      el(
        'div',
        { class: 'hs-setrow hs-info-row' },
        el(
          'span',
          { class: 'hs-setting-label' },
          el('span', { class: 'hs-setting-title' }, d.name),
          el('span', { class: 'browser-row-host' }, `${hostOf(d.url)}  ${downloadWords(d)}`),
        ),
        el(
          'span',
          { class: 'browser-actions' },
          d.state === 'completed' && state.live.has(d.id) && button('Open', act('open')),
          d.state === 'completed' && state.live.has(d.id) && button('Show in folder', act('show')),
          d.state === 'progressing' && button('Cancel', act('cancel')),
        ),
      ),
    );
  }
  parts.push(card);
  return parts;
}

async function readLogins() {
  const answer = await quietly('hearthscale/web/passwords');
  state.logins = answer?.logins ?? [];
  drawOwn();
}

function passwordsPage() {
  const parts = [
    el('span', { class: 'hs-settings-title' }, 'Passwords and autofill'),
    section('Passwords', true),
  ];
  const card = el('div', { class: 'hs-settings-card' });
  for (const login of state.logins) {
    card.append(
      el(
        'div',
        { class: 'hs-setrow hs-info-row' },
        el(
          'span',
          { class: 'hs-setting-label' },
          el('span', { class: 'hs-setting-title' }, hostOf(login.origin)),
          el('span', { class: 'browser-row-host' }, login.username),
        ),
        button('Remove', async () => {
          await quietly('hearthscale/web/password-remove', login);
          await readLogins();
        }),
      ),
    );
  }
  card.append(
    actionRow(state.imported || 'A passwords export file', 'Import', async () => {
      const answer = await quietly('hearthscale/web/passwords-import');
      if (typeof answer?.count === 'number') {
        state.imported = `Imported ${answer.count} password${answer.count === 1 ? '' : 's'}`;
      }
      await readLogins();
    }),
  );
  parts.push(card);
  return parts;
}

/** The switches Hearthscale keeps for the person's browser: ad blocking
 *  and dark pages. */
async function readSwitches() {
  const [blocking, dark] = await Promise.all([
    quietly('hearthscale/web/ad-blocking'),
    quietly('hearthscale/web/dark-pages'),
  ]);
  state.adBlocking = blocking?.enabled ?? null;
  state.darkPages = dark?.enabled ?? null;
  drawOwn();
}

/** A row with a switch that the host keeps. */
function switchRow(title, on, flip) {
  return el(
    'div',
    { class: 'hs-setrow hs-toggle-row' },
    el(
      'span',
      { class: 'hs-setting-label' },
      el(
        'span',
        { class: 'hs-setting-label-line' },
        el('span', { class: 'hs-setting-title' }, title),
      ),
    ),
    el(
      'button',
      {
        type: 'button',
        role: 'switch',
        class: 'hs-tog',
        'aria-checked': String(on),
        'aria-label': title,
        'data-on': String(on),
        onclick: async () => {
          await flip();
          await readSwitches();
        },
      },
      el('span', { class: 'hs-toggle-thumb' }),
    ),
  );
}

function settingsPage() {
  return [
    el('span', { class: 'hs-settings-title' }, 'Browser settings'),
    section('Agent', true),
    el(
      'div',
      { class: 'hs-settings-card' },
      toggleRow('Let the agent control the browser', 'agent'),
    ),
    section('Passwords'),
    el('div', { class: 'hs-settings-card' }, toggleRow('Offer to save passwords', 'passwords')),
    section('Address bar'),
    el('div', { class: 'hs-settings-card' }, toggleRow('Show full URLs', 'fullUrl')),
    section('Annotations'),
    el('div', { class: 'hs-settings-card' }, toggleRow('Add a screenshot to annotations', 'shots')),
    section('Downloads'),
    el(
      'div',
      { class: 'hs-settings-card' },
      toggleRow('Ask where to save each file', 'askDownloads'),
      actionRow('Download history', 'Clear', async () => {
        state.downloads = [];
        await quietly('hearthscale/store/set', { key: 'downloads', value: [] });
        drawOwn();
      }),
    ),
    section('Browsing data'),
    el(
      'div',
      { class: 'hs-settings-card' },
      actionRow('History', 'Clear', async () => {
        state.history = [];
        await quietly('hearthscale/store/set', { key: 'history', value: [] });
        drawOwn();
      }),
      actionRow(
        'Cookies and site data',
        'Clear',
        () => void quietly('hearthscale/web/clear', { cookies: true, cache: false }),
      ),
      actionRow(
        'Cached files',
        'Clear',
        () => void quietly('hearthscale/web/clear', { cookies: false, cache: true }),
      ),
    ),
    // Hearthscale draws pages dark and blocks ads only in the app that is
    // the person's browser.
    state.darkPages !== null && section('Appearance'),
    state.darkPages !== null &&
      el(
        'div',
        { class: 'hs-settings-card' },
        switchRow('Dark web pages', state.darkPages, () =>
          quietly('hearthscale/web/set-dark-pages', { enabled: !state.darkPages }),
        ),
      ),
    state.adBlocking !== null && section('Ads'),
    state.adBlocking !== null &&
      el(
        'div',
        { class: 'hs-settings-card' },
        switchRow('Block ads', state.adBlocking, () =>
          quietly('hearthscale/web/set-ad-blocking', { enabled: !state.adBlocking }),
        ),
      ),
  ];
}

function drawOwn() {
  if (state.mode === 'web') return;
  const scroll = own.scrollTop;
  const page =
    state.mode === 'history'
      ? historyPage()
      : state.mode === 'downloads'
        ? downloadsPage()
        : state.mode === 'passwords'
          ? passwordsPage()
          : settingsPage();
  own.replaceChildren(el('div', { class: 'hs-settings-content' }, page));
  own.scrollTop = scroll;
}

// A page of the Browser's own reads the history and the downloads again
// while it shows: other tabs add to them.
setInterval(() => {
  if (state.mode === 'history' || state.mode === 'downloads') {
    void Promise.all([stored('history'), stored('downloads')]).then(([history, downloads]) => {
      if (Array.isArray(history)) state.history = history;
      if (Array.isArray(downloads)) state.downloads = downloads;
      drawOwn();
    });
  }
}, 2000);

/** Shows one of the Browser's own pages, or the web page, and keeps the
 *  choice for the tab's next load. The tab takes the own page's name, or
 *  its own back for the web page, which names it after its title. */
function setMode(mode) {
  state.mode = mode;
  void quietly('hearthscale/ui/set-widget-state', { state: { page: mode } });
  void quietly('hearthscale/ui/set-tab', { title: PAGES[mode] ?? null });
  update();
}

// ---------- The popups ----------

/** One row of a menu. */
function item(label, onclick, chip) {
  return el(
    'div',
    {
      role: 'menuitem',
      tabindex: '-1',
      class: 'hs-mitem hs-menu-item-row hs-inkmut hs-hovbox-ink',
      'data-sel': 'false',
      'data-disabled': 'false',
      onclick,
    },
    el('span', { class: 'hs-menu-label' }, el('span', { class: 'hs-menu-title' }, label)),
    chip && el('span', { class: 'hs-menu-chip' }, chip),
  );
}

const divider = () => el('div', { class: 'hs-menu-divider' });

function zoomStep(label, onclick) {
  return el('span', { class: 'hs-hovbox-ink hs-panel-small-button', onclick }, label);
}

function menuRows() {
  const run = (fn) => () => {
    closePopup();
    fn();
  };
  const paged = state.mode === 'web' && state.loaded;
  return [
    paged && item('Find in page', run(openFind)),
    paged &&
      item(
        'Print…',
        run(() => void quietly('hearthscale/web/print')),
      ),
    paged && divider(),
    paged &&
      el(
        'div',
        { class: 'hs-browser-zoom-row' },
        el('span', { class: 'hs-flex-spacer' }, 'Zoom'),
        zoomStep('−', () => stepZoom(-1)),
        el('span', { class: 'hs-browser-zoom-value' }, `${Math.round(state.page.zoom * 100)}%`),
        zoomStep('+', () => stepZoom(1)),
        el(
          'span',
          { class: 'hs-hovbox-ink hs-browser-zoom-reset', onclick: () => applyZoom(1) },
          glyph('refresh-line', 12),
        ),
      ),
    paged && divider(),
    paged &&
      item(
        state.device ? 'Hide device toolbar' : 'Show device toolbar',
        run(() => setDevice(state.device ? null : DEVICES[0])),
      ),
    paged &&
      item(
        'Take a screenshot',
        run(() => void screenshot()),
      ),
    paged && divider(),
    item(
      'Passwords and autofill',
      run(() => openTab({ state: { page: 'passwords' } })),
    ),
    item(
      'Downloads',
      run(() => openTab({ state: { page: 'downloads' } })),
    ),
    item(
      'History',
      run(() => openTab({ state: { page: 'history' } })),
    ),
    item(
      'Clear browsing data',
      run(() => openTab({ state: { page: 'settings' } })),
    ),
    item(
      'Browser settings',
      run(() => openTab({ state: { page: 'settings' } })),
    ),
    divider(),
    paged && openable() && item('Open in your browser', run(openOutside)),
    item(
      'New tab',
      run(() => openTab({})),
    ),
  ];
}

function siteRows() {
  const url = state.page.url ?? '';
  const secure = url.startsWith('https://');
  return [
    el(
      'div',
      { class: 'hs-browser-site-menu' },
      el('span', { class: 'hs-browser-site-title' }, hostOf(url)),
      el(
        'span',
        { class: 'hs-browser-site-detail' },
        glyph(secure ? 'lock-fill' : 'lock-unlock-fill', 13),
        secure ? 'The connection is encrypted' : 'The connection is not encrypted',
      ),
    ),
  ];
}

/** Whether to keep the password a page's form sent. */
function passwordRows() {
  const { offer } = state;
  const answer = (keep) => async () => {
    if (keep) await quietly('hearthscale/web/password-save', { id: offer.id });
    state.offer = null;
    closePopup();
  };
  return [
    el(
      'div',
      { class: 'hs-browser-site-menu' },
      el(
        'span',
        { class: 'hs-browser-site-title' },
        `Save the password for ${hostOf(offer.origin)}?`,
      ),
      el(
        'span',
        { class: 'hs-browser-site-detail' },
        glyph('user-line', 13),
        offer.username || hostOf(offer.origin),
      ),
      el(
        'span',
        { class: 'browser-actions' },
        button('Save', answer(true), 'primary'),
        button('Not now', answer(false)),
      ),
    ),
  ];
}

function deviceRows() {
  return DEVICES.map((d) =>
    item(
      d.name,
      () => {
        closePopup();
        setDevice(d);
      },
      `${d.width} × ${d.height}`,
    ),
  );
}

const within = (b, p) => p.x >= b.left && p.x <= b.right && p.y >= b.top && p.y <= b.bottom;

/** Whether `p` lies in the triangle `a`, `b`, `c`, its edges included. */
function inTriangle(p, a, b, c) {
  const side = (u, v) => (p.x - v.x) * (u.y - v.y) - (u.x - v.x) * (p.y - v.y);
  const d1 = side(a, b);
  const d2 = side(b, c);
  const d3 = side(c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/** How far behind the point where the pointer left the trigger, away from
 *  the popup, the triangle starts. The page reads that point a whole move
 *  past the edge and in whole pixels, so a triangle with its tip right
 *  there would miss the next move on the way. */
const BEHIND = 4;

/** Whether `p` lies on the way from `trigger` to `popup`: the band
 *  straight between them, or the triangle from `from`, where the pointer
 *  left the trigger, to the popup's edge that faces the trigger. A popup
 *  that overlaps its trigger has no way. */
function onWay(trigger, popup, from, p) {
  let edge;
  let band;
  let tip;
  if (popup.top >= trigger.bottom || popup.bottom <= trigger.top) {
    const below = popup.top >= trigger.bottom;
    const y = below ? popup.top : popup.bottom;
    edge = [
      { x: popup.left, y },
      { x: popup.right, y },
    ];
    band = {
      left: Math.max(trigger.left, popup.left),
      right: Math.min(trigger.right, popup.right),
      top: below ? trigger.bottom : popup.bottom,
      bottom: below ? popup.top : trigger.top,
    };
    tip = from && { x: from.x, y: from.y + (below ? -BEHIND : BEHIND) };
  } else if (popup.left >= trigger.right || popup.right <= trigger.left) {
    const right = popup.left >= trigger.right;
    const x = right ? popup.left : popup.right;
    edge = [
      { x, y: popup.top },
      { x, y: popup.bottom },
    ];
    band = {
      left: right ? trigger.right : popup.right,
      right: right ? popup.left : trigger.left,
      top: Math.max(trigger.top, popup.top),
      bottom: Math.min(trigger.bottom, popup.bottom),
    };
    tip = from && { x: from.x + (right ? -BEHIND : BEHIND), y: from.y };
  } else return false;
  if (band.left <= band.right && band.top <= band.bottom && within(band, p)) return true;
  return tip !== null && inTriangle(p, tip, edge[0], edge[1]);
}

/**
 * Keeps a popup open while the pointer is on its trigger, on the popup, or
 * on the way between them, and calls `onLeave` once the pointer is
 * anywhere else, off the page included. The way is the band straight
 * between the two and the triangle from the point where the pointer left
 * the trigger to the popup's near edge, so a pointer that heads for any
 * part of the popup crosses no ground that closes it. This happens only
 * once the pointer has been on the trigger or on the popup, so a popup
 * that opened without the pointer waits for it. `popup` gives the popup's
 * element as drawn now. Returns the call that stops it.
 */
function safeTriangle(trigger, popup, onLeave) {
  let armed = trigger.matches(':hover');
  let onTrigger = armed;
  let from = null;
  const check = (e) => {
    const p = { x: e.clientX, y: e.clientY };
    const t = trigger.getBoundingClientRect();
    const m = popup().getBoundingClientRect();
    if (within(t, p)) {
      armed = onTrigger = true;
      return;
    }
    if (onTrigger) {
      onTrigger = false;
      from = p;
    }
    if (within(m, p)) {
      armed = true;
      from = null;
    } else if (armed && !onWay(t, m, from, p)) onLeave();
  };
  const away = () => {
    if (armed) onLeave();
  };
  const page = document.documentElement;
  document.addEventListener('pointermove', check, true);
  page.addEventListener('mouseleave', away);
  return () => {
    document.removeEventListener('pointermove', check, true);
    page.removeEventListener('mouseleave', away);
  };
}

/** Lays a popup under its mark, from the mark's left or right edge, kept
 *  inside the page, or above the mark where there is no room below. */
function place(floating, anchor, align) {
  const at = anchor.getBoundingClientRect();
  const box = floating.getBoundingClientRect();
  let left = align === 'right' ? at.right - box.width : at.left;
  left = Math.max(PAD, Math.min(left, innerWidth - PAD - box.width));
  let top = at.bottom + OFFSET;
  if (top + box.height > innerHeight - PAD && at.top - OFFSET - box.height >= PAD) {
    top = at.top - OFFSET - box.height;
  }
  floating.style.left = `${left}px`;
  floating.style.top = `${top}px`;
  floating.style.visibility = 'visible';
}

const popups = el('div');

function drawPopups() {
  popups.replaceChildren();
  const { popup, tip } = state;
  if (popup) {
    const rows =
      popup.kind === 'menu'
        ? menuRows()
        : popup.kind === 'site'
          ? siteRows()
          : popup.kind === 'password'
            ? passwordRows()
            : deviceRows();
    const floating = el(
      'div',
      {
        class: 'hs-menu-position',
        style: { visibility: 'hidden' },
        onclick: (e) => e.stopPropagation(),
      },
      el(
        'div',
        {
          class: 'hs-menu hs-menu-surface',
          style: { minWidth: 'min(224px, calc(100vw - var(--space) * 4))' },
        },
        rows,
      ),
    );
    popups.append(floating);
    place(floating, popup.anchor, popup.kind === 'menu' ? 'right' : 'left');
    popup.box = floating;
  }
  if (tip) {
    const floating = el(
      'div',
      { class: 'hs-menu-position hs-floating-tip', style: { visibility: 'hidden' } },
      el(
        'span',
        { class: 'hs-tip hs-tooltip', 'data-sub': 'false' },
        el('span', { class: 'hs-tooltip-title' }, tip.text),
      ),
    );
    popups.append(floating);
    place(floating, tip.anchor, 'left');
  }
}

// ---------- Drawing ----------

const root = el(
  'div',
  { class: 'browser-root' },
  toolbar,
  findBar,
  deviceBar,
  notesBar,
  area,
  blank,
  own,
  notesLayer,
);

/** Brings every part in line with the state. */
function update() {
  const { page, loaded, editing, reaching, popup, mode, settings } = state;
  const web = mode === 'web';
  const site = popup?.kind === 'site';
  // A Browser page of its own names itself where the address rests.
  const bare = !web || (loaded && !reaching && !editing && !site);
  backMark.classList.toggle('hs-browser-step-off', !page.canGoBack);
  forwardMark.classList.toggle('hs-browser-step-off', !page.canGoForward);
  kebab.classList.toggle('hs-boxsel', popup?.kind === 'menu');
  annotate.classList.toggle('hs-boxsel', state.notes !== null);
  siteButton.classList.toggle('hs-boxsel', site);
  devicePicker.classList.toggle('hs-boxsel', popup?.kind === 'device');
  shown(back, web);
  shown(forward, web);
  shown(reload, web);
  shown(annotate, web && loaded);
  shown(downloadsButton, web && state.mine.size > 0);
  address.className = bare ? 'hs-browser-address' : 'hs-url hs-browser-address';
  address.dataset.bare = String(bare);
  address.dataset.loaded = String(loaded || !web);
  shown(siteAnchor, web && loaded && !bare);
  shown(input, web && (editing || !loaded));
  shown(pageTitle, !web || (loaded && !editing));
  pageTitle.textContent = !web
    ? PAGES[mode]
    : settings.fullUrl
      ? (page.url ?? '')
      : hostOf(page.url ?? '');
  shown(placeholder, web && !loaded);
  shown(goMark, web && !loaded);
  shown(outside, web && loaded && !bare && openable());
  if (document.activeElement !== input) input.value = page.url ?? input.value;
  shown(findBar, web && state.finding);
  updateFindCount();
  const d = screen();
  shown(deviceBar, web && d !== null);
  if (d) {
    devicePicker.replaceChildren(state.device.name, glyph('arrow-down-s-line', 12));
    deviceSize.textContent = `${d.width} × ${d.height}`;
  }
  shown(notesBar, web && state.notes !== null);
  notesCount.textContent = state.notes
    ? String(state.notes.list.filter((n) => n.comment).length)
    : '';
  shown(area, web && loaded);
  shown(blank, web && !loaded);
  shown(own, !web);
  if (!web) drawOwn();
  layDevice();
  drawPopups();
  void reserve();
}

// ---------- The slot ----------

let reserved = '';
let connected = false;

/** Reserves the page's rectangle for the tab's web page, or none while
 *  the tab shows no page. */
async function reserve() {
  if (!connected) return;
  let slots = [];
  if (state.mode === 'web' && state.loaded) {
    const r = slot.getBoundingClientRect();
    slots = [
      {
        id: 'page',
        kind: 'web',
        insets: {
          left: Math.round(r.left),
          top: Math.round(r.top),
          right: Math.round(innerWidth - r.right),
          bottom: Math.round(innerHeight - r.bottom),
        },
      },
    ];
  }
  const words = JSON.stringify(slots);
  if (words === reserved) return;
  reserved = words;
  await quietly('hearthscale/ui/slots', { slots });
}

new ResizeObserver(() => void reserve()).observe(slot);
addEventListener('resize', () => {
  if (state.device) void applyDevice();
  void reserve();
  drawPopups();
  drawNotes();
});

// ---------- What the host tells ----------

app.fallbackNotificationHandler = async (note) => {
  const params = note.params ?? {};
  switch (note.method) {
    case 'hearthscale/web/page':
      state.page = params;
      if (params.url !== null) state.loaded = true;
      record(params);
      update();
      return;
    case 'hearthscale/web/password':
      if (!state.settings.passwords) return;
      state.offer = params;
      openPopup('password', address);
      return;
    case 'hearthscale/web/found':
      state.found = params;
      updateFindCount();
      return;
    case 'hearthscale/web/download': {
      const { mine, ...download } = params;
      state.live.set(download.id, download);
      if (mine && !state.mine.has(download.id)) {
        state.mine.add(download.id);
        update();
      }
      if (mine) {
        pending.downloads.set(download.id, { ...download, at: Date.now() });
        keepSoon();
      }
      if (!state.downloads.some((d) => d.id === download.id)) {
        state.downloads = [{ ...download, at: Date.now() }, ...state.downloads];
      }
      if (state.mode === 'downloads') drawOwn();
      return;
    }
  }
};

// Escape closes the popup, else ends the notes, before anything under it
// hears the key.
addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Escape') return;
    if (state.popup !== null) {
      e.stopPropagation();
      e.preventDefault();
      closePopup();
    } else if (state.notes !== null && !state.notes.open) {
      e.preventDefault();
      setAnnotating(false);
    }
  },
  true,
);

// A popup of a page the person left closes, as one does where they click
// outside it; the settings another tab changed are read again on return.
addEventListener('blur', () => closePopup());
addEventListener('focus', () => void readSettings().then(update));

const style = document.createElement('style');
style.textContent = SHEET;
document.head.append(style);
document.body.append(root, popups);
update();

await app.connect(new PostMessageTransport(window.parent, window.parent));
connected = true;
const kept = app.getHostContext()?.['hearthscale/widgetState'];
if (kept && typeof kept === 'object' && kept.page in PAGES) state.mode = kept.page;
await readSettings();
const [history, downloads] = await Promise.all([stored('history'), stored('downloads')]);
state.history = Array.isArray(history) ? history : [];
state.downloads = Array.isArray(downloads) ? downloads : [];
if (state.mode in PAGES) void quietly('hearthscale/ui/set-tab', { title: PAGES[state.mode] });
if (state.mode === 'passwords') await readLogins();
if (state.mode === 'settings') await readSwitches();
update();

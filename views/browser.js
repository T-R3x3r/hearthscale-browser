/**
 * The Browser's tab: the toolbar over the tab's web page, which Hearthscale
 * draws in the view's `web` slot and the view drives over the bridge. The
 * toolbar has back, forward and reload, the address, and the menu; the
 * find bar opens under it. A menu or a popover the view opens covers the
 * page, so it draws over it, and the page shows through where the view
 * draws nothing.
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

const SHEET = `
html, body { height: 100%; overflow: hidden; }
.browser-root { height: 100%; display: flex; flex-direction: column; }
.browser-glyph { display: block; flex: none; width: 1em; height: 1em; line-height: 1; }
.hs-shell :is(.hs-hovbox, .hs-hovbox-ink):active > .browser-glyph { transform: var(--press); opacity: var(--press-fade); }
`;

const app = new App({ name: 'Browser', version: '2.0.0' }, {}, { autoResize: false });

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
  return el(
    'span',
    { class: 'hs-hovbox-ink hs-tipwrap hs-inkdim hs-panel-button', onclick },
    mark,
  );
}

/** Shows a part, or takes it out of the layout. */
function shown(node, on) {
  node.style.display = on ? '' : 'none';
}

// ---------- State ----------

const state = {
  /** The tab's page as the host tells it. */
  page: { url: null, title: '', loading: false, canGoBack: false, canGoForward: false, zoom: 1 },
  /** The tab has a page: one it showed, or one asked for. */
  loaded: false,
  editing: false,
  /** The pointer is over the address. */
  reaching: false,
  /** The open popup: the menu or the site's popover, and its mark. */
  popup: null,
  /** The tip under the pointer: its mark and its words. */
  tip: null,
  finding: false,
  findText: '',
  found: { active: 0, total: 0 },
};

// ---------- The page ----------

/** Opens what the address field holds. */
function go() {
  const raw = input.value.trim();
  if (!raw) return;
  state.loaded = true;
  void quietly('hearthscale/web/navigate', { url: addressOf(raw) });
}

/** The page lies under the view while a popup is open over it. */
function cover() {
  if (!connected) return;
  void quietly('hearthscale/web/cover', { covered: state.popup !== null });
}

function openPopup(kind, anchor) {
  state.popup = { kind, anchor };
  cover();
  update();
}

function closePopup() {
  if (state.popup === null) return;
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

const siteButton = el(
  'span',
  {
    class: 'hs-hovbox-ink hs-inkmut hs-site-button',
    onclick: () => (state.popup?.kind === 'site' ? closePopup() : openPopup('site', siteButton)),
  },
  glyph('equalizer-fill', 15),
);
/** The site's popover closes once the pointer leaves both its mark and
 *  the popover. */
const leaveSite = (e) => {
  const to = e.relatedTarget;
  if (to instanceof Node && (siteAnchor.contains(to) || popups.contains(to))) return;
  if (state.popup?.kind === 'site') closePopup();
};
const siteAnchor = el('span', { class: 'hs-browser-site-anchor', onmouseleave: leaveSite }, siteButton);

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
    onclick: () => {
      const url = state.page.url ?? '';
      if (/^https:\/\//i.test(url)) void app.openLink({ url }).catch(() => {});
    },
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

// A page's address is furniture until it is reached for: it rests bare
// and centred, and becomes a field with the site's own controls only under
// the pointer. A blank tab is always a field.
const address = el(
  'span',
  {
    onmouseenter: () => {
      state.reaching = true;
      update();
    },
    onmouseleave: () => {
      state.reaching = false;
      state.tip = null;
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

const toolbar = el('div', { class: 'hs-browser-toolbar' }, back, forward, reload, address, kebab);

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
  stripButton(() => stepFind(false), glyph('arrow-down-s-line', 12, '', { transform: 'rotate(180deg)' })),
  stripButton(() => stepFind(true), glyph('arrow-down-s-line', 12)),
  stripButton(closeFind, glyph('close-line', 10)),
);

// ---------- The page's place ----------

/** Where the page lies. */
const slot = el('div', { class: 'hs-browser-page-slot' });

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

const root = el('div', { class: 'browser-root' }, toolbar, findBar, slot, blank);
const popups = el('div');

// ---------- The popups ----------

/** One row of a menu. */
function item(label, onclick) {
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
  return [
    item('Find in page', run(openFind)),
    item(
      'Print…',
      run(() => void quietly('hearthscale/web/print')),
    ),
    divider(),
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
    divider(),
    item(
      'Open in your browser',
      run(() => {
        const url = state.page.url ?? '';
        if (/^https:\/\//i.test(url)) void app.openLink({ url }).catch(() => {});
      }),
    ),
    item(
      'New tab',
      run(() => void quietly('hearthscale/web/open-tab')),
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

function drawPopups() {
  popups.replaceChildren();
  const { popup, tip } = state;
  if (popup) {
    const floating = el(
      'div',
      {
        class: 'hs-menu-position',
        style: { visibility: 'hidden' },
        onmouseleave: popup.kind === 'menu' ? closePopup : leaveSite,
        onclick: (e) => e.stopPropagation(),
      },
      el(
        'div',
        {
          class: 'hs-menu hs-menu-surface',
          'data-closing': 'false',
          style: { minWidth: 'min(224px, calc(100vw - 16px))' },
        },
        popup.kind === 'menu' ? menuRows() : siteRows(),
      ),
    );
    popups.append(floating);
    place(floating, popup.anchor, popup.kind === 'menu' ? 'right' : 'left');
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

/** Brings every part in line with the state. */
function update() {
  const { page, loaded, editing, reaching, popup } = state;
  const site = popup?.kind === 'site';
  const bare = loaded && !reaching && !editing && !site;
  backMark.classList.toggle('hs-browser-step-off', !page.canGoBack);
  forwardMark.classList.toggle('hs-browser-step-off', !page.canGoForward);
  kebab.classList.toggle('hs-boxsel', popup?.kind === 'menu');
  siteButton.classList.toggle('hs-boxsel', site);
  address.className = bare ? 'hs-browser-address' : 'hs-url hs-browser-address';
  address.dataset.bare = String(bare);
  address.dataset.loaded = String(loaded);
  shown(siteAnchor, loaded && !bare);
  shown(input, editing || !loaded);
  shown(pageTitle, loaded && !editing);
  pageTitle.textContent = hostOf(page.url ?? '');
  shown(placeholder, !loaded);
  shown(goMark, !loaded);
  shown(outside, loaded && !bare);
  if (!loaded || !editing) {
    if (document.activeElement !== input) input.value = page.url ?? input.value;
  }
  if (!(loaded && !bare) && state.tip?.anchor === outside) state.tip = null;
  shown(findBar, state.finding);
  updateFindCount();
  shown(slot, loaded);
  shown(blank, !loaded);
  drawPopups();
  reserve();
}

// ---------- The slot ----------

let reserved = '';
let connected = false;

/** Reserves the page's rectangle for the tab's web page, or none while
 *  the tab has no page. */
function reserve() {
  if (!connected) return;
  let slots = [];
  if (state.loaded) {
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
  void quietly('hearthscale/ui/slots', { slots });
}

new ResizeObserver(() => reserve()).observe(slot);
addEventListener('resize', () => {
  reserve();
  drawPopups();
});

// ---------- What the host tells ----------

app.fallbackNotificationHandler = async (note) => {
  const params = note.params ?? {};
  switch (note.method) {
    case 'hearthscale/web/page':
      state.page = params;
      if (params.url !== null) state.loaded = true;
      update();
      return;
    case 'hearthscale/web/found':
      state.found = params;
      updateFindCount();
      return;
  }
};

// Escape closes the popup before anything under it hears the key.
addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Escape' || state.popup === null) return;
    e.stopPropagation();
    e.preventDefault();
    closePopup();
  },
  true,
);

// A popup of a page the person left closes, as one does where they click
// outside it.
addEventListener('blur', () => closePopup());

const style = document.createElement('style');
style.textContent = SHEET;
document.head.append(style);
document.body.append(root, popups);
update();

await app.connect(new PostMessageTransport(window.parent, window.parent));
connected = true;
update();

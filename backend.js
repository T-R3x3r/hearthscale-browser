'use strict';
/* global window, document */
/**
 * The Browser plugin's backend: the browser-use action set over
 * Hearthscale's own Chromium. The backend never touches a page itself:
 * each tool sends tab commands to the session's executor surface, which
 * runs them and answers with the page's address and title and whether the
 * tab is shown, so the tab and the tools may sit on different machines.
 * The page reaches the model as an indexed state, and the functions under
 * "page scripts" run inside the page, reaching only `window`, `document`
 * and their arguments. Clicks, typing and keys reach the page as the
 * person's own input. A search runs on Google in the session's tab while
 * the person sees that tab, and otherwise on DuckDuckGo with no tab; both
 * answer the results as a list. The read_pages tool and a search with no
 * tab fetch through the backend's own network, so they need no window;
 * read_pages turns pages into Markdown with the converter the extract
 * tool runs in the page. A bot check is never defeated and a password is
 * never typed: a challenge page or a sign-in page raises the handoff, the
 * person takes the tab, and the command runs again.
 */

/** Titles that mark a page as a challenge only a human passes. */
const CHALLENGE = /just a moment|verify you are human|captcha|attention required|are you a robot/i;

/** The surface clips an evaluate result at 20,000 characters; the page
 *  scripts keep their own output under that so the JSON arrives whole.
 *  Every action returns a state, so a state stays small enough that a
 *  chain of actions fits a 16k-token local model's window. */
const STATE_CHARS = 8000;
const EXTRACT_CHARS = 12000;
/** What one read answers in all, shared out over its pages, each at most
 *  what an extract answers. */
const READ_CHARS = 20000;
const READ_PAGES_MOST = 5;
const READ_TIMEOUT_MS = 20000;
/** A desktop Chrome's request headers, as the Browser's own pages send. */
const READ_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
};
const RESULTS_MOST = 10;
const SNIPPET_CHARS = 300;
/** The attribute the state stamps on each indexed element. */
const INDEX_ATTR = 'data-hs-i';
/** How far, in pixels, from a found text the links and controls near it
 *  lie. */
const NEAR_PX = 200;

/** What a navigation answers first while the tab is hidden: the page is
 *  loaded, and the person sees nothing of it until the show tool. The model
 *  reads this right where it decides its next call, which matters more to
 *  a small model than a tool description does. */
const QUIET_NOTE = (did) =>
  `${did}. The page loaded in the background and the person cannot see it; call ${held.app.id}_show when they ask to see it.`;

/** A search the person sees runs on Google in their tab, where they can
 *  pass its bot check; a search only the chat shows reads DuckDuckGo's
 *  results page for browsers without scripts. */
const GOOGLE_SEARCH = (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}&udm=14`;
const DUCKDUCKGO_SEARCH = (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;

// ---- Page scripts ---------------------------------------------------------

/** Walks the visible part of the document, stamps every interactive
 *  element with an index, and returns the state text: one line per
 *  interactive element, one line per visible text node, in order, with a
 *  count of the interactive elements outside the view. With `near`, only
 *  the elements within that many pixels of the last found text are
 *  listed, and no text. */
function pageState(o) {
  const w = window;
  const d = document;
  const vw = w.innerWidth;
  const vh = w.innerHeight;
  const TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary']);
  const ROLES = new Set([
    'button',
    'link',
    'checkbox',
    'radio',
    'tab',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'switch',
    'combobox',
    'textbox',
    'searchbox',
    'slider',
    'spinbutton',
    'treeitem',
  ]);
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'svg', 'title']);

  for (const el of d.querySelectorAll(`[${o.attr}]`)) el.removeAttribute(o.attr);

  const style = (el) => w.getComputedStyle(el);
  const shown = (s) => s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  const near = (r) => r.bottom >= 0 && r.top <= vh && r.right >= 0 && r.left <= vw;
  const found = o.near ? w.__hsFound : null;
  const foundRect = found && found.isConnected ? found.getBoundingClientRect() : null;
  const byFound = (r) =>
    !o.near ||
    (!!foundRect && r.bottom >= foundRect.top - o.near && r.top <= foundRect.bottom + o.near);
  const under = (node, ancestor) => {
    for (let n = node; n; n = n.parentNode || n.host) if (n === ancestor) return true;
    return false;
  };
  const covered = (el, r) => {
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x >= vw || y >= vh) return false;
    const top = d.elementFromPoint(x, y);
    return !!top && top !== el && !under(top, el) && !under(el, top);
  };
  const interactive = (el, s, r) => {
    const tag = el.localName;
    if (TAGS.has(tag)) return !(tag === 'input' && el.type === 'hidden');
    const role = el.getAttribute('role');
    if (role && ROLES.has(role)) return true;
    if (el.isContentEditable) return true;
    if (r.height > vh * 0.5) return false;
    if (el.hasAttribute('onclick')) return true;
    const tabindex = el.getAttribute('tabindex');
    if (tabindex !== null && tabindex !== '-1') return true;
    if (s.cursor !== 'pointer') return false;
    const parent = el.parentElement;
    if (!parent) return true;
    return style(parent).cursor !== 'pointer' || parent.getBoundingClientRect().height > vh * 0.5;
  };

  const collapse = (t) =>
    String(t || '')
      .replace(/\s+/g, ' ')
      .trim();
  const cut = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
  const labelOf = (el) => {
    if (el.localName === 'select') {
      return collapse(el.selectedOptions[0] ? el.selectedOptions[0].text : '');
    }
    let t = collapse(el.innerText);
    if (!t) t = collapse(el.getAttribute('aria-label'));
    if (!t && el.labels && el.labels.length) t = collapse(el.labels[0].innerText);
    if (!t) {
      const img = el.querySelector('img[alt]');
      if (img) t = collapse(img.getAttribute('alt'));
    }
    if (!t) t = collapse(el.getAttribute('title'));
    if (!t) {
      const named = el.querySelector('[title],[aria-label]');
      if (named) t = collapse(named.getAttribute('aria-label') || named.getAttribute('title'));
    }
    return cut(t, 80);
  };
  const attrsOf = (el, label) => {
    const out = [];
    const add = (k, v) => {
      if (v === null || v === undefined || v === '' || v === false) return;
      if (v === true) {
        out.push(k);
        return;
      }
      const s = cut(collapse(v), 60);
      out.push(/[\s"'>=]/.test(s) ? `${k}="${s.replace(/"/g, '&quot;')}"` : `${k}=${s}`);
    };
    const tag = el.localName;
    if (tag === 'a') add('href', el.getAttribute('href'));
    if (tag === 'input') {
      add('type', el.type === 'text' ? null : el.type);
      add('name', el.name);
      add('placeholder', el.placeholder);
      if (el.type === 'checkbox' || el.type === 'radio') add('checked', el.checked);
      else if (el.type !== 'password') add('value', el.value);
    }
    if (tag === 'textarea') {
      add('name', el.name);
      add('placeholder', el.placeholder);
      add('value', el.value);
    }
    if (tag === 'select') add('options', el.options.length);
    add('role', el.getAttribute('role'));
    const aria = collapse(el.getAttribute('aria-label'));
    if (aria && aria !== label) add('aria-label', aria);
    add('aria-expanded', el.getAttribute('aria-expanded'));
    add('aria-checked', el.getAttribute('aria-checked'));
    add('aria-selected', el.getAttribute('aria-selected'));
    add('disabled', el.disabled === true || el.getAttribute('aria-disabled') === 'true');
    if (el.isContentEditable && tag !== 'input' && tag !== 'textarea') add('contenteditable', true);
    return out;
  };
  const lineOf = (el, index) => {
    const tag = el.localName;
    const label = labelOf(el);
    const attrs = attrsOf(el, label);
    const head = `[${index}]<${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}`;
    return label ? `${head}>${label}</${tag}>` : `${head} />`;
  };

  const lines = [];
  let chars = 0;
  let count = 0;
  let truncated = false;
  const push = (line) => {
    if (truncated) return;
    if (chars + line.length + 1 > o.maxChars) {
      truncated = true;
      return;
    }
    lines.push(line);
    chars += line.length + 1;
  };
  const textRect = (node) => {
    const range = d.createRange();
    range.selectNodeContents(node);
    return range.getBoundingClientRect();
  };
  const walk = (node) => {
    if (truncated) return;
    if (node.nodeType === 3) {
      if (o.near) return;
      const t = collapse(node.data);
      if (!t || (t.length < 2 && !/\w/.test(t))) return;
      const r = textRect(node);
      if ((!r.width && !r.height) || !near(r)) return;
      push(cut(t, 400));
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node;
    const tag = el.localName;
    if (SKIP.has(tag) || el.getAttribute('aria-hidden') === 'true') return;
    const s = style(el);
    if (!shown(s)) return;
    if (tag === 'iframe') {
      push(`<iframe src=${cut(collapse(el.getAttribute('src')), 60)}> (content not readable)`);
      return;
    }
    const r = el.getBoundingClientRect();
    if ((r.width || r.height) && !near(r)) return;
    if (r.width > 0 && r.height > 0 && interactive(el, s, r) && !covered(el, r)) {
      count += 1;
      el.setAttribute(o.attr, String(count));
      if (byFound(r)) push(lineOf(el, count));
      return;
    }
    if (el.shadowRoot) for (const c of el.shadowRoot.childNodes) walk(c);
    for (const c of el.childNodes) walk(c);
  };

  // An open modal is the page as far as the user can act on it.
  const modal = [...d.querySelectorAll('dialog[open],[role="dialog"],[aria-modal="true"]')].find(
    (m) =>
      shown(style(m)) && m.getBoundingClientRect().width > 0 && near(m.getBoundingClientRect()),
  );
  walk(modal || d.body || d.documentElement);

  const height = Math.max(d.documentElement.scrollHeight, d.body ? d.body.scrollHeight : 0);
  const outside = [
    ...d.querySelectorAll(
      'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem]',
    ),
  ].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && !near(r) && shown(style(el));
  }).length;
  const signIn = [
    ...d.querySelectorAll('input[type=password],input[autocomplete="current-password"]'),
  ].some((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && shown(style(el));
  });
  // A bot check in view: the visible widget of reCAPTCHA, hCaptcha or
  // Cloudflare Turnstile, which a page whose title gives no hint shows too.
  const challenge = [...d.querySelectorAll('iframe')].some((f) => {
    const src = f.src || '';
    const r = f.getBoundingClientRect();
    return (
      /\/recaptcha\/(api2|enterprise)\/anchor|hcaptcha\.com\/captcha|challenges\.cloudflare\.com/.test(src) &&
      !/size=invisible/.test(src) &&
      r.width > 0 &&
      r.height > 0 &&
      near(r) &&
      shown(style(f))
    );
  });
  return {
    text: lines.join('\n'),
    count,
    outside,
    signIn,
    challenge,
    above: Math.round(w.scrollY),
    below: Math.max(0, Math.round(height - w.scrollY - vh)),
    truncated,
  };
}

/** Scrolls the indexed element to the middle of the view and answers a
 *  point on it that no other element covers, in the CSS pixels of the
 *  viewport, for a click there. With `field`, only an element that takes
 *  text has one. */
function pageTarget(o) {
  const w = window;
  const d = document;
  const el = d.querySelector(`[${o.attr}="${o.index}"]`);
  if (!el) return 'missing';
  if (o.field) {
    const tag = el.localName;
    if (tag === 'select') return 'select';
    const typed =
      tag === 'textarea' ||
      (tag === 'input' &&
        !/^(checkbox|radio|button|submit|reset|file|image|range|color)$/.test(el.type));
    if (!typed && !el.isContentEditable) return 'not-editable';
  }
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return 'hidden';
  const under = (node, ancestor) => {
    for (let n = node; n; n = n.parentNode || n.host) if (n === ancestor) return true;
    return false;
  };
  let hit = null;
  for (const [fx, fy] of [
    [0.5, 0.5],
    [0.2, 0.5],
    [0.8, 0.5],
    [0.5, 0.2],
    [0.5, 0.8],
  ]) {
    const x = Math.min(w.innerWidth - 1, Math.max(0, r.left + r.width * fx));
    const y = Math.min(w.innerHeight - 1, Math.max(0, r.top + r.height * fy));
    hit = d.elementFromPoint(x, y);
    const page = hit === d.body || hit === d.documentElement;
    if (hit && (under(hit, el) || (!page && under(el, hit)))) {
      return { x: Math.round(x), y: Math.round(y) };
    }
  }
  return `covered:${hit ? hit.localName : ''}`;
}

/** Readies the indexed field for typing once a click has reached it: the
 *  focus in it, and either all its text selected, so typing replaces it,
 *  or the caret at its end. */
function pageCaret(o) {
  const d = document;
  const el = d.querySelector(`[${o.attr}="${o.index}"]`);
  if (!el) return 'missing';
  if (!(d.activeElement === el || el.contains(d.activeElement))) el.focus();
  if (el.isContentEditable) {
    const range = d.createRange();
    range.selectNodeContents(el);
    if (!o.clear) range.collapse(false);
    const selection = d.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  } else if (o.clear) {
    el.select();
  } else {
    try {
      el.setSelectionRange(el.value.length, el.value.length);
    } catch {
      // A field such as an email or a number has no caret to place; the
      // caret stays where the click put it.
    }
  }
  return 'ok';
}

/** Scrolls the page, the container around an indexed element, or — on a
 *  page whose own document does not scroll — the largest scrollable box. */
function pageScroll(o) {
  const w = window;
  const d = document;
  const scrollable = (el) =>
    /(auto|scroll|overlay)/.test(w.getComputedStyle(el).overflowY) &&
    el.scrollHeight > el.clientHeight + 1;
  let box = null;
  if (o.index) {
    const el = d.querySelector(`[${o.attr}="${o.index}"]`);
    if (!el) return 'missing';
    for (let n = el; n && n !== d.body; n = n.parentElement) {
      if (scrollable(n)) {
        box = n;
        break;
      }
    }
  } else if (d.documentElement.scrollHeight <= d.documentElement.clientHeight + 1) {
    let area = 0;
    for (const el of d.querySelectorAll('*')) {
      if (!scrollable(el)) continue;
      const size = el.clientWidth * el.clientHeight;
      if (size > area) {
        area = size;
        box = el;
      }
    }
  }
  const dy = (o.down ? 1 : -1) * o.pages * w.innerHeight;
  const before = box ? box.scrollTop : w.scrollY;
  if (box) box.scrollBy({ top: dy, behavior: 'instant' });
  else w.scrollBy({ top: dy, behavior: 'instant' });
  const after = box ? box.scrollTop : w.scrollY;
  return { moved: Math.round(after - before), target: box ? `<${box.localName}>` : 'the page' };
}

/** Scrolls the first visible text node containing the text into view,
 *  keeps its element for the state of what lies near it, and answers the
 *  passage around the text: its block's text, cut around the match. */
function pageFindText(o) {
  const w = window;
  const d = document;
  const want = String(o.text).toLowerCase();
  const walker = d.createTreeWalker(d.body, w.NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.data.toLowerCase().includes(want)) continue;
    const el = n.parentElement;
    if (!el) continue;
    const s = w.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') continue;
    const range = d.createRange();
    range.selectNodeContents(n);
    if (!range.getBoundingClientRect().height) continue;
    el.scrollIntoView({ block: 'center' });
    w.__hsFound = el;
    let block = el;
    while (block.parentElement && w.getComputedStyle(block).display.startsWith('inline')) {
      block = block.parentElement;
    }
    const text = String(block.innerText || '')
      .replace(/\s+/g, ' ')
      .trim();
    const at = Math.max(0, text.toLowerCase().indexOf(want));
    const from = Math.max(0, at - o.around);
    const to = Math.min(text.length, at + want.length + o.around);
    return `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`;
  }
  return null;
}

/** Greps the page's full visible text, line by line. */
function pageSearch(o) {
  const lines = (document.body ? document.body.innerText : '').split('\n');
  let re = null;
  try {
    re = new RegExp(o.pattern, 'i');
  } catch {
    re = null;
  }
  const want = String(o.pattern).toLowerCase();
  const hits = [];
  let total = 0;
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t || !(re ? re.test(t) : t.toLowerCase().includes(want))) return;
    total += 1;
    if (hits.length < o.max) hits.push(`${i + 1}: ${t.length > 200 ? `${t.slice(0, 199)}…` : t}`);
  });
  return { hits, total };
}

/** Lists the elements a CSS selector matches, with the attributes asked
 *  for and the state index of those the last state stamped. */
function pageFindElements(o) {
  let list;
  try {
    list = [...document.querySelectorAll(o.selector)];
  } catch {
    return 'bad-selector';
  }
  const names = o.attributes.length
    ? o.attributes
    : [
        'id',
        'class',
        'href',
        'name',
        'type',
        'value',
        'placeholder',
        'role',
        'aria-label',
        'src',
        'alt',
      ];
  const elements = list.slice(0, o.max).map((el) => {
    const attrs = {};
    for (const n of names) {
      const v = n === 'value' ? el.value : el.getAttribute(n);
      if (v) attrs[n] = String(v).slice(0, 120);
    }
    const index = el.getAttribute(o.attr);
    return {
      index: index ? Number(index) : null,
      tag: el.localName,
      text: String(el.innerText || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 100),
      attrs,
    };
  });
  return { total: list.length, elements };
}

/** The options of a native select, or of the ARIA listbox a custom
 *  dropdown controls once it is open. */
function pageDropdownOptions(o) {
  const w = window;
  const d = document;
  const el = d.querySelector(`[${o.attr}="${o.index}"]`);
  if (!el) return 'missing';
  if (el.localName === 'select') {
    return {
      kind: 'select',
      options: [...el.options].map((op) => ({ text: op.text.trim(), selected: op.selected })),
    };
  }
  const ref = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
  const root = (ref && d.getElementById(ref)) || d;
  const options = [...root.querySelectorAll('[role="option"],[role="menuitem"]')].filter(
    (op) => op.getBoundingClientRect().height > 0 && w.getComputedStyle(op).visibility !== 'hidden',
  );
  return {
    kind: 'aria',
    options: options.map((op) => ({
      text: String(op.innerText || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80),
      selected: op.getAttribute('aria-selected') === 'true',
    })),
  };
}

/** Chooses the option whose text matches: in a native select at once, in
 *  an open ARIA listbox by answering the point of the option for a click. */
function pageSelectDropdown(o) {
  const w = window;
  const d = document;
  const el = d.querySelector(`[${o.attr}="${o.index}"]`);
  if (!el) return 'missing';
  const want = String(o.text).trim().toLowerCase();
  const pick = (list, label) =>
    list.find((x) => label(x).toLowerCase() === want) ||
    list.find((x) => label(x).toLowerCase().includes(want));
  if (el.localName === 'select') {
    const op = pick([...el.options], (x) => x.text.trim());
    if (!op) return 'no-option';
    Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype, 'value').set.call(el, op.value);
    el.dispatchEvent(new w.Event('input', { bubbles: true }));
    el.dispatchEvent(new w.Event('change', { bubbles: true }));
    return { selected: op.text.trim() };
  }
  const ref = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
  const root = (ref && d.getElementById(ref)) || d;
  const options = [...root.querySelectorAll('[role="option"],[role="menuitem"]')].filter(
    (op) => op.getBoundingClientRect().height > 0 && w.getComputedStyle(op).visibility !== 'hidden',
  );
  if (!options.length) return 'closed';
  const op = pick(options, (x) => String(x.innerText || '').trim());
  if (!op) return 'no-option';
  op.scrollIntoView({ block: 'center' });
  const r = op.getBoundingClientRect();
  return {
    selected: String(op.innerText || '')
      .trim()
      .slice(0, 80),
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
  };
}

/** The Markdown of an element's content, with headings, links, lists and
 *  tables kept. It reads what a page's elements and a parsed document's
 *  both hold (`nodeType`, `localName`, `data`, `getAttribute`), and `env`
 *  answers the rest: `kind(el)`, one of `hidden`, `block`, `cell` and
 *  `inline`; `children(el)`, the nodes to read in order; and `link(el)`,
 *  a link's full address. It also runs inside the page, so it reaches
 *  nothing but its arguments. */
function toMarkdown(root, env) {
  const SKIP = new Set([
    'script',
    'style',
    'noscript',
    'template',
    'svg',
    'iframe',
    'head',
    'input',
    'select',
    'textarea',
    'option',
    'canvas',
    'video',
    'audio',
  ]);
  const inline = (t) => t.replace(/\s+/g, ' ');
  const elements = (el) => [...env.children(el)].filter((n) => n.nodeType === 1);
  const rowsOf = (table) =>
    elements(table).flatMap((c) =>
      c.localName === 'tr'
        ? [c]
        : /^(thead|tbody|tfoot)$/.test(c.localName)
          ? elements(c).filter((r) => r.localName === 'tr')
          : [],
    );
  const cellsOf = (tr) => elements(tr).filter((c) => c.localName === 'td' || c.localName === 'th');
  const holdsTable = (el) => elements(el).some((c) => c.localName === 'table' || holdsTable(c));
  // Spaces collapse across elements as a browser draws them: a text's
  // leading space goes after a space or a line break.
  const spaced = (out) => {
    for (let k = out.length - 1; k >= 0; k -= 1) {
      if (out[k]) return /\s$/.test(out[k]);
    }
    return true;
  };
  const conv = (node, ctx, out) => {
    if (node.nodeType === 3) {
      const text = ctx.pre ? node.data : inline(node.data);
      out.push(!ctx.pre && text[0] === ' ' && spaced(out) ? text.slice(1) : text);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node;
    const tag = el.localName;
    if (SKIP.has(tag) || el.getAttribute('aria-hidden') === 'true') return;
    const kind = env.kind(el);
    if (kind === 'hidden') return;
    const kids = (c = ctx) => {
      for (const n of env.children(el)) conv(n, c, out);
    };
    switch (tag) {
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        out.push(`\n\n${'#'.repeat(Number(tag[1]))} `);
        kids();
        out.push('\n\n');
        return;
      case 'br':
        out.push('\n');
        return;
      case 'hr':
        out.push('\n\n---\n\n');
        return;
      case 'ul':
      case 'ol': {
        out.push('\n');
        let n = 0;
        for (const c of elements(el)) {
          if (c.localName !== 'li') {
            conv(c, ctx, out);
            continue;
          }
          n += 1;
          out.push(`\n${'  '.repeat(ctx.depth)}${tag === 'ol' ? `${n}. ` : '- '}`);
          const sub = { ...ctx, depth: ctx.depth + 1 };
          for (const cc of env.children(c)) conv(cc, sub, out);
        }
        out.push('\n');
        return;
      }
      case 'li':
        out.push('\n- ');
        kids();
        return;
      case 'a': {
        const raw = el.getAttribute('href');
        const href = raw && !/^(javascript:|#)/i.test(raw) ? env.link(el) : null;
        if (!href) {
          kids();
          return;
        }
        // A link around blocks, such as a teaser, keeps its blocks and
        // gives its address on a line of its own.
        const inner = [];
        for (const n of env.children(el)) conv(n, ctx, inner);
        const text = inner.join('').trim();
        const heading = /^(#+ )(.*)$/.exec(text);
        out.push(
          text.includes('\n')
            ? `\n${text}\n${href}\n`
            : heading
              ? `\n\n${heading[1]}[${heading[2]}](${href})\n\n`
              : `[${text}](${href})`,
        );
        return;
      }
      case 'img': {
        const alt = inline(el.getAttribute('alt') || '').trim();
        if (alt) out.push(`[image: ${alt}]`);
        return;
      }
      case 'strong':
      case 'b':
        out.push('**');
        kids();
        out.push('**');
        return;
      case 'em':
      case 'i':
        out.push('*');
        kids();
        out.push('*');
        return;
      case 'code':
        if (ctx.pre) {
          kids();
          return;
        }
        out.push('`');
        kids();
        out.push('`');
        return;
      case 'pre':
        out.push('\n\n```\n');
        kids({ ...ctx, pre: true });
        out.push('\n```\n\n');
        return;
      case 'blockquote':
        out.push('\n\n> ');
        kids();
        out.push('\n\n');
        return;
      case 'table': {
        // A grid of equal rows is data; anything else is layout and its
        // cells read as ordinary blocks.
        const rows = rowsOf(el);
        const widths = new Set(rows.map((tr) => cellsOf(tr).length));
        const grid = rows.length > 1 && widths.size === 1 && !widths.has(1) && !holdsTable(el);
        if (!grid) {
          out.push('\n');
          kids();
          out.push('\n');
          return;
        }
        out.push('\n\n');
        rows.forEach((tr, i) => {
          const cells = cellsOf(tr).map((c) => {
            const part = [];
            for (const n of env.children(c)) conv(n, ctx, part);
            return inline(part.join('')).trim().replace(/\|/g, '\\|');
          });
          out.push(`| ${cells.join(' | ')} |\n`);
          if (i === 0) out.push(`|${cells.map(() => ' --- |').join('')}\n`);
        });
        out.push('\n');
        return;
      }
      default:
        if (kind === 'cell') {
          kids();
          out.push(' ');
        } else if (kind === 'block') {
          out.push('\n');
          kids();
          out.push('\n');
        } else {
          kids();
        }
    }
  };
  const out = [];
  conv(root, { depth: 0, pre: false }, out);
  return out
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The main content as Markdown, sliced from `start` to fit the surface.
 *  The script carries `toMarkdown` as its second argument. */
function pageExtract(o, markdownOf) {
  const w = window;
  const d = document;
  const BLOCK = /^(block|flex|grid|list-item|table|table-row|flow-root)$/;
  const markdown = markdownOf(d.querySelector('main, [role="main"]') || d.body, {
    kind: (el) => {
      const s = w.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return 'hidden';
      if (s.display === 'table-cell') return 'cell';
      return BLOCK.test(s.display) ? 'block' : 'inline';
    },
    children: (el) =>
      el.shadowRoot ? [...el.shadowRoot.childNodes, ...el.childNodes] : el.childNodes,
    link: (el) => el.href,
  });
  const start = Math.max(0, o.start);
  return { markdown: markdown.slice(start, start + o.maxChars), total: markdown.length, start };
}

/** The results Google's page lists, in order: each title is a heading in
 *  a link, or a link in a heading, and the rest of the text of the box
 *  that holds that heading alone is its snippet. A link through Google's
 *  redirect answers the address the redirect carries; any other link of
 *  Google's own site, and an ad, is no result. */
function pageResults(o) {
  const w = window;
  const d = document;
  const collapse = (t) =>
    String(t || '')
      .replace(/\s+/g, ' ')
      .trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const s = w.getComputedStyle(el);
    return s.visibility !== 'hidden' && s.opacity !== '0';
  };
  const ADS = /(^|\.)(googleadservices\.com|doubleclick\.net)$/;
  const addressOf = (a) => {
    let u;
    try {
      u = new URL(a.href);
    } catch {
      return null;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.hostname !== w.location.hostname) return ADS.test(u.hostname) ? null : u.href;
    const to = u.pathname === '/url' ? u.searchParams.get('q') || u.searchParams.get('url') : null;
    return to && /^https?:\/\//.test(to) ? to : null;
  };
  const linkOf = (h) => h.closest('a[href]') || h.querySelector('a[href]');
  const titles = [...d.querySelectorAll('h2, h3')].filter(
    (h) => linkOf(h) && visible(h) && !h.closest('[data-text-ad]'),
  );
  const alone = (el) => titles.filter((t) => el.contains(t)).length === 1;
  const results = [];
  const seen = new Set();
  for (const h of titles) {
    const a = linkOf(h);
    const url = addressOf(a);
    const title = collapse(h.innerText);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    let box = a.contains(h) ? a : h;
    while (box.parentElement && box.parentElement !== d.body && alone(box.parentElement)) {
      box = box.parentElement;
    }
    const own = new Set(String(a.innerText).split('\n').map(collapse));
    const snippet = String(box.innerText)
      .split('\n')
      .map(collapse)
      .filter((l) => l && l !== title && !own.has(l) && !/^https?:\/\/|›/.test(l))
      .join(' ');
    results.push({
      title,
      url,
      snippet: snippet.length > o.snippet ? `${snippet.slice(0, o.snippet - 1)}…` : snippet,
    });
    if (results.length >= o.max) break;
  }
  return results;
}

/** Draws, or removes, a numbered box over every stamped element in the
 *  viewport, for a screenshot the model reads by index. */
function pageOverlay(o) {
  const w = window;
  const d = document;
  const old = d.getElementById('hs-browser-overlay');
  if (old) old.remove();
  if (!o.show) return 0;
  const layer = d.createElement('div');
  layer.id = 'hs-browser-overlay';
  layer.style.cssText =
    'position:fixed;inset:0;pointer-events:none;z-index:2147483647;font:bold 11px/1 system-ui,sans-serif;';
  const colors = [
    '#e6194b',
    '#3cb44b',
    '#4363d8',
    '#f58231',
    '#911eb4',
    '#42d4f4',
    '#f032e6',
    '#9a6324',
    '#000075',
    '#808000',
  ];
  let n = 0;
  for (const el of d.querySelectorAll(`[${o.attr}]`)) {
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > w.innerHeight || r.right < 0 || r.left > w.innerWidth) continue;
    if (!r.width) continue;
    const index = Number(el.getAttribute(o.attr));
    const color = colors[index % colors.length];
    const box = d.createElement('div');
    box.style.cssText = `position:absolute;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;border:2px solid ${color};box-sizing:border-box;`;
    const tag = d.createElement('span');
    tag.textContent = String(index);
    tag.style.cssText = `position:absolute;left:-2px;top:${r.top < 14 ? 0 : -14}px;background:${color};color:#fff;padding:1px 3px;border-radius:2px;`;
    box.appendChild(tag);
    layer.appendChild(box);
    n += 1;
  }
  (d.body || d.documentElement).appendChild(layer);
  return n;
}

// ---- Reading a page without a tab ----------------------------------------

/** Elements that hold nothing and have no end tag. */
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
/** Elements whose content is text up to their own end tag. */
const RAW_TAGS = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'iframe', 'xmp']);
/** For a start tag, the open elements it ends, and those beyond which it
 *  ends none, as an HTML parser closes them without their end tags. */
const ENDS = {
  li: [['li'], ['ul', 'ol', 'menu']],
  dt: [['dt', 'dd'], ['dl']],
  dd: [['dt', 'dd'], ['dl']],
  tr: [
    ['tr', 'td', 'th'],
    ['table', 'thead', 'tbody', 'tfoot'],
  ],
  td: [
    ['td', 'th'],
    ['tr', 'table'],
  ],
  th: [
    ['td', 'th'],
    ['tr', 'table'],
  ],
  thead: [['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'], ['table']],
  tbody: [['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'], ['table']],
  tfoot: [['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'], ['table']],
  option: [['option'], ['select', 'datalist']],
};
/** The start tags that end an open paragraph. */
const ENDS_P = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'details',
  'div',
  'dl',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'ul',
]);
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'body',
  'caption',
  'center',
  'dd',
  'details',
  'dialog',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'header',
  'hgroup',
  'legend',
  'li',
  'main',
  'p',
  'section',
  'summary',
  'tr',
]);

/** The entities a page names, beyond the numbered ones: the Latin-1 set
 *  in code point order from 160, then the common others. */
const ENTITIES = (() => {
  const latin1 =
    'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml';
  const named = Object.fromEntries(
    latin1.split(' ').map((name, i) => [name, String.fromCharCode(160 + i)]),
  );
  return Object.assign(named, {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    ndash: '–',
    mdash: '—',
    hellip: '…',
    lsquo: '‘',
    rsquo: '’',
    sbquo: '‚',
    ldquo: '“',
    rdquo: '”',
    bdquo: '„',
    lsaquo: '‹',
    rsaquo: '›',
    bull: '•',
    trade: '™',
    euro: '€',
    dagger: '†',
    Dagger: '‡',
    permil: '‰',
    minus: '−',
    ensp: ' ',
    emsp: ' ',
    thinsp: ' ',
    zwnj: '‌',
    zwj: '‍',
    larr: '←',
    rarr: '→',
    uarr: '↑',
    darr: '↓',
    harr: '↔',
  });
})();

const decodeEntities = (text) =>
  text.indexOf('&') < 0
    ? text
    : text.replace(
        /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/g,
        (all, dec, hex, name) => {
          if (name) return ENTITIES[name] ?? all;
          const code = dec ? Number(dec) : parseInt(hex, 16);
          return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
            ? String.fromCodePoint(code)
            : '�';
        },
      );

/** An element of a parsed document, with what `toMarkdown` reads. */
class ParsedElement {
  constructor(localName, attrs) {
    this.nodeType = 1;
    this.localName = localName;
    this.attrs = attrs;
    this.childNodes = [];
  }

  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }
}

const attributesOf = (inner) => {
  const attrs = new Map();
  for (const m of inner.matchAll(
    /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g,
  )) {
    const name = m[1].toLowerCase();
    if (!attrs.has(name)) attrs.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''));
  }
  return attrs;
};

/** Where a tag that opens at `from` ends: its `>` outside a quoted
 *  value; -1 when it never ends. */
const tagEnd = (html, from) => {
  let quote = '';
  let afterEquals = false;
  for (let k = from; k < html.length; k += 1) {
    const c = html[k];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '>') {
      return k;
    } else if ((c === '"' || c === "'") && afterEquals) {
      quote = c;
    } else if (c === '=') {
      afterEquals = true;
      continue;
    }
    if (!/\s/.test(c)) afterEquals = false;
  }
  return -1;
};

/** The document an HTML text makes, as a tree of elements and texts. */
function parseHtml(html) {
  const root = new ParsedElement('#document', new Map());
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const addText = (data) => {
    if (!data) return;
    const nodes = top().childNodes;
    const last = nodes[nodes.length - 1];
    if (last && last.nodeType === 3) last.data += data;
    else nodes.push({ nodeType: 3, data });
  };
  /** Closes the furthest open element of `names` this side of `stops`. */
  const closeTo = (names, stops) => {
    let at = -1;
    for (let k = stack.length - 1; k > 0; k -= 1) {
      const name = stack[k].localName;
      if (names.includes(name)) at = k;
      else if (stops.includes(name)) break;
    }
    if (at > 0) stack.length = at;
  };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      addText(decodeEntities(html.slice(i)));
      break;
    }
    addText(decodeEntities(html.slice(i, lt)));
    i = lt;
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    const closing = html[lt + 1] === '/';
    const named = /^[a-zA-Z][^\s/>]*/.exec(html.slice(lt + (closing ? 2 : 1), lt + 80));
    if (!named) {
      addText('<');
      i = lt + 1;
      continue;
    }
    const end = tagEnd(html, lt + (closing ? 2 : 1) + named[0].length);
    if (end < 0) break;
    i = end + 1;
    const tag = named[0].toLowerCase();
    if (closing) {
      const open = stack.findLastIndex((el) => el.localName === tag);
      if (open > 0) stack.length = open;
      continue;
    }
    if (ENDS_P.has(tag)) closeTo(['p'], ['button', 'table', 'td', 'th', 'caption']);
    if (ENDS[tag]) closeTo(...ENDS[tag]);
    const el = new ParsedElement(tag, attributesOf(html.slice(lt + 1 + named[0].length, end)));
    top().childNodes.push(el);
    if (VOID_TAGS.has(tag)) continue;
    if (RAW_TAGS.has(tag)) {
      const close = new RegExp(`</${tag}[\\s/>]`, 'ig');
      close.lastIndex = i;
      const found = close.exec(html);
      const stop = found ? found.index : html.length;
      const data = html.slice(i, stop);
      if (data) el.childNodes.push({ nodeType: 3, data: decodeEntities(data) });
      const after = found ? html.indexOf('>', stop) : -1;
      i = after < 0 ? html.length : after + 1;
      continue;
    }
    stack.push(el);
  }
  return root;
}

/** The elements under a node that `test` accepts, in document order, at
 *  most `most`; the inside of an accepted element is not searched. */
const findElements = (node, test, most = Infinity, found = []) => {
  for (const child of node.childNodes) {
    if (found.length >= most) break;
    if (child.nodeType !== 1) continue;
    if (test(child)) found.push(child);
    else findElements(child, test, most, found);
  }
  return found;
};

/** The first element under a node that `test` accepts, in document order. */
const findElement = (node, test) => findElements(node, test, 1)[0] ?? null;

const hasClass = (el, name) => (el.getAttribute('class') ?? '').split(/\s+/).includes(name);

/** The text under a parsed node, its spaces collapsed. */
const textUnder = (node) => {
  const raw = (n) => (n.nodeType === 3 ? n.data : n.childNodes.map(raw).join(''));
  return raw(node).replace(/\s+/g, ' ').trim();
};

/** The results DuckDuckGo's page without scripts lists, in order and
 *  without its ads. Each title links through DuckDuckGo's redirect, whose
 *  `uddg` carries the address. */
const duckResults = (doc) =>
  findElements(doc, (el) => hasClass(el, 'result') && !hasClass(el, 'result--ad'))
    .map((box) => {
      const link = findElement(box, (el) => hasClass(el, 'result__a'));
      if (!link) return null;
      let url;
      try {
        const href = new URL(link.getAttribute('href') ?? '', 'https://duckduckgo.com/');
        url = href.searchParams.get('uddg') ?? href.href;
      } catch {
        return null;
      }
      const shown = findElement(box, (el) => hasClass(el, 'result__snippet'));
      const snippet = shown ? textUnder(shown) : '';
      return {
        title: textUnder(link),
        url,
        snippet:
          snippet.length > SNIPPET_CHARS ? `${snippet.slice(0, SNIPPET_CHARS - 1)}…` : snippet,
      };
    })
    .filter((result) => result && result.title && /^https?:\/\//.test(result.url))
    .slice(0, RESULTS_MOST);

const HIDING_STYLE = /(^|;)\s*(display\s*:\s*none|visibility\s*:\s*hidden)/i;
/** What sits around a page's content, which its styles would hide or set
 *  aside: elements, roles, and the words of a class or id, unless those
 *  words also name the content. */
const AROUND_TAGS = new Set(['nav', 'aside', 'footer', 'button', 'dialog', 'menu']);
const AROUND_ROLES = new Set([
  'navigation',
  'banner',
  'contentinfo',
  'complementary',
  'menu',
  'menubar',
  'dialog',
  'search',
]);
const AROUND_WORDS =
  /(^|[\s_-])(menu|dropdown|navbar|nav|sidebar|footer|breadcrumbs?|banner|cookies?|consent|popup|modal|share|social|related|comments?|advert|ads|sponsored|newsletter|subscribe|toc)([\s_-]|$)/i;
const CONTENT_WORDS = /(^|[\s_-])(content|article|main|body|post|entry|story)([\s_-]|$)/i;
/** The elements that hold a page's content whatever their classes say. */
const CONTENT_TAGS = new Set(['body', 'main', 'article']);

/** Where a fetched page's element stands, with no styles to read. */
const fetchedKind = (el) => {
  const named = `${el.getAttribute('class') ?? ''} ${el.getAttribute('id') ?? ''}`;
  if (
    el.attrs.has('hidden') ||
    HIDING_STYLE.test(el.getAttribute('style') ?? '') ||
    AROUND_TAGS.has(el.localName) ||
    AROUND_ROLES.has(el.getAttribute('role')) ||
    (!CONTENT_TAGS.has(el.localName) && AROUND_WORDS.test(named) && !CONTENT_WORDS.test(named))
  ) {
    return 'hidden';
  }
  if (el.localName === 'td' || el.localName === 'th') return 'cell';
  return BLOCK_TAGS.has(el.localName) ? 'block' : 'inline';
};

/** A fetched page as Markdown: its title, and the content of its main
 *  part, else of its body, without what `fetchedKind` sets aside. */
function htmlMarkdown(html, address) {
  const doc = parseHtml(html);
  const title = findElement(doc, (el) => el.localName === 'title');
  const base = findElement(doc, (el) => el.localName === 'base' && el.attrs.has('href'));
  let at = address;
  try {
    if (base) at = new URL(base.getAttribute('href'), address).href;
  } catch {
    at = address;
  }
  const main =
    findElement(doc, (el) => el.localName === 'main' || el.getAttribute('role') === 'main') ||
    findElement(doc, (el) => el.localName === 'body') ||
    doc;
  const markdown = toMarkdown(main, {
    kind: fetchedKind,
    children: (el) => el.childNodes,
    link: (el) => {
      try {
        return new URL(el.getAttribute('href'), at).href;
      } catch {
        return null;
      }
    },
  });
  const text = title?.childNodes[0]?.data ?? '';
  return { title: text.replace(/\s+/g, ' ').trim(), markdown };
}

const bytesOf = (base64) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let k = 0; k < binary.length; k += 1) bytes[k] = binary.charCodeAt(k);
  return bytes;
};

/** A fetched answer's content type, in lower case; empty when it names none. */
const contentType = (answer) =>
  (
    Object.entries(answer.headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1] ??
    ''
  ).toLowerCase();

/** A body's text in the encoding its type names, else the one its markup
 *  declares, else UTF-8. */
const textOf = (bytes, type) => {
  const head = new TextDecoder('windows-1252').decode(bytes.subarray(0, 4096));
  const label =
    /charset=["']?([\w.:-]+)/i.exec(type)?.[1] ??
    /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1] ??
    'utf-8';
  let decoder;
  try {
    decoder = new TextDecoder(label);
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  return decoder.decode(bytes);
};

/** One page for the read tool: the address it landed on, its title and
 *  its Markdown from `start`, at most `cap` characters, or why it could
 *  not be read. */
const readPage = async (address, start, cap) => {
  let url;
  try {
    url = new URL(address);
  } catch {
    return { url: address, error: 'is not a web address' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { url: address, error: 'is not an http or https address' };
  }
  let answer;
  try {
    answer = await held.net.fetch({
      url: url.href,
      headers: READ_HEADERS,
      timeoutMs: READ_TIMEOUT_MS,
    });
  } catch (e) {
    return {
      url: url.href,
      error: `could not be reached: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const landedAt = answer.url;
  const type = contentType(answer);
  const bytes = bytesOf(answer.body);
  const text = textOf(bytes, type);
  const html = /html/.test(type) || (!type && /^\s*</.test(text));
  if (!html && !/^text\/|json|xml|javascript/.test(type)) {
    return {
      url: landedAt,
      error: `is a ${type.split(';')[0] || 'binary'} file, which the reader does not read`,
    };
  }
  const { title, markdown } = html
    ? htmlMarkdown(text, landedAt)
    : { title: '', markdown: text.trim() };
  if (answer.status >= 400) {
    const refused = [401, 403, 429, 503].includes(answer.status);
    return {
      url: landedAt,
      error: `answered ${answer.status}${title ? ` "${title}"` : ''}${
        refused
          ? `; the site may let only a browser in, so open it with ${held.app.id}_navigate`
          : ''
      }`,
    };
  }
  if (html && markdown.length < 200 && /<script/i.test(text)) {
    return {
      url: landedAt,
      title,
      error: `shows its content only through scripts, which the reader does not run; open it with ${held.app.id}_navigate and read it with ${held.app.id}_extract`,
    };
  }
  const from = Math.min(start, markdown.length);
  return {
    url: landedAt,
    title,
    markdown: markdown.slice(from, from + cap),
    start: from,
    total: markdown.length,
  };
};

// ---- The backend ----------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A page script call as the one expression the surface evaluates: the
 *  function with its argument, then the functions it takes after it. */
const script = (fn, arg, helpers) =>
  `(${fn})(${[JSON.stringify(arg), ...helpers.map(String)].join(', ')})`;

const parseIndex = (value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error('index must be a positive integer from the latest state');
  }
  return n;
};

const gone = (index) =>
  new Error(`[${index}] is not on the page any more — call state and use a fresh index`);

let held = null;

/** The sessions whose tab the person sees, as the last tab command of each
 *  answered. A search reads it before it sends any command, since a
 *  command waits for a window when none is open. */
const inSight = new Set();

/** One tab command on the session's executor surface. */
const send = async (session, op, args) => {
  const out = await held.surface.command(op, args);
  if (out.shown) inSight.add(session);
  else inSight.delete(session);
  return out;
};

/** The page a handoff was last raised for: the person answered it once,
 *  and the page does not ask again until the tab has left it. */
let handedOver = null;

/** A page only the person gets past goes to them with the visible tab:
 *  a bot check, or a sign-in. Answers whether they pressed Done. */
const handOver = async (session, out, kind) => {
  if (handedOver === out.url) return false;
  handedOver = out.url;
  await send(session, 'show', {});
  const answer = await held.ask(
    kind === 'signin'
      ? {
          kind,
          text: `"${out.title}" at ${out.url} asks you to sign in. Take the browser tab, sign in, then press Done to continue.`,
        }
      : {
          kind,
          text: `"${out.title}" at ${out.url} looks like a check only you can pass. Take the browser tab, solve it, then press Done to continue.`,
        },
  );
  return answer.allow;
};

/** A challenge page goes to the person; on "Done" the same command runs
 *  once more. */
const guarded = async (session, op, args) => {
  const out = await send(session, op, args);
  if (out.url !== handedOver) handedOver = null;
  if (typeof out.title === 'string' && CHALLENGE.test(out.title)) {
    if (await handOver(session, out, 'handoff')) return send(session, op, args);
  }
  return out;
};

/** Runs a page script in the session's tab and parses its answer.
 *  `guard` routes a challenge page to the handoff; `settle` makes the
 *  surface wait for the navigation the script may have started. */
const runScript = async (
  session,
  fn,
  arg,
  { guard = false, settle = false, helpers = [] } = {},
) => {
  const out = await (guard ? guarded : send)(session, 'evaluate', {
    js: script(fn, { attr: INDEX_ATTR, ...arg }, helpers),
    settle,
  });
  let value;
  try {
    value = JSON.parse(out.result);
  } catch {
    throw new Error('the page answered with more than the surface carries');
  }
  return { out, value };
};

const landed = (out) => `${out.title ? `"${out.title}" — ` : ''}${out.url ?? ''}`;

/** The words of a state's scroll line. */
const scrollWords = (value) => {
  const where = `${value.above ? `${value.above}px above` : 'top of page'}, ${
    value.below ? `${value.below}px below` : 'end of page'
  }`;
  const outside = value.outside
    ? `; ${value.outside} more link${value.outside === 1 ? '' : 's'} and controls outside the view`
    : '';
  const cut = value.truncated ? '; the state is cut at its budget, scroll for more' : '';
  return `Scroll: ${where}${outside}${cut}`;
};

/** The indexed state of the session's tab. A page swapping documents
 *  under the script answers with an error once; the second pass reads
 *  the document that landed. A page with a bot check or a sign-in goes to
 *  the person first. */
const stateOf = async (session) => {
  const read = () => runScript(session, pageState, { maxChars: STATE_CHARS }, { guard: true });
  let failure;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      let { out, value } = await read();
      const kind = value.challenge ? 'handoff' : value.signIn ? 'signin' : null;
      if (kind && (await handOver(session, out, kind))) ({ out, value } = await read());
      return [landed(out), scrollWords(value), '', value.text || '(the page shows nothing)'].join(
        '\n',
      );
    } catch (e) {
      failure = e;
      await sleep(700);
    }
  }
  throw failure;
};

/** An action's answer: what it did, then the state it left. */
const after = async (session, note, delayMs) => {
  if (delayMs) await sleep(delayMs);
  return `${note}\n\n${await stateOf(session)}`;
};

const formatOptions = (value) =>
  value.options.length
    ? value.options
        .map((op, i) => `${i + 1}. ${op.text}${op.selected ? ' (selected)' : ''}`)
        .join('\n')
    : null;

/** Clicks the middle of the indexed element as the person would; with
 *  `field`, only an element that takes text. */
const pressOn = async (session, index, field = false) => {
  const { value } = await runScript(session, pageTarget, { index, field });
  if (value === 'missing') throw gone(index);
  if (value === 'select') throw new Error(`[${index}] is a dropdown — use select_dropdown`);
  if (value === 'not-editable') throw new Error(`[${index}] does not take text`);
  if (value === 'hidden') throw new Error(`[${index}] has no size on the page — call state`);
  if (typeof value === 'string') {
    throw new Error(
      `[${index}] is covered by a <${value.slice('covered:'.length)}> — close or scroll past what covers it`,
    );
  }
  await send(session, 'click', value);
};

/** Other names of keys, as a model may write them. */
const KEY_NAMES = {
  ctrl: 'Control',
  cmd: 'Meta',
  command: 'Meta',
  win: 'Meta',
  option: 'Alt',
  esc: 'Escape',
  return: 'Enter',
  del: 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  pgup: 'PageUp',
  pgdn: 'PageDown',
};

/** A combination in the names the surface takes: `ctrl+a` is `Control+a`. */
const keyCombo = (combo) =>
  combo
    .split(/\+(?=.)/)
    .map((part) => KEY_NAMES[part.toLowerCase()] ?? part)
    .join('+');

/** Whether the person still sees the session's tab as a search starts. The
 *  person may have closed it since the last tab command, which only the
 *  next command tells: one that opens no tab asks again, and fails when no
 *  tab is left for it, which clears the record. */
const tabInSight = async (session) => {
  if (!inSight.has(session)) return false;
  try {
    await send(session, 'evaluate', { js: 'true' });
  } catch {
    inSight.delete(session);
  }
  return inSight.has(session);
};

/** A search's answer: what it did, then the results as a numbered list
 *  and how to read them. */
const searchText = (lead, results) =>
  [
    lead,
    results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`)
      .join('\n'),
    `Read pages with ${held.app.id}_read_pages, several at once; ${held.app.id}_navigate opens one in a tab.`,
  ].join('\n\n');

/** A search in the session's tab, which the person sees: Google's page
 *  there, whose bot check goes to the person. */
const searchInTab = async (session, query) => {
  const out = await guarded(session, 'navigate', { url: GOOGLE_SEARCH(query) });
  const did = `Searched Google for "${query}"`;
  const lead = out.shown ? `${did}.` : QUIET_NOTE(did);
  const listed = async () =>
    (
      await runScript(
        session,
        pageResults,
        { max: RESULTS_MOST, snippet: SNIPPET_CHARS },
        { guard: true },
      )
    ).value;
  let results = await listed();
  if (!results.length) {
    // A page that draws its results with scripts lists them a moment
    // after it has loaded.
    await sleep(1000);
    results = await listed();
  }
  if (results.length) return { text: searchText(lead, results), results };
  // The state hands a bot check to the person, and the page they pass to
  // lists the results.
  const state = await stateOf(session);
  results = await listed();
  return results.length
    ? { text: searchText(lead, results), results }
    : { text: `${lead} The page lists no results.\n\n${state}`, results };
};

/** A search only the chat shows: DuckDuckGo's page without scripts,
 *  fetched through the backend's own network, with no tab. */
const searchWithoutTab = async (query) => {
  const answer = await held.net.fetch({
    url: DUCKDUCKGO_SEARCH(query),
    headers: READ_HEADERS,
    timeoutMs: READ_TIMEOUT_MS,
  });
  const doc = parseHtml(textOf(bytesOf(answer.body), contentType(answer)));
  if (findElement(doc, (el) => hasClass(el, 'anomaly-modal__modal'))) {
    throw new Error(
      `DuckDuckGo shows a bot check instead of results. Search again in a few minutes, or read pages you know with ${held.app.id}_read_pages.`,
    );
  }
  if (answer.status !== 200) throw new Error(`DuckDuckGo answered ${answer.status}`);
  const results = duckResults(doc);
  const lead = `Searched DuckDuckGo for "${query}".`;
  return {
    text: results.length ? searchText(lead, results) : `${lead} It lists no results.`,
    results,
  };
};

/** A read's answer for one page: where it landed, then its Markdown and
 *  where to continue, or why it could not be read. */
const pageLines = (page, i, count) => {
  const head = `Page ${i + 1} of ${count}: ${page.title ? `"${page.title}" — ` : ''}${page.url}`;
  if (page.error) return `${head}\nNot read: it ${page.error}.`;
  const end = page.start + page.markdown.length;
  const more =
    end < page.total
      ? `\n[Characters ${page.start}–${end} of ${page.total}; call read_pages with this address and start=${end} for the rest.]`
      : '';
  return `${head}\n\n${page.markdown || '(the page has no content)'}${more}`;
};

/** What a tool answers while the person keeps the agent out. */
const OFF =
  "The person turned off agent control in the Browser's settings. Ask them to turn it on, or answer without the browser.";

/** Whether the person lets an agent control the browser, as the
 *  Browser's settings in the app's store keep it. */
const allowed = async () => {
  const settings = await held.store.get('settings');
  return !(settings && typeof settings === 'object' && settings.agent === false);
};

/** Each tool's body, called with its input and the session of its call. */
const tools = {
  async navigate({ url }, session) {
    const out = await guarded(session, 'navigate', { url: String(url) });
    return after(session, out.shown ? 'Navigated.' : QUIET_NOTE('Navigated'), 0);
  },
  async search({ query }, session) {
    const words = String(query);
    const { text, results } = (await tabInSight(session))
      ? await searchInTab(session, words)
      : await searchWithoutTab(words);
    return { content: [{ kind: 'text', text }], structured: { query: words, results } };
  },
  async read_pages({ urls, start }) {
    const list = [...new Set(urls.map((u) => String(u).trim()))].filter(Boolean);
    if (!list.length) throw new Error('urls names no address');
    if (list.length > READ_PAGES_MOST) {
      throw new Error(`read takes at most ${READ_PAGES_MOST} addresses at once`);
    }
    const from = Number(start) > 0 ? Math.floor(Number(start)) : 0;
    const cap = Math.min(EXTRACT_CHARS, Math.floor(READ_CHARS / list.length));
    const pages = await Promise.all(list.map((url) => readPage(url, from, cap)));
    const text = pages.map((page, i) => pageLines(page, i, pages.length)).join('\n\n');
    return { content: [{ kind: 'text', text }], structured: { pages } };
  },
  async show(_, session) {
    await send(session, 'show', {});
    return 'The tab is in front of the person now.';
  },
  async go_back(_, session) {
    await send(session, 'evaluate', { js: '(history.back(), true)' });
    return after(session, 'Went back.', 800);
  },
  state: (_, session) => stateOf(session),
  async click({ index }, session) {
    const i = parseIndex(index);
    await pressOn(session, i);
    return after(session, `Clicked [${i}].`, 300);
  },
  async input({ index, text, clear }, session) {
    const i = parseIndex(index);
    await pressOn(session, i, true);
    const { value } = await runScript(session, pageCaret, { index: i, clear: clear !== false });
    if (value === 'missing') throw gone(i);
    await send(session, 'type', { text: String(text) });
    return after(session, `Typed into [${i}].`, 200);
  },
  async send_keys({ keys }, session) {
    const combos = String(keys).trim().split(/\s+/).filter(Boolean).map(keyCombo);
    for (const key of combos) await send(session, 'press', { key });
    return after(session, `Sent keys: ${combos.join(', ') || '(none)'}.`, 800);
  },
  async scroll({ down, pages, index }, session) {
    const count = Number(pages) > 0 ? Number(pages) : 1;
    const i = index === undefined ? 0 : parseIndex(index);
    const { value } = await runScript(session, pageScroll, {
      down: down !== false,
      pages: count,
      index: i,
    });
    if (value === 'missing') throw gone(i);
    const note = value.moved
      ? `Scrolled ${value.target} ${Math.abs(value.moved)}px ${value.moved > 0 ? 'down' : 'up'}.`
      : `${value.target} did not move — it is already at the ${down !== false ? 'bottom' : 'top'}.`;
    return after(session, note, 300);
  },
  async find_text({ text }, session) {
    const { out, value: passage } = await runScript(session, pageFindText, {
      text: String(text),
      around: 300,
    });
    if (passage === null) return after(session, `"${String(text)}" is not on the page.`, 200);
    await sleep(200);
    const { value } = await runScript(session, pageState, {
      maxChars: STATE_CHARS,
      near: NEAR_PX,
    });
    return [
      `Found "${String(text)}" on ${landed(out)}:`,
      passage,
      '',
      value.text ? `Near it:\n${value.text}` : 'No link or control is near it.',
    ].join('\n');
  },
  async search_page({ pattern, max }, session) {
    const cap = Number(max) > 0 ? Math.min(Number(max), 200) : 30;
    const { out, value } = await runScript(session, pageSearch, {
      pattern: String(pattern),
      max: cap,
    });
    const body = value.total
      ? `${value.total} matching line${value.total === 1 ? '' : 's'}${
          value.total > value.hits.length ? `, first ${value.hits.length}` : ''
        }:\n${value.hits.join('\n')}`
      : 'No line matches.';
    return `${landed(out)}\n\n${body}`;
  },
  async find_elements({ selector, attributes, max }, session) {
    const cap = Number(max) > 0 ? Math.min(Number(max), 100) : 20;
    const { out, value } = await runScript(session, pageFindElements, {
      selector: String(selector),
      attributes: Array.isArray(attributes) ? attributes.map(String) : [],
      max: cap,
    });
    if (value === 'bad-selector') throw new Error(`"${String(selector)}" is not a valid selector`);
    const lines = value.elements.map((el) => {
      const attrs = Object.entries(el.attrs)
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ');
      return `${el.index ? `[${el.index}] ` : ''}<${el.tag}${attrs ? ` ${attrs}` : ''}>${el.text}`;
    });
    const body = value.total
      ? `${value.total} element${value.total === 1 ? '' : 's'}${
          value.total > lines.length ? `, first ${lines.length}` : ''
        }:\n${lines.join('\n')}`
      : 'Nothing matches.';
    return `${landed(out)}\n\n${body}`;
  },
  async dropdown_options({ index }, session) {
    const i = parseIndex(index);
    const { value } = await runScript(session, pageDropdownOptions, { index: i });
    if (value === 'missing') throw gone(i);
    const list = formatOptions(value);
    const body = list
      ? `Options of [${i}]:\n${list}`
      : value.kind === 'select'
        ? `[${i}] has no options.`
        : `[${i}] is closed — click it, then call dropdown_options again.`;
    return body;
  },
  async select_dropdown({ index, text }, session) {
    const i = parseIndex(index);
    const arg = { index: i, text: String(text) };
    let { value } = await runScript(session, pageSelectDropdown, arg);
    if (value === 'closed') {
      // A custom dropdown lists its options only once opened.
      await pressOn(session, i);
      await sleep(400);
      ({ value } = await runScript(session, pageSelectDropdown, arg));
    }
    if (value === 'missing') throw gone(i);
    if (value === 'closed') throw new Error(`[${i}] shows no options after opening`);
    if (value === 'no-option') {
      throw new Error(`[${i}] has no option "${String(text)}" — call dropdown_options`);
    }
    if (value.x !== undefined) await send(session, 'click', { x: value.x, y: value.y });
    return after(session, `Selected "${value.selected}" in [${i}].`, 200);
  },
  async extract({ start }, session) {
    const from = Number(start) > 0 ? Math.floor(Number(start)) : 0;
    const { out, value } = await runScript(
      session,
      pageExtract,
      { start: from, maxChars: EXTRACT_CHARS },
      { helpers: [toMarkdown] },
    );
    const end = value.start + value.markdown.length;
    const more =
      end < value.total
        ? `\n\n[Characters ${value.start}–${end} of ${value.total}; call extract with start=${end} for the rest.]`
        : '';
    return `${landed(out)}\n\n${value.markdown || '(the page has no content)'}${more}`;
  },
  async evaluate({ js }, session) {
    const out = await send(session, 'evaluate', { js: String(js) });
    return out.result === undefined ? '(undefined)' : String(out.result);
  },
  async wait({ seconds }, session) {
    const s = Math.min(30, Math.max(0, Number(seconds) || 0));
    return after(session, `Waited ${s} s.`, s * 1000);
  },
  async screenshot(_, session) {
    const { value: boxes } = await runScript(session, pageOverlay, { show: true });
    let out;
    try {
      out = await send(session, 'screenshot', {});
    } finally {
      await runScript(session, pageOverlay, { show: false }).catch(() => {});
    }
    if (!out.asset) throw new Error('the surface returned no image');
    return {
      content: [
        { kind: 'asset', asset: out.asset, mediaType: 'image/png', name: 'screenshot.png' },
        {
          kind: 'text',
          text: `${boxes} element${boxes === 1 ? '' : 's'} labelled by state index.`,
        },
      ],
    };
  },
  async close(_, session) {
    await send(session, 'close', {});
    return 'The tab is closed.';
  },
};

module.exports = {
  activate(ctx) {
    held = ctx;
  },
  tools: Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [
      name,
      async (input, run) => {
        if (!(await allowed())) throw new Error(OFF);
        return tool(input, run.context.session);
      },
    ]),
  ),
};

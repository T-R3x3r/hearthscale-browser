'use strict';
/* global window, document */
/**
 * The Browser plugin's backend: the browser-use action set over
 * Hearthscale's own Chromium. The backend never touches a page itself:
 * each tool sends tab commands to the session's executor surface, which
 * runs them and answers with the page's address and title and whether the
 * tab is shown, so the tab and the tools may sit on different machines.
 * The page reaches the model as an indexed state, and the functions under
 * "page scripts" run inside the page, reaching only `window` and
 * `document`. A bot check is never defeated
 * and a password is never typed: a challenge page or a sign-in page raises
 * the handoff, the person takes the tab, and the command runs again.
 */

/** Titles that mark a page as a challenge only a human passes. */
const CHALLENGE = /just a moment|verify you are human|captcha|attention required|are you a robot/i;

/** The surface clips an evaluate result at 20,000 characters; the page
 *  scripts keep their own output under that so the JSON arrives whole.
 *  Every action returns a state, so a state stays small enough that a
 *  chain of actions fits a 16k-token local model's window. */
const STATE_CHARS = 8000;
const EXTRACT_CHARS = 12000;
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

const SEARCH_ENGINES = {
  google: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}&udm=14`,
  duckduckgo: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
  bing: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
};

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
  return {
    text: lines.join('\n'),
    count,
    outside,
    signIn,
    above: Math.round(w.scrollY),
    below: Math.max(0, Math.round(height - w.scrollY - vh)),
    truncated,
  };
}

/** Clicks the indexed element. The navigation a click may start is the
 *  surface's to wait for. */
function pageClick(o) {
  const el = document.querySelector(`[${o.attr}="${o.index}"]`);
  if (!el) return 'missing';
  el.scrollIntoView({ block: 'center' });
  el.click();
  return 'ok';
}

/** Types into the indexed element through the native value setter, so
 *  framework-bound fields see the change; editable regions take the text
 *  through the editing command so their editors see it too. */
function pageInput(o) {
  const w = window;
  const d = document;
  const el = d.querySelector(`[${o.attr}="${o.index}"]`);
  if (!el) return 'missing';
  const tag = el.localName;
  if (tag === 'select') return 'select';
  el.scrollIntoView({ block: 'center' });
  el.focus();
  if (tag === 'input' || tag === 'textarea') {
    if (tag === 'input' && /^(checkbox|radio|button|submit|reset|file|image)$/.test(el.type)) {
      return 'not-editable';
    }
    const proto = tag === 'input' ? w.HTMLInputElement.prototype : w.HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(
      el,
      o.clear ? o.text : el.value + o.text,
    );
    el.dispatchEvent(new w.Event('input', { bubbles: true }));
    el.dispatchEvent(new w.Event('change', { bubbles: true }));
    return 'ok';
  }
  if (el.isContentEditable) {
    if (o.clear) d.execCommand('selectAll', false, null);
    d.execCommand('insertText', false, o.text);
    return 'ok';
  }
  return 'not-editable';
}

/** Dispatches key combinations to the focused element. Tab moves focus
 *  by hand, and an uncancelled Enter submits the field's form or
 *  activates the focused control, since dispatched events carry no
 *  default action of their own. */
function pageKeys(o) {
  const w = window;
  const d = document;
  const CODES = {
    Enter: 13,
    Escape: 27,
    Tab: 9,
    Backspace: 8,
    Delete: 46,
    ArrowUp: 38,
    ArrowDown: 40,
    ArrowLeft: 37,
    ArrowRight: 39,
    Home: 36,
    End: 35,
    PageUp: 33,
    PageDown: 34,
    ' ': 32,
  };
  const focusable = () =>
    [
      ...d.querySelectorAll(
        'a[href],button,input,select,textarea,summary,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]',
      ),
    ].filter(
      (e) =>
        !e.disabled &&
        e.getBoundingClientRect().width > 0 &&
        w.getComputedStyle(e).visibility !== 'hidden',
    );
  const done = [];
  for (const combo of String(o.keys).trim().split(/\s+/)) {
    const parts = combo.split('+');
    let key = parts.pop();
    if (!key) continue;
    const mods = new Set(parts.map((m) => m.toLowerCase()));
    if (/^space$/i.test(key)) key = ' ';
    const shift = mods.has('shift');
    if (key.length === 1) key = shift ? key.toUpperCase() : key;
    const code =
      key === ' '
        ? 'Space'
        : /^[a-z]$/i.test(key)
          ? `Key${key.toUpperCase()}`
          : /^[0-9]$/.test(key)
            ? `Digit${key}`
            : key;
    const keyCode = CODES[key] ?? key.toUpperCase().charCodeAt(0);
    const init = {
      key,
      code,
      keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
      ctrlKey: mods.has('control') || mods.has('ctrl'),
      shiftKey: shift,
      altKey: mods.has('alt'),
      metaKey: mods.has('meta') || mods.has('cmd') || mods.has('command'),
    };
    const target = d.activeElement && d.activeElement !== d.body ? d.activeElement : d.body;
    if (key === 'Tab' && !init.ctrlKey && !init.altKey && !init.metaKey) {
      const list = focusable();
      const i = list.indexOf(target);
      const next = list[(i + (shift ? -1 : 1) + list.length) % list.length];
      if (next) next.focus();
      done.push(`${combo} → ${next ? next.localName : 'nothing'}`);
      continue;
    }
    const cancelled = !target.dispatchEvent(new w.KeyboardEvent('keydown', init));
    target.dispatchEvent(new w.KeyboardEvent('keypress', init));
    if (!cancelled && key === 'Enter') {
      const tag = target.localName;
      if (target.form && tag === 'input') {
        if (target.form.requestSubmit) target.form.requestSubmit();
        else target.form.submit();
      } else if (tag === 'button' || tag === 'a' || target.getAttribute('role') === 'button') {
        target.click();
      }
    }
    if (!cancelled && key === ' ') {
      const role = target.getAttribute('role');
      if (target.localName === 'button' || role === 'button' || role === 'checkbox') target.click();
    }
    target.dispatchEvent(new w.KeyboardEvent('keyup', init));
    done.push(combo);
  }
  return done.join(', ');
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

/** Chooses the option whose text matches, in a native select or an open
 *  ARIA listbox. */
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
    return `selected:${op.text.trim()}`;
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
  op.click();
  return `selected:${String(op.innerText || '')
    .trim()
    .slice(0, 80)}`;
}

/** The main content as Markdown, sliced from `start` to fit the surface. */
function pageExtract(o) {
  const w = window;
  const d = document;
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
  const BLOCK = /^(block|flex|grid|list-item|table|table-row|flow-root)$/;
  const inline = (t) => t.replace(/\s+/g, ' ');
  let out = '';
  const emit = (t) => {
    out += t;
  };
  const conv = (node, ctx) => {
    if (node.nodeType === 3) {
      emit(ctx.pre ? node.data : inline(node.data));
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node;
    const tag = el.localName;
    if (SKIP.has(tag) || el.getAttribute('aria-hidden') === 'true') return;
    const s = w.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return;
    const kids = (c = ctx) => {
      if (el.shadowRoot) for (const n of el.shadowRoot.childNodes) conv(n, c);
      for (const n of el.childNodes) conv(n, c);
    };
    switch (tag) {
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        emit(`\n\n${'#'.repeat(Number(tag[1]))} `);
        kids();
        emit('\n\n');
        return;
      case 'br':
        emit('\n');
        return;
      case 'hr':
        emit('\n\n---\n\n');
        return;
      case 'ul':
      case 'ol': {
        emit('\n');
        let n = 0;
        for (const c of el.children) {
          if (c.localName !== 'li') {
            conv(c, ctx);
            continue;
          }
          n += 1;
          emit(`\n${'  '.repeat(ctx.depth)}${tag === 'ol' ? `${n}. ` : '- '}`);
          const sub = { ...ctx, depth: ctx.depth + 1 };
          for (const cc of c.childNodes) conv(cc, sub);
        }
        emit('\n');
        return;
      }
      case 'li':
        emit('\n- ');
        kids();
        return;
      case 'a': {
        const href = el.getAttribute('href');
        if (!href || /^(javascript:|#)/.test(href)) {
          kids();
          return;
        }
        emit('[');
        kids();
        emit(`](${el.href})`);
        return;
      }
      case 'img': {
        const alt = inline(el.getAttribute('alt') || '').trim();
        if (alt) emit(`[image: ${alt}]`);
        return;
      }
      case 'strong':
      case 'b':
        emit('**');
        kids();
        emit('**');
        return;
      case 'em':
      case 'i':
        emit('*');
        kids();
        emit('*');
        return;
      case 'code':
        if (ctx.pre) {
          kids();
          return;
        }
        emit('`');
        kids();
        emit('`');
        return;
      case 'pre':
        emit('\n\n```\n');
        kids({ ...ctx, pre: true });
        emit('\n```\n\n');
        return;
      case 'blockquote':
        emit('\n\n> ');
        kids();
        emit('\n\n');
        return;
      case 'table': {
        // A grid of equal rows is data; anything else is layout and its
        // cells read as ordinary blocks.
        const rows = [...el.querySelectorAll('tr')].filter((tr) => tr.closest('table') === el);
        const widths = new Set(rows.map((tr) => tr.children.length));
        const grid =
          rows.length > 1 && widths.size === 1 && !widths.has(1) && !el.querySelector('table');
        if (!grid) {
          emit('\n');
          kids();
          emit('\n');
          return;
        }
        emit('\n\n');
        rows.forEach((tr, i) => {
          const cells = [...tr.children].map((c) =>
            inline(c.innerText || '')
              .trim()
              .replace(/\|/g, '\\|'),
          );
          emit(`| ${cells.join(' | ')} |\n`);
          if (i === 0) emit(`|${cells.map(() => ' --- |').join('')}\n`);
        });
        emit('\n');
        return;
      }
      default:
        if (s.display === 'table-cell') {
          kids();
          emit(' ');
        } else if (BLOCK.test(s.display)) {
          emit('\n');
          kids();
          emit('\n');
        } else {
          kids();
        }
    }
  };
  conv(d.querySelector('main, [role="main"]') || d.body, { depth: 0, pre: false });
  const markdown = out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const start = Math.max(0, o.start);
  return { markdown: markdown.slice(start, start + o.maxChars), total: markdown.length, start };
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

// ---- The backend ----------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A page script call as the one expression the surface evaluates. */
const script = (fn, arg) => `(${fn})(${JSON.stringify(arg)})`;

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

/** One tab command on the session's executor surface. */
const send = (op, args) => held.surface.command(op, args);

/** The page a handoff was last raised for: the person answered it once,
 *  and the page does not ask again until the tab has left it. */
let handedOver = null;

/** A page only the person gets past goes to them with the visible tab:
 *  a bot check, or a sign-in. Answers whether they pressed Done. */
const handOver = async (out, kind) => {
  if (handedOver === out.url) return false;
  handedOver = out.url;
  await send('show', {});
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
const guarded = async (op, args) => {
  const out = await send(op, args);
  if (out.url !== handedOver) handedOver = null;
  if (typeof out.title === 'string' && CHALLENGE.test(out.title)) {
    if (await handOver(out, 'handoff')) return send(op, args);
  }
  return out;
};

/** Runs a page script in the session's tab and parses its answer.
 *  `guard` routes a challenge page to the handoff; `settle` makes the
 *  surface wait for the navigation the script may have started. */
const runScript = async (fn, arg, { guard = false, settle = false } = {}) => {
  const out = await (guard ? guarded : send)('evaluate', {
    js: script(fn, { attr: INDEX_ATTR, ...arg }),
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

/** The indexed state of the session's tab. A page swapping documents
 *  under the script answers with an error once; the second pass reads
 *  the document that landed. */
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
 *  the document that landed. A sign-in page goes to the person first. */
const stateOf = async () => {
  let failure;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      let { out, value } = await runScript(pageState, { maxChars: STATE_CHARS }, { guard: true });
      if (value.signIn && (await handOver(out, 'signin'))) {
        ({ out, value } = await runScript(pageState, { maxChars: STATE_CHARS }, { guard: true }));
      }
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
const after = async (note, delayMs) => {
  if (delayMs) await sleep(delayMs);
  return `${note}\n\n${await stateOf()}`;
};

const formatOptions = (value) =>
  value.options.length
    ? value.options
        .map((op, i) => `${i + 1}. ${op.text}${op.selected ? ' (selected)' : ''}`)
        .join('\n')
    : null;

/** What a tool answers while the person keeps the agent out. */
const OFF =
  "The person turned off agent control in the Browser's settings. Ask them to turn it on, or answer without the browser.";

/** Whether the person lets an agent control the browser, as the
 *  Browser's settings in the app's store keep it. */
const allowed = async () => {
  const settings = await held.store.get('settings');
  return !(settings && typeof settings === 'object' && settings.agent === false);
};

const tools = {
  async navigate({ url }) {
    const out = await guarded('navigate', { url: String(url) });
    return after(out.shown ? 'Navigated.' : QUIET_NOTE('Navigated'), 0);
  },
  async search({ query, engine }) {
    const to = SEARCH_ENGINES[String(engine ?? 'google')];
    if (!to) throw new Error(`unknown search engine "${String(engine)}"`);
    const out = await guarded('navigate', { url: to(String(query)) });
    const did = `Searched for "${String(query)}"`;
    return after(out.shown ? `${did}.` : QUIET_NOTE(did), 0);
  },
  async show() {
    await send('show', {});
    return 'The tab is in front of the person now.';
  },
  async go_back() {
    await send('evaluate', { js: '(history.back(), true)' });
    return after('Went back.', 800);
  },
  state: () => stateOf(),
  async click({ index }) {
    const i = parseIndex(index);
    const { value } = await runScript(pageClick, { index: i }, { settle: true });
    if (value === 'missing') throw gone(i);
    return after(`Clicked [${i}].`, 300);
  },
  async input({ index, text, clear }) {
    const i = parseIndex(index);
    const { value } = await runScript(pageInput, {
      index: i,
      text: String(text),
      clear: clear !== false,
    });
    if (value === 'missing') throw gone(i);
    if (value === 'select') throw new Error(`[${i}] is a dropdown — use select_dropdown`);
    if (value !== 'ok') throw new Error(`[${i}] does not take text`);
    return after(`Typed into [${i}].`, 200);
  },
  async send_keys({ keys }) {
    const { value } = await runScript(pageKeys, { keys: String(keys) });
    return after(`Sent keys: ${value || '(none)'}.`, 800);
  },
  async scroll({ down, pages, index }) {
    const count = Number(pages) > 0 ? Number(pages) : 1;
    const i = index === undefined ? 0 : parseIndex(index);
    const { value } = await runScript(pageScroll, { down: down !== false, pages: count, index: i });
    if (value === 'missing') throw gone(i);
    const note = value.moved
      ? `Scrolled ${value.target} ${Math.abs(value.moved)}px ${value.moved > 0 ? 'down' : 'up'}.`
      : `${value.target} did not move — it is already at the ${down !== false ? 'bottom' : 'top'}.`;
    return after(note, 300);
  },
  async find_text({ text }) {
    const { out, value: passage } = await runScript(pageFindText, {
      text: String(text),
      around: 300,
    });
    if (passage === null) return after(`"${String(text)}" is not on the page.`, 200);
    await sleep(200);
    const { value } = await runScript(pageState, { maxChars: STATE_CHARS, near: NEAR_PX });
    return [
      `Found "${String(text)}" on ${landed(out)}:`,
      passage,
      '',
      value.text ? `Near it:\n${value.text}` : 'No link or control is near it.',
    ].join('\n');
  },
  async search_page({ pattern, max }) {
    const cap = Number(max) > 0 ? Math.min(Number(max), 200) : 30;
    const { out, value } = await runScript(pageSearch, { pattern: String(pattern), max: cap });
    const body = value.total
      ? `${value.total} matching line${value.total === 1 ? '' : 's'}${
          value.total > value.hits.length ? `, first ${value.hits.length}` : ''
        }:\n${value.hits.join('\n')}`
      : 'No line matches.';
    return `${landed(out)}\n\n${body}`;
  },
  async find_elements({ selector, attributes, max }) {
    const cap = Number(max) > 0 ? Math.min(Number(max), 100) : 20;
    const { out, value } = await runScript(pageFindElements, {
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
  async dropdown_options({ index }) {
    const i = parseIndex(index);
    const { out, value } = await runScript(pageDropdownOptions, { index: i });
    if (value === 'missing') throw gone(i);
    const list = formatOptions(value);
    const body = list
      ? `Options of [${i}]:\n${list}`
      : value.kind === 'select'
        ? `[${i}] has no options.`
        : `[${i}] is closed — click it, then call dropdown_options again.`;
    return body;
  },
  async select_dropdown({ index, text }) {
    const i = parseIndex(index);
    const arg = { index: i, text: String(text) };
    let { value } = await runScript(pageSelectDropdown, arg);
    if (value === 'closed') {
      // A custom dropdown lists its options only once opened.
      await runScript(pageClick, { index: i });
      await sleep(400);
      ({ value } = await runScript(pageSelectDropdown, arg));
    }
    if (value === 'missing') throw gone(i);
    if (value === 'closed') throw new Error(`[${i}] shows no options after opening`);
    if (value === 'no-option') {
      throw new Error(`[${i}] has no option "${String(text)}" — call dropdown_options`);
    }
    return after(`Selected "${String(value).slice('selected:'.length)}" in [${i}].`, 200);
  },
  async extract({ start }) {
    const from = Number(start) > 0 ? Math.floor(Number(start)) : 0;
    const { out, value } = await runScript(pageExtract, { start: from, maxChars: EXTRACT_CHARS });
    const end = value.start + value.markdown.length;
    const more =
      end < value.total
        ? `\n\n[Characters ${value.start}–${end} of ${value.total}; call extract with start=${end} for the rest.]`
        : '';
    return `${landed(out)}\n\n${value.markdown || '(the page has no content)'}${more}`;
  },
  async evaluate({ js }) {
    const out = await send('evaluate', { js: String(js) });
    return out.result === undefined ? '(undefined)' : String(out.result);
  },
  async wait({ seconds }) {
    const s = Math.min(30, Math.max(0, Number(seconds) || 0));
    return after(`Waited ${s} s.`, s * 1000);
  },
  async screenshot() {
    const { value: boxes } = await runScript(pageOverlay, { show: true });
    let out;
    try {
      out = await send('screenshot', {});
    } finally {
      await runScript(pageOverlay, { show: false }).catch(() => {});
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
  async close() {
    await send('close', {});
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
      async (...args) => {
        if (!(await allowed())) throw new Error(OFF);
        return tool(...args);
      },
    ]),
  ),
};

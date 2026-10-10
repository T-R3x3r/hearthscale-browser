# Developing the Browser

`README.md` is the text the Marketplace shows under **About** on the Browser's listing, so it is written for the people who install the Browser. This file is for the people who work on it.

The Browser is an ordinary Hearthscale app. Nothing in the platform knows
its name; it installs from the Marketplace like any other app.

## What it holds

- `views/browser.js`: the Browser's tab. Its toolbar (back, forward,
  reload, the address, the menu) and its find bar lie over the tab's web
  page, which Hearthscale draws in the view's `web` slot on the Browser's
  own partition and the view drives with `hearthscale/web/*`. Each
  Browser tab is a tab of a tile; a link that opens a new window opens a
  new tab beside it.
- `backend.js`: the tools an agent drives the browser with. Each tool
  sends tab commands to the session's tab (`surface.command`): a
  navigation with no tab opens one out of sight, and `show` puts that
  same tab beside the conversation. A bot check or a sign-in page goes to
  the person with the `handoff` and `signin` cards.
- The view surface opens `https:` and `http:`, so Hearthscale can make
  the Browser the person's browser: a chat's links and the launcher's
  address open in it, and its settings hold the Dark web pages and Block
  ads switches.
- Browser settings hold the agent switch: with it off, every tool refuses.
  History, Downloads, Passwords and autofill, and Browser settings each
  open in a tab of their own; the keychain of the OS keeps the passwords.
- `environment.network` is `*`: a browser may load any site, and the
  enable card shows that as one fact.

## Working on it

With a Hearthscale platform running on this machine:

```sh
hearthscale dev .
```

links this folder into the running platform, picks up every change, and
asks once in the window before any code runs.

## Releasing

Install the Hearthscale registry's GitHub App on this repository once. Then
every release whose tag equals `version` in `app.json` is picked up by the
Marketplace.

```sh
hearthscale pack .
```

builds the package to attach to the release.

## Licence

MIT. See `LICENSE`.

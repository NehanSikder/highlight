# Highlight

A distraction-light, typewriter-mode book reader that runs entirely in your
browser. It lights one line at a time and keeps it at a fixed spot on screen,
so your eyes never travel to find your place. It's a standalone reader and
needs nothing else to run.

**Live:** https://nehansikder.github.io/highlight/

## What it does

- **Typewriter mode.** The current line is highlighted at a fixed screen
  position; the text scrolls underneath it as you advance, so your eyes never
  travel to find your place.
- **Line-exact resume.** Position is saved per book at line granularity, so
  reopening (or switching back mid-session) lands you exactly where you left.
- **Reads `.epub`, `.txt`, `.md`.** Drag a file anywhere onto the page. Epubs
  are parsed in-browser (vendored JSZip); nothing is uploaded and no server is
  involved. Books are stored locally in IndexedDB.
- **Contents panel.** Press `c` or the ☰ button to jump between chapters.
- **Dark / light toggle**, following your system theme until you choose.

## Controls

| Key | Action |
|---|---|
| `↓` / `j` / scroll | Next line |
| `↑` / `k` | Previous line |
| `Space` / `PgDn` | Forward 10 lines |
| `PgUp` | Back 10 lines |
| `c` / ☰ | Contents |
| `Esc` / `b` | Library |

## Running it

Three equivalent options:

1. **Hosted:** open the live URL above. Nothing to install.
2. **Local file:** clone this repo and open `index.html` in a browser.
   (Note: Safari blocks IndexedDB on `file://` pages, so books won't persist
   there — use the hosted page or a Chromium browser for local files.)
3. **Installed app:** from Chrome/Edge/Arc, *Install page as app*; from Safari,
   *Add to Dock*. Gives the reader its own window and app identity.

## Privacy

Everything happens in your browser. Book files are parsed client-side and
stored in your browser's local IndexedDB; reading progress lives in
localStorage. No network requests, no accounts, no telemetry.

## Relationship to the hooks

The [readwhile](https://github.com/NehanSikder/readwhile) hook engine (a
separate repo) can auto-focus this reader while your coding agent works and
return you to the terminal when it needs you. That engine identifies this
reader by its window title (`Highlight`) or app name — there is **no code
dependency** in either direction. This reader is fully usable on its own, and
the hooks can point at any reading app.

## License

MIT

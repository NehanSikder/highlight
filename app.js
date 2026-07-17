/* Readwhile — typewriter-mode reader.
 *
 * Model: a book is a flat array of pre-wrapped lines. The current line is
 * highlighted at a fixed viewport position (--marker-y); arrow keys scroll
 * the text underneath it. Position persists per book at line granularity.
 * Rendering is windowed (~200 lines around the cursor) so large books stay
 * cheap.
 */

"use strict";

const MEASURE = 66;           // wrap width in characters, matches --measure
const RENDER_WINDOW = 100;    // lines rendered above/below the cursor
const DB_NAME = "readwhile";
const DB_VERSION = 1;

// ---------- status surface ----------
// Every failure must be visible on the page; silent failure is forbidden.

let statusTimer = null;
function status(msg, sticky) {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(statusTimer);
  if (!sticky) statusTimer = setTimeout(() => { el.hidden = true; }, 6000);
  console.warn("[readwhile]", msg);
}

window.addEventListener("error", (e) => status("Error: " + e.message, true));
window.addEventListener("unhandledrejection", (e) =>
  status("Error: " + (e.reason?.message || e.reason), true));

function newId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : "b-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

// ---------- IndexedDB ----------

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("books", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbPut(db, book) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("books", "readwrite");
    tx.objectStore("books").put(book);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function dbAll(db) {
  return new Promise((resolve, reject) => {
    const req = db.transaction("books").objectStore("books").getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGet(db, id) {
  return new Promise((resolve, reject) => {
    const req = db.transaction("books").objectStore("books").get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbDelete(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("books", "readwrite");
    tx.objectStore("books").delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

/* Storage with graceful degradation: IndexedDB when available; otherwise an
 * in-memory store with a visible warning (Safari blocks IndexedDB on file://
 * pages — the hosted/installed app is unaffected). */
async function initStore() {
  try {
    const db = await openDb();
    // Some browsers only fail at first transaction, so probe with a read.
    await dbAll(db);
    return {
      persistent: true,
      put: (b) => dbPut(db, b),
      all: () => dbAll(db),
      get: (id) => dbGet(db, id),
      remove: (id) => dbDelete(db, id),
    };
  } catch (err) {
    const mem = new Map();
    status(
      "This browser blocks storage for local files — books won't be saved. " +
      "Use the hosted page (or Chrome) and install it as an app.", true);
    return {
      persistent: false,
      put: async (b) => { mem.set(b.id, b); },
      all: async () => [...mem.values()],
      get: async (id) => mem.get(id),
      remove: async (id) => { mem.delete(id); },
    };
  }
}

// ---------- progress + metrics (localStorage: small, synchronous) ----------

function loadProgress() {
  try { return JSON.parse(localStorage.getItem("rw-progress") || "{}"); }
  catch { return {}; }
}

function saveProgress(bookId, line) {
  const p = loadProgress();
  p[bookId] = line;
  localStorage.setItem("rw-progress", JSON.stringify(p));
}

/* Every forward line-advance increments today's counter. This is the raw
 * feed for the (deferred) metrics/streaks layer — collected from day one,
 * no UI yet. */
function logLineRead() {
  const day = new Date().toISOString().slice(0, 10);
  let log;
  try { log = JSON.parse(localStorage.getItem("rw-lines-read") || "{}"); }
  catch { log = {}; }
  log[day] = (log[day] || 0) + 1;
  localStorage.setItem("rw-lines-read", JSON.stringify(log));
}

// ---------- text → lines ----------

/* Wrap one paragraph to the measure by words. Returns array of line strings. */
function wrapParagraph(text, width) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if (cur && cur.length + 1 + w.length > width) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cur ? cur + " " + w : w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/* paragraphs: [{text, heading?}] → flat line list [{t, h?}], blank line
 * entries ({t:""}) between paragraphs. */
function paragraphsToLines(paragraphs) {
  const lines = [];
  for (const p of paragraphs) {
    const wrapped = wrapParagraph(p.text, MEASURE);
    for (const t of wrapped) lines.push(p.heading ? { t, h: 1 } : { t });
    if (wrapped.length) lines.push({ t: "" });
  }
  while (lines.length && lines[lines.length - 1].t === "") lines.pop();
  return lines;
}

// ---------- file parsing ----------

function parsePlainText(text) {
  // Paragraph = blank-line-separated block. Markdown headings become headings.
  const blocks = text.replace(/\r\n/g, "\n").split(/\n\s*\n/);
  const paragraphs = [];
  for (const b of blocks) {
    const t = b.replace(/\n/g, " ").trim();
    if (!t) continue;
    const m = t.match(/^#{1,6}\s+(.*)$/);
    if (m) paragraphs.push({ text: m[1], heading: true });
    else paragraphs.push({ text: t });
  }
  return paragraphs;
}

async function parseEpub(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const xml = (s) => new DOMParser().parseFromString(s, "application/xml");

  const containerFile = zip.file("META-INF/container.xml");
  if (!containerFile) throw new Error("Not a valid epub (no container.xml)");
  const container = xml(await containerFile.async("string"));
  const rootfile = container.querySelector("rootfile")?.getAttribute("full-path");
  if (!rootfile) throw new Error("Not a valid epub (no rootfile)");

  const opfFile = zip.file(rootfile);
  if (!opfFile) throw new Error("Epub rootfile missing: " + rootfile);
  const opf = xml(await opfFile.async("string"));
  const opfDir = rootfile.includes("/") ? rootfile.slice(0, rootfile.lastIndexOf("/") + 1) : "";

  const title =
    opf.getElementsByTagName("dc:title")[0]?.textContent?.trim() || null;

  const manifest = {};
  for (const item of opf.querySelectorAll("manifest > item")) {
    manifest[item.getAttribute("id")] = item.getAttribute("href");
  }

  const paragraphs = [];
  for (const itemref of opf.querySelectorAll("spine > itemref")) {
    const href = manifest[itemref.getAttribute("idref")];
    if (!href) continue;
    const path = decodeURIComponent(opfDir + href).replace(/#.*$/, "");
    const file = zip.file(path);
    if (!file) continue;
    const doc = new DOMParser().parseFromString(
      await file.async("string"), "text/html");
    for (const el of doc.body?.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, blockquote") ?? []) {
      const text = el.textContent.replace(/\s+/g, " ").trim();
      if (!text) continue;
      paragraphs.push(/^h[1-6]$/i.test(el.tagName)
        ? { text, heading: true }
        : { text });
    }
  }
  if (!paragraphs.length) throw new Error("No readable text found in epub");
  return { paragraphs, title };
}

async function fileToBook(file) {
  const name = file.name.replace(/\.(epub|txt|md|markdown)$/i, "");
  let paragraphs, title = name;
  if (/\.epub$/i.test(file.name)) {
    const parsed = await parseEpub(await file.arrayBuffer());
    paragraphs = parsed.paragraphs;
    if (parsed.title) title = parsed.title;
  } else if (/\.(txt|md|markdown)$/i.test(file.name)) {
    paragraphs = parsePlainText(await file.text());
  } else {
    throw new Error("Unsupported file type: " + file.name + " (use .epub, .txt, .md)");
  }
  const lines = paragraphsToLines(paragraphs);
  if (!lines.length) throw new Error("File contained no text: " + file.name);
  return {
    id: newId(),
    title,
    addedAt: Date.now(),
    lines,
  };
}

// ---------- views ----------

const $ = (id) => document.getElementById(id);

const state = {
  store: null,
  book: null,     // currently open book
  line: 0,        // current line index
  lineHeight: 0,  // px, probed from CSS
  rendered: null, // {from, to} of rendered window
};

async function showLibrary() {
  state.book = null;
  $("reader").hidden = true;
  $("library").hidden = false;

  const books = await state.store.all();
  books.sort((a, b) => b.addedAt - a.addedAt);
  const progress = loadProgress();
  const list = $("book-list");
  list.textContent = "";
  $("lib-empty").hidden = books.length > 0;

  for (const b of books) {
    const li = document.createElement("li");
    const pct = Math.round(100 * ((progress[b.id] || 0) / Math.max(1, b.lines.length - 1)));
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = b.title;
    const pctEl = document.createElement("span");
    pctEl.className = "pct";
    pctEl.textContent = pct + "%";
    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "remove";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Remove "${b.title}"?`)) return;
      await state.store.remove(b.id);
      showLibrary();
    });
    li.append(title, pctEl, del);
    li.addEventListener("click", () => openBook(b.id));
    list.append(li);
  }
}

async function openBook(id) {
  const book = await state.store.get(id);
  if (!book) return;
  state.book = book;
  state.line = Math.min(loadProgress()[id] || 0, book.lines.length - 1);
  state.rendered = null;

  $("library").hidden = true;
  $("reader").hidden = false;
  $("book-title").textContent = book.title;

  // Probe line height from CSS so JS and CSS can't drift.
  const probe = document.createElement("div");
  probe.className = "line";
  probe.textContent = "x";
  $("text").append(probe);
  state.lineHeight = probe.getBoundingClientRect().height || 34;
  probe.remove();

  renderLines(true);
}

/* Windowed render: line i sits at absolute y = i * lineHeight inside #text;
 * #text is translated so the current line lands on the fixed marker. */
function renderLines(force) {
  const { book, line, lineHeight } = state;
  if (!book) return;

  const from = Math.max(0, line - RENDER_WINDOW);
  const to = Math.min(book.lines.length, line + RENDER_WINDOW);

  const text = $("text");

  if (force || !state.rendered || from < state.rendered.from || to > state.rendered.to) {
    text.textContent = "";
    for (let i = from; i < to; i++) {
      const el = document.createElement("div");
      const l = book.lines[i];
      el.className = "line" + (l.h ? " heading" : "");
      el.dataset.i = i;
      el.textContent = l.t || " ";
      el.style.top = i * lineHeight + "px";
      text.append(el);
    }
    state.rendered = { from, to };
  }

  const markerY = window.innerHeight * 0.38;
  text.style.transform =
    `translate(-50%, ${markerY - line * lineHeight}px)`;

  for (const el of text.children) {
    const i = Number(el.dataset.i);
    el.classList.toggle("current", i === line);
    el.classList.toggle("near", Math.abs(i - line) === 1);
  }

  $("progress").textContent =
    Math.round(100 * (line / Math.max(1, book.lines.length - 1))) + "%";
}

/* Move by delta, skipping blank lines in the direction of travel so every
 * keypress lands on prose. */
function move(delta) {
  const { book } = state;
  if (!book) return;
  let i = state.line;
  const step = delta > 0 ? 1 : -1;
  for (let n = 0; n < Math.abs(delta); n++) {
    let j = i + step;
    while (j >= 0 && j < book.lines.length && book.lines[j].t === "") j += step;
    if (j < 0 || j >= book.lines.length) break;
    i = j;
  }
  if (i === state.line) return;
  if (i > state.line) logLineRead();
  state.line = i;
  saveProgress(book.id, i);
  renderLines(false);
}

// ---------- focus dimming (d key) ----------

const DIM_PRESETS = [
  { name: "soft focus", dim: null, near: null },      // CSS defaults
  { name: "strong focus", dim: "0.35", near: "0.6" },
  { name: "no dimming", dim: "1", near: "1" },
];

function applyDim(idx) {
  const p = DIM_PRESETS[idx % DIM_PRESETS.length];
  const root = document.documentElement.style;
  if (p.dim === null) { root.removeProperty("--dim"); root.removeProperty("--near"); }
  else { root.setProperty("--dim", p.dim); root.setProperty("--near", p.near); }
  localStorage.setItem("rw-dim", String(idx % DIM_PRESETS.length));
  return p.name;
}

let dimIdx = Number(localStorage.getItem("rw-dim") || 0);
applyDim(dimIdx);

// ---------- input ----------

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (!state.book) return;
  switch (e.key) {
    case "ArrowDown": case "j": move(1); break;
    case "ArrowUp": case "k": move(-1); break;
    case "PageDown": case " ": move(10); break;
    case "PageUp": move(-10); break;
    case "Escape": case "b": showLibrary(); return;
    case "d": dimIdx = (dimIdx + 1) % DIM_PRESETS.length;
              status("Dimming: " + applyDim(dimIdx)); break;
    default: return;
  }
  e.preventDefault();
});

$("back-btn").addEventListener("click", showLibrary);

window.addEventListener("resize", () => { if (state.book) renderLines(true); });

// ---------- drag and drop ----------

let dragDepth = 0;

document.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragDepth++;
  $("drop-veil").hidden = false;
});

document.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $("drop-veil").hidden = true;
});

document.addEventListener("dragover", (e) => e.preventDefault());

document.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("drop-veil").hidden = true;
  const files = e.dataTransfer?.files ?? [];
  if (!files.length) {
    // Dragging out of an app's library (Books, Calibre, mail) often delivers
    // no real file — only Finder drags reliably do.
    status("No file received — drag the book file from Finder, not from another app.");
    return;
  }
  let added = 0;
  for (const file of files) {
    try {
      const book = await fileToBook(file);
      await state.store.put(book);
      added++;
      status(`Added "${book.title}" (${book.lines.length} lines)`);
    } catch (err) {
      status("Couldn't add " + file.name + ": " + (err.message || err), true);
    }
  }
  if (added && !state.book) showLibrary();
});

// ---------- boot ----------

(async function boot() {
  try {
    state.store = await initStore();
    await showLibrary();
  } catch (err) {
    status("Failed to start: " + (err.message || err), true);
    return;
  }
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();

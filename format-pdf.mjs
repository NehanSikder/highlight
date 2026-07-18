/* Highlight — PDF parser (Tier 3). Lazy-loaded by app.js only when a .pdf is
 * imported, so every other format never pays for pdf.js (~1.8 MB vendored).
 *
 * PDF has no paragraph structure — only glyph runs positioned on a page — so
 * this file reconstructs it: runs → visual lines → column order → paragraphs.
 * The reconstruction steps are pure functions of plain data (exported for
 * tests); only parsePdf at the bottom touches pdf.js. Coordinates are PDF user
 * space: y grows upward, so reading order is descending y. */

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/* Group positioned text runs {str,x,y,w,h} into visual lines, inferring the
 * spaces pdf.js often omits between runs. A run lands on the previous line
 * when its baseline is within half a line-height. Within a line, a horizontal
 * gap wider than ~6% of the page splits the line into separate segments —
 * that's a column gutter or table gap, never a word space — so two-column
 * pages come out as per-column lines instead of interleaved text. */
export function runsToLines(runs, pageWidth) {
  const sorted = runs.filter((r) => r.str.length).sort((a, b) => b.y - a.y || a.x - b.x);
  const groups = [];
  for (const r of sorted) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g.y - r.y) <= Math.max(2, 0.5 * Math.max(g.h, r.h))) {
      g.runs.push(r);
      g.h = Math.max(g.h, r.h);
    } else {
      groups.push({ y: r.y, h: r.h, runs: [r] });
    }
  }

  const gutter = Math.max(18, pageWidth * 0.06);
  const lines = [];
  for (const g of groups) {
    g.runs.sort((a, b) => a.x - b.x);
    let seg = null;
    const flush = () => {
      if (!seg) return;
      seg.text = seg.text.trim();
      if (seg.text) lines.push(seg);
      seg = null;
    };
    for (const r of g.runs) {
      if (!seg) {
        seg = { text: r.str, x: r.x, xEnd: r.x + r.w, y: g.y, h: r.h };
        continue;
      }
      const gap = r.x - seg.xEnd;
      if (gap > gutter && gap > 2 * g.h) {
        flush();
        seg = { text: r.str, x: r.x, xEnd: r.x + r.w, y: g.y, h: r.h };
        continue;
      }
      // Word-space inference: a gap of ~a quarter of the font size is a space
      // the PDF encoded as positioning instead of a space character.
      if (gap > 0.25 * Math.max(seg.h, r.h) &&
          !seg.text.endsWith(" ") && !r.str.startsWith(" ")) {
        seg.text += " ";
      }
      seg.text += r.str;
      seg.xEnd = Math.max(seg.xEnd, r.x + r.w);
      seg.h = Math.max(seg.h, r.h);
    }
    flush();
  }
  return lines;
}

/* Put one page's lines (already top→bottom) into reading order. Full-width
 * lines split the page into vertical bands; inside a band, if the lines fall
 * cleanly left and right of the page middle it's a two-column region, read
 * left column first. Single-column text crosses the middle, so it forms
 * bands of its own lines and passes through untouched. */
export function orderPageLines(lines, pageWidth) {
  const mid = pageWidth / 2;
  const margin = pageWidth * 0.05;
  const spansMid = (l) => l.x < mid - margin && l.xEnd > mid + margin;

  const bands = [];
  let cur = [];
  for (const l of lines) {
    if (spansMid(l)) {
      if (cur.length) { bands.push(cur); cur = []; }
      bands.push([l]);
    } else {
      cur.push(l);
    }
  }
  if (cur.length) bands.push(cur);

  const out = [];
  for (const band of bands) {
    const left = band.filter((l) => l.xEnd <= mid);
    const right = band.filter((l) => l.x > mid);
    if (left.length >= 3 && right.length >= 3 &&
        left.length + right.length === band.length) {
      out.push(...left, ...right);
    } else {
      out.push(...band);
    }
  }
  return out;
}

/* Drop page furniture: running headers/footers (the same text at the top or
 * bottom of many pages, digits normalized so "page 4" matches "page 9") and
 * bare page numbers. Body-size bare numbers at a page edge are page numbers;
 * oversized ones are kept — they're chapter numbers. */
export function stripFurniture(pages) {
  const all = pages.flat();
  const bodyH = median(all.map((l) => l.h));
  const norm = (t) => t.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();

  const counts = new Map();
  const bump = (k) => counts.set(k, (counts.get(k) ?? 0) + 1);
  for (const lines of pages) {
    for (const l of lines.slice(0, 2)) bump("t:" + norm(l.text));
    for (const l of lines.slice(-2)) bump("b:" + norm(l.text));
  }
  const thresh = Math.max(3, Math.ceil(pages.length * 0.4));
  const isPageNum = (l) =>
    /^(?:\d{1,4}|[ivxlcdm]{1,7})$/i.test(l.text.trim()) && l.h <= bodyH * 1.1;

  return pages.map((lines) =>
    lines.filter((l, i) => {
      const edge = i <= 1 ? "t:" : i >= lines.length - 2 ? "b:" : null;
      if (!edge) return true;
      if (isPageNum(l)) return false;
      return (counts.get(edge + norm(l.text)) ?? 0) < thresh;
    })
  );
}

/* Merge lines back into paragraphs. Signals for a paragraph break: extra
 * vertical whitespace, an indented first line, or a short previous line (the
 * ragged last line of a justified paragraph). A jump upward in y is a column
 * or region change, not necessarily a break — the previous line's width
 * decides. Page boundaries only break when the last line looked final, since
 * paragraphs routinely span pages. Words hyphenated across lines are joined;
 * the hyphen is kept when the next line starts uppercase (proper names).
 *
 * headingsByPage (pageIndex → [titles]) comes from the PDF's own outline;
 * when present it supplies the headings and font-size guessing is skipped. */
export function linesToParagraphs(pages, headingsByPage = new Map()) {
  const all = pages.flat();
  if (!all.length) return [];
  const bodyH = median(all.map((l) => l.h));
  const medW = median(all.map((l) => l.xEnd - l.x).filter((w) => w > 0));
  const gaps = [];
  for (const lines of pages) {
    for (let i = 1; i < lines.length; i++) {
      const g = lines[i - 1].y - lines[i].y;
      if (g > 0 && g < bodyH * 4) gaps.push(g);
    }
  }
  const medGap = median(gaps) || bodyH * 1.2;
  const useOutline = headingsByPage.size > 0;

  const paras = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.text.trim()) {
      paras.push(cur.heading ? { text: cur.text.trim(), heading: true } : { text: cur.text.trim() });
    }
    cur = null;
  };

  let prev = null;
  let prevPage = -1;
  const sentenceEnd = /[.!?…]["'”’)\]]*$/;

  pages.forEach((lines, p) => {
    for (const t of headingsByPage.get(p) ?? []) {
      flush();
      paras.push({ text: t, heading: true });
      prev = null;
    }
    for (const line of lines) {
      const isHeading = !useOutline && line.h > bodyH * 1.2 && line.text.length <= 120;
      const shortPrev = prev && prev.xEnd - prev.x < 0.7 * medW;

      let breakHere = !cur || isHeading || cur.heading;
      if (!breakHere && prevPage !== p) {
        breakHere = shortPrev && sentenceEnd.test(cur.text);
      } else if (!breakHere) {
        const gap = prev.y - line.y;
        if (gap <= -bodyH) breakHere = shortPrev;            // column/region jump
        else if (gap > medGap * 1.7) breakHere = true;       // vertical whitespace
        else if (line.x - prev.x > bodyH * 0.9) breakHere = true; // indented start
        else if (shortPrev) breakHere = true;                // para ended on prev line
      }

      if (breakHere) {
        flush();
        cur = { text: line.text, heading: isHeading };
      } else if (/[A-Za-z]-$/.test(cur.text) && /^[a-z]/.test(line.text)) {
        cur.text = cur.text.slice(0, -1) + line.text;        // de-hyphenate
      } else if (/[A-Za-z]-$/.test(cur.text)) {
        cur.text += line.text;                               // keep hyphen: "Jean-Paul"
      } else {
        cur.text += " " + line.text;
      }
      prev = line;
      prevPage = p;
    }
  });
  flush();
  return paras;
}

/* Map the PDF's outline (bookmarks) to page indexes. Author-written chapter
 * titles beat any font-size heuristic when they exist. */
async function outlineHeadings(doc) {
  const map = new Map();
  let outline = null;
  try { outline = await doc.getOutline(); } catch { return map; }
  if (!outline?.length) return map;

  async function walk(items, depth) {
    for (const it of items ?? []) {
      try {
        let dest = it.dest;
        if (typeof dest === "string") dest = await doc.getDestination(dest);
        const title = (it.title || "").replace(/\s+/g, " ").trim();
        if (Array.isArray(dest) && dest[0] && title) {
          const idx = await doc.getPageIndex(dest[0]);
          if (!map.has(idx)) map.set(idx, []);
          map.get(idx).push(title);
        }
      } catch { /* unresolvable destination — skip this entry */ }
      if (depth < 2) await walk(it.items, depth + 1);
    }
  }
  await walk(outline, 0);
  return map;
}

/* Chars-per-page below this means there's no real text layer (scanned pages
 * sometimes carry a few stray OCR'd or watermark characters). */
const SCANNED_CHARS_PER_PAGE = 30;

export async function parsePdf(file, onStatus = () => {}) {
  const pdfjs = await import("./vendor/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc =
    new URL("./vendor/pdf.worker.min.mjs", import.meta.url).href;

  const data = new Uint8Array(await file.arrayBuffer());
  let doc;
  try {
    doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  } catch (err) {
    if (err?.name === "PasswordException") {
      throw new Error("This PDF is password-protected — remove the password and try again.");
    }
    throw new Error("Couldn't open this PDF — the file may be corrupted.");
  }

  try {
    const pages = [];
    let chars = 0;
    for (let p = 1; p <= doc.numPages; p++) {
      if (p % 20 === 0 || p === doc.numPages) {
        onStatus(`Reading PDF — page ${p} of ${doc.numPages}…`);
      }
      try {
        const page = await doc.getPage(p);
        const vp = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        const runs = content.items
          .filter((it) => it.str)
          .map((it) => ({
            str: it.str,
            x: it.transform[4],
            y: it.transform[5],
            w: it.width,
            h: it.height || Math.abs(it.transform[3]) || Math.abs(it.transform[0]),
          }));
        const lines = orderPageLines(runsToLines(runs, vp.width), vp.width);
        chars += lines.reduce((n, l) => n + l.text.length, 0);
        pages.push(lines);
        page.cleanup();
      } catch {
        pages.push([]); // one bad page shouldn't sink the book
      }
    }

    if (chars / doc.numPages < SCANNED_CHARS_PER_PAGE) {
      throw new Error(
        "This looks like a scanned PDF — the pages are images with no text layer, and OCR isn't supported."
      );
    }

    const headings = await outlineHeadings(doc);
    const paragraphs = linesToParagraphs(stripFurniture(pages), headings);

    let title = null;
    try {
      title = (await doc.getMetadata())?.info?.Title?.trim() || null;
    } catch { /* metadata is optional */ }

    return { paragraphs, title };
  } finally {
    doc.destroy();
  }
}

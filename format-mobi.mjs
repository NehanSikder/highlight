/* Highlight — MOBI / AZW3 parser (Tier 2). Lazy-loaded by app.js only when a
 * .mobi/.azw3 is imported, so no other format pays for the decoder.
 *
 * The heavy lifting (PalmDB container, PalmDOC + HUFF/CDIC decompression, old
 * MOBI6 and newer KF8/AZW3 layouts) is done by the vendored foliate-js decoder.
 * This wrapper only turns an opened book's sections into the flat
 * { paragraphs, title } shape the rest of Highlight consumes, and — crucially —
 * refuses DRM-protected files instead of emitting garbage.
 *
 * domToParagraphs is injected from app.js (same block-element walk epub/html
 * use) so this module stays free of app internals and unit-testable. */

import { MOBI } from "./vendor/foliate-mobi.js";

// The decoder takes an `unzlib` for embedded fonts/images. Text extraction
// never loads those, so a throwing stub satisfies the contract without pulling
// in a decompression library.
const noUnzlib = async () => {
  throw new Error("unzlib not available (text-only import)");
};

const DRM_MESSAGE =
  "This MOBI is DRM-protected (typically a Kindle purchase). Highlight only " +
  "opens DRM-free books — no decryption.";

// PalmDOC header `encryption`: 0 = none, 1 = legacy Mobipocket, 2 = Kindle DRM.
export function isEncrypted(mobiInstance) {
  return Boolean(mobiInstance?.headers?.palmdoc?.encryption);
}

/* Walk an opened foliate book into paragraphs. Sections without a
 * `createDocument` (KF8 marks non-linear skeletons as { linear: "no" }) are
 * skipped; a section that fails to parse is skipped rather than sinking the
 * whole book. Exported for tests, which pass a mock book. */
export async function sectionsToParagraphs(book, domToParagraphs, onStatus = () => {}) {
  const sections = (book.sections ?? []).filter(
    (s) => s && typeof s.createDocument === "function"
  );
  const paragraphs = [];
  for (let i = 0; i < sections.length; i++) {
    if ((i + 1) % 20 === 0 || i + 1 === sections.length) {
      onStatus(`Reading MOBI — section ${i + 1} of ${sections.length}…`);
    }
    let doc;
    try {
      doc = await sections[i].createDocument();
    } catch {
      continue;
    }
    // KF8 documents are parsed as XHTML; a malformed one yields a parsererror
    // with no usable body. Re-parse leniently as HTML before giving up.
    if (!doc?.body || doc.querySelector("parsererror")) {
      doc = reparseAsHtml(doc);
    }
    if (doc) paragraphs.push(...domToParagraphs(doc));
  }
  return paragraphs;
}

function reparseAsHtml(doc) {
  try {
    const html = doc?.documentElement?.outerHTML;
    if (!html) return null;
    return new DOMParser().parseFromString(html, "text/html");
  } catch {
    return null;
  }
}

export async function parseMobi(file, onStatus = () => {}, domToParagraphs) {
  const mobi = new MOBI({ unzlib: noUnzlib });

  let book;
  try {
    book = await mobi.open(file);
  } catch (err) {
    // A DRM file can fail mid-parse; surface the real reason if we can see it.
    if (isEncrypted(mobi)) throw new Error(DRM_MESSAGE);
    throw new Error("Couldn't read this MOBI file — it may be corrupted.");
  }

  // Encryption is known only after the headers are parsed; check before use.
  if (isEncrypted(mobi)) throw new Error(DRM_MESSAGE);

  const paragraphs = await sectionsToParagraphs(book, domToParagraphs, onStatus);
  const title = book.metadata?.title?.trim() || null;

  try {
    book.destroy?.();
  } catch { /* best-effort cleanup of any object URLs */ }

  return { paragraphs, title };
}

/**
 * Server-side PDF text extraction.
 *
 * Uses the `legacy` pdf.js build, which targets environments without the
 * browser DOM APIs the modern build assumes. Worker is disabled: Node has no
 * `Worker` global that pdf.js recognises, and resumes are small enough that
 * main-thread parsing costs a few hundred milliseconds.
 */

interface TextItemLike {
  str?: string;
  hasEOL?: boolean;
  transform?: number[];
}

/**
 * Absolute path to pdf.js's bundled font data. Resolved from the package entry
 * rather than hardcoded, so it survives hoisting differences between npm and
 * pnpm layouts. pdf.js expects a directory URL with a trailing slash.
 */
function standardFontsDir(): string {
  const entry = import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs");
  return new URL("../../standard_fonts/", entry).href;
}

export async function extractPdfText(bytes: Buffer): Promise<string> {
  // Imported lazily: the legacy build does global setup on import, which we
  // only want to pay for when a resume actually arrives.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const doc = await pdfjs.getDocument({
    // Copy into a fresh Uint8Array; pdf.js transfers ownership of the buffer
    // and would detach Node's pooled Buffer memory.
    data: new Uint8Array(bytes),
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
    // Resumes routinely use the 14 standard PDF fonts without embedding them.
    standardFontDataUrl: standardFontsDir(),
    // Errors only. Text extraction reads the content stream's text operators
    // and the PDF's own encoding tables, so font-loading warnings are noise
    // here — glyph outlines are only needed for rendering, which we never do.
    verbosity: 0,
  }).promise;

  try {
    const pages: string[] = [];
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      pages.push(itemsToText(content.items as TextItemLike[]));
      page.cleanup();
    }
    return pages.join("\n").trim();
  } finally {
    await doc.destroy();
  }
}

/**
 * pdf.js returns positioned fragments, not lines. Concatenating them naively
 * glues every bullet into one run, destroying the line structure the chunker
 * depends on. `hasEOL` marks fragment-level breaks; we additionally break when
 * the vertical position jumps, which catches multi-column resume layouts where
 * `hasEOL` alone is unreliable.
 */
function itemsToText(items: TextItemLike[]): string {
  let out = "";
  let lastY: number | null = null;

  for (const item of items) {
    if (typeof item.str !== "string") continue;
    const y = item.transform?.[5] ?? null;

    if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) {
      out += "\n";
    }
    out += item.str;
    if (item.hasEOL) out += "\n";

    if (y !== null) lastY = y;
  }

  return out
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

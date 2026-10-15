/**
 * How large a PDF Flint reads on this Mac (./pdf-text). On their own, with no
 * imports, so the sentences that name them (./policy) and the reader that
 * holds to them read the same numbers.
 *
 * WHY THERE ARE LIMITS. The reader's time limit bounds how long Flint WAITS for
 * a PDF's text. It does not bound how long macOS works on it: the Mac's own
 * importer does its work in a system service, and that work goes on after
 * Flint has stopped waiting (a review measured a 50,000-page PDF keep it busy
 * for three and a half minutes, during which every other read timed out). So a
 * PDF that is plainly too much is refused before it is handed over at all.
 */

/**
 * The largest PDF handed to a reader, in bytes: ten megabytes, twice what a
 * picture may be. A PDF that is mostly text is far smaller (sixty pages are
 * 28 KB, nine thousand pages 1.4 MB), and one this large is mostly pictures,
 * which are not read here.
 */
export const MAX_PDF_BYTES = 10 * 1024 * 1024;

/**
 * The most pages a PDF handed to a reader may have. The Mac's importer takes
 * about five milliseconds a page (sixty pages in 0.3 s here; a review's 50,000
 * in 210 s), so a thousand pages are about five seconds: inside the twenty
 * Flint waits, with room for a busy Mac. And the local model is handed 32,000
 * characters at most, which is the first ten or twenty pages.
 */
export const MAX_PDF_PAGES = 1_000;

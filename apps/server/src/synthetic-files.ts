/**
 * Pictures and PDFs made from nothing, for the vision benchmark
 * (./vision-bench) and the tests: a PNG drawn pixel by pixel with a small
 * built-in font, and a PDF of plain text pages. Nothing is read from disk and
 * nobody's file is used: what a picture shows and what a PDF says is known
 * exactly, because this file wrote it.
 *
 * No library: a PNG is a header, one compressed block of rows and three
 * checksums (node:zlib), and a text PDF is a handful of numbered objects.
 */
import { deflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// PNG

const CRC_TABLE: number[] = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t.push(c >>> 0);
  }
  return t;
})();

/** The CRC-32 a PNG chunk ends with. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

/** A PNG of `width` by `height` from its pixels: three bytes each (red, green, blue), row by row from the top. */
export function png(width: number, height: number, rgb: Uint8Array): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || rgb.length !== width * height * 3) throw new Error('a PNG needs width x height x 3 bytes');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bits per channel
  ihdr[9] = 2; // colour type: RGB
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    // (Each row starts with its filter: 0, none.)
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(rows, y * (width * 3 + 1) + 1);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', new Uint8Array(0))]);
}

export type Colour = readonly [number, number, number];
export const WHITE: Colour = [255, 255, 255];
export const BLACK: Colour = [0, 0, 0];
export const RED: Colour = [220, 30, 30];
export const BLUE: Colour = [30, 60, 220];
export const GREEN: Colour = [20, 160, 60];

/** Capital letters, digits and a little punctuation, five dots wide and seven high: each row a string of five 0s and 1s. */
const FONT: Readonly<Record<string, readonly string[]>> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

/** A picture being drawn: a white sheet, rectangles, and words in the built-in font. */
export class Sheet {
  readonly rgb: Uint8Array;
  constructor(readonly width: number, readonly height: number, background: Colour = WHITE) {
    this.rgb = new Uint8Array(width * height * 3);
    this.rect(0, 0, width, height, background);
  }
  /** Fill a rectangle. What falls outside the sheet is not drawn. */
  rect(x: number, y: number, w: number, h: number, colour: Colour): this {
    for (let yy = Math.max(0, y); yy < Math.min(this.height, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(this.width, x + w); xx++) {
        const at = (yy * this.width + xx) * 3;
        this.rgb[at] = colour[0];
        this.rgb[at + 1] = colour[1];
        this.rgb[at + 2] = colour[2];
      }
    }
    return this;
  }
  /** Words in capitals, each dot of the font `scale` pixels square. A character the font lacks is a gap. */
  text(words: string, x: number, y: number, scale: number, colour: Colour = BLACK): this {
    let at = x;
    for (const ch of words.toUpperCase()) {
      const rows = FONT[ch] ?? FONT[' ']!;
      rows.forEach((row, r) => {
        for (let c = 0; c < 5; c++) if (row[c] === '1') this.rect(at + c * scale, y + r * scale, scale, scale, colour);
      });
      at += 6 * scale;
    }
    return this;
  }
  /** How wide `words` are at that scale. */
  static widthOf(words: string, scale: number): number {
    return words.length * 6 * scale - scale;
  }
  png(): Buffer {
    return png(this.width, this.height, this.rgb);
  }
}

// ---------------------------------------------------------------------------
// PDF

/** `text` as a PDF string: brackets and the backslash escaped. Characters outside Latin-1 become `?` (the pages are plain text in a standard font). */
function pdfString(text: string): string {
  return `(${[...text].map((c) => (c === '\\' || c === '(' || c === ')' ? `\\${c}` : c.charCodeAt(0) > 255 ? '?' : c)).join('')})`;
}

/**
 * A PDF whose pages are lines of plain text in Helvetica: `pages[n]` is page
 * n's lines. `compress` stores each page's content deflated, as most real
 * PDFs do. With no lines at all a page is blank: a PDF with no text in it,
 * which is what a scan is to anything that reads text.
 */
export function textPdf(pages: ReadonlyArray<readonly string[]>, opts: { compress?: boolean } = {}): Buffer {
  const objects: Buffer[] = [];
  const add = (body: Buffer | string): number => {
    objects.push(typeof body === 'string' ? Buffer.from(body, 'latin1') : body);
    return objects.length;
  };
  add(''); // 1: the catalog
  add(''); // 2: the page tree
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'); // 3
  const kids: number[] = [];
  for (const lines of pages) {
    const content = Buffer.from(`BT /F1 12 Tf 72 720 Td 14 TL\n${lines.map((l) => `${pdfString(l)} Tj T*\n`).join('')}ET`, 'latin1');
    const stored = opts.compress ? deflateSync(content) : content;
    const stream = add(Buffer.concat([Buffer.from(`<< /Length ${stored.length}${opts.compress ? ' /Filter /FlateDecode' : ''} >>\nstream\n`, 'latin1'), stored, Buffer.from('\nendstream', 'latin1')]));
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${stream} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`));
  }
  objects[0] = Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1');
  objects[1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`, 'latin1');
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets: number[] = [];
  let at = parts[0]!.length;
  objects.forEach((body, i) => {
    offsets.push(at);
    const obj = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    parts.push(obj);
    at += obj.length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

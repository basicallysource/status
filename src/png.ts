/**
 * A PNG encoder, in about a hundred lines, because the uptime bars cannot be
 * text.
 *
 * Ninety day-cells is the one thing on the status page that carries meaning in
 * its SHAPE — where the gaps fall, how wide the bad patch was, whether it is
 * getting worse. Emoji squares lose the shape and the alignment; a real chart
 * keeps both. So the board needs an image.
 *
 * Nothing is imported to do it. The alternatives were a WASM rasteriser
 * (satori + resvg, over a megabyte, for drawing rectangles) or Browser
 * Rendering (a network call, a token, and a screenshot of our own page). Both
 * are enormous next to what is actually needed: flat opaque rectangles, no
 * text, no curves, no fonts. PNG's own compression is DEFLATE, and Workers
 * ship CompressionStream, so the only real work is a CRC and three chunk
 * headers.
 *
 * It is also nearly free at runtime. Every row of a bar strip is identical, so
 * DEFLATE collapses the whole image to a few hundred bytes.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** CompressionStream('deflate') emits a zlib stream, which is exactly what IDAT wants. */
async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream('deflate');
  const writer = stream.writable.getWriter();
  void writer.write(data);
  void writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  // The CRC covers the type and the data, never the length.
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

/** Encode straight RGBA pixels (width*height*4) as a PNG. */
export async function encodePng(width: number, height: number, rgba: Uint8Array): Promise<Uint8Array> {
  const stride = width * 4;
  // Each scanline is prefixed with its filter type. 0 = none: the rows here are
  // flat colour, so filtering would cost cycles and save nothing.
  const raw = new Uint8Array(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + stride)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (1 + stride) + 1);
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type 6 = truecolour with alpha
  const parts = [SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', await deflate(raw)), chunk('IEND', new Uint8Array(0))];

  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export type RGBA = readonly [number, number, number, number];

/** A tiny mutable canvas. Only what a bar chart needs. */
export class Canvas {
  readonly pixels: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.pixels = new Uint8Array(width * height * 4); // transparent
  }

  fillRect(x: number, y: number, w: number, h: number, [r, g, b, a]: RGBA): void {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    for (let py = y0; py < y1; py++) {
      let i = (py * this.width + x0) * 4;
      for (let px = x0; px < x1; px++) {
        this.pixels[i++] = r;
        this.pixels[i++] = g;
        this.pixels[i++] = b;
        this.pixels[i++] = a;
      }
    }
  }

  /**
   * A rounded rectangle, done by insetting the ends rather than by drawing
   * arcs. At the radius these bars use (a pixel or two on a six-pixel bar) the
   * difference from a real quarter-circle is invisible, and this keeps every
   * edge axis-aligned, which is what makes the rows identical and the file
   * compress to nothing.
   */
  fillRounded(x: number, y: number, w: number, h: number, radius: number, color: RGBA): void {
    const r = Math.min(radius, Math.floor(w / 2), Math.floor(h / 2));
    this.fillRect(x, y + r, w, h - 2 * r, color);
    this.fillRect(x + r, y, w - 2 * r, r, color);
    this.fillRect(x + r, y + h - r, w - 2 * r, r, color);
  }

  toPng(): Promise<Uint8Array> {
    return encodePng(this.width, this.height, this.pixels);
  }
}

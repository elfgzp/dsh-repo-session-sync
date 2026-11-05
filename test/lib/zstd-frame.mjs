/**
 * Dependency-free Zstandard frame encoder / multi-frame decoder.
 *
 * WHY THIS EXISTS
 * ---------------
 * DSH persists a session as a *concatenation of independent zstd frames*
 * (`session.v4.jsonl.zstd`). Two things therefore cannot be done with the
 * runtime alone:
 *
 *  1. WRITING fixtures. Node < 22.15 has no `zlib.zstdCompressSync` at all.
 *     Building the fixtures must work on any Node, and in CI without the
 *     `zstd` CLI installed. So we emit **raw (uncompressed) zstd blocks**,
 *     which is valid per RFC 8878 §3.1.1.3 and decodable by every
 *     conformant decoder (verified against zstd v1.5.7 CLI).
 *
 *  2. READING fixtures in assertions. `zlib.zstdDecompressSync(buffer)`
 *     decodes ONLY THE FIRST FRAME and silently ignores the rest — no
 *     throw, no warning. Measured on a real 488,601-byte session:
 *     whole-buffer decode yields 1 line (the header); the file actually
 *     holds 500 lines. That is a 99.8% silent data loss. Any implementation
 *     that naively decompresses the whole file looks like it works, because
 *     the header is valid JSON.
 *
 *     Therefore `decodeFrames()` below splits the file into frames and
 *     decodes each one independently, and refuses to trust a frame
 *     boundary that does not decode to valid JSONL.
 *
 * FRAME LAYOUT (what we emit)
 * ---------------------------
 *   magic   28 b5 2f fd
 *   FHD     0xA0  -> FCS_Field_Size=4 (flag 2), Single_Segment=1,
 *                    Content_Checksum=0, Dictionary_ID=0
 *   FCS     4 bytes little-endian uncompressed size
 *   blocks  each: 3-byte LE header, Last_Block(1) | Block_Type(2)=0 | Size(21)
 *           Block_Type 0 == Raw_Block (payload copied verbatim, <= 128 KiB)
 *
 * A raw-block frame is byte-for-byte larger than its payload, which is fine
 * for fixtures (tiny) and keeps generation possible with zero dependencies.
 */

import zlib from 'node:zlib';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** RFC 8878: a block payload may not exceed 128 KiB. */
const MAX_BLOCK_SIZE = 128 * 1024;

/**
 * Encode `payload` as a single standalone zstd frame made of raw blocks.
 *
 * @param {Buffer|string} payload bytes to encode
 * @returns {Buffer} a complete, self-contained zstd frame
 */
export function encodeFrame(payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const parts = [];

  parts.push(ZSTD_MAGIC);
  parts.push(Buffer.from([0xa0])); // FHD: FCS 4 bytes, single segment

  const fcs = Buffer.alloc(4);
  fcs.writeUInt32LE(data.length, 0);
  parts.push(fcs);

  // An empty payload still needs one (empty, last) raw block.
  const blockCount = Math.max(1, Math.ceil(data.length / MAX_BLOCK_SIZE));
  for (let i = 0; i < blockCount; i++) {
    const chunk = data.subarray(i * MAX_BLOCK_SIZE, Math.min((i + 1) * MAX_BLOCK_SIZE, data.length));
    const lastBlock = i === blockCount - 1 ? 1 : 0;
    // 3-byte LE header: bit0 = Last_Block, bits1-2 = Block_Type (0 = Raw), bits3-23 = Block_Size
    // Block_Size is 21 bits, so a 128 KiB block (0x20000) fits exactly.
    const headerValue = (lastBlock & 0x1) | ((0 & 0x3) << 1) | ((chunk.length & 0x1fffff) << 3);
    const header = Buffer.alloc(3);
    header.writeUIntLE(headerValue, 0, 3);
    parts.push(header, chunk);
  }

  return Buffer.concat(parts);
}

/**
 * Concatenate several payloads into one multi-frame file, the way DSH does
 * (first frame = header line, every later durable append = another frame).
 *
 * @param {Array<Buffer|string>} frames one payload per zstd frame
 * @returns {Buffer}
 */
export function encodeFrames(frames) {
  return Buffer.concat(frames.map((f) => encodeFrame(f)));
}

/**
 * Decode exactly one standalone zstd frame. Returns `null` when the buffer is
 * not a complete, well-formed frame.
 *
 * Uses the runtime decoder when available; otherwise falls back to a raw-block
 * parser so fixtures remain readable on Node without zstd support.
 *
 * @param {Buffer} frame
 * @returns {Buffer|null}
 */
export function decodeFrame(frame) {
  if (!Buffer.isBuffer(frame) || frame.length < 8) return null;
  if (!frame.subarray(0, 4).equals(ZSTD_MAGIC)) return null;

  const native = getNativeZstd();
  if (native) {
    try {
      return native(frame);
    } catch {
      return null;
    }
  }
  return decodeRawBlockFrame(frame);
}

/**
 * Fallback decoder for the raw-block frames this module emits.
 * Returns null for anything it does not fully understand (e.g. a frame that
 * uses actual compression), which is the safe answer.
 *
 * @param {Buffer} frame
 * @returns {Buffer|null}
 */
function decodeRawBlockFrame(frame) {
  try {
    let offset = 4;
    const fhd = frame[offset++];
    const fcsFlag = (fhd >> 6) & 0x3;
    const singleSegment = (fhd >> 5) & 0x1;
    const hasChecksum = (fhd >> 2) & 0x1;
    const dictIdFlag = fhd & 0x3;

    // Only the layout this module emits is supported.
    if (fcsFlag !== 2 || singleSegment !== 1 || hasChecksum !== 0 || dictIdFlag !== 0) return null;

    if (offset + 4 > frame.length) return null;
    const contentSize = frame.readUInt32LE(offset);
    offset += 4;

    const out = [];
    let produced = 0;
    for (;;) {
      if (offset + 3 > frame.length) return null;
      const value = frame.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = value & 0x1;
      const blockType = (value >> 1) & 0x3;
      const blockSize = value >>> 3;
      if (blockType !== 0) return null; // only raw blocks supported here
      if (offset + blockSize > frame.length) return null;
      out.push(frame.subarray(offset, offset + blockSize));
      produced += blockSize;
      offset += blockSize;
      if (lastBlock) break;
    }
    if (produced !== contentSize) return null;
    return Buffer.concat(out);
  } catch {
    return null;
  }
}

/**
 * Split a multi-frame file into decoded frames.
 *
 * A frame boundary cannot be found by scanning for the magic number alone:
 * compressed payload bytes can coincidentally contain `28 b5 2f fd`. Measured
 * on real sessions, a naive magic-number scan produced 190+ candidate offsets
 * of which many were false positives. So each candidate offset is *validated*
 * by attempting a decode and requiring the output to be valid UTF-8 JSONL.
 *
 * @param {Buffer} buffer whole `session.v4.jsonl.zstd` file
 * @returns {{frames: Array<{start:number,end:number,text:string,lines:string[]}>, trailingBytes:number, corrupted:boolean}}
 */
export function decodeFrames(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { frames: [], trailingBytes: 0, corrupted: false };
  }

  const candidates = findMagicOffsets(buffer);
  const frames = [];
  let consumed = 0;

  for (let i = 0; i < candidates.length; i++) {
    const start = candidates[i];
    // A real next-frame candidate only makes sense after what we consumed.
    if (start < consumed) continue;
    const end = i + 1 < candidates.length ? candidates[i + 1] : buffer.length;
    const slice = buffer.subarray(start, end);
    const raw = decodeFrame(slice);
    if (raw === null) continue; // false positive magic, not a real boundary
    const text = raw.toString('utf8');
    if (!isValidJsonl(text)) continue; // decodes but is not a session log
    frames.push({ start, end, text, lines: text.split('\n').filter((l) => l.length > 0) });
    consumed = end;
  }

  const lastEnd = frames.length > 0 ? frames[frames.length - 1].end : 0;
  return {
    frames,
    trailingBytes: buffer.length - lastEnd,
    // A "torn tail" (half-written final frame from a crash) is a normal state;
    // it shows up as trailing bytes that did not decode.
    corrupted: frames.length === 0 && buffer.length > 0 ? true : false,
  };
}

/**
 * Decode a whole session file into its event objects.
 *
 * @param {Buffer} buffer
 * @returns {Array<object>} events, in file order
 */
export function decodeSessionEvents(buffer) {
  const { frames } = decodeFrames(buffer);
  const events = [];
  for (const frame of frames) {
    for (const line of frame.lines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // A line that fails to parse inside an otherwise valid frame means the
        // frame was not a session log after all; skip rather than throw.
      }
    }
  }
  return events;
}

/** Every offset in `buffer` where the zstd magic number appears. */
function findMagicOffsets(buffer) {
  const offsets = [];
  let index = buffer.indexOf(ZSTD_MAGIC, 0);
  while (index !== -1) {
    offsets.push(index);
    index = buffer.indexOf(ZSTD_MAGIC, index + 1);
  }
  return offsets;
}

function isValidJsonl(text) {
  const lines = text.split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) return false;
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (value === null || typeof value !== 'object') return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Whether the running Node has zstd decompression (`node --version` >= 22.15).
 * Exposed so tests can assert fixture reads work on BOTH paths.
 * @returns {boolean}
 */
export function hasNativeZstd() {
  return typeof zlib.zstdDecompressSync === 'function';
}

/**
 * Native whole-frame decoder, or null when unavailable.
 *
 * IMPORTANT: `zstdDecompressSync` decodes ONE frame and silently ignores any
 * following frames. Never call it on a whole session file — use
 * `decodeFrames()` / `decodeSessionEvents()` for that.
 *
 * @returns {((b: Buffer)=>Buffer)|null}
 */
function getNativeZstd() {
  if (!hasNativeZstd()) return null;
  return (b) => zlib.zstdDecompressSync(b);
}

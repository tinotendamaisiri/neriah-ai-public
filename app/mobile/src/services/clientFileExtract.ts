// src/services/clientFileExtract.ts
// On-device text extraction for chat attachments — used by the offline
// AI flows so PDFs and Word docs produce real answers without a backend.
//
// What this handles:
//   • DOCX  — unzip via jszip, pull text from word/document.xml. Works on
//             every modern Word/Google Docs export.
//   • DOC   — legacy binary Word 97-2003 format (OLE Compound File). Parsed
//             via the `cfb` lib + a proper FIB / piece-table walk so we
//             extract real text, not heuristic noise. Falls back silently
//             on encrypted, fast-saved, or pre-Word-97 files.
//   • PDF   — two-stage:
//               1. text-stream extraction (regex over Tj / TJ ops in
//                  FlateDecode-decompressed content streams). Handles every
//                  "real" PDF — Word→PDF, Google Docs, LaTeX, Pages.
//               2. when stage 1 returns empty / near-empty (scanned PDFs,
//                  image-only exports), render each page with
//                  react-native-pdf-thumbnail and OCR the rendered images
//                  via the same MLKit module the grading flow uses.
//   • Image — handled at the call-site (router.imageToOnDeviceReply uses
//             MLKit directly on the image URI; this file is for documents).
//
// All public entry points return the empty string on failure rather than
// throwing, so the caller can do `if (text) { ... } else { queue }`
// without try/catch boilerplate.

import JSZip from 'jszip';
import { inflate } from 'pako';
import * as FileSystem from 'expo-file-system/legacy';
import { recognizePages, isOcrAvailable } from './ocr';

const MAX_TEXT_CHARS = 60_000;

/** If text-stream PDF extraction returns fewer chars than this, we treat
 *  the PDF as scanned and run the render+OCR fallback. 50 chars is enough
 *  to clear PDFs that have a stray title or page number embedded as text
 *  but no real body. */
const PDF_TEXT_FALLBACK_THRESHOLD = 50;

/** Cap the number of pages we render+OCR. Each page is ~1-3 s of OCR on a
 *  mid-range Android — 10 pages keeps the offline flow responsive. */
const MAX_OCR_PAGES = 10;

// ── DOCX ──────────────────────────────────────────────────────────────────────

/**
 * Extract plain text from a base64-encoded .docx file.
 * Returns "" on any failure (corrupted, encrypted, .doc binary format).
 */
export async function extractDocxText(base64: string): Promise<string> {
  try {
    const bytes = base64ToBytes(base64);
    const zip = await JSZip.loadAsync(bytes);
    const docXml = zip.file('word/document.xml');
    if (!docXml) return '';
    const xml = await docXml.async('string');

    // Pull every <w:t ...>text</w:t> in order. Then add paragraph breaks
    // so the model sees structure. <w:p> is paragraph; <w:br> is line break.
    const out: string[] = [];
    const tagRe = /<w:(t|p|br)\b[^>]*\/?>(?:([^<]*)<\/w:\1>)?/g;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(xml)) !== null) {
      const tag = m[1];
      const text = m[2];
      if (tag === 't' && text) {
        out.push(decodeXml(text));
      } else if (tag === 'p') {
        out.push('\n\n');
      } else if (tag === 'br') {
        out.push('\n');
      }
    }

    const joined = out.join('').replace(/\n{3,}/g, '\n\n').trim();
    return joined.length > MAX_TEXT_CHARS ? joined.slice(0, MAX_TEXT_CHARS) : joined;
  } catch {
    return '';
  }
}

// ── DOC (legacy binary) ──────────────────────────────────────────────────────

/**
 * Extract plain text from a base64-encoded legacy .doc (Word 97-2003) file.
 *
 * The .doc format is an OLE Compound Document: a mini-filesystem of streams
 * inside one binary blob. Real text is reconstructed by walking the FIB
 * (File Information Block) at the head of the WordDocument stream, finding
 * the piece table in the 0Table or 1Table stream (per spec [MS-DOC] §2.4),
 * and stitching pieces back into reading order.
 *
 * Strategy:
 *   1. Parse the OLE container with `cfb` → get WordDocument + table streams.
 *   2. Read the FIB from the start of WordDocument:
 *        - validate magic (0xA5EC / 0xA5DC / 0xA699 — common Word versions)
 *        - read fWhichTblStm bit at FIB+0x000A (chooses 0Table vs 1Table)
 *        - read ccpText (main text length in characters)
 *        - read fcClx + lcbClx → location of CLX in the table stream
 *   3. Walk the CLX. Skip Prc entries (clxt = 0x01), find the single Pcdt
 *      (clxt = 0x02). The Pcdt contains a PlcPcd: an array of n+1 character
 *      positions (CPs) followed by an array of n PCDs.
 *   4. For each PCD, the FCompressed flag selects the encoding:
 *        - fcCompressed = 1 → 1 byte/char (Windows-1252), offset = fc / 2
 *        - fcCompressed = 0 → UTF-16-LE, offset = fc
 *      Read (cpEnd - cpStart) characters from the WordDocument stream at
 *      that offset and append.
 *
 * Returns "" on:
 *   • encrypted .doc
 *   • Mac Word formats with different FIB layout
 *   • truncated / fast-saved files where piece offsets exceed stream length
 *   • any unexpected parse failure (we never throw)
 */
export async function extractDocText(base64: string): Promise<string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const CFB = require('cfb');
    const container = CFB.read(base64, { type: 'base64' });

    const wordDoc = findCfbEntry(container, 'WordDocument');
    if (!wordDoc) return '';
    const wordBytes = toUint8(wordDoc.content);
    if (wordBytes.length < 0x200) return '';

    const fibDv = new DataView(wordBytes.buffer, wordBytes.byteOffset, wordBytes.byteLength);

    // Magic check — these are the real-world wIdent values for Word 95+ docs.
    const wIdent = fibDv.getUint16(0, true);
    if (wIdent !== 0xa5ec && wIdent !== 0xa5dc && wIdent !== 0xa699) return '';

    // Bit 9 (0x0200) of the FIB flags word at 0x000A picks the table stream.
    const fibFlags  = fibDv.getUint16(0x000a, true);
    const useTable1 = (fibFlags & 0x0200) !== 0;

    // ccpText — characters in the main (body) text run.
    const ccpText = fibDv.getInt32(0x004c, true);
    if (ccpText <= 0) return '';

    // FibRgFcLcb97: fcClx at 0x01A2, lcbClx at 0x01A6.
    const fcClx  = fibDv.getInt32(0x01a2, true);
    const lcbClx = fibDv.getInt32(0x01a6, true);
    if (fcClx <= 0 || lcbClx <= 0) return '';

    // Pull the table stream from the OLE container.
    const tableEntry = findCfbEntry(container, useTable1 ? '1Table' : '0Table')
      ?? findCfbEntry(container, useTable1 ? '0Table' : '1Table');  // some files mislabel
    if (!tableEntry) return '';
    const tableBytes = toUint8(tableEntry.content);
    if (fcClx + lcbClx > tableBytes.length) return '';

    const tableDv = new DataView(tableBytes.buffer, tableBytes.byteOffset, tableBytes.byteLength);

    // Walk the CLX looking for the Pcdt entry.
    let p = fcClx;
    const clxEnd = fcClx + lcbClx;
    let pcdtOffset = -1;
    let pcdtLen    = 0;
    while (p < clxEnd) {
      const clxt = tableBytes[p];
      p += 1;
      if (clxt === 0x01) {
        // Prc — cbGrpprl (uint16 LE) then GrpPrl bytes. Skip.
        if (p + 2 > clxEnd) break;
        const cb = tableDv.getUint16(p, true);
        p += 2 + cb;
      } else if (clxt === 0x02) {
        // Pcdt — lcb (int32 LE) then PlcPcd bytes.
        if (p + 4 > clxEnd) break;
        pcdtLen    = tableDv.getInt32(p, true);
        pcdtOffset = p + 4;
        break;
      } else {
        // Unknown CLX entry type — bail out rather than risk misreading.
        return '';
      }
    }
    if (pcdtOffset < 0 || pcdtLen <= 0) return '';

    // PlcPcd shape: (n+1) CPs of 4 bytes, then n PCDs of 8 bytes.
    // Total bytes = (n+1)*4 + n*8 = 12n + 4   →   n = (lcb - 4) / 12.
    const n = (pcdtLen - 4) / 12;
    if (!Number.isInteger(n) || n <= 0) return '';

    const cpArrayOffset  = pcdtOffset;
    const pcdArrayOffset = pcdtOffset + (n + 1) * 4;
    if (pcdArrayOffset + n * 8 > tableBytes.length) return '';

    const cps: number[] = [];
    for (let i = 0; i <= n; i++) {
      cps.push(tableDv.getInt32(cpArrayOffset + i * 4, true));
    }

    const pieces: string[] = [];
    for (let i = 0; i < n; i++) {
      const pcdOff = pcdArrayOffset + i * 8;
      // PCD: A (uint16) | fc (uint32 — encodes offset + fCompressed) | prm (uint16)
      const fcRaw       = tableDv.getUint32(pcdOff + 2, true);
      const fCompressed = (fcRaw & 0x40000000) !== 0;
      // Bottom 30 bits = stream offset. Per spec, divide by 2 in the
      // compressed (1-byte/char) case.
      const fcStripped  = fcRaw & 0x3fffffff;
      const fileOffset  = fCompressed ? Math.floor(fcStripped / 2) : fcStripped;

      const cpStart = cps[i];
      const cpEnd   = cps[i + 1];
      const cpCount = cpEnd - cpStart;
      if (cpCount <= 0) continue;

      let pieceText = '';
      if (fCompressed) {
        // 1 byte/char Windows-1252-ish. Translate the few special control
        // codes the .doc format uses for paragraph + table marks.
        const end = fileOffset + cpCount;
        if (end > wordBytes.length) continue;
        for (let j = fileOffset; j < end; j++) {
          const b = wordBytes[j];
          if      (b === 0x0d) pieceText += '\n';   // paragraph mark
          else if (b === 0x0b) pieceText += '\n';   // line break
          else if (b === 0x09) pieceText += '\t';   // tab
          else if (b === 0x07) { /* cell mark — drop */ }
          else if (b === 0x0c) { /* page break — drop */ }
          else if (b >= 0x20)  pieceText += String.fromCharCode(b);
        }
      } else {
        // UTF-16-LE, 2 bytes/char.
        const byteCount = cpCount * 2;
        if (fileOffset + byteCount > wordBytes.length) continue;
        for (let j = 0; j < cpCount; j++) {
          const lo = wordBytes[fileOffset + j * 2];
          const hi = wordBytes[fileOffset + j * 2 + 1];
          const code = lo | (hi << 8);
          if      (code === 0x000d) pieceText += '\n';
          else if (code === 0x000b) pieceText += '\n';
          else if (code === 0x0009) pieceText += '\t';
          else if (code === 0x0007) { /* cell mark */ }
          else if (code === 0x000c) { /* page break */ }
          else if (code >= 0x0020)  pieceText += String.fromCharCode(code);
        }
      }
      pieces.push(pieceText);
    }

    const joined = pieces
      .join('')
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (!joined) return '';
    return joined.length > MAX_TEXT_CHARS ? joined.slice(0, MAX_TEXT_CHARS) : joined;
  } catch {
    return '';
  }
}

// ── PDF ───────────────────────────────────────────────────────────────────────

/**
 * Extract plain text from a base64-encoded PDF.
 *
 * Two-stage pipeline:
 *   Stage 1 (fast, no native dep): walk every "stream … endstream" block,
 *     inflate FlateDecode bodies with pako, then run text-show ops over
 *     the resulting plain content. Catches Word→PDF, Google Docs, LaTeX,
 *     Pages — anything where text was kept as text.
 *   Stage 2 (slow, needs dev client): if Stage 1 returned < 50 useful
 *     chars, treat the PDF as scanned and render every page to a JPEG via
 *     react-native-pdf-thumbnail, then OCR each rendered page with MLKit.
 *
 * Stage 2 is gated on:
 *   - the PDF-thumbnail native module being linked (dev client present)
 *   - the MLKit OCR module being linked (same dev client)
 *   - expo-file-system being able to write a temp file
 * Any of those missing → we return whatever Stage 1 produced (often "").
 */
export async function extractPdfText(base64: string): Promise<string> {
  // ── Stage 1: text-stream extraction ───────────────────────────────────────
  const fromStreams = (() => {
    try {
      const bytes = base64ToBytes(base64);
      const raw   = bytesToLatin1(bytes);
      const collected: string[] = [];

      // Walk every stream … endstream pair. Capture the preceding text so
      // we can read /Filter from the dictionary, plus the body. PDFs vary
      // in CR/LF/space around these keywords; allow a wide separator.
      const streamRe = /([\s\S]{0,400}?)\bstream[\r\n]+([\s\S]*?)[\r\n]+endstream/g;
      let m: RegExpExecArray | null;
      while ((m = streamRe.exec(raw)) !== null) {
        const dict = m[1];
        const body = m[2];

        // FlateDecode is the dominant filter. We also accept it inside an
        // array filter (e.g. /Filter [/ASCII85Decode /FlateDecode]).
        const isFlate = /\/Filter\s*\[?[^\]]*\/FlateDecode/.test(dict);

        let plain = '';
        if (isFlate) {
          try {
            const chunk = new Uint8Array(body.length);
            for (let i = 0; i < body.length; i++) chunk[i] = body.charCodeAt(i) & 0xff;
            plain = bytesToLatin1(inflate(chunk));
          } catch {
            continue;  // can't decompress — skip this stream
          }
        } else {
          plain = body;
        }
        collected.push(...extractTextOps(plain));
      }

      // Tiny single-page PDFs sometimes put text-show ops directly in the
      // file body without a stream wrapper — run the same regex over the
      // whole raw file as a safety net.
      collected.push(...extractTextOps(raw));

      if (collected.length === 0) return '';
      const joined = collected
        .join(' ')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      return joined.length > MAX_TEXT_CHARS ? joined.slice(0, MAX_TEXT_CHARS) : joined;
    } catch {
      return '';
    }
  })();

  if (fromStreams.length >= PDF_TEXT_FALLBACK_THRESHOLD) {
    return fromStreams;
  }

  // ── Stage 2: render-and-OCR fallback for scanned PDFs ─────────────────────
  const scanned = await extractScannedPdfText(base64);
  if (scanned) return scanned;

  // If Stage 1 produced *some* text (just below threshold), prefer that
  // over returning empty — the caller's threshold logic will queue if it's
  // still too short.
  return fromStreams;
}

/**
 * Render every page of a scanned PDF to a JPEG via the native pdf-thumbnail
 * module, OCR each rendered page, concatenate. Returns "" if the native
 * modules aren't linked (e.g. running in Expo Go) or anything fails.
 *
 * Caps at MAX_OCR_PAGES so a 200-page scan doesn't hang the UI.
 */
async function extractScannedPdfText(base64: string): Promise<string> {
  const PdfThumbnail = getPdfThumbnail();
  if (!PdfThumbnail) return '';
  if (!isOcrAvailable()) return '';

  // Write the base64 to a cache file so the native renderer has a path.
  // Using a unique name lets multiple chats run in parallel without
  // clobbering each other.
  const tempPath = `${FileSystem.cacheDirectory}neriah_scan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.pdf`;

  try {
    await FileSystem.writeAsStringAsync(tempPath, base64, {
      encoding: FileSystem.EncodingType.Base64,
    });

    let pages: Array<{ uri: string }>;
    try {
      pages = await PdfThumbnail.generateAllPages(tempPath, 80);
    } catch (err) {
      console.warn('[clientFileExtract] pdf-thumbnail failed:', (err as Error)?.message ?? err);
      return '';
    }

    if (!Array.isArray(pages) || pages.length === 0) return '';

    const limited = pages.slice(0, MAX_OCR_PAGES);
    const ocrPages = await recognizePages(limited.map((p) => p.uri));

    // Best-effort cleanup of the rendered page images. The native module
    // writes them to its own temp dir; deleting one URI that doesn't exist
    // is harmless thanks to idempotent: true.
    for (const p of limited) {
      try {
        await FileSystem.deleteAsync(p.uri, { idempotent: true });
      } catch {
        /* ignore */
      }
    }

    const joined = ocrPages
      .map((p) => p.text.trim())
      .filter(Boolean)
      .join('\n\n')
      .trim();
    return joined.length > MAX_TEXT_CHARS ? joined.slice(0, MAX_TEXT_CHARS) : joined;
  } catch (err) {
    console.warn('[clientFileExtract] scanned-PDF fallback failed:', (err as Error)?.message ?? err);
    return '';
  } finally {
    try {
      await FileSystem.deleteAsync(tempPath, { idempotent: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Pull every text-show op out of a (decompressed) PDF content stream.
 * Returns a flat list of decoded text fragments in document order.
 */
function extractTextOps(content: string): string[] {
  const out: string[] = [];

  // (text)Tj — most common
  const tjRe = /\(((?:\\.|[^\\\)])*)\)\s*Tj/g;
  let m: RegExpExecArray | null;
  while ((m = tjRe.exec(content)) !== null) {
    const decoded = decodePdfStringLiteral(m[1]);
    if (decoded) out.push(decoded);
  }

  // [(a)(b)(c)]TJ — array form (kerned). Numbers between strings are
  // kerning offsets; ignore them but join the strings.
  const tjArrayRe = /\[((?:\\.|[^\]])*)\]\s*TJ/g;
  while ((m = tjArrayRe.exec(content)) !== null) {
    const inner = m[1];
    const partRe = /\(((?:\\.|[^\\\)])*)\)/g;
    let p: RegExpExecArray | null;
    const parts: string[] = [];
    while ((p = partRe.exec(inner)) !== null) {
      const decoded = decodePdfStringLiteral(p[1]);
      if (decoded) parts.push(decoded);
    }
    if (parts.length) out.push(parts.join(''));
  }

  // <hex>Tj — hex-encoded strings. Pairs of hex digits → byte → char.
  const tjHexRe = /<([0-9A-Fa-f\s]+)>\s*Tj/g;
  while ((m = tjHexRe.exec(content)) !== null) {
    const hex = m[1].replace(/\s+/g, '');
    if (hex.length % 2 !== 0) continue;
    let s = '';
    for (let i = 0; i < hex.length; i += 2) {
      s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    }
    if (s.trim()) out.push(s);
  }

  return out;
}

// ── Public router ────────────────────────────────────────────────────────────

/**
 * Extract text from a chat attachment by media type. Returns "" when the
 * format is unsupported, encrypted, or extraction fails — caller queues
 * for cloud or falls back to other paths.
 *
 * Word handling is content-sniffed, not extension-trusted: a file picker
 * may surface a `.docx` that's actually a binary `.doc`, or vice versa.
 * We look at magic bytes to decide which parser to run.
 */
export async function extractAttachmentText(
  base64: string,
  mediaType: 'image' | 'pdf' | 'word',
): Promise<string> {
  if (mediaType === 'pdf') return extractPdfText(base64);
  if (mediaType === 'word') {
    const fmt = detectWordFormat(base64);
    if (fmt === 'docx') return extractDocxText(base64);
    if (fmt === 'doc')  return extractDocText(base64);
    return '';
  }
  return '';
}

/**
 * Inspect the first few bytes of a base64-encoded Word file to decide
 * which parser to use:
 *   "PK\x03\x04"     → DOCX (zip-based, modern Office Open XML)
 *   "\xD0\xCF\x11\xE0…" → DOC  (OLE Compound Document, Word 97-2003)
 * Anything else → "unknown"; caller treats as unsupported.
 */
function detectWordFormat(base64: string): 'docx' | 'doc' | 'unknown' {
  try {
    // We only need the first 8 bytes — decode the first 12 base64 chars.
    const head = base64.slice(0, 12);
    const bytes = base64ToBytes(head + '='.repeat((4 - (head.length % 4)) % 4));
    if (bytes.length >= 4
        && bytes[0] === 0x50 && bytes[1] === 0x4b
        && bytes[2] === 0x03 && bytes[3] === 0x04) {
      return 'docx';
    }
    if (bytes.length >= 8
        && bytes[0] === 0xd0 && bytes[1] === 0xcf
        && bytes[2] === 0x11 && bytes[3] === 0xe0
        && bytes[4] === 0xa1 && bytes[5] === 0xb1
        && bytes[6] === 0x1a && bytes[7] === 0xe1) {
      return 'doc';
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

// ── Internals ────────────────────────────────────────────────────────────────

// Lazy-load react-native-pdf-thumbnail. Wrapping the require lets us return
// null rather than crash inside Expo Go (where the native module isn't
// linked). Same pattern ocr.ts uses for MLKit.
type PdfThumbnailModule = {
  generateAllPages: (filePath: string, quality: number) => Promise<Array<{ uri: string; width: number; height: number }>>;
};

let _pdfThumbnailModule: PdfThumbnailModule | null | undefined = undefined;

function getPdfThumbnail(): PdfThumbnailModule | null {
  if (_pdfThumbnailModule !== undefined) return _pdfThumbnailModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const mod = require('react-native-pdf-thumbnail');
    _pdfThumbnailModule = (mod?.default ?? mod) as PdfThumbnailModule;
  } catch {
    _pdfThumbnailModule = null;
  }
  return _pdfThumbnailModule;
}

function findCfbEntry(container: { FullPaths: string[]; FileIndex: Array<{ name: string; content: number[] | Uint8Array }> }, name: string): { name: string; content: number[] | Uint8Array } | null {
  // CFB entries can appear at any depth (root has them as direct children
  // for Word docs). FullPaths look like "/Root Entry/WordDocument" — match
  // by trailing path segment, case-sensitive (Word names are stable).
  for (let i = 0; i < container.FullPaths.length; i++) {
    const path = container.FullPaths[i];
    const segs = path.split('/');
    const leaf = segs[segs.length - 1];
    if (leaf === name) return container.FileIndex[i];
  }
  return null;
}

function toUint8(content: number[] | Uint8Array): Uint8Array {
  if (content instanceof Uint8Array) return content;
  return new Uint8Array(content);
}

function base64ToBytes(base64: string): Uint8Array {
  // React Native ships atob on global since 0.74; fall back to a manual
  // decode if it's missing (older targets).
  const binStr = (typeof atob === 'function')
    ? atob(base64)
    : decodeBase64Manual(base64);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i) & 0xff;
  return bytes;
}

function bytesToLatin1(bytes: Uint8Array): string {
  // Chunk the conversion so we don't blow the stack on multi-MB files.
  const chunkSize = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    parts.push(String.fromCharCode.apply(null, Array.from(slice) as any));
  }
  return parts.join('');
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

/**
 * Resolve PDF string-literal escapes per the PDF 1.7 spec §7.3.4.2:
 *   \n \r \t \b \f \( \) \\ \\ddd (octal)
 */
function decodePdfStringLiteral(s: string): string {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\b/g, '\b')
    .replace(/\\f/g, '\f')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
    .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

const _B64CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function decodeBase64Manual(input: string): string {
  let str = input.replace(/[^A-Za-z0-9+/=]/g, '');
  let output = '';
  for (let i = 0; i < str.length; i += 4) {
    const c1 = _B64CHARS.indexOf(str.charAt(i));
    const c2 = _B64CHARS.indexOf(str.charAt(i + 1));
    const c3 = _B64CHARS.indexOf(str.charAt(i + 2));
    const c4 = _B64CHARS.indexOf(str.charAt(i + 3));
    output += String.fromCharCode((c1 << 2) | (c2 >> 4));
    if (c3 !== 64 && str.charAt(i + 2) !== '=') {
      output += String.fromCharCode(((c2 & 15) << 4) | (c3 >> 2));
    }
    if (c4 !== 64 && str.charAt(i + 3) !== '=') {
      output += String.fromCharCode(((c3 & 3) << 6) | c4);
    }
  }
  return output;
}

/**
 * Structural checks for the kinds of broken video the model provider rejects
 * outright. The MiniMax gateway probes every video with ffprobe and decodes
 * frames from it; when either fails the whole request is rejected with
 * `invalid params ... (2013)`, and once such a video is in history every later
 * request replays it. Each problem
 * below was reproduced against the gateway:
 *
 * - `missing_moov`: an MP4 / QuickTime file without its `moov` box (sample
 *   index). ffmpeg and most recorders write it when they finish, so a writer
 *   killed mid-way leaves media data that nothing can play.
 * - `unreadable_first_sample`: the index points the first frame outside the
 *   file or at bytes that are not H.264 / HEVC NAL units, as left by a tool
 *   that moved `moov` to the front without rewriting the chunk offsets.
 * - `no_keyframe`: an H.264 track without a single frame that can be
 *   decoded on its own, as left by `ffmpeg -ss ... -c copy -copyinkf` cutting
 *   inside a long GOP.
 * - `no_video_track` / `no_video_frames`: audio-only files, or a `moov`
 *   whose video track has no samples (an empty cut).
 * - `not_a_media_container`: bytes no video format starts with, such as an
 *   HTML error page or random data saved under a video name.
 *
 * Deliberately conservative: a problem is reported only when the bytes
 * positively show it. Anything the parser does not fully understand (other
 * codecs, external data references, compressed `moov`, fragmented files,
 * unusual layouts) passes, because dropping a video the provider would accept
 * is worse than letting an unknown one through; the outbound retry handles
 * whatever still gets rejected.
 */

export type VideoContainerProblem =
  /** Fewer bytes than a single box header: no video format fits. */
  | 'too_small'
  /** MP4 / QuickTime data without a `moov` box, typically a write that was cut off. */
  | 'missing_moov'
  /** Bytes that no known video container starts with. */
  | 'not_a_media_container'
  /** An MP4 / QuickTime file without any video track, such as audio only. */
  | 'no_video_track'
  /** Every video track is a complete, non-fragmented track with zero samples. */
  | 'no_video_frames'
  /** The first video sample lies past the end of the file or is not NAL-unit data. */
  | 'unreadable_first_sample'
  /** No sample of the H.264 track is a keyframe (IDR, I / SI slice or recovery point). */
  | 'no_keyframe';

/**
 * What a problem means for the agent, phrased to follow "video omitted: " or
 * "Video not loaded: " and to end without a full stop. Shared by the read tool
 * and the outbound guard so both explain the same file the same way.
 */
export function describeVideoContainerProblem(problem: VideoContainerProblem): string {
  switch (problem) {
    case 'too_small':
    case 'missing_moov':
      return 'the file is damaged or incomplete';
    case 'not_a_media_container':
      return 'the file content is not a video format the model provider can read; it may be another kind of file saved under a video name, such as an HTML error page from a failed download. Check what it is with `file` or `ffprobe`';
    case 'no_video_track':
      return 'the file has no video track (for example it is audio only), and the model provider only accepts videos that contain a picture. Read a file that has a video track';
    case 'no_video_frames':
      return 'its video track contains no frames, as left by a cut or export that produced an empty clip. Create the clip again and read the new file';
    case 'unreadable_first_sample':
      return 'its first frame cannot be read because the sample index points outside the frame data, as happens when a tool edits or moves the file structure without updating the index. Get a complete copy, or re-encode it, for example `ffmpeg -i <file> -c:v libx264 -pix_fmt yuv420p <new>.mp4`, and read the new file';
    case 'no_keyframe':
      return 'it has no keyframe, so none of its frames can be decoded; this happens when a clip is cut with `ffmpeg -ss ... -c copy` at a point that is not a keyframe. Cut it again with re-encoding (without `-c copy`) and read the new file';
  }
}

const BOX_HEADER_BYTES = 8;
const LARGE_BOX_HEADER_BYTES = 16;
/**
 * Real files have a handful of top-level boxes before `moov` (ftyp, free or
 * wide, mdat; a fragmented file puts `moov` before its fragments). Past this
 * many the file is not judged, so bytes made of millions of tiny boxes cost a
 * bounded walk, not one step per 8 bytes.
 */
const MAX_TOP_LEVEL_BOXES = 1024;
/** Children of one box (`moov`, `trak`, `stbl`, ...) read before giving up. */
const MAX_CHILD_BOXES = 4096;
/**
 * Samples expanded when looking for a keyframe: 30 minutes at 60 fps is
 * 108,000. A longer index is not judged. The search stops at the first
 * keyframe, which in a normal file is the first sample.
 */
const MAX_SCANNED_SAMPLES = 120_000;
/** Larger SEI NAL units are assumed to carry a recovery point rather than parsed. */
const MAX_SEI_BYTES = 64 * 1024;

/** Top-level box types an MP4 / QuickTime file or segment starts with. */
const LEADING_BOX_TYPES: ReadonlySet<string> = new Set([
  'ftyp',
  'moov',
  'mdat',
  'free',
  'skip',
  'wide',
  'pnot',
  'uuid',
  'styp',
  'sidx',
  'moof',
]);

/** A box type made of letters, digits and spaces, as QuickTime atoms are. */
const PRINTABLE_BOX_TYPE = /^[0-9A-Za-z ]{4}$/;

/** RIFF form types of formats ffprobe reads as video or image. */
const RIFF_FORMS: ReadonlySet<string> = new Set(['AVI ', 'AVIX', 'AMV ', 'WEBP']);

/** Leading bytes of other containers, elementary streams and images ffprobe reads. */
const KNOWN_SIGNATURES: readonly (readonly number[])[] = [
  [0x1a, 0x45, 0xdf, 0xa3], // EBML: Matroska, WebM
  [0x46, 0x4c, 0x56, 0x01], // FLV
  [0x00, 0x00, 0x01], // MPEG program stream, MPEG-1/2 video, H.264 / HEVC Annex B
  [0x00, 0x00, 0x00, 0x01], // Annex B with a four-byte start code
  [0x4f, 0x67, 0x67, 0x53], // Ogg
  [0x30, 0x26, 0xb2, 0x75], // ASF, WMV
  [0x2e, 0x52, 0x4d, 0x46], // RealMedia
  [0x06, 0x0e, 0x2b, 0x34], // MXF
  [0x44, 0x4b, 0x49, 0x46], // IVF (VP8 / VP9 / AV1)
  [0x59, 0x55, 0x56, 0x34, 0x4d, 0x50, 0x45, 0x47, 0x32], // YUV4MPEG2
  [0x49, 0x44, 0x33], // ID3-tagged audio
  [0xff, 0xd8, 0xff], // JPEG
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0x47, 0x49, 0x46, 0x38], // GIF
];

/** MPEG transport stream packet sizes: plain TS, and M2TS with a 4-byte timestamp. */
const TS_PACKET_SIZES = [188, 192] as const;
const TS_SYNC_BYTE = 0x47;

interface Box {
  readonly type: string;
  /** First byte after the header. */
  readonly start: number;
  /** One past the last byte. */
  readonly end: number;
}

/** The container problem of a video file's bytes, or undefined when none is found. */
export function findVideoContainerProblem(bytes: Uint8Array): VideoContainerProblem | undefined {
  if (bytes.byteLength < BOX_HEADER_BYTES) return 'too_small';
  try {
    if (LEADING_BOX_TYPES.has(boxType(bytes, 0))) return isoBmffProblem(bytes);
    return looksLikeMedia(bytes) ? undefined : 'not_a_media_container';
  } catch {
    return undefined;
  }
}

function looksLikeMedia(bytes: Uint8Array): boolean {
  const view = viewOf(bytes);
  // A QuickTime atom this check does not list: the size must fit the file, so
  // text, whose first four bytes read as a size of hundreds of megabytes, does not pass.
  const size = view.getUint32(0);
  if (
    PRINTABLE_BOX_TYPE.test(boxType(bytes, 0)) &&
    (size === 1 || (size >= BOX_HEADER_BYTES && size <= bytes.byteLength))
  ) {
    return true;
  }
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && bytes.byteLength >= 12) {
    if (RIFF_FORMS.has(fourCc(view, 8))) return true;
  }
  if (KNOWN_SIGNATURES.some((signature) => startsWith(bytes, signature))) return true;
  return isTransportStream(bytes);
}

function isTransportStream(bytes: Uint8Array): boolean {
  return TS_PACKET_SIZES.some((packet) => {
    for (let first = 0; first < packet && first + 2 * packet < bytes.byteLength; first += 1) {
      if (
        bytes[first] === TS_SYNC_BYTE &&
        bytes[first + packet] === TS_SYNC_BYTE &&
        bytes[first + 2 * packet] === TS_SYNC_BYTE
      ) {
        return true;
      }
    }
    return false;
  });
}

function isoBmffProblem(bytes: Uint8Array): VideoContainerProblem | undefined {
  const view = viewOf(bytes);
  let moov: Box | undefined;
  let sawMovieFragment = false;
  let walkedToEnd = false;
  let offset = 0;
  for (let walked = 0; ; walked += 1) {
    if (bytes.byteLength - offset < BOX_HEADER_BYTES) {
      walkedToEnd = true;
      break;
    }
    if (walked === MAX_TOP_LEVEL_BOXES) {
      if (!moov) return undefined;
      break;
    }
    const type = boxType(bytes, offset);
    const end = boxEnd(view, offset);
    if (end === undefined || end > bytes.byteLength) {
      // A `moov` that runs past the end may still hold a usable index; any
      // other box that does means the file stops before a later `moov`.
      if (!moov) return type === 'moov' ? undefined : 'missing_moov';
      break;
    }
    if (type === 'moov' && !moov)
      moov = { type, start: offset + boxHeaderBytes(view, offset), end };
    if (type === 'moof') sawMovieFragment = true;
    offset = end;
  }
  if (!moov) return 'missing_moov';

  const movie = childBoxes(view, moov);
  if (!movie || movie.some((box) => box.type === 'cmov')) return undefined;
  const fragmented = sawMovieFragment || !walkedToEnd || movie.some((box) => box.type === 'mvex');
  const videoTracks: Box[] = [];
  for (const trak of movie.filter((box) => box.type === 'trak')) {
    const handler = trackHandler(view, trak);
    if (handler === undefined) return undefined;
    if (handler === 'vide') videoTracks.push(trak);
  }
  if (videoTracks.length === 0) return 'no_video_track';
  // The provider decodes one video track; report only when none of them works.
  let firstProblem: VideoContainerProblem | undefined;
  for (const trak of videoTracks) {
    const problem = videoTrackProblem(bytes, view, trak, fragmented);
    if (problem === undefined) return undefined;
    firstProblem ??= problem;
  }
  return firstProblem;
}

function trackHandler(view: DataView, trak: Box): string | undefined {
  const hdlr = descend(view, trak, ['mdia', 'hdlr']);
  // Full box header, then pre_defined (ISO) or component type (QuickTime), then the handler.
  if (!hdlr || hdlr.end - hdlr.start < 12) return undefined;
  return fourCc(view, hdlr.start + 8);
}

function videoTrackProblem(
  bytes: Uint8Array,
  view: DataView,
  trak: Box,
  fragmented: boolean,
): VideoContainerProblem | undefined {
  const minf = descend(view, trak, ['mdia', 'minf']);
  if (!minf) return undefined;
  const stbl = descend(view, minf, ['stbl']);
  if (!stbl) return undefined;
  const tables = childBoxes(view, stbl);
  if (!tables) return undefined;
  const sizes = readSampleSizes(
    view,
    tables.find((box) => box.type === 'stsz'),
  );
  if (!sizes) return undefined;
  if (sizes.count === 0) return fragmented ? undefined : 'no_video_frames';
  // Samples stored in another file cannot be checked from this one.
  if (!selfContained(view, minf)) return undefined;

  const chunks = readChunkOffsets(
    view,
    tables.find((box) => box.type === 'stco' || box.type === 'co64'),
  );
  const runs = readSampleToChunk(
    view,
    tables.find((box) => box.type === 'stsc'),
  );
  if (!chunks || !runs || runs[0]?.firstChunk !== 1) return undefined;
  const lengthSize = runs[0].descriptionIndex === 1 ? nalLengthSize(view, tables) : undefined;

  const firstOffset = chunks.offset(0);
  const firstSize = sizes.size(0);
  if (firstOffset + firstSize > bytes.byteLength) return 'unreadable_first_sample';
  if (lengthSize?.size !== undefined && firstSize > 0) {
    if (!walkNalUnits(bytes, firstOffset, firstOffset + firstSize, lengthSize.size, () => false)) {
      return 'unreadable_first_sample';
    }
  }
  if (lengthSize?.size === undefined || !lengthSize.avc) return undefined;
  return hasAvcKeyframe(bytes, sizes, chunks, runs, lengthSize.size) === false
    ? 'no_keyframe'
    : undefined;
}

interface SampleSizes {
  readonly count: number;
  size(index: number): number;
}

function readSampleSizes(view: DataView, stsz: Box | undefined): SampleSizes | undefined {
  if (!stsz || stsz.end - stsz.start < 12) return undefined;
  const fixed = view.getUint32(stsz.start + 4);
  const count = view.getUint32(stsz.start + 8);
  if (fixed !== 0) return { count, size: () => fixed };
  const table = stsz.start + 12;
  if (count > (stsz.end - table) / 4) return undefined;
  return { count, size: (index) => view.getUint32(table + 4 * index) };
}

interface ChunkOffsets {
  readonly count: number;
  offset(index: number): number;
}

function readChunkOffsets(view: DataView, box: Box | undefined): ChunkOffsets | undefined {
  if (!box || box.end - box.start < 8) return undefined;
  const count = view.getUint32(box.start + 4);
  const table = box.start + 8;
  const entryBytes = box.type === 'co64' ? 8 : 4;
  if (count === 0 || count > (box.end - table) / entryBytes) return undefined;
  return {
    count,
    offset: (index) =>
      entryBytes === 8
        ? Number(view.getBigUint64(table + 8 * index))
        : view.getUint32(table + 4 * index),
  };
}

interface ChunkRun {
  /** 1-based index of the first chunk of the run. */
  readonly firstChunk: number;
  readonly samplesPerChunk: number;
  readonly descriptionIndex: number;
}

function readSampleToChunk(view: DataView, stsc: Box | undefined): ChunkRun[] | undefined {
  if (!stsc || stsc.end - stsc.start < 8) return undefined;
  const count = view.getUint32(stsc.start + 4);
  const table = stsc.start + 8;
  if (count === 0 || count > (stsc.end - table) / 12) return undefined;
  const runs: ChunkRun[] = [];
  for (let index = 0; index < count; index += 1) {
    const entry = table + 12 * index;
    runs.push({
      firstChunk: view.getUint32(entry),
      samplesPerChunk: view.getUint32(entry + 4),
      descriptionIndex: view.getUint32(entry + 8),
    });
  }
  return runs;
}

/** True when every data reference of the track points into this file. */
function selfContained(view: DataView, minf: Box): boolean {
  const dref = descend(view, minf, ['dinf', 'dref']);
  if (!dref || dref.end - dref.start < 8) return false;
  const entries = childBoxes(view, { type: 'dref', start: dref.start + 8, end: dref.end });
  if (!entries || entries.length === 0) return false;
  // Each entry is a full box whose flag 1 means "data in this file".
  return entries.every(
    (entry) => entry.end - entry.start >= 4 && (view.getUint32(entry.start) & 1) === 1,
  );
}

/**
 * NAL length-prefix size of an H.264 / HEVC track from its first sample
 * description; undefined size for other codecs or an unusable configuration.
 */
function nalLengthSize(
  view: DataView,
  tables: readonly Box[],
): { size?: number; avc: boolean } | undefined {
  const stsd = tables.find((box) => box.type === 'stsd');
  if (
    !stsd ||
    stsd.end - stsd.start < 8 + BOX_HEADER_BYTES ||
    view.getUint32(stsd.start + 4) === 0
  ) {
    return undefined;
  }
  const entryOffset = stsd.start + 8;
  const entryEnd = boxEnd(view, entryOffset);
  if (entryEnd === undefined || entryEnd > stsd.end) return undefined;
  const codec = fourCc(view, entryOffset + 4);
  const avc = codec === 'avc1' || codec === 'avc3';
  const hevc = codec === 'hvc1' || codec === 'hev1';
  if (!avc && !hevc) return { avc: false };
  // Sample entry (8 bytes) plus the visual sample entry fields (70 bytes).
  const configStart = entryOffset + boxHeaderBytes(view, entryOffset) + 78;
  if (configStart > entryEnd) return { avc };
  const config = childBoxes(view, { type: codec, start: configStart, end: entryEnd })?.find(
    (box) => box.type === (avc ? 'avcC' : 'hvcC'),
  );
  const lengthByte = avc ? 4 : 21;
  if (!config || config.end - config.start <= lengthByte) return { avc };
  const size = (view.getUint8(config.start + lengthByte) & 3) + 1;
  // A three-byte length is not allowed by either codec: do not judge.
  return size === 3 ? { avc } : { size, avc };
}

/**
 * Walks the length-prefixed NAL units of one sample, which must fill it
 * exactly (trailing zero bytes count as padding). `visit` sees each unit and
 * stops the walk by returning true. False when the bytes are not NAL units.
 */
function walkNalUnits(
  bytes: Uint8Array,
  start: number,
  end: number,
  lengthSize: number,
  visit: (unitStart: number, unitEnd: number) => boolean,
): boolean {
  let units = 0;
  let offset = start;
  while (offset < end) {
    if (end - offset < lengthSize) return units > 0 && allZero(bytes, offset, end);
    let length = 0;
    for (let index = 0; index < lengthSize; index += 1) {
      length = length * 256 + (bytes[offset + index] ?? 0);
    }
    offset += lengthSize;
    if (length === 0) {
      if (allZero(bytes, offset, end)) return units > 0;
      continue;
    }
    if (length > end - offset || ((bytes[offset] ?? 0) & 0x80) !== 0) return false;
    units += 1;
    if (visit(offset, offset + length)) return true;
    offset += length;
  }
  return units > 0;
}

/**
 * Whether any sample of an H.264 track holds a keyframe: an IDR slice, an I
 * or SI slice, or a recovery point SEI. Undefined when that cannot be told,
 * because a sample lies outside the file, is not NAL-unit data, a slice
 * header does not parse, or the index is too long to scan. The samples of a
 * well-formed track do not overlap, so their sizes add up to no more than the
 * file: an index whose samples add up to more points at the same data again,
 * and is not scanned further.
 */
function hasAvcKeyframe(
  bytes: Uint8Array,
  sizes: SampleSizes,
  chunks: ChunkOffsets,
  runs: readonly ChunkRun[],
  lengthSize: number,
): boolean | undefined {
  if (sizes.count > MAX_SCANNED_SAMPLES) return undefined;
  let sample = 0;
  let scanned = 0;
  for (let run = 0; run < runs.length && sample < sizes.count; run += 1) {
    const entry = runs[run];
    if (!entry) return undefined;
    const { firstChunk, samplesPerChunk } = entry;
    const nextFirstChunk = runs[run + 1]?.firstChunk ?? chunks.count + 1;
    if (firstChunk < 1 || nextFirstChunk <= firstChunk || nextFirstChunk > chunks.count + 1)
      return undefined;
    for (
      let chunk = firstChunk - 1;
      chunk < nextFirstChunk - 1 && sample < sizes.count;
      chunk += 1
    ) {
      let offset = chunks.offset(chunk);
      for (let inChunk = 0; inChunk < samplesPerChunk && sample < sizes.count; inChunk += 1) {
        const size = sizes.size(sample);
        scanned += size;
        if (offset + size > bytes.byteLength || scanned > bytes.byteLength) return undefined;
        const keyframe = avcSampleHasKeyframe(bytes, offset, offset + size, lengthSize);
        if (keyframe !== false) return keyframe;
        offset += size;
        sample += 1;
      }
    }
  }
  return sample === sizes.count ? false : undefined;
}

/** Whether one H.264 sample holds a keyframe; undefined when it is not NAL-unit data or does not parse. */
function avcSampleHasKeyframe(
  bytes: Uint8Array,
  start: number,
  end: number,
  lengthSize: number,
): boolean | undefined {
  let verdict: boolean | undefined = false;
  const parsed = walkNalUnits(bytes, start, end, lengthSize, (unitStart, unitEnd) => {
    verdict = avcUnitIsKeyframe(bytes, unitStart, unitEnd);
    return verdict !== false;
  });
  return parsed ? verdict : undefined;
}

/** True for a keyframe NAL unit, false for any other, undefined when it does not parse. */
function avcUnitIsKeyframe(bytes: Uint8Array, start: number, end: number): boolean | undefined {
  const type = (bytes[start] ?? 0) & 0x1f;
  if (type === 5) return true;
  if (type === 1 || type === 2) {
    const reader = new RbspBitReader(bytes, start + 1, Math.min(end, start + 1 + 64));
    if (reader.readUe() === undefined) return undefined;
    const sliceType = reader.readUe();
    if (sliceType === undefined || sliceType > 9) return undefined;
    return sliceType % 5 === 2 || sliceType % 5 === 4;
  }
  if (type === 6) return seiHasRecoveryPoint(bytes, start + 1, end);
  return false;
}

/** Whether an SEI NAL unit carries a recovery point; large or unparsable ones are assumed to. */
function seiHasRecoveryPoint(bytes: Uint8Array, start: number, end: number): boolean {
  if (end - start > MAX_SEI_BYTES) return true;
  const rbsp = unescapeRbsp(bytes, start, end);
  let offset = 0;
  while (offset < rbsp.length && rbsp[offset] !== 0x80) {
    let payloadType = 0;
    while (rbsp[offset] === 0xff) {
      payloadType += 255;
      offset += 1;
    }
    if (offset >= rbsp.length) return true;
    payloadType += rbsp[offset] ?? 0;
    offset += 1;
    let payloadSize = 0;
    while (rbsp[offset] === 0xff) {
      payloadSize += 255;
      offset += 1;
    }
    if (offset >= rbsp.length) return true;
    payloadSize += rbsp[offset] ?? 0;
    offset += 1;
    if (payloadType === 6) return true;
    offset += payloadSize;
    if (offset > rbsp.length) return true;
  }
  return false;
}

/** Drops the emulation prevention byte of every 0x000003 sequence. */
function unescapeRbsp(bytes: Uint8Array, start: number, end: number): number[] {
  const out: number[] = [];
  let zeros = 0;
  for (let offset = start; offset < end; offset += 1) {
    const byte = bytes[offset] ?? 0;
    if (zeros >= 2 && byte === 3) {
      zeros = 0;
      continue;
    }
    zeros = byte === 0 ? zeros + 1 : 0;
    out.push(byte);
  }
  return out;
}

/** Reads Exp-Golomb codes from the start of an escaped RBSP. */
class RbspBitReader {
  private readonly bits: number[];
  private position = 0;

  constructor(bytes: Uint8Array, start: number, end: number) {
    this.bits = unescapeRbsp(bytes, start, end);
  }

  readUe(): number | undefined {
    let leadingZeros = 0;
    for (;;) {
      const bit = this.readBit();
      if (bit === undefined) return undefined;
      if (bit === 1) break;
      leadingZeros += 1;
      if (leadingZeros > 31) return undefined;
    }
    let value = 0;
    for (let index = 0; index < leadingZeros; index += 1) {
      const bit = this.readBit();
      if (bit === undefined) return undefined;
      value = value * 2 + bit;
    }
    return 2 ** leadingZeros - 1 + value;
  }

  private readBit(): number | undefined {
    const byte = this.bits[this.position >> 3];
    if (byte === undefined) return undefined;
    const bit = (byte >> (7 - (this.position & 7))) & 1;
    this.position += 1;
    return bit;
  }
}

/** Follows a path of single child boxes, taking the first of each type. */
function descend(view: DataView, from: Box, path: readonly string[]): Box | undefined {
  let current: Box | undefined = from;
  for (const type of path) {
    current = childBoxes(view, current)?.find((box) => box.type === type);
    if (!current) return undefined;
  }
  return current;
}

/** Child boxes of a container box; undefined when they do not tile it exactly. */
function childBoxes(view: DataView, parent: Box): Box[] | undefined {
  const boxes: Box[] = [];
  let offset = parent.start;
  while (parent.end - offset >= BOX_HEADER_BYTES) {
    if (boxes.length === MAX_CHILD_BOXES) return undefined;
    const size = view.getUint32(offset);
    const end = size === 0 ? parent.end : boxEnd(view, offset);
    if (end === undefined || end > parent.end) return undefined;
    boxes.push({
      type: fourCc(view, offset + 4),
      start: offset + boxHeaderBytes(view, offset),
      end,
    });
    offset = end;
  }
  // QuickTime may end a container with a 32-bit zero terminator.
  if (offset !== parent.end && !(parent.end - offset === 4 && view.getUint32(offset) === 0))
    return undefined;
  return boxes;
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return (
    bytes.byteLength >= signature.length && signature.every((byte, index) => bytes[index] === byte)
  );
}

function allZero(bytes: Uint8Array, start: number, end: number): boolean {
  for (let offset = start; offset < end; offset += 1) if (bytes[offset] !== 0) return false;
  return true;
}

function boxType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset + 4] ?? 0,
    bytes[offset + 5] ?? 0,
    bytes[offset + 6] ?? 0,
    bytes[offset + 7] ?? 0,
  );
}

function fourCc(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

function boxHeaderBytes(view: DataView, offset: number): number {
  return view.getUint32(offset) === 1 ? LARGE_BOX_HEADER_BYTES : BOX_HEADER_BYTES;
}

/** End offset of the box at `offset`; undefined when its size field is malformed. */
function boxEnd(view: DataView, offset: number): number | undefined {
  const size = view.getUint32(offset);
  // Size 0: the box extends to the end of the file.
  if (size === 0) return view.byteLength;
  if (size === 1) {
    if (view.byteLength - offset < LARGE_BOX_HEADER_BYTES) return undefined;
    const largeSize = Number(view.getBigUint64(offset + BOX_HEADER_BYTES));
    return largeSize >= LARGE_BOX_HEADER_BYTES ? offset + largeSize : undefined;
  }
  return size >= BOX_HEADER_BYTES ? offset + size : undefined;
}

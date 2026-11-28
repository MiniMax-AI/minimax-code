import { createHash } from 'node:crypto';
import type { Api, Message, Model } from '@earendil-works/pi-ai';
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';

import {
  listRequestImages,
  replaceRequestImages,
  type RequestImage,
} from './request-image-limit.js';
import {
  describeVideoContainerProblem,
  findVideoContainerProblem,
  type VideoContainerProblem,
} from './video-container.js';

/**
 * The MiniMax Messages gateway's video rules, from the open platform's
 * published limits (the "视频/图片输入校验规则" document) and checked against
 * the gateway while investigating reported incident and reported incident.
 * Each violation rejects the whole request with `invalid params ... (2013)`:
 *
 * - Frame sampling: the gateway takes `PROVIDER_VIDEO_SAMPLE_FPS` frames per
 *   second of duration, `nframes = round(total_frames / video_fps * 2 / 2) * 2`
 *   with Python's round (ties to even), and needs `2 <= nframes <= total_frames`.
 *   So a video below 2 fps fails, at exactly 2 fps one with 4k+3 frames fails
 *   (703 frames over 351.5 s fails, 121 over 60.5 s passes), and one of 0.5 s
 *   or less fails.
 * - Length: at most `PROVIDER_MAX_VIDEO_SECONDS` (30 minutes).
 * - Aspect ratio: at most `PROVIDER_MAX_VIDEO_ASPECT_RATIO`:1 (2000x10 passes,
 *   2020x10 fails).
 * - Pixel budget: frames are scaled so the long edge is at most 672 (the
 *   default detail), both edges rounded up to a multiple of 28, and
 *   `width * height * (nframes // 2)` must not exceed `PROVIDER_MAX_VIDEO_PIXELS`:
 *   about 19 minutes of 16:9 video.
 * - Count: at most `PROVIDER_MAX_VIDEOS_PER_REQUEST` videos across all messages.
 *
 * Whether the video is inline or a File API reference, has audio or not, or
 * how large it is makes no difference to these rules. They apply to every
 * provider and protocol alike, not only the gateway they come from: one set
 * of media rules for every model keeps a session's history valid when the
 * user switches models.
 */
export const PROVIDER_VIDEO_SAMPLE_FPS = 2;
export const PROVIDER_MAX_VIDEO_SECONDS = 30 * 60;
export const PROVIDER_MAX_VIDEO_ASPECT_RATIO = 200;
export const PROVIDER_MAX_VIDEO_PIXELS = 301_056_000;
export const PROVIDER_MAX_VIDEOS_PER_REQUEST = 20;
/** Long edge the gateway scales frames to at its default detail level. */
const PROVIDER_VIDEO_LONG_EDGE = 672;
/** The gateway rounds each scaled edge up to a multiple of its patch size. */
const PROVIDER_VIDEO_PATCH = 28;

export interface VideoFrameStats {
  readonly frameCount: number;
  /** Frames over duration. */
  readonly averageFrameRate: number;
}

export interface VideoStats extends VideoFrameStats {
  /** Coded width in pixels; 0 when unknown. */
  readonly width: number;
  /** Coded height in pixels; 0 when unknown. */
  readonly height: number;
}

/** A provider rule a readable video breaks; see `PROVIDER_VIDEO_SAMPLE_FPS`. */
export type VideoRuleViolation =
  | { readonly rule: 'aspect_ratio' }
  | { readonly rule: 'too_long'; readonly seconds: number }
  | { readonly rule: 'too_short'; readonly seconds: number }
  | { readonly rule: 'too_few_frames' }
  | {
      readonly rule: 'too_many_pixels';
      readonly seconds: number;
      readonly scaledWidth: number;
      readonly scaledHeight: number;
      /** Longest duration that fits the pixel budget at this frame size. */
      readonly maxSeconds: number;
    };

/** Why the provider would reject one video on its own; see `findProviderVideoProblem`. */
export type ProviderVideoProblem =
  | {
      readonly kind: 'container';
      readonly problem: VideoContainerProblem;
      /** As `describeVideoContainerProblem` puts it. */
      readonly reason: string;
    }
  | {
      readonly kind: 'rule';
      readonly rule: VideoRuleViolation['rule'];
      /** What the request placeholder says about the rule, with what to do. */
      readonly reason: string;
    };

export interface UnsampleableVideoResult {
  readonly messages: Message[];
  /** Videos replaced by a placeholder for breaking a provider rule (see `providerVideoRuleViolation`). */
  readonly omittedCount: number;
  /** Videos replaced by a placeholder for a broken container (see `findVideoContainerProblem`). */
  readonly brokenCount: number;
  /** Older videos replaced to stay within `PROVIDER_MAX_VIDEOS_PER_REQUEST`. */
  readonly limitedCount: number;
  /** How many of the `omittedCount` videos broke each rule. */
  readonly ruleViolations: Readonly<Partial<Record<VideoRuleViolation['rule'], number>>>;
  /** How many of the `brokenCount` videos had each container problem. */
  readonly containerProblems: Readonly<Partial<Record<VideoContainerProblem, number>>>;
}

/** True when the gateway's frame sampling fails: too short, or more frames wanted than the video has. */
export function providerRejectsVideo(stats: VideoFrameStats): boolean {
  const sampled = providerSampledFrameCount(stats);
  return sampled < 2 || sampled > stats.frameCount;
}

/** Frames the gateway samples from the video. */
export function providerSampledFrameCount({
  frameCount,
  averageFrameRate,
}: VideoFrameStats): number {
  let wanted = (frameCount / averageFrameRate) * PROVIDER_VIDEO_SAMPLE_FPS;
  // A video at exactly the sampling rate measures a hair off a whole number in floating point.
  const nearest = Math.round(wanted);
  if (Math.abs(wanted - nearest) <= Math.max(wanted, 1) * 1e-9) wanted = nearest;
  return 2 * roundHalfToEven(wanted / 2);
}

/**
 * The first provider rule the video breaks, checked in the gateway's order;
 * undefined when it passes. Size rules are skipped when the frame size is unknown.
 */
export function providerVideoRuleViolation(stats: VideoStats): VideoRuleViolation | undefined {
  const { width, height } = stats;
  const sized = width > 0 && height > 0;
  const seconds = stats.frameCount / stats.averageFrameRate;
  if (
    sized &&
    Math.max(width, height) / Math.min(width, height) > PROVIDER_MAX_VIDEO_ASPECT_RATIO
  ) {
    return { rule: 'aspect_ratio' };
  }
  if (seconds > PROVIDER_MAX_VIDEO_SECONDS) return { rule: 'too_long', seconds };
  const sampled = providerSampledFrameCount(stats);
  if (sampled < 2) return { rule: 'too_short', seconds };
  if (sampled > stats.frameCount) return { rule: 'too_few_frames' };
  if (!sized) return undefined;
  const [scaledWidth, scaledHeight] = providerScaledSize(width, height);
  const framePixels = scaledWidth * scaledHeight;
  if (framePixels * Math.floor(sampled / 2) <= PROVIDER_MAX_VIDEO_PIXELS) return undefined;
  return {
    rule: 'too_many_pixels',
    seconds,
    scaledWidth,
    scaledHeight,
    maxSeconds: Math.floor(PROVIDER_MAX_VIDEO_PIXELS / framePixels),
  };
}

function providerScaledSize(width: number, height: number): [number, number] {
  const scale = Math.min(1, PROVIDER_VIDEO_LONG_EDGE / Math.max(width, height));
  const align = (edge: number): number =>
    Math.max(
      PROVIDER_VIDEO_PATCH,
      Math.ceil(Math.round(edge * scale) / PROVIDER_VIDEO_PATCH) * PROVIDER_VIDEO_PATCH,
    );
  return [align(width), align(height)];
}

/** A broken container, or the video stats (null when they cannot be read). */
type VideoReading =
  | { readonly problem: VideoContainerProblem }
  | { readonly problem?: undefined; readonly stats: VideoStats | null };

/**
 * History replays the same videos on every request of a session, so each
 * reading is kept by the hash of the base64 data. Least recently used entries
 * go first.
 */
const VIDEO_READING_CACHE_MAX_ENTRIES = 512;
const videoReadingCache = new Map<string, VideoReading>();

/**
 * Returns the request copy of `messages` with every video the gateway would
 * reject replaced by a text placeholder that tells the agent why and what to
 * do: one whose container is broken (see `findVideoContainerProblem`), one
 * that breaks a provider rule (see `PROVIDER_VIDEO_SAMPLE_FPS`), and, past
 * `PROVIDER_MAX_VIDEOS_PER_REQUEST`, the oldest of the rest.
 *
 * A last-resort net like the undersized-image filter: the video lives in
 * persisted history, so without it the gateway rejects the whole request on
 * every later turn and the session cannot recover. Only the provider-bound
 * copy changes. A video whose stats cannot be read and whose container is not
 * positively broken is kept, because dropping real content is worse than
 * letting an unknown video through.
 *
 * The rules are the same for every target model, so `_model` does not change
 * the result; it stays in the signature the agent turn and both checkpoint
 * paths call.
 */
export async function omitUnsampleableVideosForModel(
  messages: readonly Message[],
  _model: Model<Api>,
): Promise<UnsampleableVideoResult> {
  const unchanged = {
    messages: [...messages],
    omittedCount: 0,
    brokenCount: 0,
    limitedCount: 0,
    ruleViolations: {},
    containerProblems: {},
  };
  const texts = new Map<string, string>();
  const ruleViolations: Partial<Record<VideoRuleViolation['rule'], number>> = {};
  const containerProblems: Partial<Record<VideoContainerProblem, number>> = {};
  const kept: RequestImage[] = [];
  let omittedCount = 0;
  let brokenCount = 0;
  for (const video of listRequestImages(messages)) {
    if (!video.mimeType?.toLowerCase().startsWith('video/')) continue;
    const data = blockData(messages[video.messageIndex], video.blockIndex);
    if (data === undefined) continue;
    const reading = await cachedVideoReading(data);
    if (reading.problem) {
      texts.set(video.key, placeholder(describeVideoContainerProblem(reading.problem), video.path));
      containerProblems[reading.problem] = (containerProblems[reading.problem] ?? 0) + 1;
      brokenCount += 1;
      continue;
    }
    const violation = reading.stats ? providerVideoRuleViolation(reading.stats) : undefined;
    if (!violation || !reading.stats) {
      kept.push(video);
      continue;
    }
    texts.set(video.key, placeholder(describeRuleViolation(violation, reading.stats), video.path));
    ruleViolations[violation.rule] = (ruleViolations[violation.rule] ?? 0) + 1;
    omittedCount += 1;
  }
  const overLimit = kept.slice(0, Math.max(0, kept.length - PROVIDER_MAX_VIDEOS_PER_REQUEST));
  for (const video of overLimit) texts.set(video.key, overLimitText(video.path));
  if (texts.size === 0) return unchanged;
  return {
    messages: replaceRequestImages(messages, (video) => texts.get(video.key)),
    omittedCount,
    brokenCount,
    limitedCount: overLimit.length,
    ruleViolations,
    containerProblems,
  };
}

/**
 * Why the provider would reject this one video (base64 data): a broken
 * container (see `findVideoContainerProblem`) or a broken provider rule (see
 * `PROVIDER_VIDEO_SAMPLE_FPS`), with the reason the request placeholder gives,
 * phrased to follow "video omitted: " and without a full stop. Undefined when
 * it passes, or when its stats cannot be read and its container is not
 * positively broken. User attachments use it to keep such a video out of
 * history. The videos-per-request limit is not checked: it depends on the
 * rest of the request. The reading is cached, so the outbound guard reuses it.
 */
export async function findProviderVideoProblem(
  data: string,
): Promise<ProviderVideoProblem | undefined> {
  const reading = await cachedVideoReading(data);
  if (reading.problem) {
    return {
      kind: 'container',
      problem: reading.problem,
      reason: describeVideoContainerProblem(reading.problem),
    };
  }
  const violation = reading.stats ? providerVideoRuleViolation(reading.stats) : undefined;
  if (!violation || !reading.stats) return undefined;
  return {
    kind: 'rule',
    rule: violation.rule,
    reason: describeRuleViolation(violation, reading.stats),
  };
}

/** Frame count, average frame rate and coded size of the primary video track; null when unreadable. */
export async function readVideoFrameStats(data: string): Promise<VideoStats | null> {
  return videoStatsOf(Buffer.from(data, 'base64'));
}

async function videoStatsOf(bytes: Buffer): Promise<VideoStats | null> {
  const input = new Input({
    source: new BufferSource(bytes),
    formats: ALL_FORMATS,
  });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return null;
    const { packetCount, averagePacketRate } = await track.computePacketStats();
    if (!(packetCount > 0) || !Number.isFinite(averagePacketRate) || averagePacketRate <= 0) {
      return null;
    }
    return {
      frameCount: packetCount,
      averageFrameRate: averagePacketRate,
      width: positiveOrZero(track.codedWidth),
      height: positiveOrZero(track.codedHeight),
    };
  } catch {
    return null;
  } finally {
    input.dispose();
  }
}

function positiveOrZero(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

async function readVideo(data: string): Promise<VideoReading> {
  const bytes = Buffer.from(data, 'base64');
  const problem = findVideoContainerProblem(bytes);
  if (problem) return { problem };
  return { stats: await videoStatsOf(bytes) };
}

async function cachedVideoReading(data: string): Promise<VideoReading> {
  const key = createHash('sha256').update(data).digest('hex');
  const cached = videoReadingCache.get(key);
  if (cached !== undefined) {
    videoReadingCache.delete(key);
    videoReadingCache.set(key, cached);
    return cached;
  }
  const reading = await readVideo(data);
  videoReadingCache.set(key, reading);
  for (const oldest of videoReadingCache.keys()) {
    if (videoReadingCache.size <= VIDEO_READING_CACHE_MAX_ENTRIES) break;
    videoReadingCache.delete(oldest);
  }
  return reading;
}

/** Python's `round`, which the gateway's frame count follows: ties go to the even neighbour. */
function roundHalfToEven(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction > 0.5) return floor + 1;
  if (fraction < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

function blockData(message: Message | undefined, blockIndex: number): string | undefined {
  if (!message || !Array.isArray(message.content)) return undefined;
  const block: unknown = message.content[blockIndex];
  if (!block || typeof block !== 'object') return undefined;
  const data = (block as { data?: unknown }).data;
  return typeof data === 'string' ? data : undefined;
}

function placeholder(reason: string, path: string | undefined): string {
  return path
    ? `[video omitted: ${reason}. Original file: ${path}]`
    : `[video omitted: ${reason}.]`;
}

function overLimitText(path: string | undefined): string {
  const reason = `the model provider accepts at most ${PROVIDER_MAX_VIDEOS_PER_REQUEST} videos per request, so only the ${PROVIDER_MAX_VIDEOS_PER_REQUEST} most recent are kept. Read it again if it is still needed`;
  return path
    ? `[Earlier video omitted: ${reason}. Original file: ${path}]`
    : `[Earlier video omitted: ${reason}.]`;
}

function describeRuleViolation(violation: VideoRuleViolation, stats: VideoStats): string {
  const size = `${stats.width}x${stats.height}`;
  switch (violation.rule) {
    case 'aspect_ratio':
      return `its picture is ${size} pixels, an aspect ratio above the ${PROVIDER_MAX_VIDEO_ASPECT_RATIO}:1 the model provider accepts. Crop or pad it to at most ${PROVIDER_MAX_VIDEO_ASPECT_RATIO}:1 (for example with ffmpeg's crop or pad filter) and read the new file`;
    case 'too_long':
      return (
        `it lasts ${formatMinutes(violation.seconds)}, longer than the ${PROVIDER_MAX_VIDEO_SECONDS / 60} minutes the model provider accepts for one video. Cut it into parts of at most ${PROVIDER_MAX_VIDEO_SECONDS / 60} minutes, for example ` +
        '`ffmpeg -i <file> -c copy -f segment -segment_time 1500 -reset_timestamps 1 <part>%03d.mp4`' +
        ', and read the parts one at a time'
      );
    case 'too_short':
      return `it lasts only ${formatSeconds(violation.seconds)} s, and the model provider samples ${PROVIDER_VIDEO_SAMPLE_FPS} frames per second and needs at least 2, so a video must be longer than 0.5 s. Read a frame of it as an image instead, or a longer clip`;
    case 'too_few_frames': {
      const fps = Number(stats.averageFrameRate.toFixed(2));
      return `it has ${stats.frameCount} frames at ${fps} fps, fewer than the model provider samples (${PROVIDER_VIDEO_SAMPLE_FPS} per second of video). Re-encode it above ${PROVIDER_VIDEO_SAMPLE_FPS} fps, for example at 3 fps, to send it again`;
    }
    case 'too_many_pixels':
      return `at ${size} it is too long for the model provider's pixel budget: the provider scales each frame to ${violation.scaledWidth}x${violation.scaledHeight}, samples ${PROVIDER_VIDEO_SAMPLE_FPS} per second and accepts at most 301,056,000 pixels per video, about ${violation.maxSeconds} s at this size (this video lasts ${formatSeconds(violation.seconds)} s). Split it into clips of at most ${violation.maxSeconds} s, or scale it down, and read those instead`;
  }
}

function formatSeconds(seconds: number): string {
  return String(Number(seconds.toFixed(seconds < 1 ? 2 : 1)));
}

function formatMinutes(seconds: number): string {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)} min ${whole % 60} s`;
}

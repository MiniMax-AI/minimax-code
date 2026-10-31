import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';

import {
  archivedImageText,
  boundRequestMedia,
  isRequestMediaRejection,
  omittedRequestImageText,
  PROVIDER_IMAGE_MAX_BASE64_BYTES,
  resolveRequestMediaBudget,
  selectRequestImages,
} from '../src/index.js';

function image(bytes = 10) {
  return { type: 'image' as const, data: 'a'.repeat(bytes), mimeType: 'image/png' };
}

function screenshot(id: string, bytes = 10): AgentMessage[] {
  return [
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id, name: 'read', arguments: { path: `/shots/${id}.png` } }],
      stopReason: 'toolUse',
    } as unknown as AgentMessage,
    {
      role: 'toolResult',
      toolCallId: id,
      toolName: 'read',
      content: [image(bytes)],
      isError: false,
      timestamp: 0,
    } as unknown as AgentMessage,
  ];
}

function history(count: number, bytes = 10): AgentMessage[] {
  return Array.from({ length: count }, (_, index) => screenshot(`s${index}`, bytes)).flat();
}

function keptPaths(messages: AgentMessage[], budget: { maxImages: number; maxImageBytes: number }) {
  return selectRequestImages(messages, budget).kept.map((entry) => entry.path);
}

function rejection(errorMessage: string): AssistantMessage {
  return { role: 'assistant', stopReason: 'error', errorMessage, content: [] } as unknown as AssistantMessage;
}

describe('resolveRequestMediaBudget', () => {
  it('takes the image count from the model and two thirds of the request body for bytes', () => {
    const budget = resolveRequestMediaBudget({
      model: { maxImagesPerRequest: 8 } as unknown as Model<Api>,
      maxSerializedInputBytes: 3_000,
    });
    expect(budget).toEqual({ maxImages: 8, maxImageBytes: 2_000 });
  });

  it('assumes 64 MiB of request body when the host declares none', () => {
    const budget = resolveRequestMediaBudget({
      model: { maxImagesPerRequest: 8 } as unknown as Model<Api>,
    });
    expect(budget.maxImageBytes).toBe(Math.floor((64 * 1024 * 1024 * 2) / 3));
  });
});

describe('selectRequestImages', () => {
  it('keeps every image while both limits hold', () => {
    expect(keptPaths(history(4), { maxImages: 4, maxImageBytes: 1_000 })).toHaveLength(4);
  });

  it('drops the oldest down to half the count once the count limit is crossed', () => {
    expect(keptPaths(history(5), { maxImages: 4, maxImageBytes: 1_000 })).toEqual([
      '/shots/s3.png',
      '/shots/s4.png',
    ]);
  });

  it('drops the oldest down to half the bytes once the byte limit is crossed', () => {
    expect(keptPaths(history(4, 100), { maxImages: 20, maxImageBytes: 350 })).toEqual([
      '/shots/s3.png',
    ]);
  });

  it('drops a superset as history grows, so earlier placeholders stay put', () => {
    const budget = { maxImages: 4, maxImageBytes: 1_000 };
    const shorter = selectRequestImages(history(6), budget).dropped.map((entry) => entry.key);
    const longer = selectRequestImages(history(9), budget).dropped.map((entry) => entry.key);
    expect(longer).toEqual(expect.arrayContaining(shorter));
  });

  it('keeps the newest image even when it alone crosses the byte limit', () => {
    expect(keptPaths(history(2, 100), { maxImages: 20, maxImageBytes: 50 })).toEqual([
      '/shots/s1.png',
    ]);
  });

  it('drops an image above the per-image provider limit, even the newest', () => {
    const messages = [...history(1), ...screenshot('big', PROVIDER_IMAGE_MAX_BASE64_BYTES + 1)];
    expect(keptPaths(messages, { maxImages: 20, maxImageBytes: 100 * 1024 * 1024 })).toEqual([
      '/shots/s0.png',
    ]);
  });
});

describe('boundRequestMedia', () => {
  it('replaces dropped images with a placeholder naming the original file', () => {
    const result = boundRequestMedia(history(3), { maxImages: 2, maxImageBytes: 1_000 });
    expect(result.omittedCount).toBe(2);
    expect(result.messages[1]).toMatchObject({
      content: [{ type: 'text', text: omittedRequestImageText('/shots/s0.png') }],
    });
    expect(result.messages[5]).toMatchObject({ content: [image()] });
  });
});

describe('isRequestMediaRejection', () => {
  it('matches request size and image limit rejections only on error responses', () => {
    expect(isRequestMediaRejection(rejection('413 request_too_large'))).toBe(true);
    expect(isRequestMediaRejection(rejection('too many images in request: 25 > 20'))).toBe(true);
    expect(isRequestMediaRejection(rejection('413 Request Entity Too Large'))).toBe(true);
    expect(isRequestMediaRejection(rejection('413 payload too large'))).toBe(true);
    for (const text of [
      'Input is too long.',
      '413 <html><body>nginx</body></html>',
      'Request too large for gpt-4o',
      'request body too large',
      'Request exceeds the maximum allowed size',
      'messages.0.content.1.image.source.base64: image exceeds 5 MB maximum',
      'At least one of the image dimensions exceed max allowed size for many-image requests',
      '400 image dimensions exceed max allowed size: 8000 pixels',
      '400 {"error":{"message":"gateway error 413 occurred"}}',
    ]) {
      expect(isRequestMediaRejection(rejection(text)), text).toBe(true);
    }
    expect(isRequestMediaRejection(rejection('rate limit exceeded'))).toBe(false);
    expect(isRequestMediaRejection(rejection('4130 tokens left'))).toBe(false);
  });

  it('does not treat a missing stop_reason with a count of 413 as a size rejection', () => {
    expect(
      isRequestMediaRejection(
        rejection(
          'Provider stream ended without stop_reason (messageDeltaCount=1; rawEventCount=413; messageEventCount=413; lastEventAtMs=413; eofAtMs=413)',
        ),
      ),
    ).toBe(false);
  });
});

describe('placeholder text', () => {
  it('asks for a new capture when no file is known', () => {
    expect(omittedRequestImageText(undefined)).toContain('Capture it again');
    expect(archivedImageText('/a.png')).toContain('File: /a.png');
  });
});

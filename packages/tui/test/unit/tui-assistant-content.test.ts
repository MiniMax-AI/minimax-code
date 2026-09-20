import { describe, expect, it } from 'vitest';
import { parseDeliverAssetsContent } from '@mavis/shared/asset-markup';
import { projectAssistantContentForTerminal } from '../../src/application/assistant-content.js';

describe('terminal attachment projection', () => {
  it('renders five path-based files without seven per-tag placeholders', () => {
    const names = ['first.py', 'second.py', 'test_first.py', 'report.md', 'notes.txt'];
    const content = [
      'Done.',
      '<deliver-assets>',
      ...names.map((name) => `<media type="file" path="/workspace/${name}" name="${name}" />`),
      '</deliver-assets>',
    ].join('\n');

    expect(projectAssistantContentForTerminal(content)).toEqual({
      text: 'Done.',
      assets: names.map((name) => ({ path: `/workspace/${name}`, name })),
    });
  });

  it.each([
    '<deliver-assets><media type="file" name="Missing path" /></deliver-assets>',
    '<deliver_assets><media src=" " path=" " /></deliver_assets>',
    '<media type="file" name="Missing path" />',
    '<deliver-assets>\n</deliver-assets>',
  ])('removes unusable attachment markup while preserving prose: %s', (markup) => {
    expect(projectAssistantContentForTerminal(`Before.\n\n${markup}\n\nAfter.`)).toEqual({
      text: 'Before.\n\nAfter.',
      assets: [],
    });
  });

  it('preserves prose inside an invalid attachment wrapper', () => {
    const content =
      '<deliver-assets>Keep this explanation.<media name="Missing" /></deliver-assets>';
    expect(projectAssistantContentForTerminal(content)).toEqual({
      text: 'Keep this explanation.',
      assets: [],
    });
  });

  it('keeps valid files and deduplicates aliases in mixed attachment markup', () => {
    const content = [
      '<deliver-assets>',
      '<media src="/workspace/report.txt" name="Report" />',
      '<media path="/workspace/report.txt" />',
      '<media name="Missing" />',
      '<media path="/workspace/notes.txt" />',
      '</deliver-assets>',
    ].join('\n');
    expect(projectAssistantContentForTerminal(content)).toEqual({
      text: '',
      assets: [{ path: '/workspace/report.txt', name: 'Report' }, { path: '/workspace/notes.txt' }],
    });
  });

  it('preserves literal attachment examples in inline and fenced code', () => {
    const markup = '<deliver-assets><media path="/workspace/example.txt" /></deliver-assets>';
    const content = ['Example:', `\`${markup}\``, '```xml', markup, '```'].join('\n');
    expect(projectAssistantContentForTerminal(content)).toEqual({ text: content, assets: [] });
  });

  it('projects a completed attachment after an incomplete streaming prefix', () => {
    const prefix = 'Done.\n<deliver-assets>\n<media type="file" path="/workspace/report';
    expect(projectAssistantContentForTerminal(prefix).assets).toEqual([]);
    expect(projectAssistantContentForTerminal(`${prefix}.txt" />\n</deliver-assets>`)).toEqual({
      text: 'Done.',
      assets: [{ path: '/workspace/report.txt' }],
    });
  });
});

describe('shared media source compatibility', () => {
  it.each([
    ['src="/workspace/preferred.txt" path="/workspace/fallback.txt"', '/workspace/preferred.txt'],
    ['src=" " path=" /workspace/fallback.txt "', '/workspace/fallback.txt'],
    ['path="/workspace/a&amp;b.txt"', '/workspace/a&b.txt'],
  ])('uses src before path and normalizes the source: %s', (attributes, path) => {
    expect(parseDeliverAssetsContent(`<media type="file" ${attributes} name="Report" />`)).toEqual([
      { type: 'deliver-assets', items: [{ path, name: 'Report', type: 'file' }] },
    ]);
  });
});

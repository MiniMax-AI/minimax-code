import { describe, expect, it } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { buildRecentConversationPrompt, latestUserText } from './recent-context.js';

const reply = (
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'] = 'stop',
): AssistantMessage => ({
  role: 'assistant',
  content,
  api: 'anthropic-messages',
  provider: 'test',
  model: 'test',
  usage: {
    input: 20,
    output: 60,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 80,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason,
  timestamp: 1,
});

describe('recent conversation rendering', () => {
  const user = (content: string) => ({ role: 'user' as const, content, timestamp: 0 });
  const answered = (text: string) => reply([{ type: 'text', text }]);
  const instruction = 'INSTRUCTION';

  it('keeps only the last three turns and groups steering messages into their turn', () => {
    const messages = [
      user('第一轮'),
      answered('回复一'),
      user('第二轮'),
      answered('回复二'),
      user('第三轮'),
      reply([{ type: 'toolCall', id: 'c', name: 'bash', arguments: {} }], 'toolUse'),
      user('插话：顺便看下日志'),
      answered('回复三'),
      user('第四轮'),
    ];
    const prompt = buildRecentConversationPrompt(messages, answered('回复四'), instruction);
    expect(prompt).not.toContain('第一轮');
    expect(prompt).toContain(
      '<turn>\n<user>第三轮</user>\n<user>插话：顺便看下日志</user>\n<assistant>回复三</assistant>\n</turn>',
    );
    expect(prompt).toContain('<user>第四轮</user>\n<assistant>回复四</assistant>');
    expect(prompt.match(/<turn>/g)).toHaveLength(3);
  });

  it('keeps the head of long user text and the tail of long replies', () => {
    const prompt = buildRecentConversationPrompt(
      [user(`需求开头${'甲'.repeat(5000)}需求结尾`)],
      answered(`回复开头${'乙'.repeat(5000)}下一步：跑测试`),
      instruction,
    );
    expect(prompt).toContain('需求开头');
    expect(prompt).toContain('下一步：跑测试');
    expect(prompt).toContain('…[省略');
    expect(prompt.length).toBeLessThan(5_000);
  });

  it('reduces a selection-context block to the user comments', () => {
    const text = `<user-provided-context>\n# Added chat context\n${'boilerplate '.repeat(400)}\nUser comment (requested change):\n这里改成同步调用\n\nQuoted excerpt: "..."\n</user-provided-context>\n\n帮我看看`;
    const prompt = buildRecentConversationPrompt([user(text)], answered('好的'), instruction);
    expect(prompt).toContain('[对引用内容的批注] (1) 这里改成同步调用');
    expect(prompt).not.toContain('boilerplate');
    expect(latestUserText([user(text)])).toContain('帮我看看');
  });

  it('keeps only the readable Q/A of a questionnaire answer', () => {
    const answer = `<questionnaire-response>\n  <requestId>ask_1</requestId>\n  <answers><answer><stepId>list_target</stepId></answer></answers>\n</questionnaire-response>\n\nQ: 你想执行哪一种 list？\nA: 列出当前工作区里的仓库/文件夹`;
    const prompt = buildRecentConversationPrompt(
      [
        user('执行一下 list'),
        reply([{ type: 'toolCall', id: 'q', name: 'ask_user', arguments: {} }], 'toolUse'),
        user(answer),
      ],
      answered('当前工作区有 13 个文件夹'),
      instruction,
    );
    expect(prompt).toContain(
      '<user>Q: 你想执行哪一种 list？\nA: 列出当前工作区里的仓库/文件夹</user>',
    );
    expect(prompt).not.toContain('requestId');
    expect(prompt).not.toContain('questionnaire-response');
  });

  it('never throws on unexpected message shapes', () => {
    const messages = [
      null,
      42,
      { role: 'system', content: 'x' },
      { role: 'user', content: [{ type: 'image' }] },
      user('真正的问题'),
    ];
    expect(() =>
      buildRecentConversationPrompt(messages, answered('回复'), instruction),
    ).not.toThrow();
    expect(buildRecentConversationPrompt(messages, answered('回复'), instruction)).toContain(
      '<user>真正的问题</user>',
    );
  });
});

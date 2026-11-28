import { describe, expect, it } from 'vitest';

import {
  configIssuesLostFile,
  configIssuesLostKinds,
  describeConfigNotice,
} from '../src/config-issue-copy.js';

const PATH = '/data/config.yaml';
const missing = { kind: 'missing' as const, message: 'config.yaml was deleted; all settings use defaults' };

describe('config issue notice copy', () => {
  it('says settings were lost when the deleted file was not replaced', () => {
    const notice = describeConfigNotice([missing], 'zh', PATH);
    expect(notice.summary).toBe('config.yaml 中的配置已丢失，MiniMax Code 已改用默认值启动。');
    expect(notice.footer).toContain(`可以在 ${PATH} 或设置中重新配置`);
  });

  it('does not claim defaults are in use once a replacement file is in use', () => {
    const issues = [{ ...missing, fileInUse: true }];
    const notice = describeConfigNotice(issues, 'zh', PATH);
    expect(configIssuesLostFile(issues)).toBe(false);
    expect(notice.summary).toBe('config.yaml 曾被删除，MiniMax Code 正在使用之后重新写入的配置。');
    expect(notice.lines[0]).toContain('当前使用的是之后重新写入的配置');
    expect(`${notice.summary}${notice.lines.join('')}`).not.toMatch(/已改用默认值|原文件未被修改/);
    expect(configIssuesLostKinds(issues)).toEqual({ missing: true });
  });

  it('lists only lost-settings kinds for acknowledgement', () => {
    expect(
      configIssuesLostKinds([
        { kind: 'invalid_section', section: 'sandbox', message: 'x' },
        { kind: 'empty', message: 'x' },
      ]),
    ).toEqual({ empty: true });
    expect(configIssuesLostKinds([{ kind: 'invalid_yaml', message: 'x' }])).toEqual({});
  });

  it('says plugins are limited when the whole file fell back', () => {
    const [line] = describeConfigNotice(
      [{ kind: 'invalid_yaml', line: 4, message: 'x', failClosed: true }],
      'zh',
      PATH,
    ).lines;
    expect(line).toBe('文件不是合法的 YAML（第 4 行），全部配置已改用默认值；插件禁用名单读不出来，本次只加载官方插件');
  });

  it('says what replaced a section that failed closed, and only then', () => {
    const notice = describeConfigNotice(
      [
        { kind: 'invalid_section', section: 'plugins', message: 'x', failClosed: true },
        { kind: 'invalid_section', section: 'skillEvolve', message: 'y', failClosed: true },
        { kind: 'invalid_section', section: 'browser', message: 'z', failClosed: true },
        // Not reported as failed closed: the copy must not claim it by name.
        { kind: 'invalid_section', section: 'plugins', message: 'w' },
      ],
      'zh',
      PATH,
    );
    expect(notice.lines).toEqual([
      'plugins 无法读取，本次只加载官方插件（能读出的禁用名单仍然生效）：x',
      'skillEvolve 配置有误，本次已关闭：y',
      'browser 配置有误，本次已停用：z',
      'plugins 已改用默认值：w',
    ]);
  });
});

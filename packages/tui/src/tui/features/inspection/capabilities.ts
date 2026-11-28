import type { TuiSkillList } from '../../../runtime/port.js';
import { classifyTuiSkillSource, type TuiSkill } from './product-inspection.js';
import {
  TuiInspectionPanel,
  type TuiInspectionRow,
  type TuiInspectionSection,
} from '../../shell/inspection-panel.js';

export function createTuiSkillsInspectionPanel(
  result: TuiSkillList,
  filter: string,
  onCancel: () => void,
  maxRows: () => number,
): TuiInspectionPanel {
  const skills = result.skills ?? [];
  const groups = [
    {
      title: 'Built-in',
      skills: skills.filter((skill) => classifyTuiSkillSource(skill) === 'builtin'),
    },
    {
      title: 'User',
      skills: skills.filter((skill) => classifyTuiSkillSource(skill) === 'user'),
    },
    {
      title: 'Other',
      skills: skills.filter((skill) => classifyTuiSkillSource(skill) === 'other'),
    },
  ];
  const sections = groups
    .filter((group) => group.skills.length > 0)
    .map(
      (group): TuiInspectionSection => ({
        title: `${group.title} · ${group.skills.length}`,
        rows: group.skills.map(skillRow),
      }),
    );
  if (sections.length === 0) sections.push(emptySkillsSection(filter));
  const normalizedFilter = filter.trim();
  const subtitle = [
    normalizedFilter ? `Matching “${normalizedFilter}”` : 'Available to the current Agent',
    result.hasMore ? 'More results exist' : undefined,
    'Read-only catalog',
  ]
    .filter(Boolean)
    .join(' · ');

  return new TuiInspectionPanel({
    title: 'Skills',
    subtitle,
    badge: {
      label: `${skills.length}${result.hasMore ? '+' : ''} FOUND`,
      tone: skills.length > 0 ? 'accent' : 'neutral',
    },
    sections,
    footer: 'Esc close · read only',
    layout: 'stacked',
    maxRows,
    onCancel,
  });
}

function skillRow(skill: TuiSkill): TuiInspectionRow {
  const available = skill.enabled !== false;
  return {
    label: skill.displayName ?? skill.name,
    value: `${available ? '● available' : '○ unavailable'} · ${skillSourceLabel(skill)}`,
    tone: available ? 'success' : 'neutral',
    labelTone: 'neutral',
    labelBold: true,
    detail: skill.displayDescription ?? skill.description,
    detailMaxLines: 2,
  };
}

function emptySkillsSection(filter: string): TuiInspectionSection {
  const normalizedFilter = filter.trim();
  return {
    title: 'Catalog',
    rows: [
      {
        label: 'No matches',
        value: normalizedFilter || 'No Skills configured',
        labelTone: 'neutral',
        labelBold: true,
        detail: normalizedFilter
          ? 'Close this panel and try a broader /skills filter.'
          : 'The current Agent has no visible Skills.',
      },
    ],
  };
}

function skillSourceLabel(skill: TuiSkill): string {
  if (skill.sourceKind) return skill.sourceKind;
  if (skill.sourceType === 1) return 'official';
  if (skill.sourceType === 2) return 'user';
  return skill.sourceType === undefined ? 'unknown source' : `source ${skill.sourceType}`;
}

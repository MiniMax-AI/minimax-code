import { createDefaultTokenEstimator, type TokenEstimator } from '@mavis/context-manager';

export const LOCAL_SKILL_CATALOG_MAX_BUDGET_TOKENS = 5_000;
export const LOCAL_SKILL_DESCRIPTION_MAX_CODE_POINTS = 300;
const PROTECTED_SKILL_NAMES = new Set(['mcode-tools-master', 'minimax-code-product']);

const PARTIAL_DESCRIPTION_NOTICE =
  'Skill descriptions were shortened to fit the catalog budget.';
const PARTIAL_SKILL_NOTICE =
  'Some skills were omitted because not every skill name fits within the skills context budget.';
const LOCAL_NON_MONOTONIC_RECOVERY_MAX_CONSECUTIVE_MISSES = 8;
const DEFAULT_TOKEN_ESTIMATOR = createDefaultTokenEstimator();

export type LocalSkillCatalogTokenEstimator = Pick<TokenEstimator, 'estimateTextTokens'>;

export interface LocalSkillsCatalogEntry {
  name: string;
  description: string;
  builtin: boolean;
}

export interface LocalSkillsCatalogRenderOptions {
  contextWindowTokens?: number;
  tokenEstimator?: LocalSkillCatalogTokenEstimator;
}

export interface LocalSkillsCatalogRenderResult {
  catalog: string;
  softOverflow: boolean;
  hardOverflow: boolean;
  descriptionCapTruncated: boolean;
}

interface PreparedSkill {
  name: string;
  description: readonly string[];
  descriptionTruncated: boolean;
  builtin: boolean;
}

export function resolveLocalSkillCatalogBudgetTokens(contextWindowTokens?: number): number {
  if (
    typeof contextWindowTokens !== 'number' ||
    !Number.isFinite(contextWindowTokens) ||
    contextWindowTokens <= 0
  ) {
    return LOCAL_SKILL_CATALOG_MAX_BUDGET_TOKENS;
  }
  return Math.min(Math.floor(contextWindowTokens * 0.02), LOCAL_SKILL_CATALOG_MAX_BUDGET_TOKENS);
}

export function renderLocalSkillsCatalog(
  skills: readonly LocalSkillsCatalogEntry[],
  options: LocalSkillsCatalogRenderOptions = {},
): string {
  return renderLocalSkillsCatalogResult(skills, options).catalog;
}

export function renderLocalSkillsCatalogResult(
  skills: readonly LocalSkillsCatalogEntry[],
  options: LocalSkillsCatalogRenderOptions = {},
): LocalSkillsCatalogRenderResult {
  if (skills.length === 0) {
    return {
      catalog: '',
      softOverflow: false,
      hardOverflow: false,
      descriptionCapTruncated: false,
    };
  }

  const estimator = options.tokenEstimator ?? DEFAULT_TOKEN_ESTIMATOR;
  const budgetTokens = resolveLocalSkillCatalogBudgetTokens(options.contextWindowTokens);
  const prepared = prepareSkills(skills);
  const completeLengths = prepared.map((skill) => skill.description.length);
  const completeCatalog = renderCatalog(prepared, completeLengths);
  const descriptionCapTruncated = prepared.some((skill) => skill.descriptionTruncated);
  if (fitsBudget(completeCatalog, budgetTokens, estimator)) {
    return {
      catalog: completeCatalog,
      softOverflow: false,
      hardOverflow: false,
      descriptionCapTruncated,
    };
  }

  const protectedLengths = protectedDescriptionLengths(prepared);
  const protectedFloor = renderCatalog(prepared, protectedLengths);
  if (!fitsBudget(protectedFloor, budgetTokens, estimator)) {
    return renderHardOverflow(prepared, budgetTokens, estimator, descriptionCapTruncated);
  }

  const noticedProtectedFloor = renderCatalog(
    prepared,
    protectedLengths,
    PARTIAL_DESCRIPTION_NOTICE,
  );
  const notice = fitsBudget(noticedProtectedFloor, budgetTokens, estimator)
    ? PARTIAL_DESCRIPTION_NOTICE
    : undefined;
  const allocatedLengths = allocateDescriptions(prepared, notice, budgetTokens, estimator);

  const catalog = renderCatalog(prepared, allocatedLengths, notice);
  if (!fitsBudget(catalog, budgetTokens, estimator)) {
    if (notice) {
      const lengthsWithoutNotice = allocateDescriptions(
        prepared,
        undefined,
        budgetTokens,
        estimator,
      );
      const catalogWithoutNotice = renderCatalog(prepared, lengthsWithoutNotice);
      if (fitsBudget(catalogWithoutNotice, budgetTokens, estimator)) {
        return {
          catalog: catalogWithoutNotice,
          softOverflow: true,
          hardOverflow: false,
          descriptionCapTruncated,
        };
      }
    }
    if (fitsBudget(protectedFloor, budgetTokens, estimator)) {
      return {
        catalog: protectedFloor,
        softOverflow: true,
        hardOverflow: false,
        descriptionCapTruncated,
      };
    }
    return renderHardOverflow(prepared, budgetTokens, estimator, descriptionCapTruncated);
  }
  return {
    catalog,
    softOverflow: true,
    hardOverflow: false,
    descriptionCapTruncated,
  };
}

function prepareSkills(skills: readonly LocalSkillsCatalogEntry[]): PreparedSkill[] {
  return [...skills]
    .sort((left, right) => {
      const priority = Number(isProtectedSkill(right.name)) - Number(isProtectedSkill(left.name));
      return priority || left.name.localeCompare(right.name);
    })
    .map((skill) => {
      const normalizedDescription = Array.from(normalizeDescription(skill.description));
      const protectedDescription = isProtectedSkill(skill.name);
      return {
        name: skill.name,
        builtin: skill.builtin,
        description: protectedDescription
          ? normalizedDescription
          : normalizedDescription.slice(0, LOCAL_SKILL_DESCRIPTION_MAX_CODE_POINTS),
        descriptionTruncated:
          !protectedDescription &&
          normalizedDescription.length > LOCAL_SKILL_DESCRIPTION_MAX_CODE_POINTS,
      };
    });
}

function isProtectedSkill(name: string): boolean {
  return PROTECTED_SKILL_NAMES.has(name);
}

function protectedDescriptionLengths(skills: readonly PreparedSkill[]): number[] {
  return skills.map((skill) => (isProtectedSkill(skill.name) ? skill.description.length : 0));
}

function allocateDescriptions(
  skills: readonly PreparedSkill[],
  notice: string | undefined,
  budgetTokens: number,
  estimator: LocalSkillCatalogTokenEstimator,
): number[] {
  const allocatedLengths = protectedDescriptionLengths(skills);
  const builtinComplete = allocateTier(
    skills,
    allocatedLengths,
    true,
    notice,
    budgetTokens,
    estimator,
  );
  if (builtinComplete) {
    allocateTier(skills, allocatedLengths, false, notice, budgetTokens, estimator);
  }
  return allocatedLengths;
}

function allocateTier(
  skills: readonly PreparedSkill[],
  allocatedLengths: number[],
  builtin: boolean,
  notice: string | undefined,
  budgetTokens: number,
  estimator: LocalSkillCatalogTokenEstimator,
): boolean {
  const tierIndexes = skills
    .map((skill, index) => ({ skill, index }))
    .filter(
      ({ skill }) =>
        !isProtectedSkill(skill.name) && skill.builtin === builtin && skill.description.length > 0,
    )
    .map(({ index }) => index);
  if (tierIndexes.length === 0) return true;

  const maximumLevel = Math.max(...tierIndexes.map((index) => skills[index]!.description.length));
  const allocatedLevel = findLargestLocallyFittingCandidate(maximumLevel, (candidateLevel) => {
    const candidateLengths = [...allocatedLengths];
    for (const index of tierIndexes) {
      candidateLengths[index] = Math.min(candidateLevel, skills[index]!.description.length);
    }
    const candidate = renderCatalog(skills, candidateLengths, notice);
    return fitsBudget(candidate, budgetTokens, estimator);
  });

  for (const index of tierIndexes) {
    allocatedLengths[index] = Math.min(allocatedLevel, skills[index]!.description.length);
  }
  for (const index of tierIndexes) {
    const allocatedLength = allocatedLengths[index] ?? 0;
    if (allocatedLength >= skills[index]!.description.length) continue;
    const candidateLengths = [...allocatedLengths];
    candidateLengths[index] = allocatedLength + 1;
    const candidate = renderCatalog(skills, candidateLengths, notice);
    if (fitsBudget(candidate, budgetTokens, estimator)) {
      allocatedLengths[index] = allocatedLength + 1;
    }
  }

  return tierIndexes.every(
    (index) => allocatedLengths[index] === skills[index]!.description.length,
  );
}

function renderHardOverflow(
  skills: readonly PreparedSkill[],
  budgetTokens: number,
  estimator: LocalSkillCatalogTokenEstimator,
  descriptionCapTruncated: boolean,
): LocalSkillsCatalogRenderResult {
  const protectedLengths = protectedDescriptionLengths(skills);
  const baseWithoutNotice = renderCatalog([], []);
  if (!fitsBudget(baseWithoutNotice, budgetTokens, estimator)) {
    return { catalog: '', softOverflow: false, hardOverflow: true, descriptionCapTruncated };
  }

  const countWithoutNotice = findHardOverflowPrefixLength(
    skills,
    protectedLengths,
    undefined,
    budgetTokens,
    estimator,
  );
  const baseWithNotice = renderCatalog([], [], PARTIAL_SKILL_NOTICE);
  const countWithNotice = fitsBudget(baseWithNotice, budgetTokens, estimator)
    ? findHardOverflowPrefixLength(
        skills,
        protectedLengths,
        PARTIAL_SKILL_NOTICE,
        budgetTokens,
        estimator,
      )
    : -1;
  const notice = countWithNotice >= countWithoutNotice ? PARTIAL_SKILL_NOTICE : undefined;
  const retainedCount = notice ? countWithNotice : countWithoutNotice;

  const catalog = renderCatalog(
    skills.slice(0, retainedCount),
    protectedLengths.slice(0, retainedCount),
    notice,
  );
  if (!fitsBudget(catalog, budgetTokens, estimator)) {
    return {
      catalog: fitsBudget(baseWithoutNotice, budgetTokens, estimator) ? baseWithoutNotice : '',
      softOverflow: false,
      hardOverflow: true,
      descriptionCapTruncated,
    };
  }
  return { catalog, softOverflow: false, hardOverflow: true, descriptionCapTruncated };
}

function findHardOverflowPrefixLength(
  skills: readonly PreparedSkill[],
  emptyLengths: readonly number[],
  notice: string | undefined,
  budgetTokens: number,
  estimator: LocalSkillCatalogTokenEstimator,
): number {
  return findLargestLocallyFittingCandidate(skills.length, (candidateCount) => {
    const candidate = renderCatalog(
      skills.slice(0, candidateCount),
      emptyLengths.slice(0, candidateCount),
      notice,
    );
    return fitsBudget(candidate, budgetTokens, estimator);
  });
}

function findLargestLocallyFittingCandidate(
  maximumCandidate: number,
  fitsCandidate: (candidate: number) => boolean,
): number {
  const verified = new Map<number, boolean>();
  const verify = (candidate: number): boolean => {
    const cached = verified.get(candidate);
    if (cached !== undefined) return cached;
    const fits = fitsCandidate(candidate);
    verified.set(candidate, fits);
    return fits;
  };

  let lowerBound = 0;
  let upperBound = maximumCandidate;
  while (lowerBound < upperBound) {
    const candidate = Math.ceil((lowerBound + upperBound) / 2);
    if (verify(candidate)) {
      lowerBound = candidate;
    } else {
      upperBound = candidate - 1;
    }
  }

  // Production BPE counts can dip at nearby token boundaries. Continue past a
  // failed candidate, but bound the recovery scan so one turn cannot tokenize
  // the whole 1,024-code-point or multi-thousand-skill search space repeatedly.
  let largestFitting = lowerBound;
  let consecutiveMisses = 0;
  for (
    let candidate = lowerBound + 1;
    candidate <= maximumCandidate &&
    consecutiveMisses < LOCAL_NON_MONOTONIC_RECOVERY_MAX_CONSECUTIVE_MISSES;
    candidate += 1
  ) {
    if (verify(candidate)) {
      largestFitting = candidate;
      consecutiveMisses = 0;
    } else {
      consecutiveMisses += 1;
    }
  }
  return largestFitting;
}

function renderCatalog(
  skills: readonly PreparedSkill[],
  descriptionLengths: readonly number[],
  notice?: string,
): string {
  const entries = skills.map((skill, index) => {
    const description = skill.description.slice(0, descriptionLengths[index] ?? 0).join('');
    return description ? `- ${skill.name}: ${description}` : `- ${skill.name}`;
  });
  return `<available_skills>\n${[...(notice ? [notice] : []), ...entries].join('\n')}\n</available_skills>`;
}

function fitsBudget(
  catalog: string,
  budgetTokens: number,
  estimator: LocalSkillCatalogTokenEstimator,
): boolean {
  return estimator.estimateTextTokens(catalog) <= budgetTokens;
}

function normalizeDescription(description: string): string {
  return description.replace(/\s+/gu, ' ').trim();
}

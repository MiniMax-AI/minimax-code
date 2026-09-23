import type { AppDb } from '../../../infra/db/client.js';
import { readPreferenceValue, upsertPreferenceValue } from '../../../infra/db/preference-values.js';

const MODEL_FAVORITES_PREFERENCE_KEY = 'model-favorites';

export interface ModelFavoriteRef {
  readonly providerId: string;
  readonly modelId: string;
}

export interface SetModelFavoriteInput extends ModelFavoriteRef {
  readonly favorite: boolean;
}

/**
 * User-starred models, stored in insertion order like pins: a new favorite is
 * appended to the end. Entries only identify a model; effort, thinking and
 * context stay with the picker's normal selection flow.
 *
 * Malformed stored values degrade to an empty or partial list instead of
 * failing, and favorites whose model is no longer in the catalog are kept until
 * the next write, where they are pruned against the catalog passed in.
 */
export class ModelFavoritesPreference {
  constructor(private readonly db: AppDb) {}

  list(): ModelFavoriteRef[] {
    return sanitize(readPreferenceValue(this.db, MODEL_FAVORITES_PREFERENCE_KEY));
  }

  /**
   * @param catalog Models currently listed; when provided, stale favorites
   *   outside it are dropped. Omit it to leave existing entries untouched.
   */
  set(input: SetModelFavoriteInput, catalog?: readonly ModelFavoriteRef[]): ModelFavoriteRef[] {
    const target = toRef(input);
    if (!target) return this.list();
    const known = catalog ? new Set(catalog.map(refKey)) : undefined;
    const current = this.list();
    const exists = current.some((entry) => refKey(entry) === refKey(target));
    const next = current.filter(
      (entry) =>
        (refKey(entry) === refKey(target) ? input.favorite : true) &&
        (!known || known.has(refKey(entry)) || refKey(entry) === refKey(target)),
    );
    // Starring an existing favorite is idempotent and keeps its position.
    if (input.favorite && !exists) next.push(target);
    upsertPreferenceValue(this.db, MODEL_FAVORITES_PREFERENCE_KEY, next);
    return next;
  }
}

/** Marks catalog rows with their favorite position without reordering them. */
export function annotateModelFavorites<T>(
  models: readonly T[],
  favorites: readonly ModelFavoriteRef[],
): T[] {
  const order = new Map(favorites.map((entry, index) => [refKey(entry), index]));
  return models.map((model) => {
    const ref = toRef(model);
    const index = ref ? order.get(refKey(ref)) : undefined;
    return index === undefined ? model : { ...model, favorite: true, favoriteOrder: index };
  });
}

export function modelFavoriteRefs(models: readonly unknown[]): ModelFavoriteRef[] {
  return models.flatMap((model) => {
    const ref = toRef(model);
    return ref ? [ref] : [];
  });
}

function sanitize(value: unknown): ModelFavoriteRef[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: ModelFavoriteRef[] = [];
  for (const item of value) {
    const ref = toRef(item);
    if (!ref || seen.has(refKey(ref))) continue;
    seen.add(refKey(ref));
    result.push(ref);
  }
  return result;
}

function toRef(value: unknown): ModelFavoriteRef | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { providerId, modelId } = value as Record<string, unknown>;
  if (typeof providerId !== 'string' || typeof modelId !== 'string') return undefined;
  const provider = providerId.trim();
  const model = modelId.trim();
  return provider && model ? { providerId: provider, modelId: model } : undefined;
}

function refKey(ref: ModelFavoriteRef): string {
  return `${ref.providerId}\u0000${ref.modelId}`;
}

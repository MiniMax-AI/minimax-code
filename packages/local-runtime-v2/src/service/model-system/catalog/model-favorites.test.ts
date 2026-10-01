import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProcessLocalApplication } from "../../../application/session/process-local-application.js";
import { DatabaseClient } from "../../../infra/db/client.js";
import { initializeDatabase } from "../../../infra/db/initialize.js";
import { upsertPreferenceValue } from "../../../infra/db/preference-values.js";
import { annotateModelFavorites, ModelFavoritesPreference } from "./model-favorites.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function openDatabase() {
  const dataDir = await mkdtemp(join(tmpdir(), "model-favorites-"));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const database = new DatabaseClient({ dataDir });
  cleanup.push(() => database.close());
  await initializeDatabase({ database, dataDir });
  return database;
}

const m3 = { providerId: "minimax", modelId: "MiniMax-M3" };
const kimi = { providerId: "kimi", modelId: "kimi-k3" };
const deepseek = { providerId: "deepseek", modelId: "deepseek-v4-pro" };

describe("ModelFavoritesPreference", () => {
  it("appends new favorites last and survives a reopen", async () => {
    const database = await openDatabase();
    const favorites = new ModelFavoritesPreference(database.db);
    expect(favorites.list()).toEqual([]);
    favorites.set({ ...kimi, favorite: true });
    favorites.set({ ...m3, favorite: true });
    favorites.set({ ...kimi, favorite: true }); // idempotent, keeps position
    expect(favorites.list()).toEqual([kimi, m3]);
    favorites.set({ ...kimi, favorite: false });
    expect(new ModelFavoritesPreference(database.db).list()).toEqual([m3]);
  });

  it("degrades malformed stored values instead of throwing", async () => {
    const database = await openDatabase();
    const favorites = new ModelFavoritesPreference(database.db);
    upsertPreferenceValue(database.db, "model-favorites", { not: "a list" });
    expect(favorites.list()).toEqual([]);
    upsertPreferenceValue(database.db, "model-favorites", [
      "minimax/MiniMax-M3",
      { providerId: "kimi" },
      { providerId: " kimi ", modelId: " kimi-k3 " },
      { ...kimi },
      null,
    ]);
    expect(favorites.list()).toEqual([kimi]);
    // An empty id is ignored rather than stored.
    expect(favorites.set({ providerId: "", modelId: "x", favorite: true })).toEqual([kimi]);
  });

  it("keeps stale favorites until a write prunes them against the catalog", async () => {
    const database = await openDatabase();
    const favorites = new ModelFavoritesPreference(database.db);
    favorites.set({ ...deepseek, favorite: true });
    favorites.set({ ...kimi, favorite: true });
    // deepseek left the catalog: reading keeps it, the next write drops it.
    expect(favorites.list()).toEqual([deepseek, kimi]);
    favorites.set({ ...m3, favorite: true }, [m3, kimi]);
    expect(favorites.list()).toEqual([kimi, m3]);
  });

  it("annotates catalog rows with their favorite position without reordering", () => {
    const rows = annotateModelFavorites(
      [{ ...m3, selected: true }, { ...kimi }, { ...deepseek }],
      [deepseek, m3],
    );
    expect(rows).toEqual([
      { ...m3, selected: true, favorite: true, favoriteOrder: 1 },
      { ...kimi },
      { ...deepseek, favorite: true, favoriteOrder: 0 },
    ]);
  });
});

describe("process-local model favorites", () => {
  function application(
    list: () => Promise<readonly unknown[]>,
    favorites?: ModelFavoritesPreference,
  ) {
    return createProcessLocalApplication({
      eventBus: { subscribe: vi.fn(() => () => undefined) },
      skills: {} as never,
      plugins: {} as never,
      workspace: {} as never,
      plan: {} as never,
      peripherals: {} as never,
      modelProvider: {
        application: { list, select: vi.fn(async () => true) },
        providers: {} as never,
        listProviderPresets: vi.fn(async () => []),
        oauth: {} as never,
        ...(favorites ? { favorites } : {}),
      },
    });
  }

  it("marks favorites in the listed catalog and prunes only against a readable catalog", async () => {
    const database = await openDatabase();
    const favorites = new ModelFavoritesPreference(database.db);
    favorites.set({ ...deepseek, favorite: true });
    let catalog: () => Promise<readonly unknown[]> = async () => [m3, kimi];
    const app = application(() => catalog(), favorites);

    // The catalog read fails: the stale favorite must survive the write.
    catalog = async () => {
      throw new Error("catalog offline");
    };
    await expect(app.models?.setFavorite?.({ ...kimi, favorite: true })).resolves.toBe(true);
    expect(favorites.list()).toEqual([deepseek, kimi]);

    catalog = async () => [m3, kimi];
    await app.models?.setFavorite?.({ ...m3, favorite: true });
    expect(favorites.list()).toEqual([kimi, m3]);
    await expect(app.models?.list()).resolves.toEqual([
      { ...m3, favorite: true, favoriteOrder: 1 },
      { ...kimi, favorite: true, favoriteOrder: 0 },
    ]);
  });

  it("lists the plain catalog when the preference store fails or is absent", async () => {
    const broken = {
      list: () => {
        throw new Error("database is locked");
      },
      set: vi.fn(),
    } as unknown as ModelFavoritesPreference;
    await expect(application(async () => [m3], broken).models?.list()).resolves.toEqual([m3]);
    const withoutStore = application(async () => [m3]);
    await expect(withoutStore.models?.list()).resolves.toEqual([m3]);
    expect(withoutStore.models?.setFavorite).toBeUndefined();
  });
});

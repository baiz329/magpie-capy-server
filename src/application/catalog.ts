import type { ModelDefaultInfo, ModelDescriptor, RawModel } from "../domain/model.ts";
import { describeModel, EXTRA_FREE_MODELS, freeFirst, mergeCatalog } from "../domain/model.ts";
import { CapyError, isAuthError } from "../domain/errors.ts";
import type { CapyPublicPort } from "../ports/capy-public.ts";
import type { CachePort } from "../ports/platform.ts";

export interface CatalogUseCaseOptions {
  readonly publicPort: CapyPublicPort;
  readonly fallback: readonly RawModel[];
  readonly toolsEnabled: boolean;
  readonly cache?: CachePort;
  readonly cacheTtlMs?: number;
}

export interface CatalogSnapshot {
  readonly models: readonly ModelDescriptor[];
  /** Capy `/models.default`；静态兜底/未登录时没有。 */
  readonly default?: ModelDefaultInfo;
}

const DEFAULT_TTL_MS = 10 * 60_000;

export class CatalogUseCase {
  private readonly options: CatalogUseCaseOptions;

  constructor(options: CatalogUseCaseOptions) {
    this.options = options;
  }

  async load(apiKey: string, signal?: AbortSignal): Promise<CatalogSnapshot> {
    const cacheKey = `catalog:${apiKey.slice(-16)}`;
    const hit = this.options.cache?.get<CatalogSnapshot>(cacheKey);
    if (hit) return hit;
    const snapshot = await this.loadSnapshot(apiKey, signal);
    this.options.cache?.set(cacheKey, snapshot, this.options.cacheTtlMs ?? DEFAULT_TTL_MS);
    return snapshot;
  }

  private async loadSnapshot(apiKey: string, signal?: AbortSignal): Promise<CatalogSnapshot> {
    try {
      const live = await this.options.publicPort.listModels(apiKey, signal);
      return {
        models: this.describe(freeFirst(mergeCatalog(live.items, EXTRA_FREE_MODELS))),
        ...(live.default ? { default: live.default } : {}),
      };
    } catch (error) {
      if (isAuthError(error)) throw error;
      if (this.options.fallback.length === 0) {
        throw new CapyError("upstream_unavailable", "Capy 模型目录不可用", { cause: error });
      }
      return {
        models: this.describe(freeFirst(mergeCatalog(this.options.fallback, EXTRA_FREE_MODELS))),
      };
    }
  }

  private describe(raw: readonly RawModel[]): readonly ModelDescriptor[] {
    return freeFirst(raw.map((item) => describeModel(item, { toolsEnabled: this.options.toolsEnabled })));
  }
}


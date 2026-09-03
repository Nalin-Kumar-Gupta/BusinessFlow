import { ApiError } from '../errors/api-error.js';

export interface DbHealthResult {
  ok: boolean;
  latencyMs: number;
}

export interface DatabaseClient {
  ping: () => Promise<DbHealthResult>;
}

export class D1DatabaseClient implements DatabaseClient {
  private readonly db: D1Database;

  constructor(db?: D1Database) {
    if (!db) {
      throw new ApiError({
        code: 'DB_NOT_CONFIGURED',
        status: 500,
        message: 'D1 database binding is not configured',
      });
    }
    this.db = db;
  }

  async ping(): Promise<DbHealthResult> {
    const startedAt = Date.now();
    const result = await this.db.prepare('SELECT 1 AS ok').first<{ ok: number }>();
    const ok = (result?.ok ?? 0) === 1;
    return {
      ok,
      latencyMs: Date.now() - startedAt,
    };
  }
}

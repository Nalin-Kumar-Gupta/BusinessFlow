import type { AppConfig } from '../../config/env.js';
import type { AuthContext } from '../../types.js';
import type { DatabaseClient } from '../../db/client.js';

export interface HealthSnapshot {
  status: 'ok' | 'degraded';
  mode: 'liveness' | 'readiness';
  apiVersion: string;
  environment: string;
  timestamp: string;
  db: {
    ok: boolean;
    latencyMs: number | null;
  };
  actorType: AuthContext['actorType'];
}

export class HealthService {
  constructor(
    private readonly config: AppConfig,
    private readonly db: DatabaseClient,
  ) {}

  async getSnapshot(mode: 'liveness' | 'readiness', auth: AuthContext): Promise<HealthSnapshot> {
    if (mode === 'liveness') {
      return {
        status: 'ok',
        mode,
        apiVersion: this.config.apiVersion,
        environment: this.config.env,
        timestamp: new Date().toISOString(),
        db: {
          ok: true,
          latencyMs: null,
        },
        actorType: auth.actorType,
      };
    }

    const db = await this.db.ping();
    return {
      status: db.ok ? 'ok' : 'degraded',
      mode,
      apiVersion: this.config.apiVersion,
      environment: this.config.env,
      timestamp: new Date().toISOString(),
      db: {
        ok: db.ok,
        latencyMs: db.latencyMs,
      },
      actorType: auth.actorType,
    };
  }
}

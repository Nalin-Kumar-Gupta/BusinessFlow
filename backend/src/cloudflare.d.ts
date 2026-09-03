interface D1RunResult {
  success: boolean;
}

interface D1AllResult<T = unknown> {
  results?: T[];
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<D1RunResult>;
  all<T = unknown>(): Promise<D1AllResult<T>>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

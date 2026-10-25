export interface LockSession {
  query(sql: string): Promise<unknown>;
  close(): Promise<void>;
}
export function openLockSession(
  env: Record<string, string | undefined>,
): Promise<LockSession>;

export interface LoginCredential {
  readonly clientJwt: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly orgId?: string;
  readonly accountId?: string;
  /** Clerk 的 __client id；没有就留空，绝不随机生成。 */
  readonly clientId?: string;
  readonly source: "local" | "browser" | "cookie" | "refresh";
}

export interface LoginSourcePort {
  local(signal?: AbortSignal): Promise<LoginCredential>;
  browser(signal?: AbortSignal): Promise<LoginCredential>;
}

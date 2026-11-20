export type LoginSource = "local" | "browser" | "cookie" | "refresh";

export interface ClerkSession {
  readonly clientJwt: string;
  readonly sessionId: string;
}

export interface AccountSession {
  readonly accountId: string;
  readonly uid: string;
  readonly orgId: string;
  readonly clientId: string;
  readonly accessToken: string;
  readonly clerk: ClerkSession;
  readonly source: LoginSource;
  readonly displayName?: string;
}

export function accountKey(session: Pick<AccountSession, "accountId" | "uid" | "orgId">): string {
  return `${session.uid || session.accountId}@${session.orgId}`;
}


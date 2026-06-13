/**
 * Token auth for the relay's two surfaces.
 *
 * - Browser surface: the extension sends its token inside the `register`
 *   message (browser WebSocket clients cannot set headers).
 * - Agent surface: HTTP requests carry `Authorization: Bearer <token>`.
 *
 * A surface is enforced iff its token is configured. The CLI refuses to
 * start on a non-loopback host without both tokens (fail-closed); binding
 * to loopback without tokens keeps the zero-config local workflow.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export interface AuthConfig {
  /** Token the extension must present in its register message */
  browserToken?: string;
  /** Token agents must present as an HTTP Bearer token */
  agentToken?: string;
}

/** Constant-time comparison over SHA-256 digests (handles unequal lengths) */
export function tokensMatch(expected: string, provided: string | undefined): boolean {
  if (provided === undefined) return false;
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(provided).digest();
  return timingSafeEqual(a, b);
}

/** True when the browser surface accepts this register token */
export function browserAuthorized(auth: AuthConfig, token: string | undefined): boolean {
  if (auth.browserToken === undefined) return true;
  return tokensMatch(auth.browserToken, token);
}

/** True when the agent surface accepts this Authorization header value */
export function agentAuthorized(auth: AuthConfig, authorizationHeader: string | undefined): boolean {
  if (auth.agentToken === undefined) return true;
  if (!authorizationHeader) return false;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  if (!match) return false;
  return tokensMatch(auth.agentToken, match[1]);
}

/** True for hosts where tokenless operation is acceptable */
export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '');
  return (
    bare === 'localhost' ||
    bare === '::1' ||
    /^127(\.\d{1,3}){3}$/.test(bare)
  );
}

/**
 * Policy gate (deferred enforcement seam).
 *
 * BrowserHandle ships with NO permission enforcement in v1: the default gate
 * allows every action. This interface and its single call site
 * (MessageRouter.handleBridgeRequest) are the documented extension point where
 * a future version can add per-handle origin allow/deny lists, tool-category
 * gates, and interactive approve/deny prompts in the side panel.
 *
 * See docs/security.md. The relay's routeCall is the complementary remote seam.
 */
import type { BridgeMethod } from '@browserhandle/protocol';

export interface PolicyContext {
  method: BridgeMethod;
  payload: unknown;
  tabId?: number;
}

export interface PolicyDecision {
  allow: boolean;
  /** Human-readable reason, surfaced as POLICY_DENIED when allow === false */
  reason?: string;
}

export interface PolicyGate {
  check(ctx: PolicyContext): Promise<PolicyDecision>;
}

/** Default gate: allows everything. The only gate wired up in v1. */
export class AllowAllPolicyGate implements PolicyGate {
  async check(_ctx: PolicyContext): Promise<PolicyDecision> {
    return { allow: true };
  }
}

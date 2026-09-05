import type { ComponentChildren, JSX } from 'preact';

import type { AccessContext, WorkspaceFeature } from './access-control.js';
import { canAccess } from './access-control.js';

interface LockedWorkspaceProps {
  onViewPricing: () => void;
  onOpenAccount: () => void;
  signedIn: boolean;
}

export function LockedWorkspace({ onViewPricing, onOpenAccount, signedIn }: LockedWorkspaceProps): JSX.Element {
  return (
    <section class="workspace-lock" role="region" aria-label="Workspace access">
      <div class="workspace-lock__backdrop" aria-hidden="true" />
      <div class="workspace-lock__card">
        <h3>Workspace available with Pro</h3>
        <p>
          Free includes capture and exports. Upgrade to Pro when you want persistent features,
          test-case organization, and run history in the dashboard.
        </p>
        <div class="actions-row actions-row--center">
          <button class="btn btn-primary" onClick={onViewPricing}>View pricing</button>
          <button class="btn btn-outline" onClick={onOpenAccount}>{signedIn ? 'My account' : 'Log in / Create account'}</button>
        </div>
      </div>
    </section>
  );
}

interface PlanGateProps {
  enabled: boolean;
  feature: WorkspaceFeature;
  access: AccessContext;
  onViewPricing: () => void;
  onOpenAccount: () => void;
  children: ComponentChildren;
}

/**
 * Render helper for future entitlement enforcement.
 * Keep this disabled until policy rollout starts.
 */
export function PlanGate({ enabled, feature, access, onViewPricing, onOpenAccount, children }: PlanGateProps): JSX.Element {
  if (!enabled || canAccess(feature, access)) {
    return <>{children}</>;
  }
  return <LockedWorkspace onViewPricing={onViewPricing} onOpenAccount={onOpenAccount} signedIn={access.signedIn} />;
}

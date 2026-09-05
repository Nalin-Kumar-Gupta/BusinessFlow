import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact/jsx-runtime';
import type { AuthStatusPayload } from '../../core/auth.js';
import { getSettings, saveSettings } from '../../storage/settings.js';
import {
  humanizeToken,
  resolveAccountIdentityCaption,
  resolveAccountPlanLabel,
  resolveTrialDaysLeft,
  type AccountInlineMessage,
} from './account-ux.js';

interface AccountModalProps {
  isOpen: boolean;
  isAuthLoading: boolean;
  authStatus: AuthStatusPayload | null;
  onClose: () => void;
  onOpenPricing: () => void;
  onAuthStatusChange: (status: AuthStatusPayload | null) => void;
  runtimeMessage: <T>(message: Record<string, unknown>) => Promise<T>;
}

type AccountModalTab = 'summary' | 'settings';
type AuthAction = 'idle' | 'refresh' | 'sign_out';

interface RuntimeResult {
  ok?: boolean;
  error?: string;
  status?: AuthStatusPayload;
}

export function AccountModal({
  isOpen,
  isAuthLoading,
  authStatus,
  onClose,
  onOpenPricing,
  onAuthStatusChange,
  runtimeMessage,
}: AccountModalProps): JSX.Element | null {
  const [activeTab, setActiveTab] = useState<AccountModalTab>('summary');
  const [saved, setSaved] = useState(false);
  const [settingsLoadError, setSettingsLoadError] = useState<string | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [inlineMessage, setInlineMessage] = useState<AccountInlineMessage | null>(null);
  const [authAction, setAuthAction] = useState<AuthAction>('idle');
  const [slaEnabled, setSlaEnabled] = useState(false);
  const [slaSec, setSlaSec] = useState(3);
  const [maxRunsPerTestCase, setMaxRunsPerTestCase] = useState(10);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  const entitlement = authStatus?.entitlement;
  const isSignedIn = authStatus?.signedIn === true;
  const isTrial = entitlement?.state?.toLowerCase().includes('trial') ?? false;
  const trialDaysLeft = resolveTrialDaysLeft(entitlement?.accessUntil);
  const accountPlanLabel = resolveAccountPlanLabel(authStatus);
  const accountIdentityCaption = resolveAccountIdentityCaption(authStatus, isAuthLoading);
  const canDismiss = authAction === 'idle';

  const markSaved = (): void => {
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1300);
  };

  const loadSettings = async (): Promise<void> => {
    setSettingsLoading(true);
    setSettingsLoadError(null);
    try {
      const settings = await getSettings();
      setSlaEnabled(Boolean(settings.slaEnabled));
      setSlaSec(Math.min(20, Math.max(1, Math.round(settings.slaSec ?? 3))));
      setMaxRunsPerTestCase(Math.min(15, Math.max(2, Math.round(settings.maxRunsPerTestCase ?? 10))));
    } catch {
      setSettingsLoadError('Settings could not be loaded. Try again.');
    } finally {
      setSettingsLoading(false);
    }
  };

  const persistSettings = async (
    patch: Parameters<typeof saveSettings>[0],
    applyOptimistic: () => void,
  ): Promise<void> => {
    applyOptimistic();
    setInlineMessage(null);
    try {
      await saveSettings(patch);
      markSaved();
    } catch {
      setInlineMessage({ tone: 'error', text: 'Settings were not saved. Try again.' });
      await loadSettings();
    }
  };

  const refreshAccess = async (): Promise<void> => {
    if (!isSignedIn || authAction !== 'idle') return;
    setInlineMessage(null);
    setAuthAction('refresh');
    try {
      const response = await runtimeMessage<RuntimeResult>({ type: 'TT_AUTH_REFRESH' });
      if (response?.ok !== true || !response.status) {
        throw new Error(response?.error || 'Unable to refresh access right now.');
      }
      onAuthStatusChange(response.status);
      setInlineMessage({ tone: 'ok', text: 'Access refreshed.' });
    } catch (error) {
      setInlineMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Unable to refresh access right now.' });
    } finally {
      setAuthAction('idle');
    }
  };

  const signOut = async (): Promise<void> => {
    if (!isSignedIn || authAction !== 'idle') return;
    setInlineMessage(null);
    setAuthAction('sign_out');
    try {
      const response = await runtimeMessage<RuntimeResult>({ type: 'TT_AUTH_SIGN_OUT' });
      if (response?.ok !== true || !response.status) {
        throw new Error(response?.error || 'Sign out failed.');
      }
      onAuthStatusChange(response.status);
      setInlineMessage({ tone: 'ok', text: 'Signed out successfully.' });
    } catch (error) {
      setInlineMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Sign out failed.' });
    } finally {
      setAuthAction('idle');
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    setSaved(false);
    setInlineMessage(null);
    setActiveTab('summary');
    void loadSettings();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();

    const focusableSelector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && canDismiss) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const container = dialogRef.current;
      if (!container) return;
      const focusables = Array.from(container.querySelectorAll<HTMLElement>(focusableSelector))
        .filter((node) => !node.hasAttribute('disabled'));
      if (focusables.length === 0) return;

      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [isOpen, canDismiss, onClose]);

  const settingsHint = useMemo(
    () => (slaEnabled ? `SLA threshold ${slaSec}s · ${maxRunsPerTestCase} run history limit` : `${maxRunsPerTestCase} run history limit · SLA alert off`),
    [maxRunsPerTestCase, slaEnabled, slaSec],
  );

  if (!isOpen) return null;

  return (
    <div class="modal-overlay" role="dialog" aria-modal="true" aria-label="My account" onClick={() => { if (canDismiss) onClose(); }}>
      <section ref={dialogRef} class="account-modal-card" onClick={(event) => event.stopPropagation()}>
        <header class="account-modal-header">
          <div class="account-title-wrap">
            <h3>My account</h3>
            <p>View plan details and adjust recording settings.</p>
          </div>
          <div class="actions-row account-header-actions">
            {saved && <span class="badge badge-success" role="status" aria-live="polite">Saved</span>}
            <button
              ref={closeButtonRef}
              class="icon-btn account-close-btn"
              onClick={onClose}
              disabled={!canDismiss}
              aria-label="Close account settings"
              title="Close"
            >
              <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                <path d="M5.22 5.22a.75.75 0 0 1 1.06 0L10 8.94l3.72-3.72a.75.75 0 1 1 1.06 1.06L11.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06L10 11.06l-3.72 3.72a.75.75 0 1 1-1.06-1.06L8.94 10 5.22 6.28a.75.75 0 0 1 0-1.06Z" />
              </svg>
            </button>
          </div>
        </header>

        <div class="account-modal-tab-row" role="tablist" aria-label="Account sections">
          <button class={`account-modal-tab ${activeTab === 'summary' ? 'active' : ''}`} role="tab" aria-selected={activeTab === 'summary'} onClick={() => setActiveTab('summary')}>Summary</button>
          <button class={`account-modal-tab ${activeTab === 'settings' ? 'active' : ''}`} role="tab" aria-selected={activeTab === 'settings'} onClick={() => setActiveTab('settings')}>Settings</button>
        </div>

        {inlineMessage && <div class={`account-inline-message ${inlineMessage.tone}`} role={inlineMessage.tone === 'error' ? 'alert' : 'status'}>{inlineMessage.text}</div>}

        {activeTab === 'summary' ? (
          <div class="account-surface-stack">
            <section class="account-section account-section-identity">
              <div class="account-identity-avatar" aria-hidden="true">{(authStatus?.user?.email?.trim()?.[0] ?? '?').toUpperCase()}</div>
              <div class="account-identity-copy">
                <h4>{authStatus?.user?.email ?? 'Not signed in'}</h4>
                <p>{accountIdentityCaption}</p>
              </div>
              <span class={`badge ${isSignedIn ? 'badge-success' : 'badge-muted'}`}>{isSignedIn ? 'Signed in' : 'Signed out'}</span>
            </section>

            <section class="account-section">
              <h5>Plan & access</h5>
              <dl class="account-summary-grid">
                <dt>Plan</dt><dd>{accountPlanLabel}</dd>
                <dt>Access state</dt><dd>{humanizeToken(authStatus?.state)}</dd>
                <dt>Entitlement</dt><dd>{humanizeToken(entitlement?.state)}</dd>
                <dt>Recorder profile</dt><dd>{settingsHint}</dd>
                {isTrial && <><dt>Trial</dt><dd>{trialDaysLeft ?? '—'} day{trialDaysLeft === 1 ? '' : 's'} remaining</dd></>}
              </dl>
              {entitlement?.stale && <p class="account-warning" role="status">Billing status may be stale. Refresh access to sync.</p>}
            </section>

            <section class="account-section">
              <h5>Billing</h5>
              <p class="account-section-copy">Use pricing to upgrade or change your billing setup.</p>
              <div class="actions-row">
                <button class="btn btn-primary" disabled={!isSignedIn || authAction !== 'idle'} onClick={onOpenPricing}>Manage billing</button>
                <button class="btn btn-outline" disabled={!isSignedIn || authAction !== 'idle'} onClick={() => { void refreshAccess(); }}>
                  {authAction === 'refresh' ? 'Refreshing…' : 'Refresh access'}
                </button>
              </div>
              {!isSignedIn && <p class="account-note">Sign in to open billing controls.</p>}
            </section>

            <section class="account-section account-section-danger">
              <h5>Session</h5>
              <p class="account-section-copy">Sign out from this browser profile.</p>
              <button class="btn btn-outline-danger" disabled={!isSignedIn || authAction !== 'idle'} onClick={() => { void signOut(); }}>
                {authAction === 'sign_out' ? 'Signing out…' : 'Sign out'}
              </button>
            </section>
          </div>
        ) : (
          <div class="account-settings-grid">
            {settingsLoading && <div class="account-inline-message info" role="status">Loading settings…</div>}
            {settingsLoadError && (
              <div class="account-inline-message error" role="alert">
                {settingsLoadError}
                <div class="actions-row" style="margin-top:8px">
                  <button class="btn btn-outline" onClick={() => { void loadSettings(); }} disabled={settingsLoading}>Retry</button>
                </div>
              </div>
            )}

            <section class="account-settings-section">
              <h5>Capture behavior</h5>
              <p class="account-settings-section-copy">Control capture timing and run history depth for each test case.</p>

              <label class="account-setting-card" for="account-sla-toggle">
                <div class="account-setting-copy">
                  <span class="account-setting-title">SLA performance alerts</span>
                  <span class="account-setting-description">Highlight slower API calls during a run.</span>
                </div>
                <input id="account-sla-toggle" type="checkbox" checked={slaEnabled} onChange={(event) => {
                  const checked = (event.target as HTMLInputElement).checked;
                  void persistSettings({ slaEnabled: checked }, () => setSlaEnabled(checked));
                }} />
              </label>

              <label class="account-setting-card account-setting-card--stack" for="account-sla-seconds">
                <div class="account-setting-copy">
                  <span class="account-setting-title">SLA threshold</span>
                  <span class="account-setting-description">Current threshold: <strong>{slaSec}s</strong>. Requests slower than this are flagged.</span>
                </div>
                <input id="account-sla-seconds" type="range" min={1} max={20} step={1} value={slaSec} disabled={!slaEnabled} onInput={(event) => {
                  const next = Number((event.target as HTMLInputElement).value);
                  void persistSettings({ slaSec: next }, () => setSlaSec(next));
                }} />
              </label>

              <label class="account-setting-card account-setting-card--stack" for="account-max-runs">
                <div class="account-setting-copy">
                  <span class="account-setting-title">Run history per test case</span>
                  <span class="account-setting-description">Keep up to <strong>{maxRunsPerTestCase}</strong> recent runs for each test case.</span>
                </div>
                <input id="account-max-runs" type="range" min={2} max={15} step={1} value={maxRunsPerTestCase} onInput={(event) => {
                  const next = Number((event.target as HTMLInputElement).value);
                  void persistSettings({ maxRunsPerTestCase: next }, () => setMaxRunsPerTestCase(next));
                }} />
              </label>
            </section>
          </div>
        )}
      </section>
    </div>
  );
}

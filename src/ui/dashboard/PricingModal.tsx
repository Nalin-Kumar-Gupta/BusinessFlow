import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact/jsx-runtime';
import type { BillingCatalogPayload, BillingInterval, BillingPortalPayload } from '../../core/billing.js';
import type { AuthStatusPayload } from '../../core/auth.js';
import { accessLabel, isValidEmail, toFriendlyAuthError, toSentence, validatePassword } from './pricing-utils.js';
import { readFormattedPriceLabel } from './pricing-ux.js';

interface RuntimeResult<T> {
  ok?: boolean;
  error?: string;
  catalog?: T;
  checkout?: {
    checkoutId: string;
    checkoutUrl: string;
    planKey: string;
    priceId: string;
  };
  portal?: BillingPortalPayload;
  status?: AuthStatusPayload;
  data?: {
    accepted: boolean;
    message: string;
  };
}

interface PricingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAuthSuccess: () => void;
  onOpenAccount: () => void;
  onAuthStatusChange?: (status: AuthStatusPayload | null) => void;
  runtimeMessage: <T>(message: Record<string, unknown>) => Promise<T>;
}

interface ProPrice {
  planKey: string;
  priceId: string;
  trialDays: number;
  formattedPrice: string | null;
}

function readProPrice(catalog: BillingCatalogPayload | null, interval: BillingInterval): ProPrice | null {
  if (!catalog) return null;
  const proPlan = catalog.plans.find((plan) => plan.tier === 'pro');
  return proPlan?.prices?.[interval] ?? null;
}

export function PricingModal({
  isOpen,
  onClose,
  onAuthSuccess,
  onOpenAccount,
  onAuthStatusChange,
  runtimeMessage,
}: PricingModalProps): JSX.Element | null {
  const [currentView, setCurrentView] = useState<'pricing' | 'auth'>('pricing');
  const [billingInterval, setBillingInterval] = useState<BillingInterval>('yearly');
  const [catalog, setCatalog] = useState<BillingCatalogPayload | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatusPayload | null>(null);
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');
  const [authStatusReady, setAuthStatusReady] = useState(false);
  const [authAttemptedSubmit, setAuthAttemptedSubmit] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authConfirmPassword, setAuthConfirmPassword] = useState('');
  const [authBusyAction, setAuthBusyAction] = useState<'idle' | 'sign_in' | 'sign_up' | 'forgot_password' | 'refresh' | 'sign_out' | 'open_portal'>('idle');
  const [authMessage, setAuthMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [checkoutPlanKey, setCheckoutPlanKey] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const onAuthStatusChangeRef = useRef(onAuthStatusChange);
  onAuthStatusChangeRef.current = onAuthStatusChange;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const runtimeMessageRef = useRef(runtimeMessage);
  runtimeMessageRef.current = runtimeMessage;

  const applyAuthStatus = useCallback((status: AuthStatusPayload | null): void => {
    setAuthStatus(status);
    onAuthStatusChangeRef.current?.(status);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    setFatalError(null);
    setAuthMessage(null);
    setCheckoutError(null);
    setAuthAttemptedSubmit(false);
    setAuthStatusReady(false);
    setLoadingCatalog(true);

    void (async () => {
      try {
        const catalogResponse = await runtimeMessageRef.current<RuntimeResult<BillingCatalogPayload>>({ type: 'TT_BILLING_GET_CATALOG' });
        if (cancelled) return;
        if (catalogResponse?.ok !== true || !catalogResponse.catalog) {
          setFatalError(catalogResponse?.error || 'Pricing catalog could not be loaded.');
          setAuthStatusReady(true);
          setLoadingCatalog(false);
          return;
        }

        const loadedCatalog = catalogResponse.catalog;
        if (loadedCatalog.environment !== 'sandbox') {
          setFatalError('Unsafe Paddle environment detected: expected sandbox only.');
          setAuthStatusReady(true);
          setLoadingCatalog(false);
          return;
        }

        setCatalog(loadedCatalog);
        if (!loadedCatalog.plans.some((plan) => plan.tier === 'pro')) {
          setFatalError('Pro billing plan is not configured yet.');
        }

        const authResponse = await runtimeMessageRef.current<RuntimeResult<never>>({ type: 'TT_AUTH_GET_STATUS', refreshIfNeeded: true });
        if (cancelled) return;
        applyAuthStatus(authResponse?.ok === true && authResponse.status ? authResponse.status : null);
        setAuthStatusReady(true);
        setLoadingCatalog(false);
      } catch (error) {
        if (cancelled) return;
        setFatalError(error instanceof Error ? error.message : String(error));
        setAuthStatusReady(true);
        setLoadingCatalog(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, applyAuthStatus]);

  useEffect(() => {
    if (!isOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();

    const focusableSelector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
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
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) return;
    setCurrentView('pricing');
    setCheckoutPlanKey(null);
    setCheckoutError(null);
    setFatalError(null);
    setLoadingCatalog(false);
    setAuthStatusReady(false);
    setAuthAttemptedSubmit(false);
    setShowPassword(false);
    setShowConfirmPassword(false);
  }, [isOpen]);

  const emailError = authEmail.trim().length === 0 ? 'Email is required.' : (isValidEmail(authEmail) ? '' : 'Enter a valid email address.');
  const passwordError = authPassword.length === 0 ? 'Password is required.' : (validatePassword(authPassword) ?? '');
  const confirmPasswordError = authMode !== 'signup'
    ? ''
    : authConfirmPassword.length === 0
      ? 'Confirm password is required.'
      : authConfirmPassword !== authPassword
        ? 'Passwords do not match.'
        : '';
  const authFormError = emailError || passwordError || confirmPasswordError;
  const isAuthBusy = authBusyAction !== 'idle' || !authStatusReady;
  const canSubmitAuth = !isAuthBusy && !authFormError;
  const isSignedIn = authStatus?.signedIn === true;
  const entitlement = authStatus?.entitlement;
  const planLabel = entitlement?.plan ? toSentence(entitlement.plan) : 'Free';
  const subscriptionLabel = entitlement ? `${entitlement.granted ? 'Active' : 'Inactive'} (${toSentence(entitlement.state)})` : 'Not subscribed';
  const trialLabel = entitlement ? (entitlement.state.toLowerCase().includes('trial') ? 'In trial' : 'Not in trial') : 'Not subscribed';
  const billingPeriodLabel = entitlement?.plan?.toLowerCase().includes('yearly') ? 'Yearly' : entitlement?.plan?.toLowerCase().includes('monthly') ? 'Monthly' : '—';
  const accessUntilLabel = entitlement?.accessUntil ? new Date(entitlement.accessUntil).toLocaleString() : '—';

  const proPrice = useMemo(() => readProPrice(catalog, billingInterval), [catalog, billingInterval]);
  const displayPrice = useMemo(() => readFormattedPriceLabel(proPrice ?? undefined), [proPrice]);
  const proIsAvailable = Boolean(proPrice);

  const submitAuth = async (mode: 'signin' | 'signup'): Promise<void> => {
    setAuthAttemptedSubmit(true);
    if (!canSubmitAuth) {
      setAuthMessage({ tone: 'err', text: authFormError || 'Enter valid credentials.' });
      return;
    }

    setAuthBusyAction(mode === 'signin' ? 'sign_in' : 'sign_up');
    setAuthMessage(null);
    try {
      const response = await runtimeMessage<RuntimeResult<never>>({
        type: mode === 'signin' ? 'TT_AUTH_SIGN_IN' : 'TT_AUTH_SIGN_UP',
        email: authEmail.trim(),
        password: authPassword,
      });
      if (response?.ok !== true || !response.status) {
        throw new Error(response?.error || (mode === 'signin' ? 'Sign in failed.' : 'Sign up failed.'));
      }
      applyAuthStatus(response.status);
      setAuthPassword('');
      setAuthConfirmPassword('');
      setAuthMode('signin');
      setAuthAttemptedSubmit(false);
      setAuthMessage({ tone: 'ok', text: mode === 'signin' ? 'Signed in successfully.' : 'Account created. You are now signed in.' });
      onAuthSuccess();
    } catch (error) {
      setAuthMessage({ tone: 'err', text: toFriendlyAuthError(error instanceof Error ? error.message : String(error)) });
    } finally {
      setAuthBusyAction('idle');
    }
  };

  const requestPasswordReset = async (): Promise<void> => {
    const trimmedEmail = authEmail.trim();
    setAuthAttemptedSubmit(true);
    if (!isValidEmail(trimmedEmail)) {
      setAuthMessage({ tone: 'err', text: 'Enter a valid email address first.' });
      return;
    }

    setAuthBusyAction('forgot_password');
    setAuthMessage(null);
    try {
      const response = await runtimeMessage<RuntimeResult<never>>({
        type: 'TT_AUTH_FORGOT_PASSWORD',
        email: trimmedEmail,
      });
      if (response?.ok !== true) {
        throw new Error(response?.error || 'Unable to request password reset right now.');
      }
      const message = response.data?.message || 'If that email exists, a reset link has been sent.';
      setAuthMessage({ tone: 'ok', text: message });
    } catch (error) {
      setAuthMessage({ tone: 'err', text: toFriendlyAuthError(error instanceof Error ? error.message : String(error)) });
    } finally {
      setAuthBusyAction('idle');
    }
  };

  const refreshAccess = async (): Promise<void> => {
    setAuthBusyAction('refresh');
    setAuthMessage(null);
    try {
      const response = await runtimeMessage<RuntimeResult<never>>({ type: 'TT_AUTH_REFRESH' });
      if (response?.ok !== true || !response.status) {
        throw new Error(response?.error || 'Unable to refresh access.');
      }
      applyAuthStatus(response.status);
      setAuthMessage({ tone: 'ok', text: 'Access status refreshed.' });
    } catch (error) {
      setAuthMessage({ tone: 'err', text: toFriendlyAuthError(error instanceof Error ? error.message : String(error)) });
    } finally {
      setAuthBusyAction('idle');
    }
  };

  const signOut = async (): Promise<void> => {
    setAuthBusyAction('sign_out');
    setAuthMessage(null);
    try {
      const response = await runtimeMessage<RuntimeResult<never>>({ type: 'TT_AUTH_SIGN_OUT' });
      if (response?.ok !== true || !response.status) {
        throw new Error(response?.error || 'Sign out failed.');
      }
      applyAuthStatus(response.status);
      setAuthAttemptedSubmit(false);
      setShowPassword(false);
      setShowConfirmPassword(false);
      setAuthMessage({ tone: 'ok', text: 'Signed out.' });
    } catch (error) {
      setAuthMessage({ tone: 'err', text: toFriendlyAuthError(error instanceof Error ? error.message : String(error)) });
    } finally {
      setAuthBusyAction('idle');
    }
  };

  const openBillingPortal = async (): Promise<void> => {
    setAuthBusyAction('open_portal');
    setAuthMessage(null);
    try {
      const response = await runtimeMessage<RuntimeResult<never>>({ type: 'TT_BILLING_CREATE_PORTAL' });
      if (response?.ok !== true || !response.portal?.portalUrl) {
        throw new Error(response?.error || 'Unable to open billing portal right now.');
      }
      const opened = window.open(response.portal.portalUrl, '_blank', 'noopener,noreferrer');
      if (!opened) throw new Error('Pop-up blocked. Allow pop-ups and try again.');
      setAuthMessage({ tone: 'ok', text: 'Billing opened in a new tab. Return here after you finish.' });
    } catch (error) {
      setAuthMessage({ tone: 'err', text: toFriendlyAuthError(error instanceof Error ? error.message : String(error)) });
    } finally {
      setAuthBusyAction('idle');
    }
  };

  const runCheckout = async (): Promise<void> => {
    if (!proPrice) {
      setCheckoutError('Pro price is not available for the selected billing interval.');
      return;
    }
    if (!isSignedIn) {
      setCurrentView('auth');
      return;
    }

    setCheckoutPlanKey(proPrice.planKey);
    setCheckoutError(null);
    setFatalError(null);

    try {
      const checkoutResponse = await runtimeMessage<RuntimeResult<never>>({
        type: 'TT_BILLING_CREATE_CHECKOUT',
        planKey: proPrice.planKey,
      });
      if (checkoutResponse?.ok !== true || !checkoutResponse.checkout?.checkoutUrl) {
        throw new Error(checkoutResponse?.error || 'Checkout session could not be created.');
      }
      if (checkoutResponse.checkout.planKey !== proPrice.planKey || checkoutResponse.checkout.priceId !== proPrice.priceId) {
        throw new Error('Checkout session plan mismatch detected; aborting checkout.');
      }
      const opened = window.open(checkoutResponse.checkout.checkoutUrl, '_blank', 'noopener,noreferrer');
      if (!opened) {
        throw new Error('Pop-up blocked. Allow pop-ups to open checkout.');
      }
      setAuthMessage({ tone: 'ok', text: 'Checkout opened in a new tab. Complete payment, then click “Refresh access”.' });
    } catch (error) {
      setCheckoutError(error instanceof Error ? error.message : String(error));
    } finally {
      setCheckoutPlanKey(null);
    }
  };

  if (!isOpen) return null;

  return (
    <div class="modal-overlay" role="dialog" aria-modal="true" aria-label="BusinessFlow pricing" onClick={onClose}>
      <div ref={dialogRef} class={`pricing-modal-card ${currentView === 'auth' ? 'view-auth' : ''}`} onClick={(event) => event.stopPropagation()}>
        {currentView === 'auth' ? (
          <section class="pricing-auth-view" aria-label="Account access">
            <div class="pricing-auth-header">
              <div>
                <h4>Account & access</h4>
                <p>{authStatus?.message ?? 'Sign in to continue with checkout and keep billing access in sync.'}</p>
              </div>
              <span class={`badge ${isSignedIn ? 'badge-success' : 'badge-muted'}`}>{accessLabel(authStatus)}</span>
            </div>
            {!isSignedIn ? (
              <>
                <div class="pricing-auth-switch" role="tablist" aria-label="Authentication mode">
                  <button class={`pricing-auth-switch-btn ${authMode === 'signin' ? 'active' : ''}`} role="tab" aria-selected={authMode === 'signin'} onClick={() => { setAuthMode('signin'); setAuthAttemptedSubmit(false); setAuthMessage(null); }}>Sign in</button>
                  <button class={`pricing-auth-switch-btn ${authMode === 'signup' ? 'active' : ''}`} role="tab" aria-selected={authMode === 'signup'} onClick={() => { setAuthMode('signup'); setAuthAttemptedSubmit(false); setAuthMessage(null); }}>Create account</button>
                </div>
                {!authStatusReady && <div class="pricing-state pricing-state-loading" role="status" aria-live="polite">Restoring session…</div>}
                <div class="pricing-auth-form">
                  <label class="form-label" htmlFor="pricing-auth-email">Email</label>
                  <input id="pricing-auth-email" class="input-field" type="email" value={authEmail} onInput={(event) => setAuthEmail((event.target as HTMLInputElement).value)} autoComplete="username" placeholder="you@businessflow.dev" />
                  {authAttemptedSubmit && emailError && <p class="pricing-auth-error" role="alert">{emailError}</p>}

                  <label class="form-label" htmlFor="pricing-auth-password">Password</label>
                  <div class="pricing-auth-password-row">
                    <input id="pricing-auth-password" class="input-field" type={showPassword ? 'text' : 'password'} value={authPassword} onInput={(event) => setAuthPassword((event.target as HTMLInputElement).value)} autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'} placeholder="Enter password" />
                    <button class="btn btn-outline pricing-auth-password-toggle" type="button" onClick={() => setShowPassword((prev) => !prev)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? 'Hide' : 'Show'}</button>
                  </div>
                  {authAttemptedSubmit && passwordError && <p class="pricing-auth-error" role="alert">{passwordError}</p>}

                  {authMode === 'signup' && (
                    <>
                      <label class="form-label" htmlFor="pricing-auth-confirm-password">Confirm password</label>
                      <div class="pricing-auth-password-row">
                        <input id="pricing-auth-confirm-password" class="input-field" type={showConfirmPassword ? 'text' : 'password'} value={authConfirmPassword} onInput={(event) => setAuthConfirmPassword((event.target as HTMLInputElement).value)} autoComplete="new-password" placeholder="Re-enter password" />
                        <button class="btn btn-outline pricing-auth-password-toggle" type="button" onClick={() => setShowConfirmPassword((prev) => !prev)} aria-label={showConfirmPassword ? 'Hide confirm password' : 'Show confirm password'}>{showConfirmPassword ? 'Hide' : 'Show'}</button>
                      </div>
                      {authAttemptedSubmit && confirmPasswordError && <p class="pricing-auth-error" role="alert">{confirmPasswordError}</p>}
                    </>
                  )}
                </div>
                <button class="btn btn-primary pricing-auth-submit" disabled={!canSubmitAuth} onClick={() => { void submitAuth(authMode); }}>
                  {authBusyAction === 'sign_in' ? 'Signing in…' : authBusyAction === 'sign_up' ? 'Creating account…' : authMode === 'signup' ? 'Create account' : 'Sign in'}
                </button>
                {authMode === 'signin' && (
                  <button
                    class="btn btn-ghost pricing-auth-forgot"
                    type="button"
                    disabled={isAuthBusy}
                    onClick={() => { void requestPasswordReset(); }}
                  >
                    {authBusyAction === 'forgot_password' ? 'Sending reset link…' : 'Forgot password?'}
                  </button>
                )}
              </>
            ) : (
              <div class="pricing-auth-actions pricing-auth-actions--stacked">
                <dl class="pricing-account-summary">
                  {authStatus?.user?.email && <><dt>Account</dt><dd>{authStatus.user.email}</dd></>}
                  <dt>Current plan</dt><dd>{planLabel}</dd>
                  <dt>Subscription</dt><dd>{subscriptionLabel}</dd>
                  <dt>Trial</dt><dd>{trialLabel}</dd>
                  <dt>Billing period</dt><dd>{billingPeriodLabel}</dd>
                  <dt>Access until</dt><dd>{accessUntilLabel}</dd>
                </dl>
                {entitlement?.stale && <span class="pricing-auth-error">Billing info may be stale. Refresh access to retry sync.</span>}
                <div class="actions-row">
                  <button class="btn btn-primary" disabled={isAuthBusy} onClick={() => { void openBillingPortal(); }}>{authBusyAction === 'open_portal' ? 'Opening portal…' : 'Manage billing'}</button>
                  <button class="btn btn-outline" disabled={isAuthBusy} onClick={() => { void refreshAccess(); }}>{authBusyAction === 'refresh' ? 'Refreshing…' : 'Refresh access'}</button>
                  <button class="btn btn-outline-danger" disabled={isAuthBusy} onClick={() => { void signOut(); }}>{authBusyAction === 'sign_out' ? 'Signing out…' : 'Sign out'}</button>
                </div>
              </div>
            )}
            {authMessage && <p class={authMessage.tone === 'err' ? 'pricing-auth-error' : 'pricing-auth-success'} role={authMessage.tone === 'err' ? 'alert' : 'status'}>{authMessage.text}</p>}
            <button class="btn btn-ghost pricing-auth-back" onClick={() => setCurrentView('pricing')}>← Back to pricing</button>
          </section>
        ) : (
          <>
            <div class="pricing-modal-header">
              <div>
                <h3 class="pricing-modal-title">BusinessFlow plans</h3>
                <p class="pricing-modal-subtitle">Free gives you full capture and export. Pro adds the persistent QA workspace for features, test cases, and run history.</p>
              </div>
              <div class="actions-row">
                <button class="btn btn-ghost" onClick={() => { if (isSignedIn) { onOpenAccount(); return; } setCurrentView('auth'); }}>{isSignedIn ? 'My account' : 'Sign in'}</button>
                <button ref={closeButtonRef} class="btn btn-outline" onClick={onClose}>Close</button>
              </div>
            </div>

            <div class="pricing-plan-layout">
              <article class="pricing-plan-card pricing-plan-card--free">
                <header class="pricing-plan-head">
                  <h4>Free</h4>
                  <p class="pricing-plan-tagline">Capture, review, and export QA evidence without workspace persistence.</p>
                </header>
                <div class="pricing-plan-price-wrap">
                  <div class="pricing-plan-price">$0</div>
                  <span class="pricing-plan-period">forever</span>
                </div>
                <ul class="pricing-plan-features">
                  <li>Record manual QA sessions</li>
                  <li>Automatic and manual evidence capture</li>
                  <li>Session result and report viewing</li>
                  <li>Copy evidence / Markdown</li>
                  <li>PDF, Word, Excel, and current export formats</li>
                </ul>
                <button class="btn btn-outline pricing-plan-cta" onClick={onClose}>Continue with Free</button>
              </article>

              <article class="pricing-plan-card pricing-plan-card--pro" aria-label="Pro plan">
                <header class="pricing-plan-head">
                  <div class="pricing-plan-head-top">
                    <h4>Pro</h4>
                    <span class="badge badge-success">Workspace</span>
                  </div>
                  <p class="pricing-plan-tagline">Persistent workspace for organized QA execution across features and test cases.</p>
                </header>

                <div class="pricing-billing-row">
                  <div class="pricing-billing-toggle" role="tablist" aria-label="Billing period">
                    <button class={`pricing-toggle-btn ${billingInterval === 'monthly' ? 'active' : ''}`} onClick={() => setBillingInterval('monthly')} role="tab" aria-selected={billingInterval === 'monthly'}>Monthly</button>
                    <button class={`pricing-toggle-btn ${billingInterval === 'yearly' ? 'active' : ''}`} onClick={() => setBillingInterval('yearly')} role="tab" aria-selected={billingInterval === 'yearly'}>
                      Yearly <span class="pricing-toggle-pill">Best value</span>
                    </button>
                  </div>
                </div>

                <div class="pricing-plan-price-wrap">
                  <div class="pricing-plan-price">{loadingCatalog ? 'Loading…' : displayPrice ?? 'Shown at checkout'}</div>
                  {displayPrice && <span class="pricing-plan-period">/{billingInterval === 'monthly' ? 'month' : 'year'}</span>}
                </div>
                <div class="pricing-plan-trial">{proPrice?.trialDays ?? 7}-day trial • Same Pro features on monthly or yearly billing.</div>

                <ul class="pricing-plan-features">
                  <li>Everything in Free</li>
                  <li>Persistent feature and test-case management</li>
                  <li>Run history and workspace organization</li>
                  <li>Feature-level reporting and QA tracking</li>
                  <li>Existing Pro capabilities already in BusinessFlow</li>
                </ul>

                <button class="btn btn-primary pricing-plan-cta" disabled={!proIsAvailable || Boolean(checkoutPlanKey) || loadingCatalog} onClick={() => { void runCheckout(); }}>
                  {checkoutPlanKey ? 'Opening checkout…' : isSignedIn ? 'Upgrade to Pro' : 'Sign in to upgrade'}
                </button>
              </article>
            </div>

            {loadingCatalog && <div class="pricing-state pricing-state-loading" role="status" aria-live="polite">Loading pricing and account status…</div>}
            {fatalError && <div class="pricing-state pricing-state-error" role="alert">{fatalError}</div>}
            {checkoutError && <div class="pricing-state pricing-state-error" role="alert">{checkoutError}</div>}
            {checkoutPlanKey && !checkoutError && <div class="pricing-state pricing-state-info" role="status" aria-live="polite">Creating secure checkout session…</div>}

            <p class="pricing-checkout-note">
              Checkout uses your configured Paddle price IDs from backend. If price is not shown here, Paddle checkout remains the source of truth.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

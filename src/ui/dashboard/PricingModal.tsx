import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact/jsx-runtime';
import { initializePaddle, type Paddle, CheckoutEventNames } from '@paddle/paddle-js';
import type { BillingCatalogPayload, BillingInterval, BillingPortalPayload, BillingTier } from '../../core/billing.js';
import type { AuthStatusPayload } from '../../core/auth.js';
import { accessLabel, isValidEmail, toFriendlyAuthError, toSentence, validatePassword } from './pricing-utils.js';
interface RuntimeResult<T> {
  ok?: boolean;
  error?: string;
  catalog?: T;
  checkout?: {
    checkoutId: string;
    planKey: string;
    priceId: string;
  };
  portal?: BillingPortalPayload;
  status?: AuthStatusPayload;
}
interface PricingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigateWelcome: () => void;
  onAuthSuccess: () => void;
  onAuthStatusChange?: (status: AuthStatusPayload | null) => void;
  runtimeMessage: <T>(message: Record<string, unknown>) => Promise<T>;
}
interface PlanPresentation {
  tier: BillingTier;
  title: string;
  tagline: string;
  highlight?: string;
  features: string[];
}
const PLAN_UI: PlanPresentation[] = [
  {
    tier: 'starter',
    title: 'Starter',
    tagline: 'Great for focused solo QA workflows.',
    features: ['Manual test evidence capture', 'PDF / Word / Excel exports', '7-day free trial'],
  },
  {
    tier: 'pro',
    title: 'Pro',
    tagline: 'For teams who ship every week.',
    highlight: 'Most popular',
    features: ['Everything in Starter', 'Advanced evidence workflows', 'Priority support'],
  },
  {
    tier: 'advanced',
    title: 'Advanced',
    tagline: 'Enterprise-grade QA operations.',
    features: ['Everything in Pro', 'Enterprise governance controls', 'Dedicated onboarding'],
  },
];
function toPriceMap(catalog: BillingCatalogPayload, billing: BillingInterval): Record<BillingTier, { planKey: string; priceId: string; trialDays: number }> {
  const output = {} as Record<BillingTier, { planKey: string; priceId: string; trialDays: number }>;
function toPriceMap(catalog: BillingCatalogPayload, billing: BillingInterval): Partial<Record<BillingTier, { planKey: string; priceId: string; trialDays: number }>> {
  const output: Partial<Record<BillingTier, { planKey: string; priceId: string; trialDays: number }>> = {};
  for (const plan of catalog.plans) {
    output[plan.tier] = plan.prices[billing];
    if (plan.prices?.[billing]) {
      output[plan.tier] = plan.prices[billing];
    }
  }
  return output;
}
export function PricingModal({
  isOpen,
  onClose,
  onNavigateWelcome,
  onAuthSuccess,
  onAuthStatusChange,
  runtimeMessage,
}: PricingModalProps): JSX.Element | null {
  const [billingInterval, setBillingInterval] = useState<BillingInterval>('monthly');
  const [catalog, setCatalog] = useState<BillingCatalogPayload | null>(null);
  const [paddle, setPaddle] = useState<Paddle | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatusPayload | null>(null);
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');
  const [authStatusReady, setAuthStatusReady] = useState(false);
  const [authAttemptedSubmit, setAuthAttemptedSubmit] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authConfirmPassword, setAuthConfirmPassword] = useState('');
  const [authBusyAction, setAuthBusyAction] = useState<'idle' | 'sign_in' | 'sign_up' | 'refresh' | 'sign_out' | 'open_portal'>('idle');
  const [authMessage, setAuthMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [priceLabels, setPriceLabels] = useState<Record<string, string>>({});
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [loadingPrices, setLoadingPrices] = useState(false);
  const [checkoutPlanKey, setCheckoutPlanKey] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const applyAuthStatus = useCallback((status: AuthStatusPayload | null): void => {
    setAuthStatus(status);
    onAuthStatusChange?.(status);
  }, [onAuthStatusChange]);
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setFatalError(null);
    setAuthMessage(null);
    setAuthAttemptedSubmit(false);
    setAuthStatusReady(false);
    setLoadingCatalog(true);
    void (async () => {
      const catalogResponse = await runtimeMessage<RuntimeResult<BillingCatalogPayload>>({ type: 'TT_BILLING_GET_CATALOG' });
      if (cancelled) return;
      if (catalogResponse?.ok !== true || !catalogResponse.catalog) {
        setFatalError(catalogResponse?.error || 'Failed to load sandbox billing catalog.');
        setCheckoutError(null);
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
      if (!loadedCatalog.clientToken || !loadedCatalog.clientToken.startsWith('test_')) {
        setFatalError('Missing or invalid Paddle client token. Expected sandbox test_ token.');
        setAuthStatusReady(true);
        setLoadingCatalog(false);
        return;
      }
      const instance = await initializePaddle({
        environment: 'sandbox',
        token: loadedCatalog.clientToken,
        eventCallback: (event) => {
          if (event.name !== CheckoutEventNames.CHECKOUT_COMPLETED) return;
          onNavigateWelcome();
        },
      });
      if (!instance) {
        setFatalError('Unable to initialize Paddle checkout in sandbox mode.');
        setAuthStatusReady(true);
        setLoadingCatalog(false);
        return;
      }
      setCatalog(loadedCatalog);
      setPaddle(instance);
      const authResponse = await runtimeMessage<RuntimeResult<never>>({ type: 'TT_AUTH_GET_STATUS', refreshIfNeeded: true });
      applyAuthStatus(authResponse?.ok === true && authResponse.status ? authResponse.status : null);
      setAuthStatusReady(true);
      setLoadingCatalog(false);
    })().catch((error) => {
      if (cancelled) return;
      setFatalError(error instanceof Error ? error.message : String(error));
      setCheckoutError(null);
      setAuthStatusReady(true);
      setLoadingCatalog(false);
    });
    return () => {
      cancelled = true;
    };
  }, [applyAuthStatus, isOpen, onNavigateWelcome, runtimeMessage]);
  const selectedPrices = useMemo(() => {
    if (!catalog) return null;
    return toPriceMap(catalog, billingInterval);
  }, [catalog, billingInterval]);
  useEffect(() => {
    if (!isOpen || !catalog || !paddle || !selectedPrices) return;
    let cancelled = false;
    setLoadingPrices(true);
    void (async () => {
      const nextLabels: Record<string, string> = {};
      const countryCode = catalog.detectedCountryCode;
      for (const plan of catalog.plans) {
        const selected = selectedPrices[plan.tier];
        if (!selected?.priceId) continue;
        const response = await paddle.PricePreview({
          items: [{ priceId: selected.priceId, quantity: 1 }],
          ...(countryCode ? { address: { countryCode } } : {}),
        });
        const lineItem = response.data.details.lineItems[0];
        if (!lineItem) {
          throw new Error(`Missing Paddle preview details for ${selected.planKey}`);
        }
        nextLabels[selected.planKey] = lineItem.formattedTotals.total;
      }
      if (cancelled) return;
      setPriceLabels(nextLabels);
      setLoadingPrices(false);
    })().catch((error) => {
      if (cancelled) return;
      setFatalError(error instanceof Error ? error.message : String(error));
      setLoadingPrices(false);
    });
    return () => {
      cancelled = true;
    };
  }, [billingInterval, catalog, isOpen, paddle, selectedPrices]);
  useEffect(() => {
    if (!isOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen, onClose]);
  useEffect(() => {
    if (isOpen) return;
    setCheckoutPlanKey(null);
    setCheckoutError(null);
    setFatalError(null);
    setLoadingCatalog(false);
    setLoadingPrices(false);
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
  const canCheckout = authStatus?.signedIn === true;
  const entitlement = authStatus?.entitlement;
  const planLabel = entitlement?.plan ? toSentence(entitlement.plan) : 'Unavailable';
  const subscriptionLabel = entitlement ? `${entitlement.granted ? 'Active' : 'Inactive'} (${toSentence(entitlement.state)})` : 'Unavailable';
  const trialLabel = entitlement ? (entitlement.state.toLowerCase().includes('trial') ? 'In trial' : 'Not in trial') : 'Unavailable';
  const billingPeriodLabel = entitlement?.plan?.toLowerCase().includes('yearly') ? 'Yearly' : entitlement?.plan?.toLowerCase().includes('monthly') ? 'Monthly' : 'Unavailable';
  const accessUntilLabel = entitlement?.accessUntil ? new Date(entitlement.accessUntil).toLocaleString() : 'Not set';
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
  const refreshAccess = async (): Promise<void> => {
    setAuthBusyAction('refresh');
    setAuthMessage(null);
    try {
      const response = await runtimeMessage<RuntimeResult<never>>({ type: 'TT_AUTH_REFRESH' });
      if (response?.ok !== true || !response.status) {
        throw new Error(response?.error || 'Refresh failed.');
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
      if (!opened) throw new Error('Popup blocked. Please allow popups and try again.');
      setAuthMessage({ tone: 'ok', text: 'Billing portal opened in a new tab. Return here after making changes.' });
    } catch (error) {
      setAuthMessage({ tone: 'err', text: toFriendlyAuthError(error instanceof Error ? error.message : String(error)) });
    } finally {
      setAuthBusyAction('idle');
    }
  };
  if (!isOpen) return null;
  const runCheckout = async (tier: BillingTier): Promise<void> => {
    if (!catalog || !selectedPrices || !paddle) {
      setCheckoutError('Pricing is not ready yet.');
      return;
    }
    if (!canCheckout) {
      setCheckoutError('Sign in is required before checkout. Use the account panel in this modal to continue.');
      return;
    }
    const selected = selectedPrices[tier];
    setCheckoutPlanKey(selected.planKey);
    setCheckoutError(null);
    setFatalError(null);
    try {
      const checkoutResponse = await runtimeMessage<RuntimeResult<never>>({
        type: 'TT_BILLING_CREATE_CHECKOUT',
        planKey: selected.planKey,
      });
      if (checkoutResponse?.ok !== true || !checkoutResponse.checkout) {
        throw new Error(checkoutResponse?.error || 'Failed to create checkout session.');
      }
      if (checkoutResponse.checkout.planKey !== selected.planKey || checkoutResponse.checkout.priceId !== selected.priceId) {
        throw new Error('Checkout session plan mismatch detected; aborting checkout.');
      }
      paddle.Checkout.open({
        transactionId: checkoutResponse.checkout.checkoutId,
        settings: {
          displayMode: 'overlay',
          variant: 'one-page',
        },
        ...(authStatus?.user?.email ? { customer: { email: authStatus.user.email } } : {}),
      });
    } catch (error) {
      setCheckoutError(error instanceof Error ? error.message : String(error));
    } finally {
      setCheckoutPlanKey(null);
    }
  };
  return (
    <div class="modal-overlay" role="dialog" aria-modal="true" aria-label="BusinessFlow pricing" onClick={onClose}>
      <div class="modal-card pricing-modal-card" onClick={(event) => event.stopPropagation()}>
        <div class="pricing-modal-header">
          <div>
            <h3 class="pricing-modal-title">BusinessFlow Pricing</h3>
            <p class="pricing-modal-subtitle">Choose your plan and checkout securely with Paddle. Billing activation remains webhook-driven.</p>
          </div>
          <button ref={closeButtonRef} class="btn btn-outline" onClick={onClose}>Close</button>
        </div>
        <div class="pricing-billing-row">
          <div class="pricing-billing-toggle" role="tablist" aria-label="Billing period">
            <button
              class={`pricing-toggle-btn ${billingInterval === 'monthly' ? 'active' : ''}`}
              onClick={() => setBillingInterval('monthly')}
              role="tab"
              aria-selected={billingInterval === 'monthly'}
            >
              Monthly billing
            </button>
            <button
              class={`pricing-toggle-btn ${billingInterval === 'yearly' ? 'active' : ''}`}
              onClick={() => setBillingInterval('yearly')}
              role="tab"
              aria-selected={billingInterval === 'yearly'}
            >
              Yearly billing
            </button>
          </div>
          <p class="pricing-billing-note">All plans include a free trial before billing starts.</p>
        </div>
        {(loadingCatalog || loadingPrices) && (
          <div class="pricing-state pricing-state-loading" role="status" aria-live="polite">
            Loading live pricing from Paddle…
          </div>
        )}
        {fatalError && (
          <div class="pricing-state pricing-state-error" role="alert">
            {fatalError}
          </div>
        )}
        {checkoutError && (
          <div class="pricing-state pricing-state-error" role="alert">
            {checkoutError}
          </div>
        )}
        {!canCheckout && !loadingCatalog && (
          <div class="pricing-state pricing-state-info" role="status" aria-live="polite">
            Sign in is required to start checkout.
          </div>
        )}
        <section class="pricing-auth-card" aria-label="Account access">
          <div class="pricing-auth-header">
            <div>
              <h4>Account & Access</h4>
              <p>{authStatus?.message ?? 'Authenticate to unlock paid plan checkout and entitlement sync.'}</p>
            </div>
            <span class={`badge ${canCheckout ? 'badge-success' : 'badge-muted'}`}>{accessLabel(authStatus)}</span>
          </div>
          {!canCheckout ? (
            <>
              <div class="pricing-auth-switch" role="tablist" aria-label="Authentication mode">
                <button
                  class={`pricing-auth-switch-btn ${authMode === 'signin' ? 'active' : ''}`}
                  role="tab"
                  aria-selected={authMode === 'signin'}
                  onClick={() => {
                    setAuthMode('signin');
                    setAuthAttemptedSubmit(false);
                    setAuthMessage(null);
                  }}
                >
                  Sign in
                </button>
                <button
                  class={`pricing-auth-switch-btn ${authMode === 'signup' ? 'active' : ''}`}
                  role="tab"
                  aria-selected={authMode === 'signup'}
                  onClick={() => {
                    setAuthMode('signup');
                    setAuthAttemptedSubmit(false);
                    setAuthMessage(null);
                  }}
                >
                  Sign up
                </button>
              </div>
              {!authStatusReady && (
                <div class="pricing-state pricing-state-loading" role="status" aria-live="polite">
                  Restoring session…
                </div>
              )}
              <div class="pricing-auth-form">
                <label class="privacy-note" htmlFor="pricing-auth-email">Email</label>
                <input
                  id="pricing-auth-email"
                  class="input-field"
                  type="email"
                  value={authEmail}
                  onInput={(event) => setAuthEmail((event.target as HTMLInputElement).value)}
                  autoComplete="username"
                  placeholder="you@businessflow.dev"
                />
                {authAttemptedSubmit && emailError && <p class="pricing-auth-error" role="alert">{emailError}</p>}
                <label class="privacy-note" htmlFor="pricing-auth-password">Password</label>
                <div class="pricing-auth-password-row">
                  <input
                    id="pricing-auth-password"
                    class="input-field"
                    type={showPassword ? 'text' : 'password'}
                    value={authPassword}
                    onInput={(event) => setAuthPassword((event.target as HTMLInputElement).value)}
                    autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'}
                    placeholder="Enter password"
                  />
                  <button
                    class="btn btn-outline pricing-auth-password-toggle"
                    type="button"
                    onClick={() => setShowPassword((prev) => !prev)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? 'Hide' : 'Show'}
                  </button>
                </div>
                {authAttemptedSubmit && passwordError && <p class="pricing-auth-error" role="alert">{passwordError}</p>}
                {authMode === 'signup' && (
                  <>
                    <label class="privacy-note" htmlFor="pricing-auth-confirm-password">Confirm password</label>
                    <div class="pricing-auth-password-row">
                      <input
                        id="pricing-auth-confirm-password"
                        class="input-field"
                        type={showConfirmPassword ? 'text' : 'password'}
                        value={authConfirmPassword}
                        onInput={(event) => setAuthConfirmPassword((event.target as HTMLInputElement).value)}
                        autoComplete="new-password"
                        placeholder="Re-enter password"
                      />
                      <button
                        class="btn btn-outline pricing-auth-password-toggle"
                        type="button"
                        onClick={() => setShowConfirmPassword((prev) => !prev)}
                        aria-label={showConfirmPassword ? 'Hide confirm password' : 'Show confirm password'}
                      >
                        {showConfirmPassword ? 'Hide' : 'Show'}
                      </button>
                    </div>
                    {authAttemptedSubmit && confirmPasswordError && <p class="pricing-auth-error" role="alert">{confirmPasswordError}</p>}
                  </>
                )}
              </div>
              <button
                class="btn btn-primary"
                disabled={!canSubmitAuth}
                onClick={() => {
                  void submitAuth(authMode);
                }}
              >
                {authBusyAction === 'sign_in'
                  ? 'Signing in…'
                  : authBusyAction === 'sign_up'
                    ? 'Creating account…'
                    : authMode === 'signup'
                      ? 'Create account'
                      : 'Sign in'}
              </button>
            </>
          ) : (
            <div class="pricing-auth-actions">
              {authStatus?.user?.email && <span class="privacy-note">Signed in as {authStatus.user.email}</span>}
              <span class="privacy-note">Current plan: {planLabel}</span>
              <span class="privacy-note">Subscription status: {subscriptionLabel}</span>
              <span class="privacy-note">Trial status: {trialLabel}</span>
              <span class="privacy-note">Billing period: {billingPeriodLabel}</span>
              <span class="privacy-note">Access until: {accessUntilLabel}</span>
              {entitlement?.stale && <span class="pricing-auth-error">Billing info may be stale. Refresh access to retry sync.</span>}
              <button class="btn btn-primary" disabled={isAuthBusy} onClick={() => { void openBillingPortal(); }}>
                {authBusyAction === 'open_portal' ? 'Opening billing portal…' : 'Manage Billing'}
              </button>
              <button class="btn btn-outline" disabled={isAuthBusy} onClick={() => { void refreshAccess(); }}>
                {authBusyAction === 'refresh' ? 'Refreshing…' : 'Refresh access'}
              </button>
              <button class="btn btn-outline" disabled={isAuthBusy} onClick={() => { void signOut(); }}>
                {authBusyAction === 'sign_out' ? 'Signing out…' : 'Log out'}
              </button>
            </div>
          )}
          {authMessage && (
            <p class={authMessage.tone === 'err' ? 'pricing-auth-error' : 'pricing-auth-success'} role={authMessage.tone === 'err' ? 'alert' : 'status'}>
              {authMessage.text}
            </p>
          )}
        </section>
        <div class="pricing-grid">
          {PLAN_UI.map((plan) => {
          {PLAN_UI.filter((plan) => catalog?.plans.some((p) => p.tier === plan.tier)).map((plan) => {
            const selected = selectedPrices?.[plan.tier];
            const displayPrice = selected ? priceLabels[selected.planKey] : null;
            const isLoadingPrice = !displayPrice || loadingPrices || loadingCatalog;
            const isCheckoutPending = checkoutPlanKey === selected?.planKey;
            const periodLabel = billingInterval === 'monthly' ? '/month' : '/year';
            return (
              <article key={plan.tier} class={`pricing-plan-card ${plan.highlight ? 'highlighted' : ''}`}>
                {plan.highlight && <span class="pricing-plan-badge">{plan.highlight}</span>}
                <div class="pricing-plan-head">
                  <h4>{plan.title}</h4>
                  <p class="pricing-plan-tagline">{plan.tagline}</p>
                </div>
                <div class="pricing-plan-price-wrap">
                  <div class="pricing-plan-price">
                    {isLoadingPrice ? 'Loading…' : displayPrice}
                  </div>
                  {!isLoadingPrice && <span class="pricing-plan-period">{periodLabel}</span>}
                </div>
                <div class="pricing-plan-trial">{selected?.trialDays ?? 7}-day free trial • Cancel anytime during trial</div>
                <ul class="pricing-plan-features">
                  {plan.features.map((feature) => <li key={feature}>{feature}</li>)}
                </ul>
                <button
                  class={`btn ${plan.highlight ? 'btn-primary' : 'btn-outline'} pricing-plan-cta`}
                  disabled={!selected || Boolean(checkoutPlanKey) || loadingCatalog || !canCheckout}
                  onClick={() => void runCheckout(plan.tier)}
                >
                  {isCheckoutPending ? 'Opening checkout…' : canCheckout ? `Subscribe to ${plan.title}` : 'Sign in to subscribe'}
                </button>
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}

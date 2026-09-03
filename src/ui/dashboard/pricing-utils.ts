import type { AuthStatusPayload } from '../../core/auth.js';

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export function validatePassword(password: string): string | null {
  if (password.length < 8 || password.length > 128) {
    return 'Password must be between 8 and 128 characters.';
  }
  return null;
}

export function toFriendlyAuthError(raw: string): string {
  const message = raw.toLowerCase();
  if (message.includes('invalid credentials')) return 'Incorrect email or password.';
  if (message.includes('session expired')) return 'Your session expired. Please sign in again.';
  if (message.includes('network') || message.includes('failed to fetch')) return 'Cannot reach BusinessFlow backend. Check your connection and try again.';
  if (message.includes('already') || message.includes('exists') || message.includes('registered')) return 'An account with this email already exists.';
  if (message.includes('email must be valid')) return 'Please enter a valid email address.';
  if (message.includes('password must be between')) return 'Password must be between 8 and 128 characters.';
  if (message.includes('not provisioned')) return 'Billing portal is not available until a paid/trial subscription is provisioned.';
  return raw;
}

export function accessLabel(status: AuthStatusPayload | null): string {
  if (!status) return 'Checking access…';
  if (status.state === 'access_active') return 'Access active';
  if (status.state === 'access_unavailable') return 'Access unavailable';
  if (status.state === 'session_expired') return 'Session expired';
  if (status.state === 'signed_in') return 'Signed in';
  if (status.state === 'checking_access') return 'Checking access…';
  return 'Signed out';
}

export function toSentence(raw: string): string {
  return raw.split(/[_-]+/).map((v) => `${v.slice(0, 1).toUpperCase()}${v.slice(1)}`).join(' ');
}

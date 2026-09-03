const INDICATOR_HOST_ID = '__tt_indicator__';

type IndicatorMode = 'recording' | 'paused' | 'stopping';

let hostEl: HTMLDivElement | null = null;
let pillEl: HTMLDivElement | null = null;
let dotEl: HTMLSpanElement | null = null;
let labelEl: HTMLSpanElement | null = null;
let stopBtnEl: HTMLButtonElement | null = null;

function ensureIndicatorHost(): HTMLDivElement {
  if (hostEl && document.contains(hostEl)) return hostEl;

  const existing = document.getElementById(INDICATOR_HOST_ID);
  if (existing instanceof HTMLDivElement) {
    hostEl = existing;
    return existing;
  }

  const host = document.createElement('div');
  host.id = INDICATOR_HOST_ID;
  const mountPoint = document.body ?? document.documentElement;
  mountPoint.appendChild(host);
  hostEl = host;
  return host;
}

export function mountIndicator(): void {
  const host = ensureIndicatorHost();
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  if (root.querySelector('[data-tt-indicator="pill"]')) {
    setIndicatorMode('recording');
    return;
  }

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .pill {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 2147483647;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 9999px;
      box-shadow: 0 4px 12px rgba(15, 23, 42, 0.12);
      padding: 8px 12px;
      font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 12px;
      color: #0f172a;
      line-height: 1;
      user-select: none;
    }
    .pill[data-mode='paused'] {
      background: #fffbeb;
      border-color: #fde68a;
    }
    .pill[data-mode='stopping'] {
      background: #eff6ff;
      border-color: #bfdbfe;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #ef4444;
      animation: tt-pulse 1.3s ease-in-out infinite;
      box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.5);
      flex: 0 0 auto;
    }
    .dot.is-paused {
      background: #f59e0b;
      animation: none;
      box-shadow: none;
    }
    .dot.is-stopping {
      background: #2563eb;
      animation: tt-pulse 0.9s ease-in-out infinite;
      box-shadow: 0 0 0 0 rgba(37, 99, 235, 0.42);
    }
    .label { font-weight: 600; }
    .stop {
      appearance: none;
      border: none;
      background: transparent;
      color: #ef4444;
      cursor: pointer;
      font-weight: 600;
      font-size: 12px;
      padding: 0;
      margin-left: 4px;
    }
    .stop:hover { text-decoration: underline; }
    .stop:focus-visible { outline: 2px solid #ef4444; outline-offset: 2px; border-radius: 4px; }
    .stop:disabled { opacity: 0.55; cursor: not-allowed; text-decoration: none; }
    @keyframes tt-pulse {
      0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.55); }
      70% { transform: scale(1.05); box-shadow: 0 0 0 8px rgba(239, 68, 68, 0); }
      100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); }
    }
  `;

  const pill = document.createElement('div');
  pill.className = 'pill';
  pill.setAttribute('data-tt-indicator', 'pill');
  pill.setAttribute('role', 'status');
  pill.setAttribute('aria-live', 'polite');

  const dot = document.createElement('span');
  dot.className = 'dot';

  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = 'Recording active';

  let stopping = false;

  const stopBtn = document.createElement('button');
  stopBtn.type = 'button';
  stopBtn.className = 'stop';
  stopBtn.textContent = 'Stop';
  stopBtn.addEventListener('mousedown', (event) => {
    event.stopPropagation();
  }, true);
  stopBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (stopping) return;
    stopping = true;
    setIndicatorMode('stopping');
    stopBtn.disabled = true;
    chrome.runtime.sendMessage({ type: 'TT_SESSION_STOP' })
      .catch(() => {})
      .finally(() => {
        stopping = false;
        stopBtn.disabled = false;
        setIndicatorMode('recording');
      });
  }, true);

  pill.append(dot, label, stopBtn);
  root.replaceChildren(style, pill);

  pillEl = pill;
  dotEl = dot;
  labelEl = label;
  stopBtnEl = stopBtn;
  setIndicatorMode('recording');
}

export function setIndicatorMode(mode: IndicatorMode): void {
  if (!pillEl || !dotEl || !labelEl || !stopBtnEl) return;

  pillEl.setAttribute('data-mode', mode);
  dotEl.classList.toggle('is-paused', mode === 'paused');
  dotEl.classList.toggle('is-stopping', mode === 'stopping');

  if (mode === 'paused') {
    labelEl.textContent = 'Recording paused';
    stopBtnEl.textContent = 'Stop';
    return;
  }

  if (mode === 'stopping') {
    labelEl.textContent = 'Stopping…';
    stopBtnEl.textContent = 'Stopping…';
    return;
  }

  labelEl.textContent = 'Recording active';
  stopBtnEl.textContent = 'Stop';
}

export function unmountIndicator(): void {
  if (hostEl) hostEl.remove();
  hostEl = null;
  pillEl = null;
  dotEl = null;
  labelEl = null;
  stopBtnEl = null;
}

export function getIndicatorHost(): HTMLElement | null {
  return hostEl;
}

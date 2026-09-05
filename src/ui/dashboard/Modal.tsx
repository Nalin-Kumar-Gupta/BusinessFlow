import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact/jsx-runtime';

export interface ModalProps {
  title: string;
  body: string;
  inputPlaceholder?: string;
  inputValue?: string;
  onConfirm: (value: string) => void | Promise<void>;
  onCancel: () => void;
  confirmLabel?: string;
  isDanger?: boolean;
}

const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  title,
  body,
  inputPlaceholder,
  inputValue = '',
  onConfirm,
  onCancel,
  confirmLabel = 'Confirm',
  isDanger = false,
}: ModalProps): JSX.Element {
  const [value, setValue] = useState(inputValue);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const dialogIdRef = useRef(`modal-${Math.random().toString(36).slice(2, 9)}`);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  const submit = (): void => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    Promise.resolve(onConfirm(value)).finally(() => {
      setIsSubmitting(false);
    });
  };

  const handleCancel = (): void => {
    if (isSubmitting) return;
    onCancel();
  };

  useEffect(() => {
    setValue(inputValue);
  }, [inputValue]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const initial = inputRef.current ?? confirmRef.current ?? dialogRef.current;
    initial?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        handleCancel();
        return;
      }
      if (event.key === 'Enter' && !(event.target instanceof HTMLTextAreaElement)) {
        event.preventDefault();
        submit();
        return;
      }
      if (event.key !== 'Tab') return;

      const container = dialogRef.current;
      if (!container) return;
      const focusables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
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

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus();
    };
  }, [onCancel]);

  return (
    <div class="modal-overlay" onClick={handleCancel}>
      <div
        class="modal-content"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${dialogIdRef.current}-title`}
        aria-describedby={`${dialogIdRef.current}-body`}
        tabindex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div id={`${dialogIdRef.current}-title`} class="modal-title">{title}</div>
        <div id={`${dialogIdRef.current}-body`} class="modal-body">{body}</div>
        {inputPlaceholder && (
          <input
            ref={inputRef}
            class="modal-input"
            aria-label={inputPlaceholder}
            placeholder={inputPlaceholder}
            value={value}
            disabled={isSubmitting}
            onInput={(event) => setValue((event.target as HTMLInputElement).value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
          />
        )}
        <div class="modal-actions">
          <button class="btn btn-outline" onClick={handleCancel} disabled={isSubmitting}>Cancel</button>
          <button ref={confirmRef} class={`btn ${isDanger ? 'btn-danger' : 'btn-primary'}`} onClick={submit} disabled={isSubmitting}>
            {isSubmitting ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

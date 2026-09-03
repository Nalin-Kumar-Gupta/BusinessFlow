import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact/jsx-runtime';
import type { StepPin } from '../../core/types.js';

export type PinKind = 'note' | 'bug';

export interface ScreenshotPin {
  id: string;
  kind: PinKind;
  text: string;
  pin: StepPin;
}

export interface ScreenshotHighlightRect {
  xPercent: number;
  yPercent: number;
  widthPercent: number;
  heightPercent: number;
}

interface AnnotatableScreenshotProps {
  src: string;
  alt: string;
  target: StepPin['target'];
  pins: ScreenshotPin[];
  highlightRect?: ScreenshotHighlightRect;
  maxChars: number;
  /** Read-only surfaces (e.g. developer trace) show pins but disallow editing. */
  readOnly?: boolean;
  canAddNote?: boolean;
  canAddBug?: boolean;
  onCreate?: (kind: PinKind, text: string, pin: StepPin) => void;
  onUpdate?: (id: string, kind: PinKind, text: string) => void;
  onDelete?: (id: string, kind: PinKind) => void;
  onMove?: (id: string, kind: PinKind, pin: StepPin) => void;
}

interface DraftPin {
  x: number;
  y: number;
  kind: PinKind | null;
  text: string;
}

interface DragState {
  id: string;
  kind: PinKind;
  x: number;
  y: number;
}

/** How long a pin must be held before it becomes draggable. */
const DRAG_HOLD_MS = 2000;
/** Pointer travel that cancels the hold, so a sloppy click isn't a drag. */
const HOLD_CANCEL_PX = 6;

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

export function AnnotatableScreenshot({
  src,
  alt,
  target,
  pins,
  highlightRect,
  maxChars,
  readOnly = false,
  canAddNote = false,
  canAddBug = false,
  onCreate,
  onUpdate,
  onDelete,
  onMove,
}: AnnotatableScreenshotProps): JSX.Element {
  const [draft, setDraft] = useState<DraftPin | null>(null);
  const [openPinId, setOpenPinId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState<string | null>(null);
  const [armedPinId, setArmedPinId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const holdOriginRef = useRef<{ x: number; y: number } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  /** Set after a drag so the trailing click doesn't reopen the popover. */
  const suppressClickRef = useRef(false);

  const canAddAny = !readOnly && (canAddNote || canAddBug);

  const clearHold = (): void => {
    if (holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    holdOriginRef.current = null;
    setArmedPinId(null);
  };

  const closeAll = (): void => {
    setDraft(null);
    setOpenPinId(null);
    setEditingText(null);
  };

  useEffect(() => () => clearHold(), []);

  // Dismiss popovers on outside click or Escape.
  useEffect(() => {
    if (!draft && !openPinId) return undefined;

    const onPointerDown = (event: MouseEvent): void => {
      if (!wrapRef.current?.contains(event.target as Node)) closeAll();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeAll();
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [draft, openPinId]);

  // Live drag: track the pointer and clamp to the image bounds.
  useEffect(() => {
    if (!drag) return undefined;

    const onPointerMove = (event: PointerEvent): void => {
      const rect = imgRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return;

      // Clamping each axis independently makes an out-of-bounds pointer
      // slide along the nearest edge, and settle in a corner past both.
      const next = {
        ...drag,
        x: clampPercent(((event.clientX - rect.left) / rect.width) * 100),
        y: clampPercent(((event.clientY - rect.top) / rect.height) * 100),
      };
      dragRef.current = next;
      setDrag(next);
    };

    const onPointerUp = (): void => {
      const finished = dragRef.current;
      if (finished) {
        onMove?.(finished.id, finished.kind, { target, x: finished.x, y: finished.y });
      }
      suppressClickRef.current = true;
      dragRef.current = null;
      setDrag(null);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      dragRef.current = null;
      setDrag(null);
    };

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [drag, onMove, target]);

  const beginHold = (event: PointerEvent, item: ScreenshotPin): void => {
    if (readOnly) return;
    event.stopPropagation();
    holdOriginRef.current = { x: event.clientX, y: event.clientY };
    setArmedPinId(item.id);

    holdTimerRef.current = window.setTimeout(() => {
      const next = { id: item.id, kind: item.kind, x: item.pin.x, y: item.pin.y };
      dragRef.current = next;
      setDrag(next);
      setArmedPinId(null);
      holdTimerRef.current = null;
      closeAll();
    }, DRAG_HOLD_MS);
  };

  const maybeCancelHold = (event: PointerEvent): void => {
    const origin = holdOriginRef.current;
    if (!origin || holdTimerRef.current === null) return;
    const moved = Math.hypot(event.clientX - origin.x, event.clientY - origin.y);
    if (moved > HOLD_CANCEL_PX) clearHold();
  };

  const handleImageClick = (event: MouseEvent): void => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (!canAddAny || drag) return;
    if (openPinId || draft) {
      closeAll();
      return;
    }

    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    setDraft({
      x: clampPercent(((event.clientX - rect.left) / rect.width) * 100),
      y: clampPercent(((event.clientY - rect.top) / rect.height) * 100),
      kind: null,
      text: '',
    });
  };

  const saveDraft = (): void => {
    if (!draft?.kind) return;
    const text = draft.text.trim();
    if (!text) return;
    onCreate?.(draft.kind, text, { target, x: draft.x, y: draft.y });
    closeAll();
  };

  const openPin = pins.find((item) => item.id === openPinId) ?? null;

  return (
    <div class={`annotatable-shot ${drag ? 'is-dragging' : ''}`} ref={wrapRef}>
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        class={`screenshot-thumb ${canAddAny ? 'is-annotatable' : ''}`}
        onClick={handleImageClick}
      />

      {highlightRect && (
        <div
          class="shot-highlight-rect"
          style={{
            left: `${clampPercent(highlightRect.xPercent)}%`,
            top: `${clampPercent(highlightRect.yPercent)}%`,
            width: `${clampPercent(highlightRect.widthPercent)}%`,
            height: `${clampPercent(highlightRect.heightPercent)}%`,
          }}
        />
      )}

      {pins.map((item) => {
        const isDragged = drag?.id === item.id;
        const x = isDragged ? drag.x : item.pin.x;
        const y = isDragged ? drag.y : item.pin.y;

        return (
          <button
            key={item.id}
            type="button"
            class={[
              'shot-pin',
              item.kind,
              openPinId === item.id ? 'is-open' : '',
              armedPinId === item.id ? 'is-arming' : '',
              isDragged ? 'is-dragged' : '',
            ].filter(Boolean).join(' ')}
            style={{ left: `${x}%`, top: `${y}%` }}
            title={drag ? 'Drop to place' : readOnly ? item.text : `${item.text}\n(hold 2s to drag)`}
            onPointerDown={(event) => beginHold(event as unknown as PointerEvent, item)}
            onPointerMove={(event) => maybeCancelHold(event as unknown as PointerEvent)}
            onPointerUp={clearHold}
            onPointerLeave={clearHold}
            onClick={(event) => {
              event.stopPropagation();
              if (suppressClickRef.current) {
                suppressClickRef.current = false;
                return;
              }
              setDraft(null);
              setEditingText(null);
              setOpenPinId((current) => (current === item.id ? null : item.id));
            }}
          />
        );
      })}

      {draft && (
        <div
          class="shot-popover"
          style={{ left: `${draft.x}%`, top: `${draft.y}%` }}
          onClick={(event) => event.stopPropagation()}
        >
          {draft.kind === null ? (
            <div class="shot-popover-choices">
              <button
                class="shot-choice note"
                disabled={!canAddNote}
                title={canAddNote ? undefined : 'Note limit reached'}
                onClick={() => setDraft({ ...draft, kind: 'note' })}
              >
                Add Note
              </button>
              <button
                class="shot-choice bug"
                disabled={!canAddBug}
                title={canAddBug ? undefined : 'Bug limit reached'}
                onClick={() => setDraft({ ...draft, kind: 'bug' })}
              >
                Add Bug
              </button>
            </div>
          ) : (
            <>
              <span class={`shot-popover-tag ${draft.kind}`}>
                {draft.kind === 'bug' ? 'Bug' : 'Note'}
              </span>
              <textarea
                class="shot-popover-input"
                autofocus
                maxLength={maxChars}
                placeholder={draft.kind === 'bug' ? 'Describe the bug...' : 'Describe what you observed...'}
                value={draft.text}
                onInput={(event) => setDraft({ ...draft, text: (event.target as HTMLTextAreaElement).value })}
              />
              <div class="shot-popover-foot">
                <span class="shot-popover-count">{draft.text.length}/{maxChars}</span>
                <div class="shot-popover-buttons">
                  <button class="shot-action" onClick={closeAll}>Cancel</button>
                  <button class="shot-action primary" disabled={!draft.text.trim()} onClick={saveDraft}>
                    Save
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {openPin && !drag && (
        <div
          class="shot-popover"
          style={{ left: `${openPin.pin.x}%`, top: `${openPin.pin.y}%` }}
          onClick={(event) => event.stopPropagation()}
        >
          <span class={`shot-popover-tag ${openPin.kind}`}>
            {openPin.kind === 'bug' ? 'Bug' : 'Note'}
          </span>

          {editingText === null ? (
            <>
              <p class="shot-popover-text">{openPin.text}</p>
              <div class="shot-popover-foot">
                <span class="shot-popover-count">{openPin.text.length}/{maxChars}</span>
                {!readOnly && (
                  <div class="shot-popover-buttons">
                    <button class="shot-action" onClick={() => setEditingText(openPin.text)}>Edit</button>
                    <button
                      class="shot-action danger"
                      onClick={() => {
                        onDelete?.(openPin.id, openPin.kind);
                        closeAll();
                      }}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <textarea
                class="shot-popover-input"
                autofocus
                maxLength={maxChars}
                value={editingText}
                onInput={(event) => setEditingText((event.target as HTMLTextAreaElement).value)}
              />
              <div class="shot-popover-foot">
                <span class="shot-popover-count">{editingText.length}/{maxChars}</span>
                <div class="shot-popover-buttons">
                  <button class="shot-action" onClick={() => setEditingText(null)}>Cancel</button>
                  <button
                    class="shot-action primary"
                    disabled={!editingText.trim()}
                    onClick={() => {
                      onUpdate?.(openPin.id, openPin.kind, editingText.trim());
                      closeAll();
                    }}
                  >
                    Save
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

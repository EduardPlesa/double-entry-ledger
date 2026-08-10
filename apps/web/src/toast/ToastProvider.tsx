import { createContext, use, useCallback, useMemo, useState, type ReactNode } from 'react';
import { ApiError } from '../api/problem';

/**
 * Failures, said out loud, with the one string that finds them in the logs.
 *
 * Every problem document the API returns carries `requestId`, and this is where it surfaces:
 * a user reads it out, and it locates their exact failure in the structured logs. A failure
 * with no response at all - the network, not the server - says so, rather than rendering an
 * empty field, because a blank id reads as an answer.
 *
 * Local rather than a toast library: this is a queue and an `aria-live` region, and the two of
 * them are smaller than the configuration a library would need. There is no timer - a toast
 * persists until its own "Dismiss" button is clicked, so a request id is never on screen for
 * less time than it takes to read and copy it.
 */

interface Toast {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly requestId: string | null;
}

interface ToastApi {
  showError(error: unknown): void;
  dismiss(id: string): void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = use(ToastContext);
  if (api === null) throw new Error('useToast was called outside a ToastProvider');
  return api;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const showError = useCallback((error: unknown) => {
    setToasts((current) => [...current, toastOf(error)]);
  }, []);

  const api = useMemo(() => ({ showError, dismiss }), [showError, dismiss]);

  return (
    <ToastContext value={api}>
      {children}
      <div role="status" aria-live="polite" className="fixed bottom-4 right-4 flex flex-col gap-2">
        {toasts.map((toast) => (
          <ToastCard key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  return (
    <div className="w-96 rounded border border-red-300 bg-white p-3 shadow">
      <p className="font-semibold">{toast.title}</p>
      <p className="text-sm">{toast.detail}</p>

      {toast.requestId === null ? (
        <p className="mt-2 text-xs text-gray-500">No request id: the request never reached the server.</p>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <code className="text-xs">{toast.requestId}</code>
          <button
            type="button"
            className="text-xs underline"
            onClick={() => void window.navigator.clipboard.writeText(toast.requestId ?? '')}
          >
            Copy request id
          </button>
        </div>
      )}

      <button
        type="button"
        className="mt-2 text-xs underline"
        onClick={() => { onDismiss(toast.id); }}
      >
        Dismiss
      </button>
    </div>
  );
}

function toastOf(error: unknown): Toast {
  const id = crypto.randomUUID();

  if (error instanceof ApiError) {
    return { id, title: titleOf(error.code), detail: error.detail, requestId: error.requestId };
  }

  return {
    id,
    title: 'Something went wrong',
    detail: error instanceof Error ? error.message : String(error),
    requestId: null,
  };
}

/** `ACCOUNT_OVERDRAWN` reads as "Account overdrawn", which is what a heading should look like. */
function titleOf(code: string): string {
  const words = code.toLowerCase().replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

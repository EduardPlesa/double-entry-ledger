import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, Outlet } from 'react-router';
import type { CredentialsInput } from '@ledger/shared';
import { apiFetch } from '../api/client';
import { getSessionUser, onSessionLost, refreshSession, setAccessToken } from '../api/session';

/**
 * Who is signed in, and the three calls that change the answer.
 *
 * Boot runs one refresh. The access token does not survive a reload - it is deliberately held
 * in memory only - but the `Path=/auth` cookie does, so a returning user gets their session
 * back without seeing a form. Until that call answers the status is `booting`, which is why
 * the guard renders nothing rather than redirecting: a redirect during boot would bounce every
 * signed-in user to the login screen on every reload.
 */

export interface User {
  readonly id: string;
  readonly email: string;
}

interface SessionResponse {
  readonly accessToken: string;
  readonly user: User;
}

type Status = 'booting' | 'anonymous' | 'signed-in';

interface SessionApi {
  readonly user: User | null;
  readonly status: Status;
  signIn(input: CredentialsInput): Promise<void>;
  register(input: CredentialsInput): Promise<void>;
  signOut(): Promise<void>;
}

const SessionContext = createContext<SessionApi | null>(null);

export function useSession(): SessionApi {
  const api = use(SessionContext);
  if (api === null) throw new Error('useSession was called outside a SessionProvider');
  return api;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<Status>('booting');

  useEffect(() => {
    let cancelled = false;

    const boot = async () => {
      const token = await refreshSession();
      if (cancelled) return;

      if (token === null) {
        setStatus('anonymous');
        return;
      }

      // The identity came back in the same body as the token, so there is no second call.
      setUser(getSessionUser());
      setStatus('signed-in');
    };

    void boot();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () =>
      onSessionLost(() => {
        setUser(null);
        setStatus('anonymous');
      }),
    [],
  );

  const authenticate = useCallback(async (path: '/auth/login' | '/auth/register', input: CredentialsInput) => {
    const session = await apiFetch<SessionResponse>(path, { method: 'POST', body: input });
    setAccessToken(session.accessToken);
    setUser(session.user);
    setStatus('signed-in');
  }, []);

  const signIn = useCallback((input: CredentialsInput) => authenticate('/auth/login', input), [authenticate]);
  const register = useCallback((input: CredentialsInput) => authenticate('/auth/register', input), [authenticate]);

  const signOut = useCallback(async () => {
    try {
      await apiFetch('/auth/logout', { method: 'POST' });
    } finally {
      // Whatever the server said, this browser is done with the session. A logout that failed
      // and left the user apparently signed in is worse than one that forgets locally.
      setAccessToken(null);
      setUser(null);
      setStatus('anonymous');
    }
  }, []);

  const api = useMemo(
    () => ({ user, status, signIn, register, signOut }),
    [user, status, signIn, register, signOut],
  );

  return <SessionContext value={api}>{children}</SessionContext>;
}

export function RequireSession() {
  const { status } = useSession();

  if (status === 'booting') return null;
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  return <Outlet />;
}

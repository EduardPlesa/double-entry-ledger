import { useQueryClient } from '@tanstack/react-query';
import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import type { CredentialsInput } from '@ledger/shared';
import { apiFetch } from '../api/client';
import { onSessionLost, refreshSession, setAccessToken } from '../api/session';

/**
 * Who is signed in, and the three calls that change the answer.
 *
 * Boot runs one refresh. The access token does not survive a reload - it is deliberately held
 * in memory only - but the `Path=/auth` cookie does, so a returning user gets their session
 * back without seeing a form. Until that call answers the status is `booting`, which is why
 * the guard renders nothing rather than redirecting: a redirect during boot would bounce every
 * signed-in user to the login screen on every reload.
 *
 * This provider is the single record of who is signed in - `session.ts` holds only the token,
 * never a second copy of the user, so there is nowhere for the two to disagree.
 *
 * The query cache is cleared on both the way a session ends: a deliberate `signOut` and a
 * session lost to a dead refresh cookie (`onSessionLost`). They end the session equally
 * completely from the app's point of view, and `['books']` cached under the previous user is
 * exactly as wrong to show the next signed-in identity regardless of which one happened.
 * Without this, `staleTime` lets a fresh sign-in as a different user render straight from the
 * old user's cached data for up to 30 seconds, with no request made to notice the switch.
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
  const queryClient = useQueryClient();

  useEffect(() => {
    let cancelled = false;

    const boot = async () => {
      const session = await refreshSession();
      if (cancelled) return;

      if (session === null) {
        setStatus('anonymous');
        return;
      }

      // The identity came back in the same body as the token, so there is no second call.
      setUser(session.user);
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
        // See the module docblock: a lost session is as complete an end as a deliberate
        // sign-out, and leaving the previous user's queries cached would let a stale `['books']`
        // render for whoever ends up signed in next.
        queryClient.clear();
      }),
    [queryClient],
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
      // Same reasoning as `onSessionLost`: the next sign-in must not render this user's
      // cached queries.
      queryClient.clear();
    }
  }, [queryClient]);

  const api = useMemo(
    () => ({ user, status, signIn, register, signOut }),
    [user, status, signIn, register, signOut],
  );

  return <SessionContext value={api}>{children}</SessionContext>;
}

export function RequireSession() {
  const { status } = useSession();
  const location = useLocation();

  if (status === 'booting') return null;
  // Where the user was headed, carried as router state so `Login` can send them back there
  // instead of always landing on `/books`. Only the path and query travel - the location object
  // itself is not serialisable in a way worth depending on, and the router never needs more
  // than a string to navigate back to.
  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <Outlet />;
}

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { ApiError } from './api/problem';
import { Books } from './routes/Books';
import { Login } from './routes/Login';
import { Register } from './routes/Register';
import { RequireSession, SessionProvider } from './session/SessionProvider';
import { ToastProvider } from './toast/ToastProvider';

/**
 * Providers, in the order their dependencies run: the query client knows nothing about the
 * others, the session makes API calls, the toasts are what a failed call surfaces through,
 * and the router is what the session's guard redirects inside of.
 *
 * Nothing here is optimistic, and the retry policy is why. A 4xx is an answer - the server
 * considered the request and declined it - and asking again changes nothing except the load.
 * Only a request that never got an answer is worth repeating.
 */
function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: (failureCount, error) =>
          !(error instanceof ApiError) && failureCount < 1,
      },
      mutations: { retry: false },
    },
  });
}

export function App() {
  // `useState(fn)` rather than `createQueryClient()` inline: the inline form builds a new
  // client on every render of this component, which would throw the whole cache away the
  // first time anything above it re-renders. The lazy initialiser builds exactly one.
  const [queryClient] = useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <SessionProvider>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/register" element={<Register />} />
              <Route element={<RequireSession />}>
                <Route path="/books" element={<Books />} />
              </Route>
              <Route path="*" element={<Navigate to="/books" replace />} />
            </Routes>
          </SessionProvider>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

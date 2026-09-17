import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { Route, Switch, Router as WouterRouter, Redirect } from 'wouter';
import { AppLayout } from '@/components/layout';
import DashboardPage from '@/pages/dashboard';
import ProductsPage from '@/pages/products';
import OrdersPage from '@/pages/orders';
import SettingsPage from '@/pages/settings';
import PublicOrderPage from '@/pages/public-order';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: false,
    },
  },
});

function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <h2 className="mb-2 text-3xl font-bold tracking-tight text-foreground">404</h2>
      <p className="mb-6 text-muted-foreground">Страница, которую вы ищете, не существует.</p>
    </div>
  );
}

function SignInPage({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || 'Не удалось войти');
      queryClient.clear();
      onSignedIn();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось войти');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-slate-100 px-4">
      <form onSubmit={submit} className="w-full max-w-md rounded-2xl bg-white p-8 shadow-xl">
        <img src={`${import.meta.env.BASE_URL}logo.svg`} alt="" className="mx-auto mb-5 h-12 w-12" />
        <h1 className="text-center text-2xl font-semibold text-slate-950">Вход администратора</h1>
        <p className="mt-2 text-center text-sm text-slate-600">
          Введите логин и пароль для управления сервисом
        </p>
        <label className="mt-7 block text-sm font-medium text-slate-800">
          Email
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="mt-2 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2.5 text-slate-950 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </label>
        <label className="mt-4 block text-sm font-medium text-slate-800">
          Пароль
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-2 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2.5 text-slate-950 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </label>
        {error ? <p role="alert" className="mt-4 text-sm text-red-600">{error}</p> : null}
        <button
          type="submit"
          disabled={submitting}
          className="mt-6 w-full rounded-lg bg-blue-600 px-4 py-2.5 font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? 'Входим…' : 'Войти'}
        </button>
      </form>
    </main>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  return <ErrorBoundary>{children}</ErrorBoundary>;
}

function AuthenticatedApp({ onSignedOut }: { onSignedOut: () => void }) {
  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    queryClient.clear();
    onSignedOut();
  }

  return (
    <AppLayout>
      <div className="fixed right-4 top-4 z-50">
        <button
          type="button"
          className="rounded-md border bg-background px-3 py-2 text-sm shadow-sm"
          onClick={() => void signOut()}
        >
          Выйти
        </button>
      </div>
      <RoutedErrorBoundary>
        <Switch>
          <Route path="/" component={DashboardPage} />
          <Route path="/orders" component={OrdersPage} />
          <Route path="/products" component={ProductsPage} />
          <Route path="/settings" component={SettingsPage} />
          <Route component={NotFound} />
        </Switch>
      </RoutedErrorBoundary>
    </AppLayout>
  );
}

function SessionRouter() {
  const [status, setStatus] = useState<'loading' | 'authenticated' | 'signed-out'>('loading');

  useEffect(() => {
    void fetch('/api/auth/session', { credentials: 'include' })
      .then(async (response) => {
        if (!response.ok) throw new Error('session check failed');
        const body = await response.json() as { authenticated?: boolean };
        setStatus(body.authenticated ? 'authenticated' : 'signed-out');
      })
      .catch(() => setStatus('signed-out'));
  }, []);

  if (status === 'loading') {
    return <div className="flex min-h-[100dvh] items-center justify-center bg-slate-100 text-slate-600">Загрузка…</div>;
  }
  if (status === 'signed-out') {
    return (
      <Switch>
        <Route path="/sign-in">
          <SignInPage onSignedIn={() => setStatus('authenticated')} />
        </Route>
        <Route><Redirect to="/sign-in" /></Route>
      </Switch>
    );
  }
  return <AuthenticatedApp onSignedOut={() => setStatus('signed-out')} />;
}

export default function App() {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
  return (
    <WouterRouter base={basePath}>
      <QueryClientProvider client={queryClient}>
        <Switch>
          <Route path="/order" component={PublicOrderPage} />
          <Route path="/order/:token" component={PublicOrderPage} />
          <Route><SessionRouter /></Route>
        </Switch>
        <Toaster />
      </QueryClientProvider>
    </WouterRouter>
  );
}
import { type ReactNode, useEffect, useRef } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ClerkProvider, SignIn, Show, useAuth, useClerk } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
  Redirect,
} from 'wouter';
import { AppLayout } from '@/components/layout';
import DashboardPage from '@/pages/dashboard';
import ProductsPage from '@/pages/products';
import OrdersPage from '@/pages/orders';
import SettingsPage from '@/pages/settings';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: false,
    },
  },
});

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || '/'
    : path;
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: '#2563eb',
    colorForeground: '#0f172a',
    colorMutedForeground: '#64748b',
    colorDanger: '#dc2626',
    colorBackground: '#ffffff',
    colorInput: '#f8fafc',
    colorInputForeground: '#0f172a',
    colorNeutral: '#cbd5e1',
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
    borderRadius: '0.75rem',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'bg-white rounded-2xl w-[440px] max-w-full overflow-hidden shadow-xl',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: 'text-slate-950',
    headerSubtitle: 'text-slate-600',
    socialButtonsBlockButtonText: 'text-slate-900',
    formFieldLabel: 'text-slate-800',
    footerActionLink: 'text-blue-600',
    footerActionText: 'text-slate-600',
    dividerText: 'text-slate-500',
    formButtonPrimary: 'bg-blue-600 hover:bg-blue-700',
    formFieldInput: 'bg-slate-50 text-slate-950 border-slate-300',
  },
};

function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center animate-in fade-in zoom-in duration-500">
      <h2 className="text-3xl font-bold mb-2 tracking-tight text-foreground">404</h2>
      <p className="text-muted-foreground mb-6">Страница, которую вы ищете, не существует.</p>
    </div>
  )
}

function Router() {
  return (
    <Switch>
      <Route path="/sign-in/*?" component={SignInPage} />
      <Route>
        <Show when="signed-in">
          <AuthenticatedApp />
        </Show>
        <Show when="signed-out">
          <Redirect to="/sign-in" />
        </Show>
      </Route>
    </Switch>
  );
}

function SignInPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-slate-100 px-4">
      <SignIn routing="path" path={`${basePath}/sign-in`} />
    </div>
  );
}

function AuthenticatedApp() {
  const { signOut } = useClerk();
  const { sessionClaims } = useAuth();
  const claims = sessionClaims as {
    role?: unknown;
    metadata?: { role?: unknown };
    publicMetadata?: { role?: unknown };
    public_metadata?: { role?: unknown };
  } | null;
  const role =
    claims?.role ??
    claims?.metadata?.role ??
    claims?.publicMetadata?.role ??
    claims?.public_metadata?.role;
  const isOperator = role === 'operator' || role === 'owner';

  if (!isOperator) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-slate-100 px-4">
        <div className="max-w-md rounded-2xl bg-white p-8 text-center shadow-xl">
          <h1 className="text-2xl font-semibold text-slate-950">Доступ не назначен</h1>
          <p className="mt-3 text-slate-600">
            Эта учётная запись не имеет роли оператора.
          </p>
          <button
            type="button"
            className="mt-6 rounded-md bg-blue-600 px-4 py-2 text-sm text-white"
            onClick={() => signOut({ redirectUrl: `${basePath}/sign-in` })}
          >
            Выйти
          </button>
        </div>
      </div>
    );
  }
  return (
    <AppLayout>
      <div className="fixed right-4 top-4 z-50">
        <button
          type="button"
          className="rounded-md border bg-background px-3 py-2 text-sm shadow-sm"
          onClick={() => signOut({ redirectUrl: `${basePath}/sign-in` })}
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

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const client = useQueryClient();
  const previousUserId = useRef<string | null | undefined>(undefined);
  useEffect(() => addListener(({ user }) => {
    const userId = user?.id ?? null;
    if (previousUserId.current !== undefined && previousUserId.current !== userId) {
      client.clear();
    }
    previousUserId.current = userId;
  }), [addListener, client]);
  return null;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();
  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      localization={{
        signIn: { start: { title: 'Вход оператора', subtitle: 'Войдите для управления товарами и заказами' } },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <Router />
        <Toaster />
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
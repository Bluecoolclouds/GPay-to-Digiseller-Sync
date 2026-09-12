import { Link, useLocation } from "wouter"
import { cn } from "@/lib/utils"
import { LayoutDashboard, Package, Settings, ShoppingCart } from "lucide-react"
import {
  getGetExchangeRateQueryKey,
  getHealthCheckQueryKey,
  useGetExchangeRate,
  useHealthCheck,
} from "@workspace/api-client-react"

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation()
  const { data: health } = useHealthCheck({ query: { queryKey: getHealthCheckQueryKey(), refetchInterval: 60000 } })
  const { data: exchangeRate } = useGetExchangeRate({
    query: {
      queryKey: getGetExchangeRateQueryKey(),
      refetchInterval: 60 * 60 * 1000,
    },
  })
  
  const navItems = [
    { href: "/", label: "Дашборд", icon: LayoutDashboard },
    { href: "/orders", label: "Заказы", icon: ShoppingCart },
    { href: "/products", label: "Товары", icon: Package },
    { href: "/settings", label: "Настройки", icon: Settings },
  ]
  
  return (
    <div className="flex min-h-[100dvh] flex-col lg:flex-row bg-background">
      <aside className="w-full lg:w-64 border-r bg-card shrink-0 flex flex-col">
        <div className="p-6">
          <div className="flex items-center gap-3 font-bold text-lg text-primary tracking-tight">
            <div className="w-7 h-7 rounded bg-primary text-primary-foreground flex items-center justify-center shadow-sm">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>
            </div>
            Sync Console
          </div>
        </div>
        <nav className="flex-1 px-4 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon
            const active = location === item.href
            return (
              <Link key={item.href} href={item.href} className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}>
                <Icon className="w-4 h-4" />
                {item.label}
              </Link>
            )
          })}
        </nav>
        <div className="p-4 mt-auto border-t space-y-4">
          <div className="rounded-md border bg-muted/40 px-3 py-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Курс доллара
            </div>
            <div className="mt-1 font-mono text-xl font-semibold text-foreground">
              {exchangeRate ? `${exchangeRate.purchaseRate.toFixed(2)} ₽` : "—"}
            </div>
            <div className="mt-1 text-[10px] text-muted-foreground">
              {exchangeRate
                ? `ЦБ ${exchangeRate.usdRub.toFixed(2)} ₽ + ${exchangeRate.conversionMarkupPercent}%`
                : "Получаем курс…"}
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground px-2 font-medium">
            <div className={cn("w-2 h-2 rounded-full", health?.status === "ok" ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" : "bg-destructive")}></div>
            Система {health?.status === "ok" ? "онлайн" : "офлайн"}
          </div>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto p-6 lg:p-10">
        <div className="max-w-6xl mx-auto">
          {children}
        </div>
      </main>
    </div>
  )
}
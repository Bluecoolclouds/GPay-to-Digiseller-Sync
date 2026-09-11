import { useState } from "react"
import { useGetDashboard, useListActivities, useSyncCatalog, ActivityStatus, DashboardAutomationMode, CatalogSyncInputProductKind } from "@workspace/api-client-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { RefreshCw, PackageOpen, Layers, DollarSign, Activity as ActivityIcon, AlertCircle, CheckCircle2 } from "lucide-react"
import { toast } from "sonner"
import { format } from "date-fns"

export default function DashboardPage() {
  const [productKind, setProductKind] = useState<CatalogSyncInputProductKind>(CatalogSyncInputProductKind.all)
  const { data: dashboard, isLoading: dashboardLoading, refetch: refetchDashboard } = useGetDashboard()
  const { data: activities, isLoading: activitiesLoading, refetch: refetchActivities } = useListActivities({ limit: 10 })
  const syncMutation = useSyncCatalog()

  const handleSync = () => {
    syncMutation.mutate({ data: { pageSize: 100, productKind } }, {
      onSuccess: (res) => {
        toast.success(`${res.message}. Добавлено ${res.imported}, обновлено ${res.updated}.`)
        refetchDashboard()
        refetchActivities()
      },
      onError: () => toast.error("Ошибка синхронизации")
    })
  }

  if (dashboardLoading || !dashboard) {
    return <div className="h-[50vh] flex items-center justify-center"><RefreshCw className="animate-spin text-muted-foreground w-6 h-6" /></div>
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Дашборд</h1>
          <p className="text-muted-foreground mt-1">Обзор синхронизации вашего каталога.</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            aria-label="Тип товаров для синхронизации"
            className="h-9 rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm focus:ring-1 focus:ring-ring focus:outline-none"
            value={productKind}
            onChange={(event) => setProductKind(event.target.value as CatalogSyncInputProductKind)}
            disabled={syncMutation.isPending}
          >
            <option value="all">Все товары</option>
            <option value="key">Только ключи</option>
            <option value="gift">Только гифты</option>
          </select>
          <Button onClick={handleSync} disabled={syncMutation.isPending} className="gap-2 shrink-0">
            <RefreshCw className={cn("w-4 h-4", syncMutation.isPending && "animate-spin")} />
            Синхронизировать
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Всего товаров" value={dashboard.totalProducts.toLocaleString()} icon={Layers} />
        <StatCard title="Доступно для синхр." value={dashboard.availableProducts.toLocaleString()} icon={PackageOpen} />
        <StatCard title="Опубликовано" value={dashboard.publishedProducts.toLocaleString()} icon={CheckCircle2} />
        <StatCard 
          title="Потенциальная выручка" 
          value={`~${dashboard.potentialRevenue.toLocaleString()} ₽`}
          subtitle={`Ср. маржа: ${dashboard.averageMargin.toFixed(1)}%`}
          icon={DollarSign} 
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between pb-2 border-b">
            <CardTitle className="text-lg font-semibold flex items-center gap-2">
              <ActivityIcon className="w-5 h-5 text-primary" />
              Статус системы
            </CardTitle>
            <Badge variant={dashboard.automationMode === DashboardAutomationMode.automatic ? "success" : "secondary"}>
              {dashboard.automationMode === DashboardAutomationMode.automatic ? "Автоматический" : "Ручной"} режим
            </Badge>
          </CardHeader>
          <CardContent className="pt-6">
             <div className="space-y-4">
               <div className="flex justify-between items-center py-3 border-b last:border-0">
                 <span className="text-sm font-medium">Последняя синхронизация</span>
                 <span className="text-sm text-muted-foreground font-mono">
                   {dashboard.lastSyncAt ? format(new Date(dashboard.lastSyncAt), 'MMM d, yyyy HH:mm:ss') : 'Никогда'}
                 </span>
               </div>
               <div className="flex justify-between items-center py-3 border-b last:border-0">
                 <span className="text-sm font-medium">Статус публикации</span>
                 <div className="flex items-center gap-3">
                   <div className="w-32 h-2 bg-muted rounded-full overflow-hidden">
                     <div 
                       className="h-full bg-primary" 
                       style={{ width: `${dashboard.totalProducts > 0 ? (dashboard.publishedProducts / dashboard.totalProducts) * 100 : 0}%` }}
                     />
                   </div>
                   <span className="text-sm text-muted-foreground w-12 text-right">
                     {dashboard.totalProducts > 0 ? ((dashboard.publishedProducts / dashboard.totalProducts) * 100).toFixed(1) : 0}%
                   </span>
                 </div>
               </div>
             </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="border-b pb-4">
            <CardTitle className="text-lg">Последняя активность</CardTitle>
          </CardHeader>
          <CardContent className="pt-4 p-0">
             <div className="flex flex-col">
               {activitiesLoading ? (
                 <div className="p-6 text-center text-sm text-muted-foreground">Загрузка...</div>
               ) : !activities?.length ? (
                 <div className="p-6 text-center text-sm text-muted-foreground">Нет недавней активности</div>
               ) : (
                 activities.map(activity => (
                   <div key={activity.id} className="flex gap-4 p-4 border-b last:border-0 hover:bg-muted/30 transition-colors">
                     <div className="mt-0.5">
                       {activity.status === ActivityStatus.success && <CheckCircle2 className="w-4 h-4 text-emerald-500" />}
                       {activity.status === ActivityStatus.warning && <AlertCircle className="w-4 h-4 text-amber-500" />}
                       {activity.status === ActivityStatus.error && <AlertCircle className="w-4 h-4 text-destructive" />}
                     </div>
                     <div className="flex-1 space-y-1">
                       <p className="text-sm font-medium leading-none">{activity.title}</p>
                       <p className="text-xs text-muted-foreground line-clamp-2">{activity.description}</p>
                       <p className="text-[10px] text-muted-foreground/60 font-mono mt-2">
                         {format(new Date(activity.createdAt), 'MMM d, HH:mm')}
                       </p>
                     </div>
                   </div>
                 ))
               )}
             </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function StatCard({ title, value, subtitle, icon: Icon }: { title: string, value: string | number, subtitle?: string, icon: any }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className="w-4 h-4 text-muted-foreground/50" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {subtitle && <p className="text-xs text-muted-foreground mt-1 font-mono">{subtitle}</p>}
      </CardContent>
    </Card>
  )
}

function cn(...classes: (string | boolean | undefined | null)[]) {
  return classes.filter(Boolean).join(' ')
}
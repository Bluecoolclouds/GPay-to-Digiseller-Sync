import { useEffect } from "react"
import { useForm } from "react-hook-form"
import { useGetSettings, useUpdateSettings, useGetConnections, useTestConnections, SettingsInput } from "@workspace/api-client-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"
import { ShieldCheck, Zap, ServerCrash, RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"

export default function SettingsPage() {
  const { data: settings, isLoading: settingsLoading } = useGetSettings()
  const { data: connections, isLoading: connectionsLoading, refetch: refetchConnections } = useGetConnections()
  const updateMutation = useUpdateSettings()
  const testConnectionsMutation = useTestConnections()

  const { register, handleSubmit, reset, watch, setValue } = useForm<SettingsInput>()

  useEffect(() => {
    if (settings) {
      reset({
        defaultMarginPercent: settings.defaultMarginPercent,
        usdRubRate: settings.usdRubRate,
        exchangeRateMode: settings.exchangeRateMode,
        conversionMarkupPercent: settings.conversionMarkupPercent,
        digisellerFeePercent: settings.digisellerFeePercent,
        fixedReserveRub: settings.fixedReserveRub,
        minimumProfitRub: settings.minimumProfitRub,
        automationMode: settings.automationMode as any,
        disableOnUnavailable: settings.disableOnUnavailable
      })
    }
  }, [settings, reset])

  const onSubmit = (data: SettingsInput) => {
    updateMutation.mutate({ data }, {
      onSuccess: () => {
        toast.success("Настройки успешно сохранены")
      },
      onError: () => toast.error("Не удалось сохранить настройки")
    })
  }

  const exchangeRateMode = watch("exchangeRateMode")

  const handleTestConnections = () => {
    testConnectionsMutation.mutate(undefined, {
      onSuccess: () => {
        toast.success("Подключения проверены")
        refetchConnections()
      },
      onError: () => toast.error("Ошибка проверки подключений")
    })
  }

  if (settingsLoading) {
    return <div className="h-[50vh] flex items-center justify-center"><RefreshCw className="animate-spin text-muted-foreground w-6 h-6" /></div>
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-5xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Настройки</h1>
        <p className="text-muted-foreground mt-1">Настройка правил ценообразования и поведения системы.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-6">
          <form id="settings-form" onSubmit={handleSubmit(onSubmit)}>
            <Card>
              <CardHeader>
                <CardTitle>Правила ценообразования</CardTitle>
                <CardDescription>Глобальные настройки для новых товаров</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Маржа по умолчанию (%)</label>
                    <Input type="number" {...register("defaultMarginPercent", { valueAsNumber: true })} />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Источник курса</label>
                    <select
                      className="h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm focus:ring-1 focus:ring-ring focus:outline-none"
                      {...register("exchangeRateMode")}
                    >
                      <option value="cbr">Автоматически — ЦБ РФ</option>
                      <option value="manual">Ввести вручную</option>
                    </select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">
                      {exchangeRateMode === "manual" ? "Ручной курс USD → RUB" : "Курс ЦБ USD → RUB"}
                    </label>
                    <Input
                      type="number"
                      step="0.01"
                      readOnly={exchangeRateMode !== "manual"}
                      {...register("usdRubRate", { valueAsNumber: true })}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Запас на конвертацию (%)</label>
                    <Input type="number" step="0.1" {...register("conversionMarkupPercent", { valueAsNumber: true })} />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Комиссия Digiseller (%)</label>
                    <Input type="number" step="0.1" {...register("digisellerFeePercent", { valueAsNumber: true })} />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Фиксированный резерв (RUB)</label>
                    <Input type="number" {...register("fixedReserveRub", { valueAsNumber: true })} />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Минимальная прибыль (RUB)</label>
                    <Input type="number" {...register("minimumProfitRub", { valueAsNumber: true })} />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="mt-6">
              <CardHeader>
                <CardTitle>Автоматизация и безопасность</CardTitle>
                <CardDescription>Управление автоматическим поведением системы</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <label className="text-sm font-medium text-foreground">Режим автоматизации</label>
                    <p className="text-xs text-muted-foreground max-w-xs">Автоматический режим будет постоянно синхронизировать изменения каталога и цен.</p>
                  </div>
                  <select 
                    className="h-9 rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm focus:ring-1 focus:ring-ring focus:outline-none"
                    {...register("automationMode")}
                  >
                    <option value="manual">Ручной</option>
                    <option value="automatic">Автоматический</option>
                  </select>
                </div>
                
                <div className="flex items-center justify-between pt-2 border-t">
                  <div className="space-y-0.5">
                    <label className="text-sm font-medium text-foreground">Безопасность: Отключать при недоступности</label>
                    <p className="text-xs text-muted-foreground max-w-xs">Автоматически приостанавливать товар в Digiseller, если у поставщика закончился товар.</p>
                  </div>
                  <Switch 
                    checked={watch("disableOnUnavailable")} 
                    onCheckedChange={(c) => setValue("disableOnUnavailable", c)}
                  />
                </div>
              </CardContent>
            </Card>
            
            <div className="mt-6 flex justify-end">
              <Button type="submit" disabled={updateMutation.isPending} className="w-full sm:w-auto">
                {updateMutation.isPending ? "Сохранение..." : "Сохранить настройки"}
              </Button>
            </div>
          </form>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-4 border-b">
              <CardTitle className="text-lg flex items-center gap-2">
                <Zap className="w-5 h-5 text-primary" /> Подключения
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6 space-y-4">
               {connectionsLoading || !connections ? (
                 <div className="text-sm text-center text-muted-foreground py-4">Проверка...</div>
               ) : (
                 <>
                   <div className="p-4 border rounded-lg bg-card shadow-sm space-y-3 relative overflow-hidden">
                     <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-primary/50 to-primary/10"></div>
                     <div className="flex items-center justify-between">
                       <span className="font-semibold text-sm">Поставщик GPay</span>
                       {connections.gpay.healthy ? <ShieldCheck className="w-4 h-4 text-emerald-500" /> : <ServerCrash className="w-4 h-4 text-destructive" />}
                     </div>
                     <p className="text-xs text-muted-foreground">{connections.gpay.detail}</p>
                     <Badge variant={connections.gpay.healthy ? "success" : "destructive"}>{connections.gpay.label}</Badge>
                   </div>
                   
                   <div className="p-4 border rounded-lg bg-card shadow-sm space-y-3 relative overflow-hidden">
                     <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-primary/50 to-primary/10"></div>
                     <div className="flex items-center justify-between">
                       <span className="font-semibold text-sm">API Digiseller</span>
                       {connections.digiseller.healthy ? <ShieldCheck className="w-4 h-4 text-emerald-500" /> : <ServerCrash className="w-4 h-4 text-destructive" />}
                     </div>
                     <p className="text-xs text-muted-foreground">{connections.digiseller.detail}</p>
                     <Badge variant={connections.digiseller.healthy ? "success" : "destructive"}>{connections.digiseller.label}</Badge>
                   </div>
                   
                   <Button variant="outline" className="w-full mt-4 gap-2 h-10" onClick={handleTestConnections} disabled={testConnectionsMutation.isPending}>
                     <RefreshCw className={cn("w-4 h-4", testConnectionsMutation.isPending && "animate-spin")} />
                     Проверить подключения
                   </Button>
                 </>
               )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
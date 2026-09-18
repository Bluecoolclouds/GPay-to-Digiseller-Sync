import { useEffect, useState } from "react"
import { useForm } from "react-hook-form"
import { useQueryClient } from "@tanstack/react-query"
import { getGetConnectionsQueryKey, getGetSettingsQueryKey, useGetSettings, useUpdateSettings, useGetConnections, useTestConnections, usePreviewSettings, useTestNotifications, useDisableNotifications, SettingsInput } from "@workspace/api-client-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"
import { AlertTriangle, BellRing, Calculator, ShieldCheck, Zap, ServerCrash, RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"

export default function SettingsPage() {
  const queryClient = useQueryClient()
  const { data: settings, isLoading: settingsLoading } = useGetSettings()
  const { data: connections, isLoading: connectionsLoading } = useGetConnections()
  const updateMutation = useUpdateSettings()
  const previewMutation = usePreviewSettings()
  const testConnectionsMutation = useTestConnections()
  const testNotificationsMutation = useTestNotifications()
  const disableNotificationsMutation = useDisableNotifications()
  const [previewedValues, setPreviewedValues] = useState("")

  const { register, handleSubmit, reset, watch, setValue } = useForm<SettingsInput>({
    defaultValues: {
      exchangeRateMode: "cbr",
      disableOnUnavailable: true,
      digisellerChatCodeEnabled: false,
      digisellerThankYouPromoEnabled: false,
      customerSiteUrl: "",
    },
  })

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
        disableOnUnavailable: settings.disableOnUnavailable,
        digisellerChatCodeEnabled: settings.digisellerChatCodeEnabled,
        digisellerThankYouPromoEnabled: settings.digisellerThankYouPromoEnabled,
        customerSiteUrl: settings.customerSiteUrl ?? "",
      })
    }
  }, [settings, reset])

  const onSubmit = (data: SettingsInput) => {
    const update = {
      ...data,
      customerSiteUrl: data.customerSiteUrl?.trim() || null,
    }
    if (!update.notificationWebhookUrl?.trim()) {
      delete update.notificationWebhookUrl
    }
    if (previewedValues !== JSON.stringify(update)) {
      toast.error("Сначала рассчитайте изменения для текущих настроек")
      return
    }
    if (!previewMutation.data?.previewToken) {
      toast.error("Предпросмотр устарел. Рассчитайте изменения ещё раз")
      return
    }
    updateMutation.mutate({ data: { ...update, previewToken: previewMutation.data.previewToken } }, {
      onSuccess: () => {
        toast.success("Настройки успешно сохранены")
        setPreviewedValues("")
        queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() })
      },
      onError: () => {
        queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() })
        toast.error("Не удалось полностью применить настройки. Проверьте сообщение сервера и повторите предпросмотр.")
      }
    })
  }

  const exchangeRateMode = watch("exchangeRateMode")

  const handlePreview = handleSubmit((data) => {
    const preview = {
      ...data,
      customerSiteUrl: data.customerSiteUrl?.trim() || null,
    }
    if (!preview.notificationWebhookUrl?.trim()) {
      delete preview.notificationWebhookUrl
    }
    previewMutation.mutate(
      { data: preview },
      {
        onSuccess: () => setPreviewedValues(JSON.stringify(preview)),
        onError: () => {
          setPreviewedValues("")
          toast.error("Не удалось рассчитать изменения")
        },
      },
    )
  })

  const handleTestConnections = () => {
    testConnectionsMutation.mutate(undefined, {
      onSuccess: (result) => {
        queryClient.setQueryData(getGetConnectionsQueryKey(), result)
        toast.success("Подключения проверены")
      },
      onError: () => toast.error("Ошибка проверки подключений")
    })
  }

  const handleTestNotifications = () => {
    testNotificationsMutation.mutate(undefined, {
      onSuccess: () => toast.success("Тестовое уведомление отправлено"),
      onError: () => toast.error("Не удалось отправить тестовое уведомление")
    })
  }

  const handleDisableNotifications = () => {
    disableNotificationsMutation.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() })
        toast.success("Канал уведомлений отключён")
      },
      onError: () => toast.error("Не удалось отключить канал")
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
                      <option value="cbr">Автоматически — BestChange (СБП/Сбер → USDT TRC20)</option>
                      <option value="manual">Ввести вручную</option>
                    </select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">
                      {exchangeRateMode === "manual" ? "Ручной курс USD → RUB" : "Курс покупки USDT за RUB"}
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

            {previewMutation.data && previewedValues && (
              <Card className={cn(
                "mt-6",
                previewMutation.data.automaticUpdateAllowed
                  ? "border-emerald-500/30"
                  : "border-amber-500/50",
              )}>
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    {previewMutation.data.automaticUpdateAllowed
                      ? <Calculator className="w-5 h-5 text-emerald-600" />
                      : <AlertTriangle className="w-5 h-5 text-amber-600" />}
                    Предпросмотр изменений
                  </CardTitle>
                  <CardDescription>
                    Курс {previewMutation.data.usdRubRate.toFixed(2)} ₽ · {previewMutation.data.rateSource}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="rounded-md bg-muted/50 p-3">
                      <div className="text-muted-foreground text-xs">Изменится товаров</div>
                      <div className="text-xl font-semibold">{previewMutation.data.affectedProducts}</div>
                    </div>
                    <div className="rounded-md bg-muted/50 p-3">
                      <div className="text-muted-foreground text-xs">Опубликованных цен</div>
                      <div className="text-xl font-semibold">{previewMutation.data.publishedPriceChanges}</div>
                    </div>
                    <div className="rounded-md bg-muted/50 p-3">
                      <div className="text-muted-foreground text-xs">Мин. чистая прибыль</div>
                      <div className="text-xl font-semibold">
                        {previewMutation.data.minimumExpectedProfitRub === null
                          ? "—"
                          : `${previewMutation.data.minimumExpectedProfitRub.toFixed(2)} ₽`}
                      </div>
                    </div>
                  </div>
                  {!previewMutation.data.automaticUpdateAllowed && (
                    <p className="flex items-start gap-2 text-amber-700 dark:text-amber-300">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      Актуальный курс недоступен. Автоматическое обновление цен будет остановлено до восстановления источника.
                    </p>
                  )}
                </CardContent>
              </Card>
            )}

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

            <Card className="mt-6">
              <CardHeader>
                <CardTitle>Чат Digiseller</CardTitle>
                <CardDescription>
                  Для API-ключа Digiseller нужны права переписки с покупателями:
                  просмотр и отправка сообщений.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <label className="text-sm font-medium">Принимать 16-значные коды в чате</label>
                    <p className="max-w-md text-xs text-muted-foreground">
                      Проверяет код заказа и отправляет покупателю ссылку на страницу получения.
                    </p>
                  </div>
                  <Switch checked={watch("digisellerChatCodeEnabled")} onCheckedChange={(value) => setValue("digisellerChatCodeEnabled", value)} />
                </div>
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <label className="text-sm font-medium">Отправлять промокод после выдачи ключа</label>
                    <p className="max-w-md text-xs text-muted-foreground">
                      Одноразовый код на 5% действует 30 дней. Скидку оператор применяет вручную.
                    </p>
                  </div>
                  <Switch checked={watch("digisellerThankYouPromoEnabled")} onCheckedChange={(value) => setValue("digisellerThankYouPromoEnabled", value)} />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">URL клиентского сайта</label>
                  <Input type="url" placeholder="https://example.com/app" {...register("customerSiteUrl")} />
                  <p className="text-xs text-muted-foreground">
                    Укажите HTTPS-адрес вместе с базовым путём приложения, без завершающего слеша.
                  </p>
                </div>
              </CardContent>
            </Card>

            <Card className="mt-6">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <BellRing className="w-5 h-5 text-primary" />
                  Оперативные уведомления
                </CardTitle>
                <CardDescription>
                  HTTPS webhook для критических ошибок и сообщений о восстановлении
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">URL webhook</label>
                  <Input
                    type="url"
                    autoComplete="off"
                    placeholder={settings?.notificationConfigured ? "Канал настроен — введите URL только для замены" : "https://…"}
                    {...register("notificationWebhookUrl")}
                  />
                  <p className="text-xs text-muted-foreground">
                    URL хранится зашифрованно и не отображается после сохранения.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <Badge variant={settings?.notificationConfigured ? "success" : "secondary"}>
                    {settings?.notificationConfigured ? "Канал настроен" : "Канал не настроен"}
                  </Badge>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleTestNotifications}
                    disabled={!settings?.notificationConfigured || testNotificationsMutation.isPending}
                  >
                    <RefreshCw className={cn("w-4 h-4 mr-2", testNotificationsMutation.isPending && "animate-spin")} />
                    Проверить канал
                  </Button>
                  {settings?.notificationConfigured && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={handleDisableNotifications}
                      disabled={disableNotificationsMutation.isPending}
                    >
                      Отключить
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
            
            <div className="mt-6 flex flex-col-reverse sm:flex-row justify-end gap-3">
              <Button type="button" variant="outline" onClick={handlePreview} disabled={previewMutation.isPending} className="w-full sm:w-auto">
                {previewMutation.isPending ? "Расчёт..." : "Рассчитать изменения"}
              </Button>
              <Button type="submit" disabled={updateMutation.isPending || !previewedValues} className="w-full sm:w-auto">
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
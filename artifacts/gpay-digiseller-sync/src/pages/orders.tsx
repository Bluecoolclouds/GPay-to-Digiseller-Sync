import { useState, useRef, useEffect, useCallback } from "react"
import { 
  useListOrders, 
  useUpdateOrder, 
  useSyncOrders,
  Order,
  ListOrdersStatus,
  OrderStatus,
  OrderUpdateStatus,
  getListOrdersQueryKey,
} from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"
import { Search, Filter, RefreshCw, Clock, CheckCircle2, Clock4, Box, AlertTriangle } from "lucide-react"
import { cn } from "@/lib/utils"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"

function getMutationErrorMessage(error: unknown, fallback: string) {
  if (typeof error === "object" && error !== null && "data" in error) {
    const data = (error as { data?: unknown }).data
    if (typeof data === "object" && data !== null && "error" in data && typeof data.error === "string") {
      return `${fallback}: ${data.error}`
    }
  }
  if (error instanceof Error && error.message.trim()) {
    return `${fallback}: ${error.message}`
  }
  return fallback
}

export default function OrdersPage() {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("")
  const [status, setStatus] = useState<ListOrdersStatus>("all")
  const [page, setPage] = useState(1)

  const syncMutation = useSyncOrders()

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search)
      setPage(1)
    }, 300)
    return () => clearTimeout(t)
  }, [search])

  const { data, isLoading, isError, error, isFetching } = useListOrders(
    {
      page,
      pageSize: 20,
      search: debouncedSearch || undefined,
      status: status !== "all" ? status : undefined,
    },
    {
      query: {
        queryKey: getListOrdersQueryKey({
          page,
          pageSize: 20,
          search: debouncedSearch || undefined,
          status: status !== "all" ? status : undefined,
        }),
        refetchInterval: 30000,
      }
    }
  )

  const handleSync = () => {
    syncMutation.mutate(undefined, {
      onSuccess: (res) => {
        queryClient.invalidateQueries({ queryKey: getListOrdersQueryKey() })
        if (res.skipped) {
          toast.info("Синхронизация уже выполняется. Дождитесь её завершения.")
        } else if (res.stage === "backfill") {
          toast.success(`Исторический импорт завершён: импортировано ${res.inserted}, обновлено ${res.updated}.`)
        } else if (res.fetched === 0) {
          toast.success("Синхронизация завершена. Новых заказов нет.")
        } else {
          toast.success(`Синхронизация завершена: импортировано ${res.inserted}, обновлено ${res.updated}.`)
        }
      },
      onError: (err) => {
        toast.error(getMutationErrorMessage(err, "Ошибка при синхронизации заказов"))
      }
    })
  }

  const syncStatus = data?.sync
  const lastSuccessfulSync = syncStatus?.lastSuccessfulAt
    ? new Date(syncStatus.lastSuccessfulAt).toLocaleString("ru-RU", {
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      })
    : "ещё не завершалась"
  const hasSyncWarning = Boolean(
    syncStatus && (syncStatus.isStale || syncStatus.consecutiveFailures > 0),
  )

  const updateOrderInCache = useCallback((updatedOrder: Order) => {
    const queryKey = getListOrdersQueryKey({
      page,
      pageSize: 20,
      search: debouncedSearch || undefined,
      status: status !== "all" ? status : undefined,
    })
    queryClient.setQueryData(queryKey, (old: any) => {
      if (!old) return old
      return {
        ...old,
        items: old.items.map((i: Order) => i.id === updatedOrder.id ? updatedOrder : i)
      }
    })
  }, [page, debouncedSearch, status, queryClient])

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Заказы</h1>
          <p className="text-muted-foreground mt-1">Оплаченные товары и статус выполнения.</p>
        </div>
        <Button
          onClick={handleSync}
          disabled={syncMutation.isPending}
          variant="outline"
          className="gap-2 bg-card"
        >
          <RefreshCw className={cn("h-4 w-4", syncMutation.isPending && "animate-spin")} />
          {syncMutation.isPending
            ? syncStatus?.isBackfill ? "Исторический импорт..." : "Синхронизация..."
            : "Синхронизировать"}
        </Button>
      </div>

      <div
        className={cn(
          "rounded-lg border px-4 py-3 text-sm",
          hasSyncWarning
            ? "border-amber-500/50 bg-amber-500/10 text-amber-950 dark:text-amber-100"
            : "border-border/60 bg-card text-muted-foreground",
        )}
      >
        <div className="flex items-start gap-2">
          {hasSyncWarning ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />}
          <div>
            <div className="font-medium text-foreground">
              Последняя полная синхронизация: {lastSuccessfulSync}
            </div>
            {syncStatus?.isBackfill && (
              <p className="mt-1">Исторический импорт ещё не завершён. Список заказов может быть неполным.</p>
            )}
            {!syncStatus?.isBackfill && syncStatus?.isStale && (
              <p className="mt-1">Данные устарели: успешной синхронизации не было более 15 минут.</p>
            )}
            {syncStatus && syncStatus.consecutiveFailures > 0 && (
              <p className="mt-1">
                Ошибок подряд: {syncStatus.consecutiveFailures}.
                {syncStatus.lastError ? ` Последняя ошибка: ${syncStatus.lastError}` : ""}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-4 justify-between">
        <div className="flex items-center gap-2 w-full sm:w-96">
          <div className="relative w-full">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input 
              type="search"
              placeholder="Поиск по инвойсу или названию..." 
              className="pl-9 bg-card"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-muted-foreground shrink-0" />
          <select 
            className="h-9 rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as ListOrdersStatus)
              setPage(1)
            }}
          >
            <option value="all">Все статусы</option>
            <option value="new">Новые</option>
            <option value="processing">В обработке</option>
            <option value="delivered">Выполнены</option>
          </select>
        </div>
      </div>

      <Card className="overflow-hidden shadow-sm border-border/60">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-muted-foreground uppercase bg-muted/40 border-b">
              <tr>
                <th className="px-4 py-3 font-medium w-48">Инвойс / Дата</th>
                <th className="px-4 py-3 font-medium">Товар</th>
                <th className="px-4 py-3 font-medium w-32">Оплата</th>
                <th className="px-4 py-3 font-medium w-48">Статус</th>
                <th className="px-4 py-3 font-medium">Примечание</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {isLoading ? (
                <tr><td colSpan={5} className="px-4 py-12 text-center text-muted-foreground"><div className="flex flex-col items-center"><RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 opacity-50" /> Загрузка заказов...</div></td></tr>
              ) : isError ? (
                 <tr><td colSpan={5} className="px-4 py-8 text-center text-destructive">Ошибка загрузки: {getMutationErrorMessage(error, "Неизвестная ошибка")}</td></tr>
              ) : !data?.items?.length ? (
                <tr><td colSpan={5} className="px-4 py-12 text-center text-muted-foreground">
                  <div className="flex flex-col items-center justify-center">
                    <Box className="w-12 h-12 text-muted-foreground/30 mb-3" />
                    Заказы не найдены.
                  </div>
                </td></tr>
              ) : (
                data.items.map(order => (
                  <OrderRow 
                    key={order.id} 
                    order={order} 
                    onUpdate={updateOrderInCache}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
        {data && data.total > 20 && (
          <div className="px-4 py-3 border-t bg-muted/20 flex items-center justify-between">
             <div className="text-xs text-muted-foreground">
               Показано от {((page-1)*20)+1} до {Math.min(page*20, data.total)} из {data.total}
             </div>
             <div className="flex gap-2">
               <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>Назад</Button>
               <Button variant="outline" size="sm" onClick={() => setPage(p => p + 1)} disabled={page * 20 >= data.total}>Вперед</Button>
             </div>
          </div>
        )}
      </Card>
    </div>
  )
}

function OrderRow({
  order,
  onUpdate,
}: {
  order: Order
  onUpdate: (o: Order) => void
}) {
  const [note, setNote] = useState(order.operatorNote || "")
  const [isNoteFocused, setIsNoteFocused] = useState(false)
  const updateMutation = useUpdateOrder()

  const lastSavedNote = useRef(order.operatorNote || "")
  const initializedForId = useRef<number | null>(null)
  
  const mutateFnRef = useRef(updateMutation.mutate)
  mutateFnRef.current = updateMutation.mutate
  const onUpdateRef = useRef(onUpdate)
  onUpdateRef.current = onUpdate

  // Init state from server only once per order ID
  useEffect(() => {
    if (order && initializedForId.current !== order.id) {
      initializedForId.current = order.id
      setNote(order.operatorNote || "")
      lastSavedNote.current = order.operatorNote || ""
    }
  }, [order])

  // Sync internal state if server data changes (e.g. via global sync) while not focused
  useEffect(() => {
    if (!isNoteFocused && order.operatorNote !== lastSavedNote.current) {
      const newNote = order.operatorNote || ""
      setNote(newNote)
      lastSavedNote.current = newNote
    }
  }, [order.operatorNote, isNoteFocused])

  // Auto-save note
  useEffect(() => {
    const t = setTimeout(() => {
      if (initializedForId.current !== order.id) return
      if (note !== lastSavedNote.current) {
        mutateFnRef.current(
          { invoiceId: order.invoiceId, data: { note: note || null } }, 
          {
            onSuccess: (res) => {
              onUpdateRef.current(res)
              lastSavedNote.current = note
            }
          }
        )
      }
    }, 1000)
    return () => clearTimeout(t)
  }, [note, order.id, order.invoiceId])

  const handleStatusChange = (newStatus: OrderUpdateStatus) => {
    if (newStatus === order.status) return
    const requiresReturnConfirmation = order.isReturned && newStatus !== "new"
    if (
      requiresReturnConfirmation &&
      !window.confirm(
        "Платёж по этому заказу возвращён. Подтвердите, что ключ всё равно нужно выдать.",
      )
    ) {
      return
    }
    updateMutation.mutate(
      {
        invoiceId: order.invoiceId,
        data: {
          status: newStatus,
          ...(requiresReturnConfirmation ? { confirmReturned: true } : {}),
        },
      },
      {
        onSuccess: (res) => {
          onUpdateRef.current(res)
          toast.success(`Статус заказа ${order.invoiceId} обновлен`)
        },
        onError: (err) => {
          toast.error(getMutationErrorMessage(err, "Не удалось обновить статус"))
        }
      }
    )
  }

  const getStatusBadge = (status: OrderStatus) => {
    switch (status) {
      case "new":
        return <Badge variant="destructive" className="bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20"><Clock className="w-3 h-3 mr-1" /> Новый</Badge>
      case "processing":
        return <Badge variant="secondary" className="bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20"><Clock4 className="w-3 h-3 mr-1" /> В обработке</Badge>
      case "delivered":
        return <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"><CheckCircle2 className="w-3 h-3 mr-1" /> Выполнен</Badge>
    }
  }

  const saleDate = new Date(order.saleTimestamp).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  })

  return (
    <tr className={cn("hover:bg-muted/30 transition-colors group", order.status === "new" && "bg-rose-50/30 dark:bg-rose-950/10")}>
      <td className="px-4 py-3 align-top">
        <div className="flex flex-wrap items-center gap-2">
          <div className="font-mono text-sm font-medium text-foreground">{order.invoiceId}</div>
          {order.isReturned && (
            <Badge variant="destructive" className="bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30">
              <AlertTriangle className="w-3 h-3 mr-1" /> Возврат
            </Badge>
          )}
        </div>
        <div className="text-[11px] text-muted-foreground mt-1 flex items-center gap-1">
          {saleDate}
        </div>
      </td>
      <td className="px-4 py-3 align-top">
        <div className="font-medium text-foreground text-sm line-clamp-2 leading-tight" title={order.productName}>
          {order.productName}
        </div>
        <div className="text-xs text-muted-foreground mt-1.5 flex gap-2 font-mono">
          <span>DS ID: {order.digisellerProductId}</span>
        </div>
      </td>
      <td className="px-4 py-3 align-top font-mono text-sm whitespace-nowrap">
        {order.paidAmountRub !== null ? (
          <span className="font-medium">{order.paidAmountRub.toLocaleString()} ₽</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-4 py-3 align-top">
        <Select value={order.status} onValueChange={(v) => handleStatusChange(v as OrderUpdateStatus)}>
          <SelectTrigger className="h-8 w-full border-none shadow-none bg-transparent hover:bg-muted/50 p-0 focus:ring-0 [&>svg]:hidden flex justify-start items-center cursor-pointer">
            {getStatusBadge(order.status)}
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="new">Новый</SelectItem>
            <SelectItem value="processing">В обработке</SelectItem>
            <SelectItem value="delivered">Выполнен</SelectItem>
          </SelectContent>
        </Select>
      </td>
      <td className="px-4 py-3 align-top min-w-[200px]">
        <div className="relative">
          <Textarea 
            className="min-h-[40px] h-10 py-2 px-3 text-xs resize-none bg-transparent border-transparent hover:border-input focus:border-input focus:bg-background transition-all"
            placeholder="Добавить примечание..."
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onFocus={() => setIsNoteFocused(true)}
            onBlur={() => setIsNoteFocused(false)}
          />
          {updateMutation.isPending && (
            <div className="absolute right-2 top-2.5 opacity-50">
              <RefreshCw className="w-3 h-3 animate-spin text-muted-foreground" />
            </div>
          )}
        </div>
      </td>
    </tr>
  )
}
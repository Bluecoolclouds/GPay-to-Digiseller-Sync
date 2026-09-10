import { useState, useRef, useEffect } from "react"
import { useListProducts, useUpdateProduct, usePublishProduct, Product, ListProductsStatus, ProductPublicationStatus } from "@workspace/api-client-react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"
import { Search, Filter, Play, Check, AlertTriangle, ArrowRight } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { getListProductsQueryKey } from "@workspace/api-client-react"
import { cn } from "@/lib/utils"

export default function ProductsPage() {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState<ListProductsStatus>("all")
  const [page, setPage] = useState(1)
  
  const [debouncedSearch, setDebouncedSearch] = useState("")
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search)
      setPage(1)
    }, 300)
    return () => clearTimeout(t)
  }, [search])

  const { data, isLoading } = useListProducts({
    page,
    pageSize: 20,
    search: debouncedSearch || undefined,
    status: status !== "all" ? status : undefined
  })

  const updateProductInCache = (updatedProduct: Product) => {
    queryClient.setQueryData(getListProductsQueryKey({ page, pageSize: 20, search: debouncedSearch || undefined, status: status !== "all" ? status : undefined }), (old: any) => {
      if (!old) return old;
      return {
        ...old,
        items: old.items.map((i: Product) => i.id === updatedProduct.id ? updatedProduct : i)
      }
    })
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Товары</h1>
        <p className="text-muted-foreground mt-1">Управление маржой и публикация в Digiseller.</p>
      </div>

      <div className="flex flex-col sm:flex-row gap-4 justify-between">
        <div className="flex items-center gap-2 w-full sm:w-96">
          <div className="relative w-full">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input 
              type="search"
              placeholder="Поиск по названию или ID..." 
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
              setStatus(e.target.value as ListProductsStatus)
              setPage(1)
            }}
          >
            <option value="all">Все статусы</option>
            <option value="draft">Черновики</option>
            <option value="published">Опубликовано</option>
            <option value="available">Доступно в GPay</option>
            <option value="unavailable">Недоступно</option>
          </select>
        </div>
      </div>

      <Card className="overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-muted-foreground uppercase bg-muted/40 border-b">
              <tr>
                <th className="px-4 py-3 font-medium">Товар</th>
                <th className="px-4 py-3 font-medium">Доступность</th>
                <th className="px-4 py-3 font-medium">Цены (USD → RUB)</th>
                <th className="px-4 py-3 font-medium w-32">Маржа %</th>
                <th className="px-4 py-3 font-medium text-right">Статус / Действие</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {isLoading ? (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">Загрузка каталога...</td></tr>
              ) : !data?.items?.length ? (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">Товары не найдены.</td></tr>
              ) : (
                data.items.map(product => (
                  <ProductRow 
                    key={product.id} 
                    product={product} 
                    onUpdate={updateProductInCache}
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

function ProductRow({ product, onUpdate }: { product: Product, onUpdate: (p: Product) => void }) {
  const [margin, setMargin] = useState(product.marginPercent.toString())
  const updateMutation = useUpdateProduct()
  const publishMutation = usePublishProduct()

  const lastSaved = useRef(product.marginPercent.toString())
  const debouncedMargin = useRef(margin)
  const mutateFnRef = useRef(updateMutation.mutate)
  mutateFnRef.current = updateMutation.mutate
  const onUpdateRef = useRef(onUpdate)
  onUpdateRef.current = onUpdate
  
  useEffect(() => {
    const t = setTimeout(() => {
      debouncedMargin.current = margin
      const numMargin = Number(debouncedMargin.current)
      if (debouncedMargin.current !== lastSaved.current && !isNaN(numMargin)) {
        mutateFnRef.current({ id: product.id, data: { marginPercent: numMargin } }, {
          onSuccess: (res) => {
            onUpdateRef.current(res)
            lastSaved.current = debouncedMargin.current
            toast.success("Маржа обновлена")
          }
        })
      }
    }, 800)
    return () => clearTimeout(t)
  }, [margin, product.id])

  // Sync internal state if server data changes (e.g. via global sync)
  useEffect(() => {
    if (lastSaved.current !== product.marginPercent.toString()) {
      setMargin(product.marginPercent.toString())
      lastSaved.current = product.marginPercent.toString()
    }
  }, [product.marginPercent])

  const handlePublish = () => {
    publishMutation.mutate({ id: product.id }, {
      onSuccess: (res) => {
        onUpdateRef.current(res)
        toast.success("Товар опубликован в Digiseller")
      },
      onError: () => toast.error("Не удалось опубликовать товар")
    })
  }

  const isPublished = product.publicationStatus === ProductPublicationStatus.published

  return (
    <tr className="hover:bg-muted/30 transition-colors group">
      <td className="px-4 py-3">
        <div className="font-medium text-foreground max-w-[280px] sm:max-w-sm truncate" title={product.name}>{product.name}</div>
        <div className="text-xs text-muted-foreground mt-0.5 flex gap-2 font-mono">
          <span>GPay: {product.gpayId}</span>
          {product.digisellerId && <span>• DS: {product.digisellerId}</span>}
          {product.region && <span>• {product.region}</span>}
        </div>
      </td>
      <td className="px-4 py-3">
        {product.isAvailable ? (
          <Badge variant="success">Доступен</Badge>
        ) : (
          <Badge variant="destructive">Недоступен</Badge>
        )}
      </td>
      <td className="px-4 py-3 font-mono text-xs">
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground">${product.supplierPriceUsd.toFixed(2)}</span>
          <ArrowRight className="w-3 h-3 text-muted-foreground" />
          <span className="font-medium text-foreground">{product.salePriceRub.toLocaleString()} ₽</span>
        </div>
        {product.profitRub !== undefined && (
          <div className="text-[10px] text-emerald-600 dark:text-emerald-500 mt-1 font-medium">
            +{product.profitRub.toLocaleString()} ₽ прибыль
          </div>
        )}
      </td>
      <td className="px-4 py-3">
        <div className="relative w-24">
          <Input 
            type="number" 
            min="0"
            className={cn("h-8 text-right pr-7 font-mono text-xs", updateMutation.isPending && "opacity-50")}
            value={margin}
            onChange={(e) => setMargin(e.target.value)}
          />
          <span className="absolute right-3 top-2 text-xs text-muted-foreground select-none">%</span>
        </div>
      </td>
      <td className="px-4 py-3 text-right">
        <div className="flex items-center justify-end gap-2">
          {product.warningMessage && (
            <span title={product.warningMessage}>
              <AlertTriangle className="w-4 h-4 text-amber-500" aria-label={product.warningMessage} />
            </span>
          )}
          {isPublished ? (
            <Badge variant="outline" className="gap-1 bg-muted/50 border-primary/20 text-primary h-7 px-2">
              <Check className="w-3 h-3" /> Опубликовано
            </Badge>
          ) : (
             <Button 
               size="sm" 
               className="h-7 text-xs px-3 gap-1.5"
               onClick={handlePublish}
               disabled={publishMutation.isPending || !product.isAvailable}
             >
               <Play className="w-3 h-3" /> Опубликовать
             </Button>
          )}
        </div>
      </td>
    </tr>
  )
}
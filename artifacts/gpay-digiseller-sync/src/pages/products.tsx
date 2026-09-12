import { useState, useRef, useEffect } from "react"
import { useListProducts, useUpdateProduct, usePublishProduct, usePublishProductsBatch, Product, ListProductsStatus, ListProductsProductKind, ProductPublicationStatus, ProductProductKind, BatchPublishResult } from "@workspace/api-client-react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"
import { Search, Filter, Play, Check, AlertTriangle, ArrowRight, Images, Save } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { getListProductsQueryKey } from "@workspace/api-client-react"
import { cn } from "@/lib/utils"

function getMutationErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) {
    return `${fallback}: ${error.message}`
  }
  return fallback
}

export default function ProductsPage() {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState<ListProductsStatus>("all")
  const [productKind, setProductKind] = useState<ListProductsProductKind>("all")
  const [page, setPage] = useState(1)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [batchResult, setBatchResult] = useState<BatchPublishResult | null>(null)
  const batchMutation = usePublishProductsBatch()
  
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
    status: status !== "all" ? status : undefined,
    productKind: productKind !== "all" ? productKind : undefined
  })

  useEffect(() => {
    setSelectedIds(new Set())
    setBatchResult(null)
  }, [page, status, productKind, debouncedSearch])

  const eligibleItems = (data?.items ?? []).filter(
    (product) =>
      product.isAvailable &&
      product.publicationStatus !== ProductPublicationStatus.published &&
      product.productKind !== ProductProductKind.unknown,
  )
  const allEligibleSelected =
    eligibleItems.length > 0 &&
    eligibleItems.every((product) => selectedIds.has(product.id))

  const toggleAllEligible = () => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (allEligibleSelected) {
        eligibleItems.forEach((product) => next.delete(product.id))
      } else {
        eligibleItems.forEach((product) => next.add(product.id))
      }
      return next
    })
  }

  const handleBatchPublish = () => {
    const productIds = Array.from(selectedIds)
    if (
      !window.confirm(
        `Создать или обновить ${productIds.length} карточек в Digiseller? Это изменит внешний каталог. Изображения GPay будут загружены автоматически.`,
      )
    ) return

    batchMutation.mutate(
      { data: { productIds } },
      {
        onSuccess: (result) => {
          setBatchResult(result)
          setSelectedIds(new Set())
          queryClient.invalidateQueries()
          const imageFailures = result.items.filter(
            (item) => item.imageStatus === "failed",
          ).length
          if (result.failed > 0 || imageFailures > 0) {
            toast.warning(
              `Опубликовано ${result.succeeded}, ошибок ${result.failed}, проблем с изображениями ${imageFailures}`,
            )
          } else {
            toast.success(`Опубликовано ${result.succeeded} товаров`)
          }
        },
        onError: (error) =>
          toast.error(
            getMutationErrorMessage(error, "Пакетная публикация не выполнена"),
          ),
      },
    )
  }

  const updateProductInCache = (updatedProduct: Product) => {
    queryClient.setQueryData(getListProductsQueryKey({ page, pageSize: 20, search: debouncedSearch || undefined, status: status !== "all" ? status : undefined, productKind: productKind !== "all" ? productKind : undefined }), (old: any) => {
      if (!old) return old;
      return {
        ...old,
        items: old.items.map((i: Product) => i.id === updatedProduct.id ? updatedProduct : i)
      }
    })
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Товары</h1>
          <p className="text-muted-foreground mt-1">Управление маржой и публикация в Digiseller.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Если GPay не прислал изображение, при публикации будет создана стандартная обложка.
            </p>
        </div>
        <Button
          onClick={handleBatchPublish}
          disabled={selectedIds.size === 0 || batchMutation.isPending}
          className="gap-2"
        >
          <Play className="h-4 w-4" />
          {batchMutation.isPending
            ? "Публикация..."
            : `Опубликовать выбранные (${selectedIds.size})`}
        </Button>
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
            aria-label="Тип товара"
            className="h-9 rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={productKind}
            onChange={(e) => {
              setProductKind(e.target.value as ListProductsProductKind)
              setPage(1)
            }}
          >
            <option value="all">Все типы</option>
            <option value="key">Ключи</option>
            <option value="gift">Гифты</option>
            <option value="unknown">Неизвестные</option>
          </select>
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

      {batchResult && (
        <Card className="border-primary/20 bg-primary/5 p-4">
          <div className="font-medium">
            Пакет завершен: опубликовано {batchResult.succeeded} из {batchResult.requested}
          </div>
          {batchResult.items.some(
            (item) => item.status === "failed" || item.imageStatus === "failed",
          ) && (
            <div className="mt-2 space-y-1 text-sm text-muted-foreground">
              {batchResult.items
                .filter(
                  (item) =>
                    item.status === "failed" || item.imageStatus === "failed",
                )
                .map((item) => (
                  <div key={item.productId}>
                    {item.name}: {item.error || "изображение не загружено"}
                  </div>
                ))}
            </div>
          )}
        </Card>
      )}

      <Card className="overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-muted-foreground uppercase bg-muted/40 border-b">
              <tr>
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    aria-label="Выбрать доступные товары на странице"
                    checked={allEligibleSelected}
                    onChange={toggleAllEligible}
                    disabled={eligibleItems.length === 0}
                    className="h-4 w-4 rounded border-input"
                  />
                </th>
                <th className="px-4 py-3 font-medium">Товар</th>
                <th className="px-4 py-3 font-medium">Доступность</th>
                <th className="px-4 py-3 font-medium">Цены (USD → RUB)</th>
                <th className="px-4 py-3 font-medium w-32">Маржа %</th>
                <th className="px-4 py-3 font-medium text-right">Статус / Действие</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {isLoading ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">Загрузка каталога...</td></tr>
              ) : !data?.items?.length ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">Товары не найдены.</td></tr>
              ) : (
                data.items.map(product => (
                  <ProductRow 
                    key={product.id} 
                    product={product} 
                    onUpdate={updateProductInCache}
                    selected={selectedIds.has(product.id)}
                    onSelectionChange={(selected) =>
                      setSelectedIds((current) => {
                        const next = new Set(current)
                        if (selected) next.add(product.id)
                        else next.delete(product.id)
                        return next
                      })
                    }
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

function ProductRow({
  product,
  onUpdate,
  selected,
  onSelectionChange,
}: {
  product: Product
  onUpdate: (p: Product) => void
  selected: boolean
  onSelectionChange: (selected: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [margin, setMargin] = useState(product.marginPercent.toString())
  const [categoryId, setCategoryId] = useState(product.platiCategoryId?.toString() ?? "")
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

  useEffect(() => {
    setCategoryId(product.platiCategoryId?.toString() ?? "")
  }, [product.platiCategoryId])

  const handleSaveCategory = () => {
    const parsedCategoryId = Number(categoryId)
    if (!Number.isInteger(parsedCategoryId) || parsedCategoryId < 1) {
      toast.error("Введите корректный ID категории Plati")
      return
    }
    updateMutation.mutate(
      { id: product.id, data: { platiCategoryId: parsedCategoryId } },
      {
        onSuccess: (res) => {
          onUpdateRef.current(res)
          toast.success("Категория сохранена. Повторите публикацию для проверки.")
        },
        onError: (error) =>
          toast.error(getMutationErrorMessage(error, "Не удалось сохранить категорию")),
      },
    )
  }

  const handlePublish = () => {
    publishMutation.mutate({ id: product.id }, {
      onSuccess: (res) => {
        onUpdateRef.current(res)
        if (res.imageUrl && !res.digisellerImageUploaded) {
          toast.warning("Товар опубликован, но изображение не загрузилось")
        } else {
          toast.success("Товар опубликован в Digiseller")
        }
      },
      onError: (error) =>
        {
          queryClient.invalidateQueries({ queryKey: getListProductsQueryKey() })
          toast.error(
          getMutationErrorMessage(error, "Не удалось опубликовать товар"),
          )
        }
    })
  }

  const isPublished = product.publicationStatus === ProductPublicationStatus.published
  const canSelect =
    product.isAvailable &&
    !isPublished &&
    product.productKind !== ProductProductKind.unknown

  return (
    <tr className="hover:bg-muted/30 transition-colors group">
      <td className="px-4 py-3">
        <input
          type="checkbox"
          aria-label={`Выбрать ${product.name}`}
          checked={selected}
          onChange={(event) => onSelectionChange(event.target.checked)}
          disabled={!canSelect}
          className="h-4 w-4 rounded border-input"
        />
      </td>
      <td className="px-4 py-3">
        <div className="flex items-start gap-3">
          {product.imageUrl ? (
            <img
              src={product.imageUrl}
              alt=""
              loading="lazy"
              className="h-12 w-12 shrink-0 rounded-md border bg-muted object-cover"
            />
          ) : (
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border bg-muted">
              <Images className="h-5 w-5 text-muted-foreground" />
            </div>
          )}
          <div className="min-w-0">
            <div className="font-medium text-foreground max-w-[280px] sm:max-w-sm truncate" title={product.name}>{product.name}</div>
            <div className="mt-1 flex flex-wrap gap-1">
              <Badge variant={product.productKind === ProductProductKind.unknown ? "destructive" : "secondary"}>
                {product.productKind === ProductProductKind.key
                  ? "Ключ"
                  : product.productKind === ProductProductKind.gift
                    ? "Гифт"
                    : `Неизвестный тип (${product.productType})`}
              </Badge>
              {product.digisellerImageUploaded && (
                <Badge variant="outline">Изображение в DS</Badge>
              )}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5 flex gap-2 font-mono">
              <span>GPay: {product.gpayId}</span>
              {product.digisellerId && <span>• DS: {product.digisellerId}</span>}
              {product.region && <span>• {product.region}</span>}
            </div>
          </div>
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
        <div className="flex flex-col items-end gap-2">
          {product.publicationError && (
            <div
              className="max-w-xs rounded-md border border-destructive/30 bg-destructive/5 p-2 text-left text-xs text-destructive"
              data-testid={`status-publication-error-${product.id}`}
            >
              <div className="font-medium">
                {product.publicationFailureStage === "image"
                  ? "Не удалось загрузить изображение"
                  : product.publicationFailureStage === "stock"
                    ? "Ошибка пополнения Text-остатка"
                  : product.publicationFailureStage === "category"
                    ? "Ошибка категории Digiseller"
                    : "Ошибка Digiseller"}
                {product.digisellerId ? ` · DS ${product.digisellerId}` : ""}
              </div>
              <div className="mt-1 break-words">{product.publicationError}</div>
              {product.publicationFailureStage === "image" && (
                <div className="mt-1 font-medium">Повторите публикацию, чтобы загрузить изображение.</div>
              )}
            </div>
          )}
          {(product.publicationFailureStage === "category" || product.platiCategoryId) && (
            <div className="flex items-center gap-1.5">
              <Input
                type="number"
                min="1"
                placeholder="ID категории Plati"
                aria-label={`ID категории Plati для ${product.name}`}
                data-testid={`input-plati-category-${product.id}`}
                className="h-8 w-40 text-xs"
                value={categoryId}
                onChange={(event) => setCategoryId(event.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 px-2"
                onClick={handleSaveCategory}
                disabled={updateMutation.isPending}
                data-testid={`button-save-plati-category-${product.id}`}
              >
                <Save className="h-3.5 w-3.5" />
                <span className="sr-only">Сохранить категорию</span>
              </Button>
            </div>
          )}
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
               disabled={publishMutation.isPending || !product.isAvailable || product.productKind === ProductProductKind.unknown}
             >
               <Play className="w-3 h-3" /> Опубликовать
             </Button>
          )}
          </div>
        </div>
      </td>
    </tr>
  )
}
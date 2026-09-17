import { useState, useRef, useEffect } from "react"
import { useListProducts, useUpdateProduct, useUpdateProductsMargin, useGetProductsMarginSummary, getGetProductsMarginSummaryQueryKey, usePublishProduct, usePublishProductsBatch, useGetLatestPublishProductsBatch, getGetLatestPublishProductsBatchQueryKey, Product, ListProductsStatus, ListProductsProductKind, ProductPublicationStatus, ProductProductKind } from "@workspace/api-client-react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"
import { Search, Filter, Play, Check, AlertTriangle, ArrowRight, Images, Save } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { getListProductsQueryKey } from "@workspace/api-client-react"
import { cn } from "@/lib/utils"
import { DigisellerImportDialog } from "@/components/digiseller-import-dialog"

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
  const [allFilteredSelected, setAllFilteredSelected] = useState(false)
  const [bulkMargin, setBulkMargin] = useState("15")
  const [importProduct, setImportProduct] = useState<Product | null>(null)
  const batchMutation = usePublishProductsBatch()
  const marginMutation = useUpdateProductsMargin()
  const completedTaskRef = useRef<string | null>(null)
  const { data: batchTask } = useGetLatestPublishProductsBatch({
    query: {
      queryKey: getGetLatestPublishProductsBatchQueryKey(),
      refetchInterval: (query) =>
        query.state.data?.status === "queued" ||
        query.state.data?.status === "running"
          ? 1_000
          : false,
    },
  })
  
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
  const marginSummaryParams = {
    search: debouncedSearch || undefined,
    status: status !== "all" ? status : undefined,
    productKind: productKind !== "all" ? productKind : undefined,
  }
  const {
    data: filteredSummary,
    isFetching: isFilteredSummaryLoading,
  } = useGetProductsMarginSummary(
    marginSummaryParams,
    {
      query: {
        queryKey: getGetProductsMarginSummaryQueryKey(marginSummaryParams),
        enabled: allFilteredSelected,
      },
    },
  )

  useEffect(() => {
    setSelectedIds(new Set())
  }, [page, status, productKind, debouncedSearch])

  useEffect(() => {
    if (
      batchTask?.status !== "completed" ||
      completedTaskRef.current === batchTask.taskId
    ) return
    completedTaskRef.current = batchTask.taskId
    void queryClient.invalidateQueries({ queryKey: getListProductsQueryKey() })
    const imageFailures = batchTask.items.filter(
      (item) => item.imageStatus === "failed",
    ).length
    if (batchTask.failed > 0 || imageFailures > 0) {
      toast.warning(
        `Опубликовано ${batchTask.succeeded}, ошибок ${batchTask.failed}, проблем с изображениями ${imageFailures}`,
      )
    } else {
      toast.success(`Опубликовано ${batchTask.succeeded} товаров`)
    }
  }, [batchTask, queryClient])

  const visibleItems = data?.items ?? []
  const eligibleItems = visibleItems.filter(
    (product) =>
      product.isAvailable &&
      product.publicationStatus !== ProductPublicationStatus.published &&
      product.productKind !== ProductProductKind.unknown,
  )
  const allEligibleSelected =
    visibleItems.length > 0 &&
    visibleItems.every((product) => selectedIds.has(product.id))

  const toggleAllEligible = () => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (allEligibleSelected) {
        visibleItems.forEach((product) => next.delete(product.id))
      } else {
        visibleItems.forEach((product) => next.add(product.id))
      }
      return next
    })
  }

  const handleBatchPublish = () => {
    const productIds = eligibleItems
      .filter((product) => selectedIds.has(product.id))
      .map((product) => product.id)
    if (
      !window.confirm(
        `Создать или обновить ${productIds.length} карточек в Digiseller? Это изменит внешний каталог. Изображения GPay будут загружены автоматически.`,
      )
    ) return

    batchMutation.mutate(
      { data: { productIds } },
      {
        onSuccess: (result) => {
          setSelectedIds(new Set())
          queryClient.setQueryData(
            getGetLatestPublishProductsBatchQueryKey(),
            result,
          )
          toast.success("Публикация запущена в фоне")
        },
        onError: (error) =>
          toast.error(
            getMutationErrorMessage(error, "Пакетная публикация не выполнена"),
          ),
      },
    )
  }

  const handleBulkMargin = () => {
    const marginPercent = Number(bulkMargin)
    if (!Number.isFinite(marginPercent) || marginPercent < 0 || marginPercent > 500) {
      toast.error("Введите маржу от 0 до 500%")
      return
    }
    const productIds = Array.from(selectedIds)
    const affectedCount = allFilteredSelected
      ? filteredSummary?.total ?? 0
      : productIds.length
    const publishedCount = allFilteredSelected
      ? filteredSummary?.published ?? 0
      : visibleItems.filter(
          (product) =>
            selectedIds.has(product.id) &&
            product.publicationStatus === ProductPublicationStatus.published,
        ).length
    if (affectedCount === 0) {
      toast.error("По текущему выбору товары не найдены")
      return
    }
    if (
      !window.confirm(
        `Установить маржу ${marginPercent}% для ${affectedCount} товаров?${publishedCount ? ` Цены ${publishedCount} опубликованных карточек будут обновлены в Digiseller.` : ""}`,
      )
    ) return
    marginMutation.mutate(
      {
        data: allFilteredSelected
          ? {
              filter: {
                search: debouncedSearch || undefined,
                status,
                productKind,
              },
              marginPercent,
            }
          : { productIds, marginPercent },
      },
      {
        onSuccess: (result) => {
          setSelectedIds(new Set())
          setAllFilteredSelected(false)
          void queryClient.invalidateQueries({ queryKey: getListProductsQueryKey() })
          toast.success(
            `Маржа ${result.marginPercent}% применена к ${result.updated} товарам`,
          )
        },
        onError: (error) =>
          toast.error(
            getMutationErrorMessage(error, "Не удалось массово изменить маржу"),
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
  const batchIsActive =
    batchTask?.status === "queued" || batchTask?.status === "running"
  const completedItems =
    batchTask?.items.filter(
      (item) => item.status === "published" || item.status === "failed",
    ).length ?? 0

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
          disabled={eligibleItems.every((product) => !selectedIds.has(product.id)) || batchMutation.isPending || batchIsActive}
          className="gap-2"
        >
          <Play className="h-4 w-4" />
          {batchMutation.isPending || batchIsActive
            ? "Публикация выполняется…"
            : `Опубликовать выбранные (${eligibleItems.filter((product) => selectedIds.has(product.id)).length})`}
        </Button>
      </div>

      {(selectedIds.size > 0 || allFilteredSelected) && (
        <Card className="flex flex-col gap-3 border-primary/20 bg-primary/5 p-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="font-medium">
              {allFilteredSelected
                ? isFilteredSummaryLoading
                  ? "Считаем товары по фильтру…"
                  : `Выбрано по фильтру: ${filteredSummary?.total ?? 0}`
                : `Выбрано товаров на странице: ${selectedIds.size}`}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Для опубликованных карточек цена сначала обновится в Digiseller, затем локально.
            </p>
          </div>
          <div className="flex items-end gap-2">
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="bulk-margin">
                Новая маржа, %
              </label>
              <Input
                id="bulk-margin"
                type="number"
                min="0"
                max="500"
                step="0.1"
                className="w-32 bg-background"
                value={bulkMargin}
                onChange={(event) => setBulkMargin(event.target.value)}
              />
            </div>
            <Button
              type="button"
              variant="secondary"
              onClick={handleBulkMargin}
              disabled={
                marginMutation.isPending ||
                (allFilteredSelected &&
                  (isFilteredSummaryLoading || !filteredSummary?.total))
              }
              className="gap-2"
            >
              <Save className="h-4 w-4" />
              {marginMutation.isPending ? "Применение…" : "Применить маржу"}
            </Button>
          </div>
        </Card>
      )}

      <DigisellerImportDialog
        open={importProduct !== null}
        product={importProduct}
        onOpenChange={(open) => {
          if (!open) setImportProduct(null)
        }}
        onLinked={(updated) => {
          updateProductInCache(updated)
          void queryClient.invalidateQueries({ queryKey: getListProductsQueryKey() })
        }}
      />

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

      <Card className="border-dashed p-4">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={allFilteredSelected}
            onChange={(event) => {
              setAllFilteredSelected(event.target.checked)
              setSelectedIds(new Set())
            }}
            disabled={!data?.total}
            className="mt-0.5 h-4 w-4 rounded border-input"
          />
          <span>
            <span className="block text-sm font-medium">
              Выбрать все товары по текущему фильтру
            </span>
            <span className="mt-1 block text-xs text-muted-foreground">
              {allFilteredSelected && filteredSummary
                ? `Будет изменено ${filteredSummary.total}, опубликовано в Digiseller — ${filteredSummary.published}.`
                : `Отдельный режим для всех ${data?.total ?? 0} товаров, включая другие страницы.`}
            </span>
          </span>
        </label>
      </Card>

      {batchTask && (
        <Card className="border-primary/20 bg-primary/5 p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="font-medium">
              {batchTask.status === "completed"
                ? `Пакет завершён: опубликовано ${batchTask.succeeded} из ${batchTask.requested}`
                : `Публикация: обработано ${completedItems} из ${batchTask.requested}`}
            </div>
            <Badge variant={batchTask.status === "completed" ? "outline" : "secondary"}>
              {batchTask.status === "queued"
                ? "В очереди"
                : batchTask.status === "running"
                  ? "Выполняется"
                  : "Завершено"}
            </Badge>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-primary/10">
            <div
              className="h-full bg-primary transition-all"
              style={{
                width: `${batchTask.requested ? (completedItems / batchTask.requested) * 100 : 0}%`,
              }}
            />
          </div>
          <div className="mt-3 max-h-64 space-y-1 overflow-y-auto text-sm">
            {batchTask.items.map((item) => (
              <div
                key={item.productId}
                className="flex items-start justify-between gap-3 rounded-md bg-background/70 px-3 py-2"
              >
                <span className="min-w-0 truncate" title={item.name}>{item.name}</span>
                <span className={cn(
                  "shrink-0 text-xs",
                  item.status === "failed" ? "text-destructive" : "text-muted-foreground",
                )}>
                  {item.status === "queued"
                    ? "Ожидает"
                    : item.status === "publishing"
                      ? "Публикуется…"
                      : item.status === "published"
                        ? `Опубликован${item.digisellerId ? ` · DS ${item.digisellerId}` : ""}`
                        : item.error || "Ошибка"}
                </span>
              </div>
            ))}
          </div>
          {batchTask.status !== "completed" && (
            <div className="mt-3 text-xs text-muted-foreground">
              Можно обновить страницу или перейти в другой раздел — задача продолжит выполняться.
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
                    aria-label="Выбрать товары на странице"
                    checked={allEligibleSelected}
                    onChange={toggleAllEligible}
                    disabled={visibleItems.length === 0 || allFilteredSelected}
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
                    onImport={() => setImportProduct(product)}
                     batchIsActive={batchIsActive}
                    selected={selectedIds.has(product.id)}
                    selectionDisabled={allFilteredSelected}
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
  onImport,
  batchIsActive,
  selected,
  selectionDisabled,
  onSelectionChange,
}: {
  product: Product
  onUpdate: (p: Product) => void
  onImport: () => void
  batchIsActive: boolean
  selected: boolean
  selectionDisabled: boolean
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
          toast.success(
            product.publicationStatus === ProductPublicationStatus.published
              ? "Старая карточка отключена. Опубликуйте товар в новой категории."
              : "Категория сохранена. Повторите публикацию для проверки.",
          )
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
  return (
    <tr className="hover:bg-muted/30 transition-colors group">
      <td className="px-4 py-3">
        <input
          type="checkbox"
          aria-label={`Выбрать ${product.name}`}
          checked={selected}
          disabled={selectionDisabled}
          onChange={(event) => onSelectionChange(event.target.checked)}
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
                  : product.publicationFailureStage === "uncertain"
                    ? "Требуется сверка с Digiseller"
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
              {product.publicationFailureStage === "uncertain" && (
                <div className="mt-1 font-medium">Не запускайте создание повторно, пока не проверите карточку в Digiseller.</div>
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
            <>
              {!product.digisellerId && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 px-3 text-xs"
                  onClick={onImport}
                  disabled={batchIsActive || publishMutation.isPending}
                >
                  Связать DS
                </Button>
              )}
              <Button
                size="sm"
                className="h-7 text-xs px-3 gap-1.5"
                onClick={handlePublish}
                disabled={batchIsActive || publishMutation.isPending || !product.isAvailable || product.productKind === ProductProductKind.unknown}
              >
                <Play className="w-3 h-3" /> Опубликовать
              </Button>
            </>
          )}
          </div>
        </div>
      </td>
    </tr>
  )
}
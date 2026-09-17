import { useEffect, useMemo, useState } from "react"
import {
  getListDigisellerProductsQueryKey,
  type Product,
  useLinkDigisellerProduct,
  useListDigisellerProducts,
} from "@workspace/api-client-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Search } from "lucide-react"
import { toast } from "sonner"

type DeliveryType = "code" | "text" | "form"

function errorMessage(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? `Не удалось связать товар: ${error.message}`
    : "Не удалось связать товар"
}

export function DigisellerImportDialog({
  open,
  product,
  onOpenChange,
  onLinked,
}: {
  open: boolean
  product: Product | null
  onOpenChange: (open: boolean) => void
  onLinked: (product: Product) => void
}) {
  const [search, setSearch] = useState("")
  const [deliveryType, setDeliveryType] = useState<DeliveryType>("code")
  const listQuery = useListDigisellerProducts({
    query: {
      queryKey: getListDigisellerProductsQueryKey(),
      enabled: open,
    },
  })
  const linkMutation = useLinkDigisellerProduct()

  useEffect(() => {
    if (!open) return
    setSearch(product?.name ?? "")
    setDeliveryType("code")
  }, [open, product])

  const visibleProducts = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("ru-RU")
    if (!query) return listQuery.data?.items ?? []
    return (listQuery.data?.items ?? []).filter(
      (item) =>
        item.name.toLocaleLowerCase("ru-RU").includes(query) ||
        String(item.id).includes(query),
    )
  }, [listQuery.data?.items, search])

  const handleLink = (digisellerId: number) => {
    if (!product) return
    linkMutation.mutate(
      {
        data: {
          localProductId: product.id,
          digisellerId,
          deliveryType,
        },
      },
      {
        onSuccess: (updated) => {
          onLinked(updated)
          void listQuery.refetch()
          onOpenChange(false)
          toast.success(`Связано с карточкой Digiseller ${digisellerId}`)
        },
        onError: (error) => toast.error(errorMessage(error)),
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Связать существующий товар Digiseller</DialogTitle>
          <DialogDescription>
            Локальный товар: <span className="font-medium text-foreground">{product?.name}</span>.
            Выберите точную карточку — сопоставление по названию автоматически не выполняется.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-[1fr_220px]">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Название или ID Digiseller"
              className="pl-9"
            />
          </div>
          <select
            aria-label="Тип выдачи существующей карточки"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={deliveryType}
            onChange={(event) => setDeliveryType(event.target.value as DeliveryType)}
          >
            <option value="code">Code — уникальные коды</option>
            <option value="text">Text — текст/ключи</option>
            <option value="form">Form — ручная форма</option>
          </select>
        </div>

        <p className="text-xs text-muted-foreground">
          Укажите реальный тип выдачи карточки. Для старых Text/Form-карточек последующая
          повторная публикация может создать замену Code согласно текущим правилам сервиса.
        </p>

        <div className="max-h-[55vh] space-y-2 overflow-y-auto pr-1">
          {listQuery.isLoading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              Загружаем товары Digiseller…
            </div>
          ) : listQuery.isError ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
              Не удалось загрузить каталог Digiseller. Проверьте разрешение «Товары:
              просматривать» у API-ключа.
            </div>
          ) : visibleProducts.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              Подходящие карточки не найдены.
            </div>
          ) : (
            visibleProducts.map((item) => {
              const linkedElsewhere =
                item.linkedProductId !== null && item.linkedProductId !== product?.id
              const linkedHere = item.linkedProductId === product?.id
              return (
                <div
                  key={item.id}
                  className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium" title={item.name}>
                      {item.name}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="font-mono">DS {item.id}</span>
                      <span>{item.priceRub.toLocaleString("ru-RU")} ₽</span>
                      <Badge variant={item.visible ? "outline" : "secondary"}>
                        {item.visible ? "Виден" : "Скрыт"}
                      </Badge>
                      <Badge variant={item.inStock ? "success" : "destructive"}>
                        {item.inStock
                          ? item.numInStock === null
                            ? "В наличии"
                            : `Остаток: ${item.numInStock}`
                          : "Нет в наличии"}
                      </Badge>
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant={linkedHere ? "outline" : "default"}
                    disabled={linkedElsewhere || linkedHere || linkMutation.isPending}
                    onClick={() => handleLink(item.id)}
                  >
                    {linkedHere
                      ? "Уже связан"
                      : linkedElsewhere
                        ? "Связан с другим"
                        : "Связать"}
                  </Button>
                </div>
              )
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
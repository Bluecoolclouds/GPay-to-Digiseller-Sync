import { type FormEvent, useEffect, useRef, useState } from "react"
import { useRoute } from "wouter"
import { CheckCircle2, Loader2, ShieldCheck } from "lucide-react"

type PublicOrder = {
  productName: string
  code: string
  expiresAt: string
  alreadySubmitted: boolean
}

export default function PublicOrderPage() {
  const [, params] = useRoute("/order/:token")
  const token = params?.token ?? ""
  const [order, setOrder] = useState<PublicOrder | null>(null)
  const [code, setCode] = useState("")
  const [state, setState] = useState<"loading" | "ready" | "submitting" | "done" | "error">("loading")
  const [message, setMessage] = useState("")
  const [autoSeconds, setAutoSeconds] = useState<number | null>(null)
  const autoStarted = useRef(false)

  useEffect(() => {
    document.title = "Получение заказа"
    void fetch(`/api/public/orders/${encodeURIComponent(token)}`, {
      credentials: "omit",
      cache: "no-store",
    }).then(async (response) => {
      const body = await response.json() as PublicOrder & { error?: string }
      if (!response.ok) throw new Error(body.error || "Ссылка недоступна")
      setOrder(body)
      setCode(body.code)
      if (body.alreadySubmitted) {
        setState("done")
        setMessage("Код уже принят. Заказ находится в обработке.")
      } else {
        setState("ready")
        if (body.code && !autoStarted.current) {
          autoStarted.current = true
          setAutoSeconds(3)
        }
      }
    }).catch((error) => {
      setMessage(error instanceof Error ? error.message : "Ссылка недоступна")
      setState("error")
    })
  }, [token])

  async function submit() {
    if (state === "submitting" || code.trim().length < 3) return
    setAutoSeconds(null)
    setState("submitting")
    setMessage("")
    try {
      const response = await fetch(`/api/public/orders/${encodeURIComponent(token)}`, {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      })
      const body = await response.json() as { error?: string }
      if (!response.ok) throw new Error(body.error || "Не удалось принять код")
      setCode("")
      setState("done")
      setMessage("Код принят. Заказ передан в обработку.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Не удалось принять код")
      setState("error")
    }
  }

  useEffect(() => {
    if (autoSeconds === null) return
    if (autoSeconds <= 0) {
      void submit()
      return
    }
    const timer = window.setTimeout(() => setAutoSeconds((value) => value === null ? null : value - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [autoSeconds])

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    void submit()
  }

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-slate-100 px-4 py-10">
      <section className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-xl sm:p-8">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-blue-600 text-white">
          <ShieldCheck className="h-7 w-7" />
        </div>
        <h1 className="mt-5 text-center text-2xl font-semibold text-slate-950">Получение заказа</h1>

        {state === "loading" ? (
          <div className="flex items-center justify-center gap-2 py-12 text-slate-600">
            <Loader2 className="h-5 w-5 animate-spin" /> Проверяем ссылку…
          </div>
        ) : state === "done" ? (
          <div className="mt-7 rounded-xl border border-emerald-200 bg-emerald-50 p-5 text-center">
            <CheckCircle2 className="mx-auto h-9 w-9 text-emerald-600" />
            <p className="mt-3 font-medium text-emerald-950">{message}</p>
            <p className="mt-2 text-sm text-emerald-800">Эту страницу можно закрыть.</p>
          </div>
        ) : state === "error" && !order ? (
          <div role="alert" className="mt-7 rounded-xl border border-red-200 bg-red-50 p-5 text-center text-red-800">
            {message}
          </div>
        ) : (
          <form onSubmit={onSubmit} className="mt-7">
            <p className="text-center text-sm text-slate-600">{order?.productName}</p>
            <label className="mt-6 block text-sm font-medium text-slate-800">
              Код заказа
              <input
                value={code}
                onChange={(event) => {
                  setCode(event.target.value)
                  setAutoSeconds(null)
                  if (state === "error") setState("ready")
                }}
                autoComplete="one-time-code"
                required
                minLength={3}
                maxLength={500}
                className="mt-2 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-3 font-mono text-slate-950 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              />
            </label>
            {autoSeconds !== null ? (
              <div className="mt-3 flex items-center justify-between rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-800">
                <span>Продолжим автоматически через {autoSeconds} сек.</span>
                <button type="button" className="font-medium underline" onClick={() => setAutoSeconds(null)}>Отменить</button>
              </div>
            ) : null}
            {message ? <p role="alert" className="mt-3 text-sm text-red-600">{message}</p> : null}
            <button
              type="submit"
              disabled={state === "submitting" || code.trim().length < 3}
              className="mt-5 flex w-full items-center justify-center rounded-lg bg-blue-600 px-4 py-3 font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {state === "submitting" ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Отправляем…</> : "Продолжить"}
            </button>
            <p className="mt-4 text-center text-xs text-slate-500">
              Ссылка действует до {order ? new Date(order.expiresAt).toLocaleString("ru-RU") : "—"}
            </p>
          </form>
        )}
      </section>
    </main>
  )
}
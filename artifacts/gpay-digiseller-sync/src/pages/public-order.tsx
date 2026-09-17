import { type FormEvent, useEffect, useRef, useState } from "react"
import { useLocation, useRoute } from "wouter"
import { CheckCircle2, Loader2, ShieldCheck, Key, ArrowRight, AlertCircle, RefreshCw, Copy, Check, Lock } from "lucide-react"
import heroImg from "../assets/order-delivery-hero.png"

type PublicOrder = {
  productName: string
  code: string
  deliveredKey: string
  deliveryStatus: string | null
  expiresAt: string
  alreadySubmitted: boolean
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        } catch {
          setCopied(false)
        }
      }}
      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-sm transition-all hover:bg-emerald-700 hover:shadow focus:outline-none focus:ring-2 focus:ring-emerald-600/50 active:scale-95"
      title="Скопировать"
      aria-label={copied ? "Ключ скопирован" : "Скопировать ключ"}
    >
      {copied ? <Check className="h-5 w-5" /> : <Copy className="h-5 w-5" />}
    </button>
  )
}

export default function PublicOrderPage() {
  const [, navigate] = useLocation()
  const [, params] = useRoute("/order/:token")
  const token = params?.token ?? ""
  const isAccessPage = !token
  const [order, setOrder] = useState<PublicOrder | null>(null)
  const [invoiceId, setInvoiceId] = useState("")
  const [code, setCode] = useState("")
  const [state, setState] = useState<"loading" | "ready" | "submitting" | "done" | "error">("loading")
  const [message, setMessage] = useState("")
  const [autoSeconds, setAutoSeconds] = useState<number | null>(null)
  const autoStarted = useRef(false)

  useEffect(() => {
    document.title = "Получение заказа"
    if (isAccessPage) {
      setState("ready")
      return
    }
    let stopped = false
    let timer: number | undefined
    const load = async () => {
      try {
        const response = await fetch(`/api/public/orders/${encodeURIComponent(token)}`, {
          credentials: "omit",
          cache: "no-store",
        })
        const body = await response.json() as PublicOrder & { error?: string }
        if (!response.ok) throw new Error(body.error || "Ссылка недоступна")
        if (stopped) return
        setOrder(body)
        if (!body.alreadySubmitted) setCode(body.code)
        if (body.deliveredKey) {
          setState("done")
          setMessage("Ключ успешно получен.")
        } else if (body.alreadySubmitted) {
          setState("done")
          setMessage("Код принят. Получаем ключ, страница обновится автоматически.")
          timer = window.setTimeout(load, 3_000)
        } else {
          setState("ready")
          if (body.code && !autoStarted.current) {
            autoStarted.current = true
            setAutoSeconds(3)
          }
        }
      } catch (error) {
        if (stopped) return
        setMessage(error instanceof Error ? error.message : "Ссылка недоступна")
        setState("error")
      }
    }
    void load()
    return () => {
      stopped = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [isAccessPage, token])

  async function openOrder(event: FormEvent) {
    event.preventDefault()
    if (!invoiceId.trim() || code.trim().length !== 16) return
    setState("submitting")
    setMessage("")
    try {
      const response = await fetch("/api/public/orders/access", {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invoiceId: invoiceId.trim(), code: code.trim() }),
      })
      const body = await response.json() as { urlPath?: string; error?: string }
      if (!response.ok || !body.urlPath) {
        throw new Error(body.error || "Не удалось открыть заказ")
      }
      navigate(body.urlPath)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Не удалось открыть заказ")
      setState("ready")
    }
  }

  async function submit() {
    if (state === "submitting" || code.trim().length !== 16) return
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
      setMessage("Код принят. Получаем ключ, обновите страницу через несколько секунд.")
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
    <main className="min-h-[100dvh] flex items-center justify-center bg-slate-100/50 p-4 sm:p-6 md:p-10 font-sans">
      <div className="w-full max-w-5xl bg-white rounded-3xl shadow-2xl overflow-hidden flex flex-col md:flex-row border border-slate-200/60 min-h-[600px]">

        {/* Left Side: Visual Banner */}
        <div className="md:w-[45%] bg-slate-950 relative overflow-hidden flex flex-col justify-between shrink-0 h-64 md:h-auto">
          <div className="absolute inset-0">
            <img src={heroImg} alt="" className="w-full h-full object-cover opacity-60 scale-105" />
            <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/40 to-transparent" />
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-transparent to-slate-950/80 md:to-transparent" />
          </div>
          <div className="relative z-10 p-8 sm:p-10 flex flex-col h-full justify-end">
            <div className="inline-flex items-center gap-2 text-blue-400 mb-4 animate-in fade-in slide-in-from-bottom-2 duration-700">
              <ShieldCheck className="h-5 w-5" />
              <span className="font-semibold tracking-wider uppercase text-xs">Безопасная выдача</span>
            </div>
            <h2 className="text-2xl md:text-3xl font-bold text-white mb-2 text-balance leading-tight animate-in fade-in slide-in-from-bottom-4 duration-700 delay-100 fill-mode-both">
              Ваш цифровой заказ готов к получению.
            </h2>
            <p className="text-slate-400 text-sm text-balance animate-in fade-in slide-in-from-bottom-4 duration-700 delay-200 fill-mode-both">
              Мгновенный доступ к ключам активации сразу после проверки.
            </p>
          </div>
        </div>

        {/* Right Side: Interactive Panel */}
        <div className="md:w-[55%] p-8 sm:p-12 lg:p-16 flex flex-col justify-center relative bg-white">
          {isAccessPage ? (
            <div className="flex flex-col animate-in fade-in zoom-in-95 duration-500">
              <div className="mb-2 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-blue-50 text-blue-600 border border-blue-100 shadow-sm">
                <Lock className="h-6 w-6" />
              </div>
              <h1 className="text-3xl font-bold text-slate-900 tracking-tight mt-4">Доступ к заказу</h1>
              <p className="text-slate-500 mt-2 text-sm leading-relaxed">
                Введите данные вашего заказа Digiseller для безопасного получения покупки.
              </p>

              <form onSubmit={openOrder} className="mt-8 space-y-5">
                <div>
                  <label className="block text-sm font-semibold text-slate-900 mb-2">Номер счета (Invoice ID)</label>
                  <input
                    value={invoiceId}
                    onChange={(event) => setInvoiceId(event.target.value)}
                    autoComplete="off"
                    required
                    maxLength={200}
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3.5 text-slate-900 transition-all focus:border-blue-600 focus:bg-white focus:outline-none focus:ring-4 focus:ring-blue-600/10 shadow-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-slate-900 mb-2">16-значный код заказа</label>
                  <input
                    value={code}
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 16))}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    required
                    minLength={16}
                    maxLength={16}
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3.5 font-mono text-slate-900 tracking-widest transition-all focus:border-blue-600 focus:bg-white focus:outline-none focus:ring-4 focus:ring-blue-600/10 shadow-sm"
                  />
                </div>
                {message ? (
                  <div className="flex items-start gap-3 rounded-xl bg-red-50 p-4 text-red-800 border border-red-100 animate-in fade-in">
                    <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
                    <p className="text-sm font-medium">{message}</p>
                  </div>
                ) : null}
                <button
                  type="submit"
                  disabled={state === "submitting" || !invoiceId.trim() || code.length !== 16}
                  className="group relative mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-4 font-semibold text-white shadow-md transition-all hover:bg-slate-800 focus:outline-none focus:ring-4 focus:ring-slate-900/20 disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:bg-slate-900 active:scale-[0.98]"
                >
                  {state === "submitting" ? (
                    <><Loader2 className="mr-2 h-5 w-5 animate-spin" /> Проверка данных…</>
                  ) : (
                    <>Получить доступ <ArrowRight className="h-5 w-5 transition-transform group-hover:translate-x-1" /></>
                  )}
                </button>
              </form>
            </div>
          ) : state === "loading" ? (
            <div className="flex flex-col items-center justify-center py-16 text-center animate-in fade-in duration-700">
              <div className="relative mb-8">
                <div className="absolute inset-0 animate-ping rounded-full bg-blue-100 opacity-60"></div>
                <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-tr from-blue-100 to-blue-50 text-blue-600 shadow-sm border border-blue-200/50">
                  <Loader2 className="h-8 w-8 animate-spin" />
                </div>
              </div>
              <h2 className="text-xl font-bold text-slate-900">Безопасное подключение</h2>
              <p className="mt-2 text-sm text-slate-500 max-w-[250px]">Получаем данные вашего заказа. Пожалуйста, подождите...</p>
            </div>
          ) : state === "done" ? (
            <div className="flex flex-col animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-50 border border-emerald-100 text-emerald-600 shadow-sm">
                <CheckCircle2 className="h-8 w-8" />
              </div>
              <h2 className="text-2xl font-bold text-slate-900 mb-2">Заказ выдан</h2>
              <p className="text-slate-600 mb-8 text-sm">{message}</p>

              {order?.deliveredKey ? (
                <div className="space-y-3">
                  <label className="text-sm font-semibold text-slate-900">Ваш ключ активации</label>
                  <div className="relative group">
                    <div className="absolute -inset-0.5 rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-400 opacity-25 blur transition duration-500 group-hover:opacity-40"></div>
                    <div className="relative flex items-center justify-between gap-3 rounded-2xl border border-emerald-200/60 bg-white p-1.5 shadow-sm">
                      <code className="px-4 py-3 font-mono text-lg font-bold text-emerald-950 tracking-wider break-all flex-1">
                        {order.deliveredKey}
                      </code>
                      <CopyButton text={order.deliveredKey} />
                    </div>
                  </div>
                  <div className="mt-6 flex items-start gap-3 rounded-xl bg-slate-50 p-4 border border-slate-100">
                    <ShieldCheck className="h-5 w-5 shrink-0 text-slate-400" />
                    <p className="text-xs text-slate-500 leading-relaxed">
                      Этот ключ привязан к вашему заказу. Сохраните его и активируйте на соответствующей платформе.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl border border-blue-100 bg-blue-50/50 p-8 flex flex-col items-center justify-center text-center">
                  <RefreshCw className="h-8 w-8 animate-spin text-blue-500 mb-4" />
                  <p className="text-base font-semibold text-blue-900">Формирование ключа...</p>
                  <p className="text-sm text-blue-700/70 mt-1">Страница обновится автоматически</p>
                </div>
              )}
            </div>
          ) : state === "error" && !order ? (
            <div className="flex flex-col items-center justify-center text-center py-12 animate-in fade-in zoom-in-95 duration-500">
              <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-red-50 border border-red-100 text-red-600 shadow-sm">
                <AlertCircle className="h-8 w-8" />
              </div>
              <h2 className="text-xl font-bold text-slate-900 mb-3">Ошибка доступа</h2>
              <div className="rounded-xl border border-red-100 bg-red-50 p-4 text-sm font-medium text-red-800 w-full max-w-sm">
                {message}
              </div>
            </div>
          ) : (
            <div className="flex flex-col animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div className="mb-8">
                <div className="inline-flex items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700 mb-4 shadow-sm">
                  <Key className="h-3.5 w-3.5" /> Заказ найден
                </div>
                <h2 className="text-2xl font-bold text-slate-900 mb-2 leading-tight">
                  {order?.productName}
                </h2>
                <p className="text-slate-500 text-sm">Подтвердите код заказа для безопасной выдачи ключа.</p>
              </div>

              <form onSubmit={onSubmit} className="space-y-5">
                <div>
                  <label className="block text-sm font-semibold text-slate-900 mb-2">Уникальный код заказа</label>
                  <input
                    value={code}
                    onChange={(event) => {
                      setCode(event.target.value.replace(/\D/g, "").slice(0, 16))
                      setAutoSeconds(null)
                      if (state === "error") setState("ready")
                    }}
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    required
                    minLength={16}
                    maxLength={16}
                    placeholder="0000 0000 0000 0000"
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-4 font-mono text-lg text-slate-900 tracking-[0.2em] transition-all focus:border-blue-600 focus:bg-white focus:outline-none focus:ring-4 focus:ring-blue-600/10 shadow-sm placeholder:tracking-normal placeholder:text-slate-300"
                  />
                </div>

                {autoSeconds !== null ? (
                  <div className="flex items-center justify-between rounded-xl border border-indigo-100 bg-indigo-50/80 px-4 py-3 shadow-sm animate-in fade-in slide-in-from-top-2">
                    <div className="flex items-center gap-3">
                      <div className="relative flex h-6 w-6 items-center justify-center">
                        <svg className="absolute inset-0 h-6 w-6 -rotate-90 text-indigo-200" viewBox="0 0 36 36">
                          <path className="stroke-current" fill="none" strokeWidth="3" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                          <path className="stroke-indigo-600 transition-all duration-1000 ease-linear" strokeDasharray={`${(autoSeconds / 3) * 100}, 100`} fill="none" strokeWidth="3" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                        </svg>
                        <span className="text-[10px] font-bold text-indigo-700">{autoSeconds}</span>
                      </div>
                      <span className="text-sm font-semibold text-indigo-900">Авто-проверка через...</span>
                    </div>
                    <button
                      type="button"
                      className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 transition-colors bg-indigo-100/50 hover:bg-indigo-100 px-2.5 py-1.5 rounded-md"
                      onClick={() => setAutoSeconds(null)}
                    >
                      Отменить
                    </button>
                  </div>
                ) : null}

                {message ? (
                  <div className="flex items-start gap-3 rounded-xl bg-red-50 p-4 text-red-800 border border-red-100 animate-in fade-in">
                    <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
                    <p className="text-sm font-medium">{message}</p>
                  </div>
                ) : null}

                <button
                  type="submit"
                  disabled={state === "submitting" || code.trim().length !== 16}
                  className="group relative mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-4 font-semibold text-white shadow-md transition-all hover:bg-blue-700 focus:outline-none focus:ring-4 focus:ring-blue-600/20 disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:bg-blue-600 active:scale-[0.98]"
                >
                  {state === "submitting" ? (
                    <><Loader2 className="mr-2 h-5 w-5 animate-spin" /> Отправка…</>
                  ) : (
                    <>Получить ключ <ArrowRight className="h-5 w-5 transition-transform group-hover:translate-x-1" /></>
                  )}
                </button>
                <p className="text-center text-xs text-slate-400 font-medium mt-6">
                  Безопасная ссылка действительна до {order ? new Date(order.expiresAt).toLocaleString("ru-RU") : "—"}
                </p>
              </form>
            </div>
          )}
        </div>
      </div>
    </main>
  )
}

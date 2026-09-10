# GPay → Digiseller Sync

Панель импортирует товары GPay Market, рассчитывает цены с наценкой и готовит их к публикации в Digiseller.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — контракт приложения
- `lib/db/src/schema/` — товары, настройки и журнал синхронизации
- `artifacts/api-server/src/lib/` — клиенты GPay и Digiseller
- `artifacts/api-server/src/routes/sync.ts` — API панели
- `artifacts/gpay-digiseller-sync/` — веб-панель

## Architecture decisions

- Закупка и фактическая публикация в Digiseller по умолчанию ручные: сначала проверяем категории, контент, цены и возвраты.
- Доступы внешних сервисов хранятся только в Replit Secrets.
- Перед продажей цена считается из USD/RUB, комиссии, наценки, резерва и минимальной прибыли.
- Расчетный курс закупки — официальный USD/RUB ЦБ РФ плюс настраиваемый запас на конвертацию; базовое значение запаса — 2%.

## Product

- Живая проверка подключений GPay и Digiseller
- Импорт доступных товаров из GPay
- Поиск, фильтры, индивидуальная наценка и расчет прибыли
- Общие правила цены и безопасный ручной режим
- Журнал синхронизации

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details

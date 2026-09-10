# GGsel Seller API v2 — практический справочник

Источник справочника — извлечённая официальная документация (`ggsel-api-v2-extracted.txt`). Это именно конспект опубликованной схемы: если документация не указывает обязательность, формат, лимит или base URL, ниже это **не предполагается**.

## Быстрый старт

* В документации для примеров используется `https://seller.ggsel.com`; это URL, встречающийся в сгенерированных примерах curl, а не отдельное объявление base URL. Относительный префикс всех путей: `/api_sellers/v2`.
* Авторизация — API-key в заголовке `Authorization` (схема security называется `apiKey`, описание: «Your API key»). Значение-плейсхолдер ниже — `<API_KEY>`, реальный ключ в документации отсутствует.
* Для JSON-запросов используйте `Content-Type: application/json` и обычно `Accept: application/json`.
* Заголовок `locale` — строковый, опубликованное значение по умолчанию `ru`. Допустимые значения документация не перечисляет; не следует выводить их из названий полей.
* `:id`, `:offer_id`, `:option_id`, `:variant_id`, `:job_id` — части пути, заменяются URL-кодированными значениями.
* Успешные пакетные изменения и операции с товарами асинхронны: HTTP 200 означает постановку задания, а не завершение операции.

Минимальный пример (без настоящего ключа):

```bash
curl -X GET 'https://seller.ggsel.com/api_sellers/v2/offers?page=1&limit=10' \
  -H 'Accept: application/json' \
  -H 'Authorization: <API_KEY>' \
  -H 'locale: ru'
```

## Общие схемы

### Ошибки

Обычная ошибка: `{ "errors": [{ "code": "NOT_FOUND" }] }`. В `ErrorWithEntity` дополнительно описан `entity`: `id` (integer, nullable), `resource` (string, nullable), `description` (string, nullable; в схеме помечен required). Код — string; документация приводит `NOT_FOUND` даже в примерах 400/401/422 и не публикует исчерпывающий enum. Поэтому клиенту следует сохранять весь массив ошибок, HTTP-код и неизвестные поля.

### AsyncJobResult и пагинация

Ответ постановки задания: `{ "success": true, "job_id": "string" }`. Страница результата задания описывает `success` (boolean), `status` (string), `result` (object, nullable) и `errors` (object[], nullable); точный набор полей результата зависит от операции и в общей схеме не унифицирован.

Пагинация: `pagination.page`, `limit`, `has_next_page`, `has_previous_page`; `total_pages` и `total_count` помечены deprecated (документация рекомендует флаги). В некоторых ответах `pagination` может быть nullable.

### Базовые объекты

**Offer** (используемые в create/patch/get/list): `id`; `status` = `draft|active|paused|archived`; `is_autoselling`; `delivery` = `auto|manual` (nullable); локализованные `title_ru/title_en`, `description_ru/description_en`, `instructions_ru/instructions_en`; `cover_image_ru_url`, `cover_image_en_url`; `price`; `currency` (документация указывает RUB); `category` (`id`, `title`, `content_type`, `fee`, `payment_fee`, `tree`, `has_children`); `min_quantity`, `max_quantity`, `quantity`, `is_unlimited_quantity`; `post_payment_url`; `pre_payment_settings`; `notification_settings`; счётчики/даты и прочие поля следует принимать как расширение ответа (полная обязательность не утверждена).

**Option**: `id`, `type` = `text|multiline_text|check_box|radio_button`, `status` = `active|archived|hidden`, `title_ru/title_en`, `comment_ru/comment_en`, `is_required` (default false), `is_price_modifier_hidden` (default false), `position` (default 0), `has_splitted_products` (default false), `variants[]`.

**Variant**: `id`, `title_ru/title_en`, `price`, `discount_type` = `fixed|percent`, `impact_type` = `increase|decrease`, `is_default` (default false), `status` = `active|archived|hidden` (в visibility-ответах только active/hidden), `position` (default 0).

**Product / splitted product**: `id`, `value`, `status` = `in_stock|sold|archived`, `created_at`. Для splitted product привязка задаётся вариантом в URL.

## Все 25 endpoint-страниц

В таблице «параметры» перечислены параметры, явно показанные источником. `обяз.` означает только опубликованную документацией обязательность.

| Метод | HTTP path | Назначение | Параметры |
|---|---|---|---|
| [Archive option variants asynchronously](https://seller.ggsel.com/docs/v2/archive-option-variants-asynchronously) | DELETE `/api_sellers/v2/offers/:offer_id/options/:option_id/variants` | Архивировать варианты (async) | path: `offer_id` integer обяз., `option_id` integer обяз.; header `locale`; body `option_variant_ids` integer[], `delete_all` string `true/false` |
| [Archive options](https://seller.ggsel.com/docs/v2/archive-options) | DELETE `/api_sellers/v2/offers/:offer_id/options` | Архивировать options (async) | path `offer_id` integer обяз.; header `locale`; body `option_ids` integer[], `delete_all` string `true/false` |
| [Archive products](https://seller.ggsel.com/docs/v2/archive-products) | DELETE `/api_sellers/v2/offers/:offer_id/products` | Архивировать товары в offer (async) | path `offer_id` integer обяз.; header `locale`; body `product_ids` integer[], `delete_all` string `true/false` (архивировать весь stock) |
| [Archive splitted products](https://seller.ggsel.com/docs/v2/archive-splitted-products) | DELETE `/api_sellers/v2/offers/:offer_id/variants/:variant_id/splitted_products` | Архивировать splitted products (async) | path `offer_id`, `variant_id` integer обяз.; header `locale`; body `product_ids` integer[], `delete_all` string `true/false` |
| [Batch activate offers](https://seller.ggsel.com/docs/v2/batch-activate-offers) | POST `/api_sellers/v2/offers/batch_activate` | Массово активировать offers (async) | header `locale`; body `offer_ids` integer[] обяз., 1–100 |
| [Batch delete offers](https://seller.ggsel.com/docs/v2/batch-delete-offers) | POST `/api_sellers/v2/offers/batch_delete` | Массово удалить offers (async) | header `locale`; body `offer_ids` integer[] обяз., 1–100 |
| [Batch pause offers](https://seller.ggsel.com/docs/v2/batch-pause-offers) | POST `/api_sellers/v2/offers/batch_pause` | Массово поставить offers на паузу (async) | header `locale`; body `offer_ids` integer[] обяз., 1–100 |
| [Batch update options visibility](https://seller.ggsel.com/docs/v2/batch-update-options-visibility) | PATCH `/api_sellers/v2/offers/:offer_id/options/batch_visibility` | Изменить visibility options | path `offer_id` integer обяз.; header `locale`; body `options[]` обяз.: `{id integer обяз., status active|hidden обяз.}` |
| [Batch update variants visibility](https://seller.ggsel.com/docs/v2/batch-update-variants-visibility) | PATCH `/api_sellers/v2/offers/:offer_id/options/:option_id/variants/batch_visibility` | Изменить visibility variants | path `offer_id`, `option_id` integer обяз.; header `locale`; body `variants[]` обяз.: `{id integer обяз., status active|hidden обяз.}` |
| [Create many](https://seller.ggsel.com/docs/v2/create-many) | POST `/api_sellers/v2/offers/:offer_id/options` | Создать/обновить несколько options | path `offer_id` integer обяз.; header `locale`; body `options[]` (поля ниже) |
| [Create offer](https://seller.ggsel.com/docs/v2/create-offer) | POST `/api_sellers/v2/offers` | Создать offer | header `locale`; body поля CreateOfferRequest ниже |
| [Create or update variants](https://seller.ggsel.com/docs/v2/create-or-update-variants) | POST `/api_sellers/v2/offers/:offer_id/options/:option_id/variants` | Создать/обновить variants | path `offer_id`, `option_id` integer обяз.; header `locale`; body `variants[]` |
| [Create products](https://seller.ggsel.com/docs/v2/create-products) | POST `/api_sellers/v2/offers/:offer_id/products` | Добавить товары | path `offer_id` integer обяз.; header `locale`; body `products[]: {value string}` |
| [Create splitted products](https://seller.ggsel.com/docs/v2/create-splitted-products) | POST `/api_sellers/v2/offers/:offer_id/variants/:variant_id/splitted_products` | Добавить товары для variant | path `offer_id` integer обяз., `variant_id` (источник опечатан как `intger`) обяз.; header `locale`; body `products[]: {value string}` |
| [Get async job result](https://seller.ggsel.com/docs/v2/get-async-job-result) | GET `/api_sellers/v2/async_job_results/:job_id` | Получить состояние/результат задания | path `job_id` string обяз.; header `locale` |
| [Get offer](https://seller.ggsel.com/docs/v2/get-offer) | GET `/api_sellers/v2/offers/:id` | Получить offer | path `id` integer обяз.; header `locale` |
| [List of categories](https://seller.ggsel.com/docs/v2/list-of-categories) | GET `/api_sellers/v2/categories` | Список категорий | query `parent_id`, `page`, `limit`; header `locale` |
| [List offer options visible to seller](https://seller.ggsel.com/docs/v2/list-offer-options-visible-to-seller) | GET `/api_sellers/v2/offers/:offer_id/options` | Список options offer | path `offer_id` integer обяз.; header `locale` |
| [List offers](https://seller.ggsel.com/docs/v2/list-offers) | GET `/api_sellers/v2/offers` | Поиск/список offers | query `page` default 1, `limit` default 100, `search`, `category_id`, `status active|paused|draft`, `sort price_asc|price_desc|sales_count_asc|sales_count_desc|products_count_asc|products_count_desc`, `delivery auto|manual`, `updated_at_from date_time`; header `locale` |
| [List products](https://seller.ggsel.com/docs/v2/list-products) | GET `/api_sellers/v2/offers/:offer_id/products` | Список товаров | path `offer_id` integer обяз.; query `status in_stock|sold` default in_stock, `sort_column` default created_at, `sort_direction` default desc; header `locale` |
| [List splitted products](https://seller.ggsel.com/docs/v2/list-splitted-products) | GET `/api_sellers/v2/offers/:offer_id/variants/:variant_id/splitted_products` | Список товаров variant | path `offer_id`, `variant_id` integer обяз.; query те же status/sort; header `locale` |
| [Patch offer](https://seller.ggsel.com/docs/v2/patch-offer) | PATCH `/api_sellers/v2/offers/:id` | Частично обновить offer | path `id` integer обяз.; header `locale`; body поля PatchOffer ниже |
| [Search categories](https://seller.ggsel.com/docs/v2/search-categories) | GET `/api_sellers/v2/categories/search` | Поиск категорий | query `q` string обяз., `page`, `limit`; header `locale` |
| [View option](https://seller.ggsel.com/docs/v2/view-option) | GET `/api_sellers/v2/offers/:offer_id/options/:id` | Получить option и variants | path `offer_id`, `id` integer обяз.; header `locale` |

## Форматы запросов и ответов

### Асинхронные операции

Архивирование, batch activate/delete/pause и создание products в опубликованных ответах возвращают `200` и `success/job_id`. Практический workflow:

1. Отправить запрос и сохранить `job_id` вместе с исходной операцией.
2. Периодически вызвать `GET /async_job_results/:job_id`; интервал и SLA официальной страницей не заданы.
3. Считать задание завершённым только по `status`/`result` ответа; при наличии `errors` обработать их. Не считать HTTP 200 завершением.
4. При сетевой повторной отправке учитывать, что документация не обещает идемпотентность async-операций; visibility PATCH прямо называется **Idempotent request**.

### CreateOfferRequest и PatchOffer

Поля запроса (если не помечены `nullable`, источник не утверждает обязательность в этом справочнике): `title_ru`, `title_en`, `description_ru`, `description_en`, `instructions_ru`, `instructions_en`, `cover_image_ru` (Base64), `cover_image_en` (Base64, nullable), `price`, `currency` (nullable; единственное значение `RUB`), `is_autoselling` (nullable, default false), `category_id`, `min_quantity` (nullable, default 1), `max_quantity` (nullable, default 1), `quantity` (nullable), `is_unlimited_quantity` (nullable, default false), `post_payment_url` (nullable, default пустая строка), `delivery` (nullable, `auto|manual`, default auto), `pre_payment_settings` (nullable), `notification_settings` (nullable).

`pre_payment_settings`: `is_enabled` (default false), `url` (nullable), `allow_payment` (default true). `notification_settings`: `type` (nullable, `email|url`, default email), `url` (nullable), `email` (nullable), `http_method` (nullable, `GET|POST`), `is_disabled` (default false), `is_default` (default true). PATCH имеет тот же набор; отсутствие поля следует трактовать как «не менять» только потому, что endpoint называется PATCH — сама схема не описывает merge-семантику подробнее.

Пример создания:

```bash
curl -X POST 'https://seller.ggsel.com/api_sellers/v2/offers' \
 -H 'Authorization: <API_KEY>' -H 'locale: ru' -H 'Content-Type: application/json' \
 --data '{"title_ru":"Название","description_ru":"Описание","price":100,"currency":"RUB","category_id":123}'
```

### Options и variants

Create-many принимает `options[]`: `id` (если отсутствует, создаётся новая запись), `type`, `status`, `has_splitted_products`, `title_ru`, `title_en`, `comment_ru`, `comment_en` (nullable), `is_required` (default false), `is_price_modifier_hidden` (default false), `position` (default 0). Create/update variants принимает `variants[]`: `id` (если отсутствует — новая запись), локализованные titles, `price`, `discount_type`, `impact_type`, `is_default` (default false), `status`, `position` (default 0).

Visibility PATCH возвращает `{data: Option[]}` или `{data: Variant[]}` и предназначен для повторяемых изменений. Option в первом ответе включает вложенные variants; variant — описанные выше поля. Типы `check_box`/`radio_button` и наличие `has_splitted_products` определяют модель options, но источник не описывает правила совместимости.

### Products

Добавление: `{"products":[{"value":"..."}]}`; значение — строка содержимого, пустота/лимиты не определены. List-ответ: `{data:[{id,value,status,created_at}],pagination:{...}}`. `status` фильтра списка документирован как только `in_stock|sold`, хотя объект также содержит `archived`; это не следует считать ошибкой клиента. Archive тела позволяют либо IDs, либо `delete_all` как строку `"true"`/`"false"`; тип Boolean документация не заявляет.

## Ответы, коды и типичные ошибки

| Группа | Успех | Заявленные HTTP-коды | Типичный ответ/причина |
|---|---|---|---|
| CRUD/list/get | 200 | 401, 404; PATCH/create также 422 | `data` (offer/option/list) или пагинированный список; 401 auth, 404 сущность, 422 валидация |
| batch offers | 200 | 400, 401, 422 | job; 400 — пустой `offer_ids`, 422 — слишком много/невалидно |
| archive | 200 | 400, 401, 404, 422 | job; invalid operation, not found, «too many items»/products not allowed |
| visibility | 200 | 400, 401, 404, 422 | idempotent `data`; неверный статус/ID/сущность |
| list categories/search | 200 | 401 (search также источник не показывает 404) | `data` категорий + pagination |

Во всех перечисленных ошибках Content-Type — JSON и форма `errors[]`; `ErrorWithEntity` может содержать `code`, `entity.id`, `entity.resource`, `entity.description`. Не программируйте бизнес-логику по `NOT_FOUND` из автопримеров: документация повторяет его для разных статусов.

Пример async:

```bash
curl -X POST 'https://seller.ggsel.com/api_sellers/v2/offers/batch_pause' \
 -H 'Authorization: <API_KEY>' -H 'locale: ru' -H 'Content-Type: application/json' \
 --data '{"offer_ids":[123456,234567]}'
# затем:
curl 'https://seller.ggsel.com/api_sellers/v2/async_job_results/JOB_ID' \
 -H 'Authorization: <API_KEY>' -H 'locale: ru'
```

## Проверка покрытия источника и замечания

Покрыты все страницы с методами (в извлечённом файле их 24): 4 archive, 3 batch offer, 2 visibility, 5 create, 3 get/list products/jobs, 2 offer CRUD, 2 category, 1 view option (ссылки находятся в таблице). Отдельная [страница введения Seller API v2](https://seller.ggsel.com/docs/v2/seller-api-v-2) отражена в разделах старта/авторизации. Учтены также schema-страницы: [Async job result](https://seller.ggsel.com/docs/v2/schemas/async-job-result-object), [Create offer request](https://seller.ggsel.com/docs/v2/schemas/create-offer-request-object), [Error with entity](https://seller.ggsel.com/docs/v2/schemas/error-with-entity-object), [General error](https://seller.ggsel.com/docs/v2/schemas/general-error-object), [Pagination](https://seller.ggsel.com/docs/v2/schemas/pagination-object). Итого охвачены все 30 `# PAGE` блоков источника. Если считать introduction частью «25 endpoint-страниц», это даёт требуемые 25; фактических HTTP-методов в файле 24.

Замеченные особенности оригинала:

* base URL не оформлен отдельным параметром; `seller.ggsel.com` виден в автосгенерированном примере.
* `delete_all` везде объявлен как `string`, хотя значения выглядят как Boolean.
* `variant_id` в create-splitted-products напечатан как `intger`.
* Автопример ошибок часто содержит `NOT_FOUND` независимо от HTTP-кода и названия ошибки.
* `total_pages`/`total_count` помечены deprecated, но всё ещё присутствуют в схемах.
* list products разрешает фильтр `in_stock|sold`, а объект статуса также перечисляет `archived`.
* Поля схем часто не помечены required (кроме явно отмеченных); этот справочник не добавляет обязательность по здравому смыслу.
* В extracted-документе встречаются повторяющиеся UI-блоки языков генератора кода; они не являются дополнительными endpoint или требованиями API и намеренно исключены.
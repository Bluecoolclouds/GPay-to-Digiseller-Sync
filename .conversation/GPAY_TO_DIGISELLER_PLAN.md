# GPay Market → Digiseller: план синхронизации

Официальные источники:

- GPay Partner API: https://gpay.market/partner-api/index.html
- Digiseller Swagger: https://api.digiseller.com/swagger/ui/index
- Digiseller Swagger JSON: https://api.digiseller.com/swagger/docs/v1

## Вывод

Связка технически реализуема. GPay предоставляет каталог, партнерские цены, доступность и оформление заказов. Digiseller позволяет создавать и редактировать товары, менять цены и статусы, управлять вариантами и добавлять цифровой контент.

## Основные методы Digiseller

### Авторизация

- `POST /api/apilogin` — проверка данных продавца и подписи, получение токена.
- `GET /api/token/perms` — проверка разрешений токена.

Токен и учетные данные должны храниться только в Secrets.

### Создание товаров

- `POST /api/product/create/uniquefixed` — уникальный товар с фиксированной ценой.
- `POST /api/product/create/uniqueunfixed` — уникальный товар с нефиксированной ценой.
- `POST /api/product/create/software` — программное обеспечение.
- `POST /api/product/create/arbitrary` — произвольный цифровой товар.
- `POST /api/product/create/book` — книга.
- `GET /api/product/platform/category/add/{product_id}/{category_id}` — добавить товар в подкатегорию площадки.

Для большинства товаров GPay подходят `uniquefixed` или `arbitrary`; точный тип зависит от способа выдачи Steam Gift или ключа.

Обязательные поля базовой схемы:

- `content_type`;
- `categories`;
- `name` с локализациями;
- `description` с локализациями;
- `price`.

Типы контента: `Text`, `File`, `Url`, `DigisellerCode`, `Form`.

### Обновление и управление продажей

- `POST /api/product/edit/base/{product_id}` — изменить базовые параметры.
- `POST /api/product/edit/V2/status` — массово изменить статус товаров.
- `POST /api/product/edit/prices` — массово обновить цены.
- `GET|POST /api/products/list` — быстро получить описания товаров по ID.
- `GET /api/products/{product_id}/data` — получить информацию о товаре.

### Контент и выдача

- `POST /api/product/content/add/text` — добавить текст или URL.
- `POST /api/product/content/update/text` — обновить текстовый контент.
- `POST /api/product/content/add/file/{product_id}` — добавить файл.
- `POST /api/product/content/add/files/{product_id}/{count}` — загрузить содержимое архива.
- `GET|PUT /api/product/content/code/count` — получить или изменить количество кодов DigisellerCode.
- `POST /api/product/content/update/form` — изменить форму доставки.

### Опции и варианты

- `GET /api/products/options/list/{productId}`;
- `POST /api/products/options`;
- `POST /api/products/options/update`;
- `POST /api/products/options/{parameterId}/variants`;
- `POST /api/products/options/{parameterId}/variants/{variantId}`;
- методы удаления option/variant и настройки предварительной проверки.

## Предлагаемый процесс

```text
GPay /products/list
    ↓
фильтрация по доступности, типу и региону
    ↓
локальная таблица соответствий
gpay_product_id ↔ digiseller_product_id
    ↓
расчет цены с курсом, комиссией и наценкой
    ↓
создание товара в Digiseller
    ↓
периодическое обновление цены и статуса
    ↓
продажа в Digiseller
    ↓
повторная проверка GPay price/availability/balance
    ↓
создание и подтверждение заказа GPay
    ↓
доставка ключа или Steam Gift покупателю
```

## Что автоматизировать

1. Импорт выбранных товаров GPay.
2. Выбор категории и типа карточки Digiseller.
3. Формулу наценки по типу товара.
4. Конвертацию USD в валюту Digiseller.
5. Массовое обновление цен.
6. Отключение карточек при `isAvailable != true`.
7. Получение и обработку продаж Digiseller.
8. Закупку в GPay только после повторной проверки цены.
9. Выдачу результата и журнал всех операций.

## Безопасный MVP

- Первые карточки публикуются только после ручного одобрения.
- Закупка GPay после продажи подтверждается оператором.
- Автоматически работают импорт, пересчет цены и отключение недоступных позиций.
- После проверки возвратов и способов доставки автоматизируется закупка и выдача.

## Риски

- Нужно отдельно подтвердить правила перепродажи GPay и Digiseller.
- Нельзя считать `imageUrl` автоматическим разрешением на повторное использование изображения.
- Цена GPay указывается в USD и может измениться между синхронизацией и покупкой.
- Остатки некоторых ключей кэшируются; финальная доступность определяется при заказе.
- Для Steam Gift требуется отдельный сценарий доставки, данные Steam-профиля и контроль статуса.
- Нужна защита от двойного заказа при повторных webhook или сетевых ошибках.
- Товар следует скрывать, если GPay сообщает недоступность или предупреждение.

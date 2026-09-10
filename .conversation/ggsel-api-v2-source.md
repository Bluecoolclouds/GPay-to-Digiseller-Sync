

# SOURCE https://seller.ggsel.com/docs/v2/seller-api-v-2

Seller API V2 | GSellers API Documentation

# Seller API V2

This API uses api key for auth that is issued from seller admin page. Either `all` or specific `api_sellers/v2` permissions will work

## Authentication​

Your API key

| Security Scheme Type: | apiKey |
| --- | --- |
| Header parameter name: | Authorization |

# SOURCE https://seller.ggsel.com/docs/v2/get-async-job-result

Get async job result | GSellers API Documentation

# Get async job result

GET

Get async job result

Async job result

# SOURCE https://seller.ggsel.com/docs/v2/list-of-categories

List of categories | GSellers API Documentation

# List of categories

GET

List of categories

Unauthorized

# SOURCE https://seller.ggsel.com/docs/v2/search-categories

Search categories | GSellers API Documentation

# Search categories

GET

Search categories

# SOURCE https://seller.ggsel.com/docs/v2/view-option

View option | GSellers API Documentation

GET

View option

# SOURCE https://seller.ggsel.com/docs/v2/create-many

Create many | GSellers API Documentation

# Create many

POST

Create many

Bulk operation succeeded

# SOURCE https://seller.ggsel.com/docs/v2/list-offer-options-visible-to-seller

List offer options visible to seller | GSellers API Documentation

GET

List offer options visible to seller

List of seller-visible options

# SOURCE https://seller.ggsel.com/docs/v2/archive-options

Archive options | GSellers API Documentation

# Archive options

DELETE

Archive options

Options archived

# SOURCE https://seller.ggsel.com/docs/v2/batch-update-options-visibility

Batch update options visibility | GSellers API Documentation

# Batch update options visibility

PATCH

Batch update options visibility

Idempotent request

Invalid operation

# SOURCE https://seller.ggsel.com/docs/v2/create-or-update-variants

Create or update variants | GSellers API Documentation

# Create or update variants

POST

## /api_sellers/v2/offers/:offer_id/options/:option_id/variants

Create or update variants

All created or updated

# SOURCE https://seller.ggsel.com/docs/v2/archive-option-variants-asynchronously

Archive option variants asynchronously | GSellers API Documentation

# Archive option variants asynchronously

DELETE

## /api_sellers/v2/offers/:offer_id/options/:option_id/variants

Archive option variants asynchronously

Job created

# SOURCE https://seller.ggsel.com/docs/v2/batch-update-variants-visibility

Batch update variants visibility | GSellers API Documentation

# Batch update variants visibility

PATCH

Batch update variants visibility

Idempotent request

Invalid operation

# SOURCE https://seller.ggsel.com/docs/v2/list-products

List products | GSellers API Documentation

# List products

GET

List products

success

# SOURCE https://seller.ggsel.com/docs/v2/create-products

Create products | GSellers API Documentation

# Create products

POST

Create products

Operation succeeded

Unauthorized

# SOURCE https://seller.ggsel.com/docs/v2/archive-products

Archive products | GSellers API Documentation

# Archive products

DELETE

Archive products

# SOURCE https://seller.ggsel.com/docs/v2/list-splitted-products

List splitted products | GSellers API Documentation

# List splitted products

GET

List splitted products

success

# SOURCE https://seller.ggsel.com/docs/v2/create-splitted-products

Create splitted products | GSellers API Documentation

# Create splitted products

```
POST /api_sellers/v2/offers/:offer_id/variants/:variant_id/splitted_products
```

Create splitted products

## Request​

## Responses​

- 204
- 401
- 404
- 422

Operation succeeded

# SOURCE https://seller.ggsel.com/docs/v2/archive-splitted-products

Archive splitted products | GSellers API Documentation

# Archive splitted products

```
DELETE /api_sellers/v2/offers/:offer_id/variants/:variant_id/splitted_products
```

Archive splitted products

## Request​

## Responses​

- 200
- 400
- 401
- 404
- 422

Splitted products archive enqueued

# SOURCE https://seller.ggsel.com/docs/v2/list-offers

List offers | GSellers API Documentation

# List offers

GET

## /api_sellers/v2/offers

List offers

List of offers

Unauthorized

# SOURCE https://seller.ggsel.com/docs/v2/create-offer

Create offer | GSellers API Documentation

# Create offer

POST

Create offer

Offer created

Unauthorized

# SOURCE https://seller.ggsel.com/docs/v2/get-offer

Get offer | GSellers API Documentation

GET

- 200
- 401
- 404

Shows offer

Unauthorized

# SOURCE https://seller.ggsel.com/docs/v2/patch-offer

Patch offer | GSellers API Documentation

# Patch offer

PATCH

Patch offer

Offer updated

# SOURCE https://seller.ggsel.com/docs/v2/batch-activate-offers

Batch activate offers | GSellers API Documentation

# Batch activate offers

POST

## /api_sellers/v2/offers/batch_activate

Batch activate offers

Job enqueued

Bad request — empty offer_ids

Unauthorized

# SOURCE https://seller.ggsel.com/docs/v2/batch-pause-offers

Batch pause offers | GSellers API Documentation

# Batch pause offers

POST

Batch pause offers

Job enqueued

# SOURCE https://seller.ggsel.com/docs/v2/batch-delete-offers

Batch delete offers | GSellers API Documentation

# Batch delete offers

```
POST /api_sellers/v2/offers/batch_delete
```

Batch delete offers

## Request​

## Responses​

- 200
- 400
- 401
- 422

Job enqueued

Batch delete offers | GSellers API Documentation
[Перейти к основному содержимому](#__docusaurus_skipToContent_fallback)
# Batch delete offers
```
POST ## /api\_sellers/v2/offers/batch\_delete
```
Batch delete offers
## Request[​](#request)
## Responses[​](#responses)
* 200
* 400
* 401
* 422
Job enqueued
Bad request — empty offer\_ids
Unauthorized
Too many items

# SOURCE https://seller.ggsel.com/docs/v2/schemas/async-job-result-object

async_job_result_object | GSellers API Documentation

# async_job_result_object

job_id string required

Background job identifier

status string required

Task execution status

Possible values: [`pending`, `completed`, `failed`]

results object required

Execution results (structure depends on operation type)

property name* any

Execution results (structure depends on operation type)

async_job_result_object

```json
{  "job_id": "string",  "status": "pending",  "results": {}}
```

# SOURCE https://seller.ggsel.com/docs/v2/schemas/pagination-object

pagination_object | GSellers API Documentation

# pagination_object

page integer

limit integer

items per page

has_next_page boolean

is next page available

has_previous_page boolean

is previous page available

total_pages integer deprecated

use has_next_page and has_previous_page for navigation

total_count integer nullable deprecated

use has_next_page and has_previous_page for navigation

```json
{  "page": 0,  "limit": 0,  "has_next_page": true,  "has_previous_page": true}
```

# SOURCE https://seller.ggsel.com/docs/v2/schemas/general-error-object

general_error_object | GSellers API Documentation

# general_error_object

errors object[]

Array [

code string

Example: `NOT_FOUND`

]

general_error_object

```json
{  "errors": [    {      "code": "NOT_FOUND"    }  ]}
```

# SOURCE https://seller.ggsel.com/docs/v2/schemas/error-with-entity-object

error_with_entity_object | GSellers API Documentation

# error_with_entity_object

errors object[]

Array [

code string required

Example: `NOT_FOUND`

entity object

id integer nullable

Record ID

resource string nullable

REST resource name

description string nullable required

Error description

]

error_with_entity_object

```json
{  "errors": [    {      "code": "NOT_FOUND",      "entity": {        "id": 0,        "resource": "string",        "description": "string"      }    }  ]}
```

# SOURCE https://seller.ggsel.com/docs/v2/schemas/create-offer-request-object

create_offer_request_object | GSellers API Documentation

# create_offer_request_object

description_ru string

Product description (RU)

description_en string

Product description (EN)

instructions_ru string

Product instructions (RU)

instructions_en string

Product instructions (EN)

cover_image_ru string

Product cover image in Base64 format (RU)

cover_image_en string nullable

Product cover image in Base64 format (EN)

price number

Product price

currency string nullable

Product price is always in RUB

Possible values: [`RUB`]

is_autoselling boolean nullable

Whether automatic product delivery is enabled

Default value: `false`

category_id integer

Category ID compatible with V1 API

min_quantity integer nullable

Minimum purchase quantity

Default value: `1`

max_quantity integer nullable

Maximum purchase quantity

Default value: `1`

is_unlimited_quantity boolean nullable

Whether stock quantity is unlimited

Default value: `false`

post_payment_url string nullable

Product fulfillment URL in merchant system

Default value: ``

delivery string nullable

auto - automatically set delivery status together with fulfillment time manual - manual delivery status update

Possible values: [`auto`, `manual`]

Default value: `auto`

pre_payment_settings object nullable

is_enabled boolean

Whether pre-payment validation settings are enabled

Default value: `false`

url string nullable

Merchant notification URL

allow_payment boolean

Allow payment when validation request fails

Default value: `true`

notification_settings object nullable

type string nullable

Merchant notification type for new order

Possible values: [`email`, `url`]

Default value: `email`

url string nullable

Merchant notification URL

email string nullable

Merchant notification email

http_method string nullable

Notification HTTP method

Possible values: [`GET`, `POST`]

is_disabled boolean

Whether notifications are disabled

Default value: `false`

is_default boolean

If true, notifications will be sent only by email

Default value: `true`

create_offer_request_object

```json
{  "title_ru": "string",  "title_en": "string",  "description_ru": "string",  "description_en": "string",  "instructions_ru": "string",  "instructions_en": "string",  "cover_image_ru": "string",  "cover_image_en": "string",  "price": 0,  "currency": "RUB",  "is_autoselling": false,  "category_id": 0,  "min_quantity": 1,  "max_quantity": 1,  "quantity": 0,  "is_unlimited_quantity": false,  "post_payment_url": "",  "delivery": "auto",  "pre_payment_settings": {    "is_enabled": false,    "url": "string",    "allow_payment": true  },  "notification_settings": {    "type": "email",    "url": "string",    "email": "string",    "http_method": "GET",    "is_disabled": false,    "is_default": true  }}
```
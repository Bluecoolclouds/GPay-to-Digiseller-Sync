---
name: Digiseller buyer chat promotions
description: Operational rule for the one-time promo codes sent through Digiseller buyer chats.
---

One-time promo codes sent after delivery are valid for 30 days and are redeemed atomically when the buyer sends the code in a later Digiseller order chat. The system confirms registration, but the 5% discount is applied manually by an operator before the buyer pays.

**Why:** The official Digiseller API documents cart/payment transitions, price calculation, quantity discounts, and regular-buyer discounts calculated from email, but no endpoint for creating or applying a seller-defined one-time coupon to a specific unpaid order. Product-level price edits are not a safe substitute because they affect shared catalog state and cannot bind an uncertain mutation to one buyer. Claiming automatic application would be misleading and could create a double discount after an ambiguous response.

**How to apply:** Keep customer-facing copy explicit that the code registers one request, the operator must confirm the new price before payment, and paid orders cannot receive the discount. Do not change this to automatic checkout discounting without first confirming and testing an official buyer/order-scoped Digiseller mechanism.
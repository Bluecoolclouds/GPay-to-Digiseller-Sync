type ProductDescriptionInput = {
  productId: number;
  cleanName: string;
  platform: string;
  region: string;
  productKind: "key" | "gift" | "unknown";
};

const instantDeliveryRu = [
  [
    "🚀 Автоматическая выдача цифрового ключа сразу после оплаты — сервис работает круглосуточно.",
    "🔑 Страница с вашим ключом откроется в окне завершённого заказа.",
    "📧 Копия ключа также придёт на электронную почту, указанную при оформлении покупки.",
  ],
  [
    "🚀 Получите ключ автоматически в любое время суток: выдача запускается сразу после успешного платежа.",
    "🔑 После оплаты откроется страница заказа, где будет доступен ключ активации.",
    "📧 Дополнительно ключ отправляется на e-mail, который вы укажете при покупке.",
  ],
  [
    "🚀 Ключ выдаётся моментально и без ожидания оператора, 24 часа в сутки.",
    "🔑 Сразу после подтверждения оплаты вы увидите его на странице оформленного заказа.",
    "📧 Этот же ключ будет продублирован на указанную при оформлении электронную почту.",
  ],
] as const;

const instantDeliveryEn = [
  [
    "🚀 Your digital key is delivered automatically as soon as payment is confirmed, 24/7.",
    "🔑 The page containing your key will open in the completed order window.",
    "📧 A copy of the key will also be sent to the email address entered at checkout.",
  ],
  [
    "🚀 Receive your key automatically at any time of day, immediately after successful payment.",
    "🔑 Once payment is complete, the activation key will appear on your order page.",
    "📧 The key is also sent to the email address you provide during checkout.",
  ],
  [
    "🚀 Instant key delivery is available around the clock with no operator wait.",
    "🔑 After payment confirmation, the key becomes available on the completed order page.",
    "📧 The same key will be delivered to the email address entered with the order.",
  ],
] as const;

const giftPromoRu = [
  {
    title: "🎁 ПОДАРОК — случайный ключ к игре в Steam",
    intro:
      "Купите товар у нас, оставьте положительный отзыв и получите дополнительный Steam-ключ к случайной игре. Название игры станет известно после отправки подарка в переписку на странице заказа.<br>",
    steps: [
      "1️⃣ Оформите и оплатите покупку.",
      "2️⃣ Оставьте положительный отзыв в свободной форме.",
      '3️⃣ Напишите в «Переписку с продавцом» на странице заказа: «Хочу подарок».',
    ],
  },
  {
    title: "🎁 БОНУС ЗА ОТЗЫВ — случайная игра для Steam",
    intro:
      "После покупки и положительного отзыва мы подарим вам ключ от случайной Steam-игры. Узнать, какая игра выпала, можно будет в переписке по завершённому заказу.<br>",
    steps: [
      "1️⃣ Приобретите у нас любой товар.",
      "2️⃣ Поделитесь положительным отзывом о покупке.",
      '3️⃣ В сообщениях к заказу отправьте фразу «Хочу подарок».',
    ],
  },
  {
    title: "🎁 СЛУЧАЙНЫЙ STEAM-КЛЮЧ В ПОДАРОК",
    intro:
      "За оформленный заказ и положительный отзыв вы можете получить бонусный ключ к случайной игре Steam. Подарок отправляется через переписку на странице вашей покупки.<br>",
    steps: [
      "1️⃣ Совершите покупку в нашем магазине.",
      "2️⃣ Оставьте положительный отзыв.",
      '3️⃣ Откройте «Переписку с продавцом» и напишите «Хочу подарок».',
    ],
  },
] as const;

const giftPromoEn = [
  {
    title: "🎁 BONUS — a random Steam game key",
    intro:
      "Buy from us, leave a positive review, and receive a bonus key for a random Steam game. The title will be revealed when the gift is sent through the order conversation.<br>",
  },
  {
    title: "🎁 REVIEW BONUS — a random Steam game",
    intro:
      "After your purchase and positive review, we will send you a key for a random Steam game through the conversation on your completed order.<br>",
  },
  {
    title: "🎁 GET A RANDOM STEAM KEY AS A GIFT",
    intro:
      "A completed purchase and positive review qualify you for a bonus key to a random Steam game, delivered through your order conversation.<br>",
  },
] as const;

function variantIndex(productId: number) {
  return Math.abs(productId) % instantDeliveryRu.length;
}

export function buildProductDescriptions(input: ProductDescriptionInput) {
  const index = variantIndex(input.productId);
  const typeRu =
    input.productKind === "gift" ? "Steam Gift" : "цифровой ключ";
  const typeEn =
    input.productKind === "gift" ? "Steam Gift" : "digital activation key";
  const deliveryRu =
    input.productKind === "gift"
      ? [
          "После оформления заказа потребуется ссылка на ваш профиль Steam. Подарок отправляется после обработки заказа.",
        ]
      : [...instantDeliveryRu[index]];
  const deliveryEn =
    input.productKind === "gift"
      ? [
          "After placing the order, provide your Steam profile link. The gift is sent after the order is processed.",
        ]
      : [...instantDeliveryEn[index]];
  const promoRu = giftPromoRu[index];
  const promoEn = giftPromoEn[index];

  return {
    descriptionRu: [
      ...deliveryRu,
      "",
      `${input.cleanName} — ${typeRu} для ${input.platform}.`,
      "",
      "Информация о товаре:",
      `• Платформа: ${input.platform}`,
      `• Тип товара: ${typeRu}`,
      `• Регион активации: ${input.region}`,
      "",
      "Перед покупкой убедитесь, что выбранный регион и платформа подходят для вашего аккаунта.",
      "",
      promoRu.title,
      "",
      promoRu.intro,
      "",
      "Для получения подарка:",
      ...promoRu.steps,
      "",
      "⚠️ За один заказ можно получить только один подарочный ключ.",
    ].join("\n"),
    descriptionEn: [
      ...deliveryEn,
      "",
      `${input.cleanName} — ${typeEn} for ${input.platform}.`,
      "",
      "Product information:",
      `• Platform: ${input.platform}`,
      `• Product type: ${typeEn}`,
      `• Activation region: ${input.region}`,
      "",
      "Before purchasing, make sure the selected platform and activation region are suitable for your account.",
      "",
      promoEn.title,
      "",
      promoEn.intro,
      "",
      "How to receive the gift:",
      "1️⃣ Complete a purchase from our store.",
      "2️⃣ Leave a positive review in your own words.",
      '3️⃣ Write “I want a gift” in the seller conversation on the order page.',
      "",
      "⚠️ Each order qualifies for one bonus key only.",
    ].join("\n"),
  };
}
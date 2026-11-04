import { Bot, webhookCallback, Context } from "grammy";
import { parsePhoneNumber } from "libphonenumber-js";

export interface Env {
  BOT_TOKEN: string;
  OSINT_KV: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const bot = new Bot(env.BOT_TOKEN);

    // Команда /start (без изменений)
    bot.command("start", async (ctx: Context) => {
      await ctx.reply(
        "👋 <b>OSINT-бот</b>\n\n" +
        "Просто отправьте мне email или номер телефона, и я проверю открытые источники.\n\n" +
        "⚠️ Только публичные данные.",
        { parse_mode: "HTML" }
      );
    });

    // Обработчик всех текстовых сообщений (не команд)
    bot.on("message:text", async (ctx: Context) => {
      const text = ctx.message.text.trim();

      // Игнорируем команды (они обрабатываются выше)
      if (text.startsWith("/")) return;

      // --- ЛОГИКА ОПРЕДЕЛЕНИЯ ТИПА ---
      if (text.includes("@")) {
        // Это похоже на email -> проверяем утечки
        await handleEmailCheck(ctx, text, env);
      } else {
        // Пытаемся распознать как телефон -> выдаем информацию
        await handlePhoneCheck(ctx, text, env);
      }
    });

    return webhookCallback(bot, "cloudflare-mod")(request);
  },
};

// ============================================
// ЛОГИКА ДЛЯ EMAIL (XposedOrNot + KV Cache)
// ============================================
async function handleEmailCheck(ctx: Context, email: string, env: Env) {
  // 1. Локальная валидация (защита квоты)
  // Простая проверка, чтобы не гонять API на явный мусор
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return ctx.reply("❌ Похоже на невалидный email. Проверьте формат.");
  }

  const cacheKey = `email:${email.toLowerCase()}`;

  // 2. Проверка кэша KV (защита от повторных запросов)
  const cached = await env.OSINT_KV.get(cacheKey, "json");
  if (cached) {
    return ctx.reply(formatBreachReport(email, cached.breaches), { parse_mode: "HTML" });
  }

  // 3. Запрос к XposedOrNot (бесплатный API)
  await ctx.reply("🔎 Проверяю утечки...");

  try {
    const res = await fetch(`https://api.xposedornot.com/v1/check-email/${encodeURIComponent(email)}`);

    // Обработка 404 (означает, что утечек не найдено)
    if (res.status === 404) {
      const result = { breaches: [] };
      // Кэшируем результат "не найден" на 24 часа, чтобы не спамить API
      await env.OSINT_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: 86400 });
      return ctx.reply(formatBreachReport(email, []), { parse_mode: "HTML" });
    }

    if (!res.ok) {
      return ctx.reply("❌ Не удалось проверить утечки. Попробуйте позже.");
    }

    const data: any = await res.json();
    // XposedOrNot может возвращать массив внутри массива или просто массив
    const breaches: string[] = data.breaches?.flat() || [];

    // Кэшируем результат на 24 часа
    await env.OSINT_KV.put(cacheKey, JSON.stringify({ breaches }), { expirationTtl: 86400 });

    return ctx.reply(formatBreachReport(email, breaches), { parse_mode: "HTML" });

  } catch (e) {
    console.error(e);
    await ctx.reply("❌ Ошибка при запросе к API утечек.");
  }
}

// ============================================
// ЛОГИКА ДЛЯ ТЕЛЕФОНА (Локальная + Ссылки)
// ============================================
async function handlePhoneCheck(ctx: Context, rawPhone: string, env: Env) {
  // 1. Локальная валидация через libphonenumber-js
  let phone;
  try {
    phone = parsePhoneNumber(rawPhone);
    if (!phone || !phone.isValid()) {
      // Если это не похоже на телефон, просто игнорируем (или можно ответить подсказкой)
      return ctx.reply("🤔 Не могу распознать это как email или номер телефона.");
    }
  } catch {
    return ctx.reply("❌ Не удалось распознать номер. Попробуйте формат +79991234567.");
  }

  const e164 = phone.number; // Формат E.164
  const country = phone.country || "неизвестно";
  const type = phone.getType() || "неизвестен";

  // 2. Формируем структурированный ответ (без платных API)
  const lines = [
    `📞 <b>Номер:</b> ${e164}`,
    `🌍 <b>Страна:</b> ${country}`,
    `📱 <b>Тип линии:</b> ${type}`,
    ``,
    `👤 <b>Аккаунты в соцсетях:</b>`,
    `<i>Автоматическая проверка недоступна в бесплатном режиме.</i>`,
    ``,
    `🔗 <b>Проверить вручную:</b>`,
    `<a href="https://www.google.com/search?q='${e164}'">Google</a> | ` +
    `<a href="https://www.truecaller.com/search/${e164.replace('+','')}">Truecaller</a>`,
  ];

  await ctx.reply(lines.join("\n"), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

// ============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================
function formatBreachReport(email: string, breaches: string[]): string {
  if (breaches.length === 0) {
    return `✅ <b>${email}</b>\nВ известных публичных утечках не найден.`;
  }

  const lines = [
    `📧 <b>${email}</b>`,
    `⚠️ Найден в <b>${breaches.length}</b> утечках:`,
    ...breaches.slice(0, 15).map((b: string) => `• ${b}`),
  ];

  if (breaches.length > 15) {
    lines.push(`... и ещё ${breaches.length - 15}`);
  }

  return lines.join("\n");
}

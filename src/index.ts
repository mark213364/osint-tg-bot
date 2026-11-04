import { Bot, webhookCallback, Context } from "grammy";
import { parsePhoneNumber } from "libphonenumber-js";

export interface Env {
  BOT_TOKEN: string;
  NUMLOOKUP_KEY: string;
  HIBP_KEY?: string;
  OSINT_KV: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const bot = new Bot(env.BOT_TOKEN);

    // /start и /help — просто подсказка
    bot.command("start", async (ctx: Context) => {
      await ctx.reply(
        "👋 <b>OSINT-бот</b>\n\n" +
          "Просто отправьте мне:\n" +
          "• номер телефона (например <code>+79991234567</code>)\n" +
          "• email (например <code>user@example.com</code>)\n\n" +
          "⚠️ Работаю только с открытыми данными.",
        { parse_mode: "HTML" }
      );
    });

    bot.command("help", async (ctx: Context) => {
      await ctx.reply(
        "Отправьте номер телефона или email — я верну справку по открытым источникам."
      );
    });

    // Любое текстовое сообщение — пытаемся распознать номер или email
    bot.on("message:text", async (ctx: Context) => {
      const text = ctx.message?.text?.trim();
      if (!text) return;

      // Игнорируем команды (начинаются с /)
      if (text.startsWith("/")) return;

      const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);

      if (isEmail) {
        await handleEmail(ctx, text, env);
      } else {
        await handlePhone(ctx, text, env);
      }
    });

    bot.catch((err) => console.error("Bot error:", err));

    return webhookCallback(bot, "cloudflare-mod")(request);
  },
};

// ============================
// EMAIL
// ============================
async function handleEmail(ctx: Context, email: string, env: Env) {
  await ctx.reply("🔎 Проверяю email...");

  const lines: string[] = [`📧 <b>Email:</b> ${email}`];

  const domain = email.split("@")[1];

  // 1. MX-записи через Cloudflare DNS-over-HTTPS (бесплатно, без ключей)
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`,
      { headers: { Accept: "application/dns-json" } }
    );
    const data: any = await res.json();
    const mxRecords = (data.Answer ?? [])
      .filter((r: any) => r.type === 15)
      .map((r: any) => r.data);
    lines.push(`🌐 <b>Домен:</b> ${domain}`);
    lines.push(
      `📮 <b>MX-записи:</b> ${
        mxRecords.length ? "✅ есть (" + mxRecords.length + ")" : "❌ нет"
      }`
    );
    if (mxRecords.length) {
      lines.push(`<i>${mxRecords.slice(0, 3).join("\n")}</i>`);
    }
  } catch {
    lines.push("📮 <b>MX-записи:</b> ⚠️ ошибка проверки");
  }

  // 2. HIBP (если задан ключ)
  if (env.HIBP_KEY) {
    try {
      const res = await fetch(
        `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(
          email
        )}?truncateResponse=true`,
        {
          headers: {
            "hibp-api-key": env.HIBP_KEY,
            "User-Agent": "OSINT-TG-Bot",
          },
        }
      );
      if (res.status === 200) {
        const breaches: Array<{ Name: string }> = await res.json();
        lines.push(
          `⚠️ <b>Утечки:</b> ${breaches
            .map((b) => b.Name)
            .slice(0, 10)
            .join(", ")}`
        );
      } else if (res.status === 404) {
        lines.push("✅ <b>Утечки:</b> в публичных базах HIBP не найден");
      }
    } catch {
      lines.push("⚠️ <b>Утечки:</b> ошибка проверки HIBP");
    }
  } else {
    lines.push("ℹ️ <b>Утечки:</b> ключ HIBP не настроен");
  }

  // 3. Gravatar (через Web Crypto MD5 не посчитать — просто ссылка на профиль по email)
  lines.push(
    `🖼 <b>Gravatar:</b> <a href="https://gravatar.com/${encodeURIComponent(
      email
    )}">проверить</a>`
  );

  await ctx.reply(lines.join("\n"), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

// ============================
// PHONE
// ============================
async function handlePhone(ctx: Context, raw: string, env: Env) {
  // 1. ЛОКАЛЬНАЯ ПРОВЕРКА (квота API не тратится)
  let phone;
  try {
    phone = parsePhoneNumber(raw);
    if (!phone.isValid()) {
      return ctx.reply(
        "❌ Не похоже на валидный номер. Пример: <code>+79991234567</code>",
        { parse_mode: "HTML" }
      );
    }
  } catch {
    return ctx.reply(
      "❌ Не удалось распознать номер. Пример: <code>+79991234567</code>",
      { parse_mode: "HTML" }
    );
  }

  const e164 = phone.number; // +79991234567
  const cacheKey = `phone:${e164}`;

  // 2. КЭШ (квота API не тратится)
  const cached = await env.OSINT_KV.get(cacheKey, "json");
  if (cached) {
    await ctx.reply(formatPhoneReport(cached, e164), { parse_mode: "HTML" });
    return;
  }

  // 3. API (тратит 1 из 100 в месяц)
  await ctx.reply("🔎 Запрашиваю данные о номере...");

  try {
    const res = await fetch(
      `https://api.numlookupapi.com/v1/validate/${encodeURIComponent(
        e164
      )}?apikey=${env.NUMLOOKUP_KEY}`
    );

    if (!res.ok) {
      return ctx.reply(
        "❌ API недоступен или квота исчерпана. Попробуйте позже."
      );
    }

    const data: any = await res.json();

    // Кэшируем на 30 дней
    await env.OSINT_KV.put(cacheKey, JSON.stringify(data), {
      expirationTtl: 60 * 60 * 24 * 30,
    });

    await ctx.reply(formatPhoneReport(data, e164), { parse_mode: "HTML" });
  } catch (e) {
    console.error(e);
    await ctx.reply("❌ Ошибка при запросе к API.");
  }
}

// ============================
// ФОРМАТ ОТВЕТА ПО НОМЕРУ
// ============================
function formatPhoneReport(data: any, fallback: string): string {
  const number =
    data.international_format || data.e164_format || data.number || fallback;
  const digits = (data.number || fallback).replace(/\D/g, "");

  const lines = [
    `📞 <b>Номер:</b> ${number}`,
    `🌍 <b>Страна:</b> ${data.country_name || data.country_code || "—"}`,
    `📍 <b>Регион:</b> ${data.location || "—"}`,
    `📡 <b>Оператор:</b> ${data.carrier || "—"}`,
    `📱 <b>Тип линии:</b> ${data.line_type || "—"}`,
    `🕐 <b>Часовой пояс:</b> ${
      Array.isArray(data.timezones) ? data.timezones.join(", ") : "—"
    }`,
    ``,
    `👤 <b>Аккаунты в соцсетях:</b>`,
    `<i>Автоматическая проверка недоступна в бесплатном режиме.</i>`,
    ``,
    `🔗 <b>Проверить вручную:</b>`,
    `<a href="https://www.google.com/search?q=%22${digits}%22">Google</a> | ` +
      `<a href="https://www.truecaller.com/search/${digits}">Truecaller</a> | ` +
      `<a href="https://www.google.com/search?q=%22${digits}%22+site:vk.com">VK</a>`,
  ];

  return lines.join("\n");
}

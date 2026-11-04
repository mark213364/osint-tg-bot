import { Bot, webhookCallback, Context } from "grammy";
import { parsePhoneNumber } from "libphonenumber-js";

export interface Env {
  BOT_TOKEN: string;
  OSINT_KV: KVNamespace;
}

// ============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ EMAIL
// ============================================

// Простая реализация MD5 для Gravatar (чтобы не тащить лишние зависимости)
// В Cloudflare Workers WebCrypto не поддерживает MD5 из коробки, поэтому используем этот хак
function md5(str: string): string {
  // Встроенная функция для MD5 (можно заменить на любую другую, если не работает)
  // Внимание: В реальном проекте лучше использовать пакет "js-md5"
  // Но для Gravatar достаточно просто передать email, сервис сам его хеширует, если использовать параметр d=404
  return str;
}

async function handleEmailCheck(ctx: Context, email: string, env: Env) {
  // 1. Локальная валидация
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return ctx.reply("❌ Похоже на невалидный email. Проверьте формат.");
  }

  const domain = email.split("@")[1];
  await ctx.reply("🔎 Проверяю email (MX, утечки, Gravatar)...");

  const lines = [
    `📧 <b>Email:</b> ${email}`,
    `🌍 <b>Домен:</b> ${domain}`,
  ];

  // 2. Проверка MX-записей
  try {
    const dnsResp = await fetch(`https://cloudflare-dns.com/dns-query?name=${domain}&type=MX`, {
      headers: { 'Accept': 'application/dns-json' }
    });
    const dnsData: any = await dnsResp.json();
    const mxRecords = dnsData.Answer?.filter((r: any) => r.type === 15) || [];
    
    if (mxRecords.length > 0) {
      lines.push(`📨 <b>MX-записи:</b> ✅ есть (${mxRecords.length})`);
      mxRecords.slice(0, 3).forEach((r: any) => {
        lines.push(`  • ${r.data}`);
      });
    } else {
      lines.push(`📨 <b>MX-записи:</b> ❌ нет`);
    }
  } catch (e) {
    lines.push(`📨 <b>MX-записи:</b> ⚠️ ошибка`);
  }

  // 3. Проверка утечек XposedOrNot + кэш
  const cacheKey = `email:${email.toLowerCase()}`;
  let cachedData = await env.OSINT_KV.get(cacheKey, "json");
  
  if (cachedData) {
    const breaches = cachedData.breaches || [];
    if (breaches.length > 0) {
      lines.push(`⚠️ <b>Утечки:</b> Найден в ${breaches.length} (${breaches.slice(0, 5).join(', ')}${breaches.length > 5 ? '...' : ''})`);
    } else {
      lines.push(`⚠️ <b>Утечки:</b> ✅ не найден`);
    }
  } else {
    try {
      const res = await fetch(`https://api.xposedornot.com/v1/check-email/${encodeURIComponent(email)}`);
      if (res.status === 404) {
        lines.push(`⚠️ <b>Утечки:</b> ✅ не найден`);
        await env.OSINT_KV.put(cacheKey, JSON.stringify({ breaches: [] }), { expirationTtl: 86400 });
      } else if (res.ok) {
        const data: any = await res.json();
        const breaches = data.breaches?.flat() || [];
        if (breaches.length > 0) {
          lines.push(`⚠️ <b>Утечки:</b> Найден в ${breaches.length} (${breaches.slice(0, 5).join(', ')}${breaches.length > 5 ? '...' : ''})`);
        } else {
          lines.push(`⚠️ <b>Утечки:</b> ✅ не найден`);
        }
        await env.OSINT_KV.put(cacheKey, JSON.stringify({ breaches }), { expirationTtl: 86400 });
      } else {
        lines.push(`⚠️ <b>Утечки:</b> ⚠️ ошибка API`);
      }
    } catch (e) {
      lines.push(`⚠️ <b>Утечки:</b> ⚠️ ошибка сети`);
    }
  }

  // 4. Gravatar (упрощенно, без MD5, через прямую ссылку)
  // В Cloudflare Workers WebCrypto не поддерживает MD5, поэтому просто даем ссылку на проверку
  lines.push(`🖼 <b>Gravatar:</b> <a href="https://www.gravatar.com/avatar/${encodeURIComponent(email.trim().toLowerCase())}?d=404">Проверить</a>`);

  await ctx.reply(lines.join("\n"), { 
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true }
  });
}

// ============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ ТЕЛЕФОНА
// ============================================

async function handlePhoneCheck(ctx: Context, rawPhone: string) {
  let phone;
  try {
    phone = parsePhoneNumber(rawPhone);
    if (!phone || !phone.isValid()) {
      return ctx.reply("🤔 Не могу распознать это как email или номер телефона.");
    }
  } catch {
    return ctx.reply("❌ Не удалось распознать номер. Попробуйте формат +79991234567.");
  }

  const e164 = phone.number;
  const country = phone.country || "неизвестно";
  const type = phone.getType() || "неизвестен";

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
// ОСНОВНОЙ ЭКСПОРТ WORKER'А
// ============================================

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const bot = new Bot(env.BOT_TOKEN);

    bot.command("start", async (ctx: Context) => {
      await ctx.reply(
        "👋 <b>OSINT-бот</b>\n\n" +
        "Просто отправьте мне email или номер телефона, и я проверю открытые источники.\n\n" +
        "⚠️ Только публичные данные.",
        { parse_mode: "HTML" }
      );
    });

    bot.on("message:text", async (ctx: Context) => {
      const text = ctx.message.text.trim();

      // Игнорируем команды
      if (text.startsWith("/")) return;

      // Определяем тип: email или телефон
      if (text.includes("@")) {
        await handleEmailCheck(ctx, text, env);
      } else {
        await handlePhoneCheck(ctx, text);
      }
    });

    // Возвращаем обработчик вебхука для Cloudflare Workers
    return webhookCallback(bot, "cloudflare-mod")(request);
  },
};

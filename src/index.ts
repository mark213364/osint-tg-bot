import { Bot, webhookCallback, Context } from "grammy";

export interface Env {
  BOT_TOKEN: string;
  HIBP_KEY?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const bot = new Bot(env.BOT_TOKEN);

    bot.command("start", async (ctx: Context) => {
      await ctx.reply(
        "👋 <b>OSINT-бот</b>\n\n" +
        "/email user@example.com — проверка email\n" +
        "/phone +79991234567 — информация о номере\n\n" +
        "⚠️ Только открытые данные.",
        { parse_mode: "HTML" }
      );
    });

    bot.command("email", async (ctx: Context) => {
      const email = ctx.match?.trim();
      if (!email || !email.includes("@")) {
        return ctx.reply("Формат: /email user@example.com");
      }

      await ctx.reply("🔎 Проверяю...");
      const lines = [`📧 <b>${email}</b>`];

      // Проверка MX через Cloudflare DNS
      try {
        const domain = email.split("@")[1];
        const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${domain}&type=MX`, {
          headers: { Accept: "application/dns-json" },
        });
        const data: any = await res.json();
        const hasMx = (data.Answer ?? []).some((r: any) => r.type === 15);
        lines.push(`MX-записи: ${hasMx ? "✅ есть" : "❌ нет"}`);
      } catch {
        lines.push("MX-записи: ⚠️ ошибка");
      }

      // HIBP (если ключ задан)
      if (env.HIBP_KEY) {
        try {
          const res = await fetch(
            `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}?truncateResponse=true`,
            { headers: { "hibp-api-key": env.HIBP_KEY, "User-Agent": "OSINT-Bot" } }
          );
          if (res.status === 200) {
            const breaches = await res.json();
            lines.push(`⚠️ Утечки: ${breaches.map((b: any) => b.Name).join(", ")}`);
          } else if (res.status === 404) {
            lines.push("✅ В утечках не найден");
          }
        } catch {
          lines.push("⚠️ Ошибка HIBP");
        }
      }

      await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
    });

    bot.command("phone", async (ctx: Context) => {
      const raw = ctx.match?.trim();
      if (!raw) return ctx.reply("Формат: /phone +79991234567");

      let clean = raw.replace(/[^\d+]/g, "");
      if (clean.startsWith("8") && clean.length === 11) clean = "+7" + clean.slice(1);
      if (clean.startsWith("7") && clean.length === 11) clean = "+" + clean;

      if (!clean.startsWith("+7") || clean.length !== 12) {
        return ctx.reply("❌ Пока поддержка только РФ (+7/8XXXXXXXXXX)");
      }

      const def = clean.slice(2, 5);
      const ops: Record<string, string> = {
        "900": "Билайн", "901": "Билайн", "902": "Билайн", "903": "Билайн", "904": "Билайн",
        "905": "Билайн", "906": "Билайн", "908": "Билайн", "909": "Билайн",
        "910": "МТС", "911": "МТС", "912": "МТС", "913": "МТС", "914": "МТС",
        "915": "МТС", "916": "МТС", "917": "МТС", "918": "МТС", "919": "МТС",
        "920": "МегаФон", "921": "МегаФон", "922": "МегаФон", "923": "МегаФон",
        "924": "МегаФон", "925": "МегаФон", "926": "МегаФон", "927": "МегаФон",
        "928": "МегаФон", "929": "МегаФон",
        "930": "Tele2", "931": "Tele2", "932": "Tele2", "933": "Tele2",
        "934": "Tele2", "935": "Tele2", "936": "Tele2", "937": "Tele2",
        "938": "Tele2", "939": "Tele2",
      };

      await ctx.reply(
        `📞 <b>+7 (${def}) ...</b>\nОператор: ${ops[def] || "неизвестен"}\nРегион: РФ`,
        { parse_mode: "HTML" }
      );
    });

    // Обработка вебхука для Cloudflare
    return webhookCallback(bot, "cloudflare-mod")(request);
  },
};

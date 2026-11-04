import { parsePhoneNumber } from 'libphonenumber-js';

bot.command("phone", async (ctx) => {
  const raw = ctx.match?.trim();
  if (!raw) return ctx.reply("Формат: /phone +79991234567");

  // 1. ЛОКАЛЬНАЯ ПРОВЕРКА (квота не тратится)
  let phone;
  try {
    phone = parsePhoneNumber(raw);
    if (!phone.isValid()) {
      return ctx.reply("❌ Номер невалиден. Проверьте формат.");
    }
  } catch {
    return ctx.reply("❌ Не удалось распознать номер.");
  }

  const e164 = phone.number; // например +79991234567
  const cacheKey = `phone:${e164}`;

  // 2. ПРОВЕРКА КЭША (квота не тратится)
  const cached = await env.OSINT_KV.get(cacheKey, "json");
  if (cached) {
    return ctx.reply(formatPhoneReport(cached), { parse_mode: "HTML" });
  }

  // 3. ЗАПРОС К API (тратит 1 из 100)
  await ctx.reply("🔎 Запрашиваю данные...");
  
  try {
    const res = await fetch(
      `https://api.numlookupapi.com/v1/validate/${encodeURIComponent(e164)}`,
      { headers: { apikey: env.NUMLOOKUP_KEY } }
    );
    
    if (!res.ok) {
      return ctx.reply("❌ API временно недоступен или квота исчерпана.");
    }
    
    const data = await res.json();
    
    // Сохраняем в кэш на 30 дней, чтобы не тратить квоту повторно
    await env.OSINT_KV.put(cacheKey, JSON.stringify(data), {
      expirationTtl: 60 * 60 * 24 * 30,
    });
    
    return ctx.reply(formatPhoneReport(data), { parse_mode: "HTML" });
    
  } catch (e) {
    console.error(e);
    return ctx.reply("❌ Ошибка при запросе к API.");
  }
});

// Функция форматирования ответа в нужном вам виде
function formatPhoneReport(data: any): string {
  return [
    `📞 <b>Номер:</b> ${data.international_format || data.e164_format || data.number || "—"}`,
    `🌍 <b>Страна:</b> ${data.country_name || "—"}`,
    `📍 <b>Регион/Город:</b> ${data.location || "—"}`,
    `📡 <b>Оператор:</b> ${data.carrier || "—"}`,
    `📱 <b>Тип линии:</b> ${data.line_type || "—"}`,
    `🕐 <b>Часовой пояс:</b> ${(data.timezones || []).join(", ") || "—"}`,
    ``,
    `👤 <b>Аккаунты в соцсетях:</b>`,
    `<i>Автоматическая проверка недоступна. Используйте ссылки ниже для ручного поиска.</i>`,
    ``,
    `🔗 <a href="https://www.google.com/search?q='${data.e164_format || data.number}'">Google</a> | <a href="https://www.truecaller.com/search/${(data.number || "").replace('+','')}">Truecaller</a>`,
  ].join("\n");
}

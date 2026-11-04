async function handleEmailCheck(ctx: Context, email: string, env: Env) {
  // 1. Локальная валидация
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return ctx.reply("❌ Похоже на невалидный email. Проверьте формат.");
  }

  const domain = email.split("@")[1];
  await ctx.reply("🔎 Проверяю email (MX, утечки, Gravatar)...");

  // Массив для сбора строк ответа
  const lines = [
    `📧 <b>Email:</b> ${email}`,
    `🌍 <b>Домен:</b> ${domain}`,
  ];

  // 2. Проверка MX-записей (через бесплатный Cloudflare DNS)
  try {
    const dnsResp = await fetch(`https://cloudflare-dns.com/dns-query?name=${domain}&type=MX`, {
      headers: { 'Accept': 'application/dns-json' }
    });
    const dnsData: any = await dnsResp.json();
    const mxRecords = dnsData.Answer?.filter((r: any) => r.type === 15) || [];
    
    if (mxRecords.length > 0) {
      lines.push(`📨 <b>MX-записи:</b> ✅ есть (${mxRecords.length})`);
      // Показываем первые 3 записи, чтобы не спамить
      mxRecords.slice(0, 3).forEach((r: any) => {
        lines.push(`  • ${r.data}`);
      });
    } else {
      lines.push(`📨 <b>MX-записи:</b> ❌ нет`);
    }
  } catch (e) {
    lines.push(`📨 <b>MX-записи:</b> ⚠️ ошибка`);
  }

  // 3. Проверка утечек через XposedOrNot (бесплатно)
  // Используем кэш, чтобы не спамить API
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

  // 4. Проверка Gravatar (через Web Crypto API)
  try {
    // Хешируем email в MD5 (встроенный Web Crypto в Cloudflare Workers)
    const msgBuffer = new TextEncoder().encode(email.trim().toLowerCase());
    const hashBuffer = await crypto.subtle.digest('MD5' as any, msgBuffer).catch(() => null);
    
    if (hashBuffer) {
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      const gravatarUrl = `https://www.gravatar.com/avatar/${hashHex}?d=404`;
      
      const gravatarCheck = await fetch(gravatarUrl, { method: 'HEAD' });
      if (gravatarCheck.status === 200) {
        lines.push(`🖼 <b>Gravatar:</b> <a href="https://www.gravatar.com/avatar/${hashHex}">Профиль</a>`);
      } else {
        lines.push(`🖼 <b>Gravatar:</b> не найден`);
      }
    }
  } catch (e) {
    // Игнорируем ошибки Gravatar, если WebCrypto не поддерживает MD5
    lines.push(`🖼 <b>Gravatar:</b> проверить вручную`);
  }

  // Отправляем итоговый ответ
  await ctx.reply(lines.join("\n"), { 
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true }
  });
}

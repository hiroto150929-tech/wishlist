// fetch-meta: 商品ページのURLから「名前・価格・画像」を取り出して返す Edge Function
//
// 呼び出し: supabase.functions.invoke("fetch-meta", { body: { url } })
// 返り値:   { title: string|null, price: number|null, image: string|null }
//
// ログイン中のユーザーだけが呼べます(JWT検証をオンのままにしてください)。

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// 社内ネットワークなどへのアクセスを防ぐ
function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true;
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return h.includes(":");
  return false;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

// <meta> タグを { property/name/itemprop: content } にまとめる
function readMeta(html: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/([a-zA-Z_:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attrs[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? "";
    }
    const key = (attrs.property || attrs.name || attrs.itemprop || "").toLowerCase();
    if (key && attrs.content && !map.has(key)) map.set(key, decodeEntities(attrs.content.trim()));
  }
  return map;
}

// JSON-LD(構造化データ)から Product を探す
function readJsonLd(html: string): { name?: string; image?: string; price?: string } {
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const stack: unknown[] = [data];
    while (stack.length) {
      const node = stack.pop();
      if (Array.isArray(node)) { stack.push(...node); continue; }
      if (!node || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;
      if (o["@graph"]) stack.push(o["@graph"]);
      const type = String(o["@type"] ?? "");
      if (/product/i.test(type)) {
        let image = o.image as unknown;
        if (Array.isArray(image)) image = image[0];
        if (image && typeof image === "object") image = (image as Record<string, unknown>).url;
        let offers = o.offers as unknown;
        if (Array.isArray(offers)) offers = offers[0];
        const off = (offers ?? {}) as Record<string, unknown>;
        const price = off.price ?? off.lowPrice ?? (off.priceSpecification as Record<string, unknown> | undefined)?.price;
        return {
          name: typeof o.name === "string" ? o.name : undefined,
          image: typeof image === "string" ? image : undefined,
          price: price != null ? String(price) : undefined,
        };
      }
    }
  }
  return {};
}

function toYen(v?: string | null): number | null {
  if (!v) return null;
  const s = v.replace(/[,，\s]/g, "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const m = s.match(/\d+(\.\d+)?/);
  if (!m) return null;
  const n = Math.round(Number(m[0]));
  return Number.isFinite(n) && n > 0 && n < 100_000_000 ? n : null;
}

function cleanTitle(t?: string | null): string | null {
  if (!t) return null;
  let s = decodeEntities(t).replace(/\s+/g, " ").trim();
  // 「Amazon.co.jp: 商品名 : 家電&カメラ」などのサイト名部分を落とす
  s = s.replace(/^Amazon\.co\.jp\s*[:：]\s*/i, "").replace(/\s*[:：|｜]\s*(Amazon\.co\.jp|Amazon|楽天市場|Yahoo!ショッピング)?[^:：|｜]*$/i, (m) => (m.length < 40 ? "" : m));
  s = s.replace(/【楽天市場】/g, "").trim();
  return s.slice(0, 200) || null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let target: URL;
  try {
    const { url } = await req.json();
    target = new URL(String(url));
  } catch {
    return json({ error: "invalid url" }, 400);
  }
  if (!/^https?:$/.test(target.protocol) || isBlockedHost(target.hostname)) return json({ error: "blocked url" }, 400);

  let html = "";
  let finalUrl = target.href;
  try {
    const res = await fetch(target.href, {
      redirect: "follow",
      signal: AbortSignal.timeout(9000),
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "ja,en;q=0.8",
      },
    });
    finalUrl = res.url || finalUrl;
    if (isBlockedHost(new URL(finalUrl).hostname)) return json({ error: "blocked url" }, 400);
    // 先頭 1.5MB だけ読む(大きすぎるページ対策)
    const reader = res.body?.getReader();
    const dec = new TextDecoder();
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      html += dec.decode(value, { stream: true });
      if (size > 1_500_000) { await reader.cancel(); break; }
    }
  } catch (e) {
    return json({ title: null, price: null, image: null, error: "fetch failed: " + (e as Error).message });
  }

  const meta = readMeta(html);
  const ld = readJsonLd(html);

  const title = cleanTitle(
    meta.get("og:title") || meta.get("twitter:title") || ld.name ||
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1],
  );

  let image =
    meta.get("og:image") || meta.get("og:image:url") || meta.get("twitter:image") || ld.image ||
    html.match(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)/i)?.[1] ||
    // Amazon の商品画像
    html.match(/"hiRes":"(https:[^"]+)"/)?.[1] ||
    html.match(/id="landingImage"[^>]+src="([^"]+)"/)?.[1] ||
    null;
  if (image) {
    try { image = new URL(decodeEntities(image), finalUrl).href; } catch { image = null; }
  }

  const price = toYen(
    meta.get("product:price:amount") || meta.get("og:price:amount") || meta.get("price") || ld.price ||
    html.match(/class="a-price-whole">([\d,]+)/)?.[1] ||           // Amazon
    html.match(/itemprop=["']price["'][^>]*content=["']([\d.,]+)/i)?.[1] ||
    null,
  );

  return json({ title, price, image });
});

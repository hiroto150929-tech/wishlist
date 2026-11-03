// fetch-meta: 商品ページのURLから「名前・価格・画像・ショップ名」を取り出して返す Edge Function
//
// 呼び出し: supabase.functions.invoke("fetch-meta", { body: { url } })
// 返り値:   { title, price, image, shop, source, reason }
//   source: どこから取れたか("page" | "microlink" | "url")
//   reason: うまく取れなかったときの理由(日本語)
//
// ログイン中のユーザーだけが呼べます(JWT検証をオンのままにしてください)。

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ブラウザに近いリクエストヘッダー(簡易的なボット判定で弾かれにくくする)
const UA_DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const UA_MOBILE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

function headers(ua: string): HeadersInit {
  return {
    "User-Agent": ua,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.6,en;q=0.5",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
  };
}

// 社内ネットワークなどへのアクセスを防ぐ
function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true;
  if (h.includes(":") && (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80"))) return true;
  return false;
}

// ---------- ショップ名 ----------
const SHOPS: [RegExp, string][] = [
  [/(^|\.)amazon\.(co\.jp|com|jp)$|(^|\.)amzn\.(asia|to)$/, "Amazon"],
  [/(^|\.)rakuten\.(co\.jp|ne\.jp)$|(^|\.)r10\.to$/, "楽天市場"],
  [/(^|\.)shopping\.yahoo\.co\.jp$|(^|\.)store\.shopping\.yahoo\.co\.jp$/, "Yahoo!ショッピング"],
  [/(^|\.)paypaymall\.yahoo\.co\.jp$/, "Yahoo!ショッピング"],
  [/(^|\.)zozo\.jp$/, "ZOZOTOWN"],
  [/(^|\.)mercari\.com$/, "メルカリ"],
  [/(^|\.)uniqlo\.com$/, "ユニクロ"],
  [/(^|\.)gu-global\.com$/, "GU"],
  [/(^|\.)muji\.com$/, "無印良品"],
  [/(^|\.)nitori-net\.jp$/, "ニトリ"],
  [/(^|\.)yodobashi\.com$/, "ヨドバシ.com"],
  [/(^|\.)biccamera\.com$/, "ビックカメラ"],
  [/(^|\.)apple\.com$/, "Apple"],
  [/(^|\.)ikea\.com$/, "IKEA"],
  [/(^|\.)qoo10\.jp$/, "Qoo10"],
];
function shopFromHost(host: string): string | null {
  const h = host.toLowerCase();
  for (const [re, name] of SHOPS) if (re.test(h)) return name;
  return null;
}

// ---------- Amazon ----------
function amazonAsin(u: URL): string | null {
  if (!/amazon\./i.test(u.hostname)) return null;
  const m = u.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/ASIN|o\/ASIN)\/([A-Z0-9]{10})/i);
  return m ? m[1].toUpperCase() : null;
}
// /<商品名のスラッグ>/dp/ASIN の形なら、スラッグから商品名を推測
function amazonSlugTitle(u: URL): string | null {
  const m = u.pathname.match(/^\/([^/]+)\/dp\//);
  if (!m) return null;
  try {
    const s = decodeURIComponent(m[1]).replace(/-/g, " ").trim();
    return s.length > 2 ? s : null;
  } catch { return null; }
}
const amazonImage = (asin: string) => `https://images-na.ssl-images-amazon.com/images/P/${asin}.09.LZZZZZZZ.jpg`;

// ---------- HTML の読み取り ----------
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}
const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

// 文字コードを判定して正しくデコードする(Shift_JIS / EUC-JP のサイト対策)
function decodeHtml(bytes: Uint8Array, contentType: string | null): string {
  let charset = contentType?.match(/charset=["']?([\w-]+)/i)?.[1];
  if (!charset) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
    charset = head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1];
  }
  const cs = (charset || "utf-8").toLowerCase().replace(/^(x-)?sjis$|^windows-31j$|^ms932$/, "shift_jis");
  try { return new TextDecoder(cs).decode(bytes); } catch { return new TextDecoder("utf-8").decode(bytes); }
}

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

function readJsonLd(html: string): { name?: string; image?: string; price?: string; brand?: string } {
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

function toYen(v?: string | number | null): number | null {
  if (v == null || v === "") return null;
  const s = String(v).replace(/[,，\s円¥￥]/g, "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const m = s.match(/\d+(\.\d+)?/);
  if (!m) return null;
  const n = Math.round(Number(m[0]));
  return Number.isFinite(n) && n > 0 && n < 100_000_000 ? n : null;
}

function cleanTitle(t?: string | null): string | null {
  if (!t) return null;
  let s = decodeEntities(t).replace(/\s+/g, " ").trim();
  s = s.replace(/^Amazon\.co\.jp\s*[:：]\s*/i, "")
       .replace(/\s*[:：]\s*[^:：]{1,30}$/, (m) => (/(家電|カメラ|ホーム|キッチン|ファッション|本|おもちゃ|ゲーム|ドラッグストア|食品|スポーツ|DIY|ビューティー|文房具|パソコン)/.test(m) ? "" : m))
       .replace(/【楽天市場】/g, "")
       .replace(/\s*[|｜]\s*(楽天市場|Yahoo!ショッピング|ZOZOTOWN|メルカリ|Amazon\.co\.jp)\s*$/i, "")
       .replace(/\s*[-–]\s*(Yahoo!ショッピング|楽天市場)\s*$/i, "")
       .trim();
  return s.slice(0, 200) || null;
}

function isBotWall(status: number, html: string): boolean {
  if (status === 403 || status === 429 || status === 503) return true;
  return /validateCaptcha|api-services-support@amazon\.com|Robot Check|captcha-delivery|cf-chl-|Attention Required|アクセスが集中/i.test(html.slice(0, 20000));
}

function extract(html: string, pageUrl: URL) {
  const meta = readMeta(html);
  const ld = readJsonLd(html);
  const isAmazon = /amazon\./i.test(pageUrl.hostname);

  let title =
    (isAmazon && html.match(/id="productTitle"[^>]*>([\s\S]*?)<\/span>/)?.[1]) ||
    meta.get("og:title") || meta.get("twitter:title") || ld.name ||
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || null;
  title = title ? cleanTitle(stripTags(title)) : null;

  let image =
    meta.get("og:image") || meta.get("og:image:secure_url") || meta.get("og:image:url") || meta.get("twitter:image") ||
    ld.image ||
    html.match(/data-old-hires="(https:[^"]+)"/)?.[1] ||
    html.match(/"hiRes":"(https:[^"]+)"/)?.[1] ||
    html.match(/data-a-dynamic-image="\{&quot;(https:[^&]+)&quot;/)?.[1] ||
    html.match(/id="landingImage"[^>]+src="([^"]+)"/)?.[1] ||
    html.match(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)/i)?.[1] ||
    null;
  if (image) {
    try { image = new URL(decodeEntities(image), pageUrl).href; } catch { image = null; }
  }

  const price = toYen(
    meta.get("product:price:amount") || meta.get("og:price:amount") || meta.get("price") || ld.price ||
    html.match(/"priceAmount"\s*:\s*([\d.]+)/)?.[1] ||                    // Amazon
    html.match(/class="a-price-whole">([\d,]+)/)?.[1] ||                   // Amazon
    html.match(/itemprop=["']price["'][^>]*content=["']([\d.,]+)/i)?.[1] ||
    html.match(/data-price=["']([\d,]+)["']/i)?.[1] ||                     // 楽天ほか
    html.match(/class="[^"]*price2[^"]*"[^>]*>\s*([\d,]+)/i)?.[1] ||       // 楽天
    null,
  );

  const shop = meta.get("og:site_name") || null;
  return { title, image, price, shop };
}

async function fetchPage(url: string, ua: string) {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(9000), headers: headers(ua) });
  const finalUrl = res.url || url;
  if (isBlockedHost(new URL(finalUrl).hostname)) throw new Error("blocked url");
  // 先頭 2MB だけ読む
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size > 2_000_000) { await reader.cancel(); break; }
  }
  const bytes = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { bytes.set(c.subarray(0, Math.min(c.length, size - off)), off); off += c.length; if (off >= size) break; }
  return { status: res.status, finalUrl, html: decodeHtml(bytes, res.headers.get("content-type")) };
}

// 直接取れないときの予備: Microlink(無料枠・キー不要)でページ情報を取る
async function viaMicrolink(url: string) {
  try {
    const res = await fetch(`https://api.microlink.io/?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(9000) });
    if (!res.ok) return null;
    const j = await res.json();
    if (j?.status !== "success") return null;
    const d = j.data ?? {};
    return {
      title: cleanTitle(d.title),
      image: d.image?.url ?? null,
      shop: d.publisher ?? null,
    };
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let target: URL;
  try {
    const { url } = await req.json();
    target = new URL(String(url).trim());
  } catch {
    return json({ reason: "URLの形式が正しくありません" }, 400);
  }
  if (!/^https?:$/.test(target.protocol) || isBlockedHost(target.hostname)) return json({ reason: "このURLは使えません" }, 400);

  // Amazon は余計なパラメータを外した短い形にする(取得が安定する)
  let asin = amazonAsin(target);
  const slugTitle = amazonSlugTitle(target);
  const fetchUrl = asin ? `https://${target.hostname}/dp/${asin}` : target.href;

  let out: { title: string | null; price: number | null; image: string | null; shop: string | null } =
    { title: null, price: null, image: null, shop: null };
  let source = "page";
  let reason: string | null = null;
  let finalUrl = new URL(fetchUrl);

  // 1) ページを直接読む(ダメならスマホ版としてもう一度)
  for (const ua of [UA_DESKTOP, UA_MOBILE]) {
    try {
      const page = await fetchPage(fetchUrl, ua);
      finalUrl = new URL(page.finalUrl);
      asin = asin || amazonAsin(finalUrl);
      if (isBotWall(page.status, page.html)) { reason = "サイト側で自動アクセスがブロックされました"; continue; }
      if (page.status >= 400) { reason = `ページを開けませんでした(${page.status})`; continue; }
      const got = extract(page.html, finalUrl);
      out = {
        title: out.title || got.title,
        price: out.price || got.price,
        image: out.image || got.image,
        shop: out.shop || got.shop,
      };
      if (out.title && out.image) { reason = null; break; }
    } catch (e) {
      reason = (e as Error).name === "TimeoutError" ? "ページの読み込みに時間がかかりすぎました" : "ページを読み込めませんでした";
    }
  }

  // 2) 足りなければ Microlink で補う
  if (!out.title || !out.image) {
    const ml = await viaMicrolink(finalUrl.href);
    if (ml && (ml.title || ml.image)) {
      if (!out.title && ml.title) { out.title = ml.title; source = "microlink"; }
      if (!out.image && ml.image) { out.image = ml.image; source = "microlink"; }
      out.shop = out.shop || ml.shop;
    }
  }

  // 3) それでも足りなければ、URL から分かる範囲で埋める(Amazon)
  if (asin && !out.image) { out.image = amazonImage(asin); source = out.title ? source : "url"; }
  if (!out.title && slugTitle) { out.title = slugTitle; source = "url"; }

  out.shop = shopFromHost(finalUrl.hostname) || shopFromHost(target.hostname) || out.shop;
  if (out.title && out.image && out.price) reason = null;
  else if (!out.price && (out.title || out.image)) reason = reason ?? "価格はページから読み取れませんでした";

  return json({ ...out, source, reason });
});

// identify-photo: 商品の写真から、その商品を特定してネット上の販売ページを探す Edge Function
//
// 呼び出し: supabase.functions.invoke("identify-photo", { body: { image: "<base64>", mime: "image/jpeg" } })
// 返り値:
//   {
//     name, brand, category, query, confidence,          // 写真から読み取った内容
//     candidates: [{ title, price, image, shop, url }],   // 実在を確認できた販売ページ(最大3件)
//     search_links: [{ label, url }],                     // 自分で探すための検索リンク
//     reason                                              // うまくいかなかったときの理由(日本語)
//   }
//
// 必要な設定(Supabase → Edge Functions → Secrets):
//   GEMINI_API_KEY  … Google AI Studio で発行した API キー
//   GEMINI_MODEL    … 省略可(既定: gemini-2.5-flash。使えないときは他のモデルで自動的にやり直します)
// ログイン中のユーザーだけが呼べます(JWT検証をオンのままにしてください)。

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const MAX_IMAGE_BYTES = 4_000_000; // base64 で約3MBの画像まで

type Ident = {
  name?: string; brand?: string; model?: string; category?: string;
  search_query?: string; confidence?: string;
  candidates?: { title?: string; url?: string; price?: number | string; shop?: string }[];
};

const PROMPT = `あなたは買い物アシスタントです。写真に写っている商品を特定し、日本の通販サイトでその商品の販売ページを探してください。

手順:
1. 写真から、商品名・ブランド・型番・色などをできるだけ正確に読み取る(パッケージの文字やロゴを重視)。
2. Google検索で、日本の通販サイト(Amazon.co.jp、楽天市場、Yahoo!ショッピング、メーカー公式ストアなど)の「その商品の個別ページ」を最大3件探す。検索結果の一覧ページやまとめ記事は含めない。
3. 見つからなければ candidates は空にする。URL を推測で作らないこと。

最後に、次の形の JSON だけを \`\`\`json と \`\`\` で囲んで出力してください(説明文は不要):
{
  "name": "日本語の商品名(ブランド名と型番を含め、40文字程度まで)",
  "brand": "ブランド名(不明なら空文字)",
  "model": "型番(不明なら空文字)",
  "category": "次から1つ: ガジェット, 家電, 本, 服, 靴, バッグ, 化粧品, 食品, 飲料, 日用品, インテリア, キッチン, 文房具, おもちゃ, スポーツ, アウトドア, その他",
  "search_query": "通販サイトで検索するときの検索語",
  "confidence": "high / medium / low のいずれか(写真から商品を特定できた確からしさ)",
  "candidates": [ { "title": "ページの商品名", "url": "https://...", "price": 1980, "shop": "ショップ名" } ]
}
写真に商品が写っていない場合は、name を空文字、confidence を "low" にしてください。`;

// モデルの返答から JSON 部分を取り出す
function parseJson(text: string): Ident | null {
  const block = text.match(/```json\s*([\s\S]*?)```/i)?.[1] ?? text.match(/\{[\s\S]*\}/)?.[0];
  if (!block) return null;
  try { return JSON.parse(block); } catch { return null; }
}

function searchLinks(q: string) {
  const e = encodeURIComponent(q);
  return [
    { label: "楽天で探す", url: `https://search.rakuten.co.jp/search/mall/${e}/` },
    { label: "Amazonで探す", url: `https://www.amazon.co.jp/s?k=${e}` },
    { label: "Googleで探す", url: `https://www.google.com/search?tbm=shop&q=${e}` },
  ];
}

const isSearchOrListPage = (u: URL) =>
  /\/(s|search)(\/|$|\?)|search\.rakuten|\/search\/|[?&](k|q|keyword|p)=/i.test(u.pathname + u.search + u.hostname);

async function callGemini(apiKey: string, model: string, image: string, mime: string, useSearch: boolean) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    signal: AbortSignal.timeout(30000),
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ inline_data: { mime_type: mime, data: image } }, { text: PROMPT }] }],
      ...(useSearch ? { tools: [{ google_search: {} }] } : {}),
      generationConfig: { temperature: 0.2 },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || `HTTP ${res.status}`;
    const err = new Error(res.status === 429 ? "rate" : /API key|API_KEY/i.test(msg) ? "key" : msg) as Error & { status?: number; detail?: string };
    err.status = res.status;
    err.detail = `${res.status} ${msg}`.slice(0, 140);
    throw err;
  }
  const cand = body?.candidates?.[0];
  const text = (cand?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("\n");
  if (!text.trim()) {
    const why = cand?.finishReason || body?.promptFeedback?.blockReason || "empty";
    const err = new Error("empty") as Error & { detail?: string };
    err.detail = `応答が空でした(${why})`;
    throw err;
  }
  const chunks: { uri: string; title: string }[] = (cand?.groundingMetadata?.groundingChunks ?? [])
    .map((c: { web?: { uri?: string; title?: string } }) => ({ uri: c.web?.uri ?? "", title: c.web?.title ?? "" }))
    .filter((c: { uri: string }) => c.uri);
  return { text, chunks };
}

// fetch-meta(同じプロジェクトの関数)でページを実際に開き、名前・価格・画像を確認する
async function checkPage(url: string, auth: string, apikey: string) {
  const base = Deno.env.get("SUPABASE_URL");
  if (!base) return null;
  try {
    const res = await fetch(`${base}/functions/v1/fetch-meta`, {
      method: "POST",
      signal: AbortSignal.timeout(20000),
      headers: { "Content-Type": "application/json", Authorization: auth, apikey },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) return null;
    const d = await res.json();
    if (!d?.title) return null;
    return { title: d.title as string, price: (d.price ?? null) as number | null, image: (d.image ?? null) as string | null, shop: (d.shop ?? null) as string | null, url: (d.url || url) as string };
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) return json({ reason: "写真検索の準備ができていません(GEMINI_API_KEY の設定が必要です)", candidates: [], search_links: [] });
  const model = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";

  let image = "", mime = "image/jpeg";
  try {
    const b = await req.json();
    image = String(b.image || "").replace(/^data:[^,]+,/, "");
    mime = /^image\/(jpeg|png|webp|heic|heif)$/.test(b.mime) ? b.mime : "image/jpeg";
  } catch { /* 下でエラーにする */ }
  if (!image) return json({ reason: "写真が届きませんでした", candidates: [], search_links: [] }, 400);
  if (image.length > MAX_IMAGE_BYTES) return json({ reason: "写真が大きすぎます", candidates: [], search_links: [] }, 413);

  let ident: Ident | null = null;
  let chunks: { uri: string; title: string }[] = [];
  let usedSearch = true;

  // 1) 指定モデル + Google検索 → 2) 予備モデル + Google検索 → 3) Google検索なし(商品名だけ特定)の順に試す
  const models = [...new Set([model, "gemini-2.5-flash", "gemini-flash-latest", "gemini-2.5-flash-lite"])];
  const attempts: { model: string; search: boolean }[] = [
    ...models.map((m) => ({ model: m, search: true })),
    ...models.slice(0, 2).map((m) => ({ model: m, search: false })),
  ];
  let lastErr: (Error & { status?: number; detail?: string }) | null = null;
  const started = Date.now();
  for (const at of attempts) {
    if (Date.now() - started > 60000) break;   // 合計1分を超えたらやめる(関数の時間制限対策)
    try {
      const r = await callGemini(apiKey, at.model, image, mime, at.search);
      const parsed = parseJson(r.text);
      if (!parsed) { lastErr = Object.assign(new Error("parse"), { detail: "応答の形式を読み取れませんでした" }); continue; }
      ident = parsed;
      chunks = r.chunks;
      usedSearch = at.search;
      lastErr = null;
      console.log("gemini ok", at.model, at.search ? "with search" : "no search");
      break;
    } catch (e) {
      lastErr = e as Error & { status?: number; detail?: string };
      console.error("gemini failed", at.model, at.search, lastErr.detail || lastErr.message);
      if (lastErr.message === "key") break;                      // キーが違うなら何度やっても同じ
      if (lastErr.name === "TimeoutError" && !at.search) break;
    }
  }

  if (!ident) {
    const m = lastErr?.message;
    const reason = m === "key" ? "Gemini の API キーが正しくありません"
      : m === "rate" ? "今日の利用回数の上限に達しました。時間をおいて試してください"
      : lastErr?.name === "TimeoutError" ? "商品の特定に時間がかかりすぎました。もう一度お試しください"
      : `商品を特定できませんでした(${lastErr?.detail || lastErr?.message || "原因不明"})`;
    return json({ reason, candidates: [], search_links: [] });
  }

  if (!ident || !ident.name) {
    return json({ reason: "写真から商品を読み取れませんでした。商品名やロゴが写るように撮ってみてください", candidates: [], search_links: [] });
  }

  const query = (ident.search_query || [ident.brand, ident.model, ident.name].filter(Boolean).join(" ")).slice(0, 100);

  // 候補URL: モデルが挙げたページ → 検索の根拠になったページ の順に、最大5件を確認
  const urls: string[] = [];
  const push = (u?: string) => {
    if (!u) return;
    try {
      const x = new URL(u);
      if (!/^https?:$/.test(x.protocol) || isSearchOrListPage(x)) return;
      if (!urls.includes(x.href)) urls.push(x.href);
    } catch { /* 無効なURLは捨てる */ }
  };
  (ident.candidates ?? []).forEach((c) => push(c.url));
  chunks.forEach((c) => push(c.uri));

  const auth = req.headers.get("Authorization") ?? "";
  const apikey = req.headers.get("apikey") ?? "";
  const checked = await Promise.all(urls.slice(0, 5).map((u) => checkPage(u, auth, apikey)));

  const seen = new Set<string>();
  const candidates = checked
    .filter((c): c is NonNullable<typeof c> => !!c)
    .filter((c) => {
      try {
        const u = new URL(c.url);
        if (isSearchOrListPage(u)) return false;
        const key = u.hostname + u.pathname;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      } catch { return false; }
    })
    .slice(0, 3);

  return json({
    name: ident.name,
    brand: ident.brand || null,
    category: ident.category || null,
    query,
    confidence: ident.confidence || "medium",
    candidates,
    search_links: searchLinks(query),
    reason: candidates.length ? null : usedSearch
      ? "販売ページは見つかりませんでした。名前だけ入れるか、検索リンクから探してください"
      : "商品名は分かりました(ネット検索は使えませんでした)。名前だけ入れるか、検索リンクから探してください",
  });
});

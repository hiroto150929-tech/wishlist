# 欲しいものリスト

メールアドレスでログインし、スマホでもPCでも同じリストを見られる個人用アプリです。

- フロント: `index.html` 1ファイル(ビルド不要)
- 認証・データ保存: [Supabase](https://supabase.com)(メール認証 + PostgreSQL)
- 機能: 名前・価格・URL・メモ・優先度(高/中/低)・カテゴリ、購入済みチェック、検索・絞り込み・並べ替え、表示中の合計金額

## セットアップ(所要 10 分ほど)

### 1. Supabase プロジェクトを作る

1. https://supabase.com でアカウントを作成し、New project でプロジェクトを作成(無料プランで十分です)
2. 左メニュー **SQL Editor** を開き、`schema.sql` の中身を貼り付けて **Run**
   - `wishes` テーブルと、「自分のデータだけ読み書きできる」セキュリティ設定(RLS)が作られます

### 2. 接続情報を `config.js` に書く

1. Supabase の **Project Settings → API**(または Connect)から、次の2つを控える
   - Project URL
   - `anon` (publishable) key
2. `config.js` を書き換える(`index.html` を差し替えても設定は残ります)

```js
window.WISHLIST_CONFIG = {
  SUPABASE_URL: "https://xxxxxxxx.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_...",
};
```

`anon` key は公開前提のキーで、データはRLSで守られます。**`service_role` key は絶対に入れないでください。**

### 3. ローカルで動かす

```bash
cd wishlist
npx serve .        # または python3 -m http.server 8000
```

ブラウザで表示された URL(例: http://localhost:3000)を開きます。

### 4. 公開してスマホからも使う

静的ホスティングならどこでも動きます(Cloudflare Pages / Netlify / Vercel / GitHub Pages など)。フォルダをそのままデプロイしてください。

公開 URL が決まったら、Supabase の **Authentication → URL Configuration** で次を設定します。

- **Site URL**: 公開した URL
- **Redirect URLs**: 公開 URL と `http://localhost:3000`(ローカル確認用)

これを設定しないと、確認メールやパスワード再設定メールのリンクが正しく戻ってきません。

### 5. スマホのホーム画面に追加する(アプリとして使う)

公開URLをスマホで開いてログインし、次の操作をします。アドレスバーのない全画面で、専用アイコン付きで起動します。

- iPhone(Safari): 共有ボタン → 「ホーム画面に追加」
- Android(Chrome): メニュー(︙) → 「ホーム画面に追加」/「アプリをインストール」

アプリを更新したら `sw.js` の `VERSION` を `v2` のように上げると、端末側にも確実に反映されます。

アイコン(黒地に白字「list」)を変えたいときは `icons/make_icons.py` の定数を編集して `python3 icons/make_icons.py` を実行してください(要 `pip install cairosvg`)。

### 6. 自分専用にする場合(任意)

他人の新規登録を止めたい場合は、最初に自分のアカウントを作成した後、Supabase の **Authentication → Sign In / Providers**(または Settings)で **Allow new users to sign up** をオフにしてください。

## 追加機能のセットアップ(画像・URL自動入力・並べ替え・共有リンク)

### A. DBを更新する
Supabase の **SQL Editor** で `migrations/002_images_order_share.sql` の中身を貼り付けて **Run**。

### B. URL自動入力の Edge Function を作る
1. Supabase の左メニュー **Edge Functions** → **Deploy a new function** → **Via Editor**
2. 関数名を `fetch-meta` にする
3. `supabase/functions/fetch-meta/index.ts` の中身を貼り付けて **Deploy**
4. 「Verify JWT」(ログイン必須)はオンのままでOK

(CLI を使う場合: `supabase functions deploy fetch-meta`)

### C. スマホの「共有」から追加する
- **Android**: ホーム画面に追加したアプリは、Chrome などの共有メニューに「my list」が出ます。
- **iPhone**: 「ショートカット」アプリで次のショートカットを作ります。
  1. 新規ショートカット → 詳細(ⓘ)で「共有シートに表示」をオン、受け取る種類は「URL」
  2. アクション「URLをエンコード」(入力: ショートカットの入力)
  3. アクション「テキスト」に `https://hiroto150929-tech.github.io/wishlist/?url=` と入力し、末尾に「URLをエンコード」の結果を差し込む
  4. アクション「URLを開く」(入力: テキスト)
  - Safari で開くので、最初の1回だけ Safari でもログインしてください。

### D. 共有リンク
アプリ右上の「共有」からリンクを作成します。見られるのは未購入のもの(名前・価格・画像・商品ページ)だけで、メモは見えません。「リンクを無効にする」でいつでも止められます。

## Claude Code で機能追加する

このフォルダで `claude` を起動して、たとえば次のように頼めます。

- 「商品URLから画像を表示する機能を追加して」
- 「月ごとの予算を設定して、合計との差額を表示して」
- 「ホーム画面に追加できるPWAにして、オフラインでも見られるようにして」
- 「CSVでエクスポートできるようにして」

DBの列を増やすときは、`schema.sql` に `alter table` を足して SQL Editor で実行するよう伝えてください。

## ファイル構成

| ファイル | 内容 |
| --- | --- |
| `index.html` | アプリ本体(HTML / CSS / JS) |
| `config.js` | Supabase の接続設定 |
| `manifest.json` | アプリ名・アイコン・色(PWA設定) |
| `sw.js` | Service Worker(起動を速くする・オフライン時の画面) |
| `icons/` | アプリアイコンと生成スクリプト |
| `schema.sql` | テーブル定義とRLSポリシー(新規構築用) |
| `migrations/` | 既存DBへの追加変更SQL |
| `supabase/functions/fetch-meta/` | URLから商品情報を取るEdge Function |
| `README.md` | この説明 |

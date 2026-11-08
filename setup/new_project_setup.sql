-- 新しい Supabase プロジェクト用: これ1つを SQL Editor で実行すればテーブル・権限・関数がすべて揃います
-- (schema.sql + migrations/002 + 003 + 004 をまとめたもの。何度実行しても安全です)


-- ================================================================
-- schema.sql
-- ================================================================
-- Supabase の SQL Editor に貼り付けて実行してください(新規構築用)
-- 続けて migrations/002 → 003 → 004 の順に実行してください

create table if not exists public.wishes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null,
  price       integer,
  url         text,
  memo        text,
  priority    smallint not null default 2 check (priority between 1 and 3), -- 1=高 2=中 3=低
  category    text,
  purchased   boolean not null default false,
  image_url   text,
  sort_order  double precision,
  purchased_at date,          -- 購入日
  shop        text,          -- ショップ
  payment     text,          -- 支払い方法
  rating      smallint check (rating is null or rating between 1 and 5), -- 満足度
  created_at  timestamptz not null default now()
);

create index if not exists wishes_user_idx on public.wishes (user_id, created_at desc);

-- 行レベルセキュリティ: 自分のデータだけ読み書きできる
alter table public.wishes enable row level security;

drop policy if exists "own wishes select" on public.wishes;
drop policy if exists "own wishes insert" on public.wishes;
drop policy if exists "own wishes update" on public.wishes;
drop policy if exists "own wishes delete" on public.wishes;

create policy "own wishes select" on public.wishes
  for select using (auth.uid() = user_id);
create policy "own wishes insert" on public.wishes
  for insert with check (auth.uid() = user_id);
create policy "own wishes update" on public.wishes
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own wishes delete" on public.wishes
  for delete using (auth.uid() = user_id);

-- ================================================================
-- migrations/002_images_order_share.sql
-- ================================================================
-- 追加機能用のDB変更(画像・並べ替え・共有リンク)
-- Supabase の SQL Editor に貼り付けて Run してください。何度実行しても安全です。

-- 1) 商品画像のURLと、手動並べ替え用の順番
alter table public.wishes add column if not exists image_url text;
alter table public.wishes add column if not exists sort_order double precision;

-- 2) 共有リンク(1人につき1つ。token を知っている人だけが閲覧できる)
create table if not exists public.shares (
  token      uuid primary key default gen_random_uuid(),
  user_id    uuid not null unique default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.shares enable row level security;

drop policy if exists "own share select" on public.shares;
drop policy if exists "own share insert" on public.shares;
drop policy if exists "own share delete" on public.shares;
create policy "own share select" on public.shares for select using (auth.uid() = user_id);
create policy "own share insert" on public.shares for insert with check (auth.uid() = user_id);
create policy "own share delete" on public.shares for delete using (auth.uid() = user_id);

-- 3) 共有リンクを開いた人(ログインなし)が、未購入のアイテムだけを読める関数
--    メモ・購入済みのものは返さない
-- (まだ無いときだけ作る。migrations/004 で新しい形に置き換わります)
do $do$ begin
  if to_regprocedure('public.get_shared_list(uuid)') is null then
    execute $f$
create function public.get_shared_list(p_token uuid)
returns table (
  name text, price integer, url text, image_url text,
  priority smallint, category text, sort_order double precision, created_at timestamptz
)
language sql
security definer
set search_path = public
stable
as $body$
  select w.name, w.price, w.url, w.image_url, w.priority, w.category, w.sort_order, w.created_at
  from public.wishes w
  join public.shares s on s.user_id = w.user_id
  where s.token = p_token and not w.purchased
  order by w.sort_order nulls last, w.created_at desc;
$body$;
    $f$;
  end if;
end $do$;

revoke all on function public.get_shared_list(uuid) from public;
grant execute on function public.get_shared_list(uuid) to anon, authenticated;

-- ================================================================
-- migrations/003_purchases.sql
-- ================================================================
-- 購入品管理用のDB変更
-- Supabase の SQL Editor に貼り付けて Run してください。何度実行しても安全です。

-- 1) 購入品の情報(欲しいものリストと同じテーブルで、purchased = true のものが購入品)
alter table public.wishes add column if not exists purchased_at date;      -- 購入日
alter table public.wishes add column if not exists shop text;              -- 購入したお店
alter table public.wishes add column if not exists payment text;           -- 支払い方法
alter table public.wishes add column if not exists rating smallint;        -- 満足度 1〜5

do $$ begin
  alter table public.wishes add constraint wishes_rating_range check (rating is null or rating between 1 and 5);
exception when duplicate_object then null; end $$;

-- すでに「購入済み」にしてあるものは、登録日を購入日として埋めておく
update public.wishes set purchased_at = created_at::date where purchased and purchased_at is null;

create index if not exists wishes_purchased_idx on public.wishes (user_id, purchased, purchased_at desc);

-- 2) ユーザーごとの設定(月の予算など)
create table if not exists public.user_settings (
  user_id        uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  monthly_budget integer check (monthly_budget is null or monthly_budget >= 0),
  updated_at     timestamptz not null default now()
);

alter table public.user_settings enable row level security;

drop policy if exists "own settings select" on public.user_settings;
drop policy if exists "own settings insert" on public.user_settings;
drop policy if exists "own settings update" on public.user_settings;
create policy "own settings select" on public.user_settings for select using (auth.uid() = user_id);
create policy "own settings insert" on public.user_settings for insert with check (auth.uid() = user_id);
create policy "own settings update" on public.user_settings for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ================================================================
-- migrations/004_share_options_theme_budgets.sql
-- ================================================================
-- 共有リンクの詳細設定・テーマ・月ごとの予算
-- Supabase の SQL Editor に貼り付けて Run してください。何度実行しても安全です。
-- (002・003 を実行済みであることが前提です)

-- 1) 共有リンク: 1人で複数作れるようにし、共有する内容を選べるようにする
alter table public.shares drop constraint if exists shares_user_id_key;
alter table public.shares add column if not exists label        text;                          -- リンクの名前(例: 家族用)
alter table public.shares add column if not exists share_wish   boolean not null default true; -- 欲しいものを共有
alter table public.shares add column if not exists share_bought boolean not null default false;-- 購入品を共有
alter table public.shares add column if not exists period_mode  text    not null default 'all';-- 購入品の期間
alter table public.shares add column if not exists date_from    date;
alter table public.shares add column if not exists date_to      date;
alter table public.shares add column if not exists categories   text[];                        -- 空ならすべて。'' は未分類
alter table public.shares add column if not exists show_price   boolean not null default true; -- 金額を見せる

do $$ begin
  alter table public.shares add constraint shares_period_mode_check
    check (period_mode in ('all', 'this_month', 'last_month', 'this_year', 'last_3_months', 'range'));
exception when duplicate_object then null; end $$;

create index if not exists shares_user_idx on public.shares (user_id);

drop policy if exists "own share update" on public.shares;
create policy "own share update" on public.shares for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 共有ページ用の関数(設定に合わせて、見せてよいものだけを返す)
drop function if exists public.get_shared_list(uuid);
create function public.get_shared_list(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  s public.shares;
  d date := (now() at time zone 'Asia/Tokyo')::date;
  f date;
  t date;
  w jsonb := '[]'::jsonb;
  p jsonb := '[]'::jsonb;
  all_cats boolean;
begin
  select * into s from public.shares where token = p_token;
  if not found then return null; end if;

  case s.period_mode
    when 'this_month'    then f := date_trunc('month', d)::date; t := (date_trunc('month', d) + interval '1 month - 1 day')::date;
    when 'last_month'    then f := (date_trunc('month', d) - interval '1 month')::date; t := (date_trunc('month', d) - interval '1 day')::date;
    when 'this_year'     then f := date_trunc('year', d)::date;  t := (date_trunc('year', d) + interval '1 year - 1 day')::date;
    when 'last_3_months' then f := (date_trunc('month', d) - interval '2 month')::date; t := d;
    when 'range'         then f := s.date_from; t := s.date_to;
    else f := null; t := null;
  end case;

  all_cats := s.categories is null or cardinality(s.categories) = 0;

  if s.share_wish then
    select coalesce(jsonb_agg(jsonb_build_object(
             'name', x.name, 'price', case when s.show_price then x.price end, 'url', x.url,
             'image_url', x.image_url, 'priority', x.priority, 'category', x.category)
           order by x.sort_order nulls last, x.created_at desc), '[]'::jsonb)
      into w
      from public.wishes x
     where x.user_id = s.user_id and not x.purchased
       and (all_cats or coalesce(x.category, '') = any (s.categories));
  end if;

  if s.share_bought then
    select coalesce(jsonb_agg(jsonb_build_object(
             'name', x.name, 'price', case when s.show_price then x.price end, 'url', x.url,
             'image_url', x.image_url, 'category', x.category, 'shop', x.shop, 'rating', x.rating,
             'purchased_at', coalesce(x.purchased_at, x.created_at::date))
           order by coalesce(x.purchased_at, x.created_at::date) desc, x.created_at desc), '[]'::jsonb)
      into p
      from public.wishes x
     where x.user_id = s.user_id and x.purchased
       and (all_cats or coalesce(x.category, '') = any (s.categories))
       and (f is null or coalesce(x.purchased_at, x.created_at::date) >= f)
       and (t is null or coalesce(x.purchased_at, x.created_at::date) <= t);
  end if;

  return jsonb_build_object(
    'label', s.label, 'share_wish', s.share_wish, 'share_bought', s.share_bought,
    'show_price', s.show_price, 'period_mode', s.period_mode, 'period_from', f, 'period_to', t,
    'categories', coalesce(to_jsonb(s.categories), '[]'::jsonb),
    'wishes', w, 'purchases', p);
end;
$$;

revoke all on function public.get_shared_list(uuid) from public;
grant execute on function public.get_shared_list(uuid) to anon, authenticated;

-- 2) テーマ(端末をまたいで同じテーマにするため)
alter table public.user_settings add column if not exists theme text;

-- 3) 月ごとの予算
create table if not exists public.monthly_budgets (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  month   text not null check (month ~ '^\d{4}-\d{2}$'),   -- 例: 2026-11
  amount  integer not null check (amount >= 0),
  primary key (user_id, month)
);

alter table public.monthly_budgets enable row level security;

drop policy if exists "own budgets select" on public.monthly_budgets;
drop policy if exists "own budgets insert" on public.monthly_budgets;
drop policy if exists "own budgets update" on public.monthly_budgets;
drop policy if exists "own budgets delete" on public.monthly_budgets;
create policy "own budgets select" on public.monthly_budgets for select using (auth.uid() = user_id);
create policy "own budgets insert" on public.monthly_budgets for insert with check (auth.uid() = user_id);
create policy "own budgets update" on public.monthly_budgets for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own budgets delete" on public.monthly_budgets for delete using (auth.uid() = user_id);

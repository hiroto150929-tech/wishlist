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

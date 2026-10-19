-- Supabase の SQL Editor に貼り付けて実行してください(新規構築用)
-- 共有リンク機能は migrations/002_images_order_share.sql も実行してください

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
  created_at  timestamptz not null default now()
);

create index if not exists wishes_user_idx on public.wishes (user_id, created_at desc);

-- 行レベルセキュリティ: 自分のデータだけ読み書きできる
alter table public.wishes enable row level security;

create policy "own wishes select" on public.wishes
  for select using (auth.uid() = user_id);
create policy "own wishes insert" on public.wishes
  for insert with check (auth.uid() = user_id);
create policy "own wishes update" on public.wishes
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own wishes delete" on public.wishes
  for delete using (auth.uid() = user_id);

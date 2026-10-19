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
create or replace function public.get_shared_list(p_token uuid)
returns table (
  name text, price integer, url text, image_url text,
  priority smallint, category text, sort_order double precision, created_at timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select w.name, w.price, w.url, w.image_url, w.priority, w.category, w.sort_order, w.created_at
  from public.wishes w
  join public.shares s on s.user_id = w.user_id
  where s.token = p_token and not w.purchased
  order by w.sort_order nulls last, w.created_at desc;
$$;

revoke all on function public.get_shared_list(uuid) from public;
grant execute on function public.get_shared_list(uuid) to anon, authenticated;

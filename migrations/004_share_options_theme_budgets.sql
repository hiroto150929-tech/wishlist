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

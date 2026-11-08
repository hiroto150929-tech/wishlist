-- 【引っ越し ステップ2】新しい Supabase プロジェクトの SQL Editor で実行します。
-- 先に、新しいアプリに「Googleでログイン」で一度ログインしておいてください(アカウントを作るため)。
--
-- やること: 下の「ここにステップ1でコピーしたものを貼り付け」の1行を消して、
--           コピーした内容({ で始まり } で終わる長い文字)をそこに貼り付けてから Run。
-- 二重に取り込まないよう、新しいアカウントにすでにアイテムがあるときは止まります。

do $import$
declare
  me uuid := (select id from auth.users where email = 'hiroto150929@gmail.com');
  j  jsonb := $mylist_data_7q2x$
ここにステップ1でコピーしたものを貼り付け
$mylist_data_7q2x$;
  n  int;
begin
  if me is null then
    raise exception '新しいプロジェクトにアカウントがありません。先にアプリで「Googleでログイン」してください。';
  end if;
  if exists (select 1 from public.wishes where user_id = me) then
    raise exception 'すでにアイテムが入っています(二重取り込みを防ぐため中止しました)。';
  end if;

  insert into public.wishes (user_id, name, price, url, memo, priority, category, purchased, created_at,
                             image_url, sort_order, purchased_at, shop, payment, rating)
  select me, x.name, x.price, x.url, x.memo, coalesce(x.priority, 2), x.category, coalesce(x.purchased, false),
         coalesce(x.created_at, now()), x.image_url, x.sort_order, x.purchased_at, x.shop, x.payment, x.rating
    from jsonb_to_recordset(coalesce(j->'wishes', '[]'::jsonb)) as x(
           name text, price integer, url text, memo text, priority smallint, category text, purchased boolean,
           created_at timestamptz, image_url text, sort_order double precision, purchased_at date,
           shop text, payment text, rating smallint);
  get diagnostics n = row_count;

  insert into public.monthly_budgets (user_id, month, amount)
  select me, x.month, x.amount
    from jsonb_to_recordset(coalesce(j->'budgets', '[]'::jsonb)) as x(month text, amount integer)
  on conflict (user_id, month) do update set amount = excluded.amount;

  if jsonb_typeof(j->'settings') = 'object' then
    insert into public.user_settings (user_id, monthly_budget, theme)
    values (me, (j->'settings'->>'monthly_budget')::integer, j->'settings'->>'theme')
    on conflict (user_id) do update set monthly_budget = excluded.monthly_budget, theme = excluded.theme;
  end if;

  raise notice '引っ越し完了: アイテム % 件を取り込みました', n;
end
$import$;

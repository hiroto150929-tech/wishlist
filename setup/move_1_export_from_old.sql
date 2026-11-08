-- 【引っ越し ステップ1】今の(古い)Supabase プロジェクトの SQL Editor で実行します。
-- あなたのリスト・購入品・予算・テーマを 1つのデータ(JSON)にまとめて表示します。
-- 結果の export_json のマスをクリックして、中身をすべてコピーしてください。
-- ※ 1行目のメールアドレスが、いつもログインしているアドレスか確認してください。

with me as (
  select id from auth.users where email = 'hiroto150929@gmail.com'
)
select jsonb_build_object(
  'version', 1,
  'exported_at', now(),
  'wishes',   (select coalesce(jsonb_agg(to_jsonb(w) - 'id' - 'user_id' order by w.created_at), '[]'::jsonb)
                 from public.wishes w join me on w.user_id = me.id),
  'budgets',  (select coalesce(jsonb_agg(jsonb_build_object('month', b.month, 'amount', b.amount)), '[]'::jsonb)
                 from public.monthly_budgets b join me on b.user_id = me.id),
  'settings', (select to_jsonb(s) - 'user_id' - 'updated_at'
                 from public.user_settings s join me on s.user_id = me.id)
)::text as export_json;

-- Avatar finish + custom upload migration
-- Run in Supabase SQL editor (or via supabase db push).
--
-- Note: leaves the existing `trade-images` bucket untouched. Adds two new
-- buckets (`avatars`, `group-avatars`) alongside it.
--
-- IMPORTANT — PostgREST schema cache:
-- After ALTER TABLE, the API caches the old schema. The NOTIFY at the END
-- of this file forces a reload. If you skip it or run only a partial
-- migration, expect "Could not find the 'X' column ... in the schema cache"
-- for up to ~60 seconds (auto-reload), or until you click
-- Project Settings → API → Restart database.

-- Pre-flight verify (uncomment to run alone):
--   SELECT column_name, data_type, column_default
--     FROM information_schema.columns
--     WHERE table_name='profiles' AND column_name LIKE 'avatar%';
--   -- 0 rows = columns missing, run the ALTER below
--   -- 3 rows = columns already present, only need NOTIFY at the end

-- ─────────────────────────────────────────────────────────────────
-- 1. Profiles — personal avatar fields
--
-- The ACTUAL table is `profiles` (not user_profiles). FK column is
-- `id` matching auth.users.id (verify with the SELECT below).
--
-- Verify columns BEFORE running:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name='profiles' AND column_name IN ('id','user_id');
-- ─────────────────────────────────────────────────────────────────
alter table public.profiles
  add column if not exists avatar_finish    text default 'chrome',
  add column if not exists avatar_initials  text,
  add column if not exists avatar_image_url text,
  add column if not exists last_seen_at     timestamptz;

-- Drop both old name variants for idempotency.
alter table public.profiles
  drop constraint if exists profiles_avatar_finish_chk;
alter table public.profiles
  drop constraint if exists profiles_avatar_finish_check;
alter table public.profiles
  add constraint profiles_avatar_finish_check check (
    avatar_finish in ('chrome','gold','rosegold','gunmetal',
                      'sapphire','emerald','amethyst','slate')
  );

-- Backfill from legacy `color` where the value is already a finish.
update public.profiles
  set avatar_finish = case
    when color in ('chrome','gold','rosegold','gunmetal',
                   'sapphire','emerald','amethyst','slate') then color
    else 'chrome'
  end
  where avatar_finish is null;

update public.profiles
  set avatar_initials = upper(substring(coalesce(initials,'??') from 1 for 2))
  where avatar_initials is null;

-- RLS — public read (so community feeds can show other users' finishes)
-- but write only your own row. Codebase keys on `id` = auth.uid().
alter table public.profiles enable row level security;

drop policy if exists "users_read_own_profile"   on public.profiles;
drop policy if exists "users_update_own_profile" on public.profiles;
drop policy if exists "users_insert_own_profile" on public.profiles;
drop policy if exists "Profiles read"            on public.profiles;
drop policy if exists "Profiles update"          on public.profiles;
drop policy if exists "Profiles insert"          on public.profiles;

create policy "users_read_own_profile"
  on public.profiles for select
  using (true);
create policy "users_update_own_profile"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);
create policy "users_insert_own_profile"
  on public.profiles for insert
  with check (auth.uid() = id);

-- Verify after running:
--   SELECT column_name, data_type, column_default
--   FROM information_schema.columns
--   WHERE table_name='profiles' AND column_name LIKE 'avatar%';
--   -- Expect 3 rows: avatar_finish, avatar_initials, avatar_image_url
--   SELECT policyname, cmd FROM pg_policies WHERE tablename='profiles';

-- ─────────────────────────────────────────────────────────────────
-- 2. Communities — group avatar fields
-- ─────────────────────────────────────────────────────────────────
alter table public.communities
  add column if not exists avatar_finish    text default 'chrome',
  add column if not exists avatar_image_url text,
  add column if not exists icon_initials    text;

alter table public.communities
  drop constraint if exists communities_avatar_finish_chk;
alter table public.communities
  add constraint communities_avatar_finish_chk check (
    avatar_finish in ('chrome','gold','rosegold','gunmetal',
                      'sapphire','emerald','amethyst','slate')
  );

update public.communities
  set avatar_finish = case
    when color in ('chrome','gold','rosegold','gunmetal',
                   'sapphire','emerald','amethyst','slate') then color
    else 'chrome'
  end
  where avatar_finish is null;

update public.communities
  set icon_initials = upper(substring(coalesce(name,'??') from 1 for 2))
  where icon_initials is null;

-- ─────────────────────────────────────────────────────────────────
-- VERIFY (run before/after to confirm both buckets exist + are public):
--   SELECT id, name, public FROM storage.buckets
--   WHERE id IN ('avatars', 'group-avatars');
-- Both rows should come back with public=true.
-- ─────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────
-- 3. Storage buckets — public, 2MB cap, image MIME whitelist
-- If your role can't INSERT into storage.buckets directly (managed
-- Supabase often blocks it), create both buckets via the dashboard:
--   Storage → New bucket → public:on, file size limit:2MB
--   allowed types: image/jpeg, image/png, image/webp
-- ─────────────────────────────────────────────────────────────────
insert into storage.buckets
  (id, name, public, file_size_limit, allowed_mime_types)
  values
  ('avatars', 'avatars', true, 2097152,
   array['image/jpeg','image/png','image/webp'])
  on conflict (id) do update
    set public = excluded.public,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets
  (id, name, public, file_size_limit, allowed_mime_types)
  values
  ('group-avatars', 'group-avatars', true, 2097152,
   array['image/jpeg','image/png','image/webp'])
  on conflict (id) do update
    set public = excluded.public,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

-- ─────────────────────────────────────────────────────────────────
-- 4. RLS — paths are folder-prefixed (`{user_id}/{timestamp}.jpg`).
-- Drop old single-file policies from prior runs first (idempotent).
-- ─────────────────────────────────────────────────────────────────
drop policy if exists "avatars public read"        on storage.objects;
drop policy if exists "avatars owner write"        on storage.objects;
drop policy if exists "avatars owner update"       on storage.objects;
drop policy if exists "avatars owner delete"       on storage.objects;
drop policy if exists "avatars_public_read"        on storage.objects;
drop policy if exists "avatars_user_write"         on storage.objects;
drop policy if exists "avatars_user_update"        on storage.objects;
drop policy if exists "avatars_user_delete"        on storage.objects;

create policy "avatars_public_read"
  on storage.objects for select
  using (bucket_id = 'avatars');

create policy "avatars_user_write"
  on storage.objects for insert
  with check (
    bucket_id = 'avatars'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "avatars_user_update"
  on storage.objects for update
  using (
    bucket_id = 'avatars'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "avatars_user_delete"
  on storage.objects for delete
  using (
    bucket_id = 'avatars'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "group-avatars public read"  on storage.objects;
drop policy if exists "group-avatars owner write"  on storage.objects;
drop policy if exists "group-avatars owner update" on storage.objects;
drop policy if exists "group-avatars owner delete" on storage.objects;
drop policy if exists "group_avatars_public_read"  on storage.objects;
drop policy if exists "group_avatars_owner_write"  on storage.objects;
drop policy if exists "group_avatars_owner_update" on storage.objects;
drop policy if exists "group_avatars_owner_delete" on storage.objects;

create policy "group_avatars_public_read"
  on storage.objects for select
  using (bucket_id = 'group-avatars');

create policy "group_avatars_owner_write"
  on storage.objects for insert
  with check (
    bucket_id = 'group-avatars'
    and exists (
      select 1 from public.communities
      where id::text = (storage.foldername(name))[1]
        and owner_id = auth.uid()
    )
  );

create policy "group_avatars_owner_update"
  on storage.objects for update
  using (
    bucket_id = 'group-avatars'
    and exists (
      select 1 from public.communities
      where id::text = (storage.foldername(name))[1]
        and owner_id = auth.uid()
    )
  );

create policy "group_avatars_owner_delete"
  on storage.objects for delete
  using (
    bucket_id = 'group-avatars'
    and exists (
      select 1 from public.communities
      where id::text = (storage.foldername(name))[1]
        and owner_id = auth.uid()
    )
  );

-- ─────────────────────────────────────────────────────────────────
-- 6. Force PostgREST to reload its schema cache so the new columns
-- are visible to the API immediately. Without this, saves return
-- "Could not find the 'avatar_finish' column of 'profiles' in the
-- schema cache" until the cache auto-reloads (~60s).
-- ─────────────────────────────────────────────────────────────────
-- Community posts — screenshot URL + per-post metadata jsonb.
-- Auto-share + edit-cascade write a trade's screenshot here so it
-- renders in the community feed; metadata holds chip-render fields
-- (grade / rr / session / market / emotion / confidence).
-- ─────────────────────────────────────────────────────────────────
do $$ begin
  if to_regclass('public.community_posts') is not null then
    execute 'alter table public.community_posts add column if not exists image_url text';
    execute 'alter table public.community_posts add column if not exists metadata jsonb default ''{}''::jsonb';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────
-- 7. SECURITY — RLS on every user-owned table.
-- Without this, app-side filters are the ONLY thing keeping users
-- from each others' data. Defense-in-depth: enable RLS + proper
-- policies so the database refuses cross-user reads even if the JS
-- forgets a .eq('user_id', ...).
--
-- Pre-flight audit (uncomment to run alone):
--   SELECT schemaname, tablename, rowsecurity
--     FROM pg_tables
--     WHERE schemaname='public'
--       AND tablename IN ('trades','profiles','communities',
--                         'community_posts','community_members',
--                         'community_post_likes','community_post_replies',
--                         'invites','user_settings');
-- Every row should show rowsecurity = true after this script runs.
-- ─────────────────────────────────────────────────────────────────

-- TRADES — split policies so SELECT can allow community members to
-- read each other's trades (the community feed builds posts directly
-- from trades.in('user_id', memberIds)) while writes stay owner-only.
alter table public.trades enable row level security;
drop policy if exists "trades_all_own"         on public.trades;
drop policy if exists "trades_select_own"      on public.trades;
drop policy if exists "trades_select_member"   on public.trades;
drop policy if exists "trades_insert_own"      on public.trades;
drop policy if exists "trades_update_own"      on public.trades;
drop policy if exists "trades_delete_own"      on public.trades;
-- SELECT: my own trades, OR trades from anyone who shares a community
-- with me (where "shares" means: there's a community row where both
-- auth.uid() AND trades.user_id are either the owner or in members[]).
create policy "trades_select_member" on public.trades
  for select using (
    auth.uid() = user_id
    or exists (
      select 1 from public.communities c
      where
        (c.owner_id = auth.uid() or auth.uid() = ANY (c.members))
        and
        (c.owner_id = trades.user_id or trades.user_id = ANY (c.members))
    )
  );
create policy "trades_insert_own" on public.trades
  for insert with check (auth.uid() = user_id);
create policy "trades_update_own" on public.trades
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "trades_delete_own" on public.trades
  for delete using (auth.uid() = user_id);

-- PROFILES policies were created earlier (read=public, write=own).

-- COMMUNITIES — members can read, owner can write.
do $$ begin
  if to_regclass('public.communities') is not null then
    execute 'alter table public.communities enable row level security';
  end if;
end $$;
drop policy if exists "communities_read_member"      on public.communities;
drop policy if exists "communities_write_owner"      on public.communities;
drop policy if exists "communities_select_visible"   on public.communities;
drop policy if exists "communities_select_own"       on public.communities;
drop policy if exists "communities_update_by_owner"  on public.communities;
drop policy if exists "communities_insert_anyone"    on public.communities;
drop policy if exists "communities_insert_own"       on public.communities;
drop policy if exists "communities_delete_owner"     on public.communities;
drop policy if exists "communities_delete_by_owner"  on public.communities;
drop policy if exists "Enable read access for all users" on public.communities;
-- SELECT: owner OR member (UUID listed in communities.members array).
-- This is the policy that lets joined users actually see the groups
-- they're members of.
create policy "communities_select_visible" on public.communities
  for select using (
    auth.uid() = owner_id
    or auth.uid() = ANY (members)
  );
-- INSERT: only the owner (auth.uid()) can create a community for
-- themselves — the row's owner_id must match.
create policy "communities_insert_own" on public.communities
  for insert with check (auth.uid() = owner_id);
-- UPDATE (owner): owner can update everything on the row. Required
-- by removeMember() to write a new members array.
create policy "communities_update_by_owner" on public.communities
  for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

-- UPDATE (invited user, self-join): a user with a pending invite for
-- this community can update the row IF the resulting row has them in
-- members[]. This is the policy that lets acceptCommInvite() succeed
-- without requiring owner-only writes. The WITH CHECK enforces the
-- only allowed effect: their own UUID being added.
drop policy if exists "communities_join_via_invite" on public.communities;
create policy "communities_join_via_invite" on public.communities
  for update using (
    exists (
      select 1 from public.invites
      where community_id = communities.id
        and to_id = auth.uid()
        and status = 'pending'
    )
  )
  with check (auth.uid() = ANY (members));

-- DELETE: owner.
create policy "communities_delete_by_owner" on public.communities
  for delete using (auth.uid() = owner_id);

-- COMMUNITY_POSTS — members can read, only post author can write/delete.
do $$ begin
  if to_regclass('public.community_posts') is not null then
    execute 'alter table public.community_posts enable row level security';
  end if;
end $$;
drop policy if exists "posts_read_member"               on public.community_posts;
drop policy if exists "posts_write_own"                 on public.community_posts;
drop policy if exists "posts_insert_member"             on public.community_posts;
drop policy if exists "posts_delete_own"                on public.community_posts;
drop policy if exists "community_posts_select_own"      on public.community_posts;
drop policy if exists "community_posts_select_members"  on public.community_posts;
drop policy if exists "community_posts_insert_own"      on public.community_posts;
drop policy if exists "community_posts_update_own"      on public.community_posts;
drop policy if exists "community_posts_delete_own_or_owner" on public.community_posts;
drop policy if exists "Enable read access for users"    on public.community_posts;
-- SELECT: any member (owner or in members[]) of the community can read
-- every post in it — including the daily check-ins, which is the only
-- thing this codebase writes to community_posts today.
create policy "community_posts_select_members" on public.community_posts
  for select using (
    exists (
      select 1 from public.communities c
      where c.id = community_posts.community_id
        and (c.owner_id = auth.uid() or auth.uid() = ANY (c.members))
    )
  );
-- INSERT: must be a member, must post as themselves.
create policy "community_posts_insert_own" on public.community_posts
  for insert with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.communities c
      where c.id = community_posts.community_id
        and (c.owner_id = auth.uid() or auth.uid() = ANY (c.members))
    )
  );
-- UPDATE: author only.
create policy "community_posts_update_own" on public.community_posts
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- DELETE: author OR community owner (moderation).
create policy "community_posts_delete_own_or_owner" on public.community_posts
  for delete using (
    auth.uid() = user_id
    or exists (
      select 1 from public.communities c
      where c.id = community_posts.community_id
        and c.owner_id = auth.uid()
    )
  );

-- COMMUNITY_MEMBERS — only relevant if a separate join table exists.
-- This codebase stores membership on communities.members[] instead, so
-- the table is usually absent. The whole block is wrapped in a guard
-- so the migration is a no-op when the table isn't there.
do $$ begin
  if to_regclass('public.community_members') is not null then
    execute 'alter table public.community_members enable row level security';
    execute 'drop policy if exists "members_read_same_community" on public.community_members';
    execute 'drop policy if exists "members_join_self"           on public.community_members';
    execute 'drop policy if exists "members_leave_self"          on public.community_members';
    execute 'drop policy if exists "members_remove_by_owner"     on public.community_members';
    execute $POL$
      create policy "members_read_same_community" on public.community_members
        for select using (
          exists (
            select 1 from public.community_members cm2
            where cm2.community_id = community_members.community_id
              and cm2.user_id = auth.uid()
          )
        )
    $POL$;
    execute $POL$
      create policy "members_join_self" on public.community_members
        for insert with check (auth.uid() = user_id)
    $POL$;
    execute $POL$
      create policy "members_remove_by_owner" on public.community_members
        for delete using (
          auth.uid() = user_id
          or exists (
            select 1 from public.communities
            where id = community_members.community_id
              and owner_id = auth.uid()
          )
        )
    $POL$;
  end if;
end $$;

-- COMMUNITY_POST_LIKES — read same as posts; write only own row.
do $$ begin
  if to_regclass('public.community_post_likes') is not null then
    execute 'alter table public.community_post_likes enable row level security';
  end if;
end $$;
drop policy if exists "likes_read_member"            on public.community_post_likes;
drop policy if exists "likes_write_own"              on public.community_post_likes;
drop policy if exists "likes_delete_own"             on public.community_post_likes;
drop policy if exists "post_likes_select_members"    on public.community_post_likes;
drop policy if exists "post_likes_insert_own"        on public.community_post_likes;
drop policy if exists "post_likes_delete_own"        on public.community_post_likes;
-- SELECT: any community member can see every like in their community.
create policy "post_likes_select_members" on public.community_post_likes
  for select using (
    exists (
      select 1 from public.communities c
      where c.id = community_post_likes.community_id
        and (c.owner_id = auth.uid() or auth.uid() = ANY (c.members))
    )
  );
create policy "post_likes_insert_own" on public.community_post_likes
  for insert with check (auth.uid() = user_id);
create policy "post_likes_delete_own" on public.community_post_likes
  for delete using (auth.uid() = user_id);

-- COMMUNITY_POST_REPLIES — read same as posts; write only own row.
do $$ begin
  if to_regclass('public.community_post_replies') is not null then
    execute 'alter table public.community_post_replies enable row level security';
  end if;
end $$;
drop policy if exists "replies_read_member"           on public.community_post_replies;
drop policy if exists "replies_write_own"             on public.community_post_replies;
drop policy if exists "replies_delete_own"            on public.community_post_replies;
drop policy if exists "post_replies_select_members"   on public.community_post_replies;
drop policy if exists "post_replies_insert_own"       on public.community_post_replies;
drop policy if exists "post_replies_delete_own"       on public.community_post_replies;
-- SELECT: any community member can read every reply in their community.
create policy "post_replies_select_members" on public.community_post_replies
  for select using (
    exists (
      select 1 from public.communities c
      where c.id = community_post_replies.community_id
        and (c.owner_id = auth.uid() or auth.uid() = ANY (c.members))
    )
  );
create policy "post_replies_insert_own" on public.community_post_replies
  for insert with check (auth.uid() = user_id);
create policy "post_replies_delete_own" on public.community_post_replies
  for delete using (auth.uid() = user_id);

-- INVITES — visible to sender + recipient; write by sender only.
do $$ begin
  if to_regclass('public.invites') is not null then
    execute 'alter table public.invites enable row level security';
  end if;
end $$;
drop policy if exists "invites_read_self"   on public.invites;
drop policy if exists "invites_insert_self" on public.invites;
drop policy if exists "invites_update_self" on public.invites;
drop policy if exists "invites_delete_self" on public.invites;
create policy "invites_read_self" on public.invites
  for select using (auth.uid() = from_id or auth.uid() = to_id);
create policy "invites_insert_self" on public.invites
  for insert with check (auth.uid() = from_id);
create policy "invites_update_self" on public.invites
  for update using (auth.uid() = to_id or auth.uid() = from_id);
create policy "invites_delete_self" on public.invites
  for delete using (auth.uid() = to_id or auth.uid() = from_id);

-- USER_SETTINGS — only owner can read/write.
do $$ begin
  if to_regclass('public.user_settings') is not null then
    execute 'alter table public.user_settings enable row level security';
  end if;
end $$;
drop policy if exists "user_settings_all_own" on public.user_settings;
create policy "user_settings_all_own" on public.user_settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────
-- 8. STORAGE — trade-images bucket policies (avatars + group-avatars
-- already covered above). Keep public read so feed thumbnails work,
-- restrict writes to user's own folder.
-- ─────────────────────────────────────────────────────────────────
drop policy if exists "trade_images_public_read"  on storage.objects;
drop policy if exists "trade_images_user_write"   on storage.objects;
drop policy if exists "trade_images_user_update"  on storage.objects;
drop policy if exists "trade_images_user_delete"  on storage.objects;
create policy "trade_images_public_read" on storage.objects
  for select using (bucket_id = 'trade-images');
create policy "trade_images_user_write" on storage.objects
  for insert with check (
    bucket_id = 'trade-images'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
create policy "trade_images_user_update" on storage.objects
  for update using (
    bucket_id = 'trade-images'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
create policy "trade_images_user_delete" on storage.objects
  for delete using (
    bucket_id = 'trade-images'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- ─────────────────────────────────────────────────────────────────
notify pgrst, 'reload schema';

-- Final verify (paste these into the SQL editor after the migration):
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name='profiles' AND column_name LIKE 'avatar%';
--   -- expect: avatar_finish, avatar_initials, avatar_image_url
--   SELECT tablename, rowsecurity FROM pg_tables
--     WHERE schemaname='public'
--       AND tablename IN ('trades','profiles','communities',
--                         'community_posts','community_members');
--   -- every row should show rowsecurity = true
--   SELECT tablename, policyname, cmd FROM pg_policies
--     WHERE schemaname='public' ORDER BY tablename, cmd;

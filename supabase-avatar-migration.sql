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
  add column if not exists avatar_image_url text;

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
notify pgrst, 'reload schema';

-- Final verify (paste these into the SQL editor after the migration):
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name='profiles' AND column_name LIKE 'avatar%';
--   -- expect: avatar_finish, avatar_initials, avatar_image_url
--   SELECT policyname, cmd FROM pg_policies WHERE tablename='profiles';
--   -- expect: users_read_own_profile, users_update_own_profile,
--   --         users_insert_own_profile

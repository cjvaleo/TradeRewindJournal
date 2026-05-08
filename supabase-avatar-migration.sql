-- Avatar finish + custom upload migration
-- Run in Supabase SQL editor (or via supabase db push).
--
-- Note: leaves the existing `trade-images` bucket untouched. Adds two new
-- buckets (`avatars`, `group-avatars`) alongside it.

-- ─────────────────────────────────────────────────────────────────
-- 1. Profiles — personal avatar fields
-- ─────────────────────────────────────────────────────────────────
alter table public.profiles
  add column if not exists avatar_finish    text default 'chrome',
  add column if not exists avatar_image_url text,
  add column if not exists avatar_initials  text;

alter table public.profiles
  drop constraint if exists profiles_avatar_finish_chk;
alter table public.profiles
  add constraint profiles_avatar_finish_chk check (
    avatar_finish in ('chrome','gold','rosegold','gunmetal',
                      'sapphire','emerald','amethyst','slate')
  );

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

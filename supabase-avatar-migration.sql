-- Avatar finish + custom upload migration
-- Run in Supabase SQL editor (or via supabase db push).

-- 1. Schema: add avatar_finish, avatar_image_url, avatar_initials.
-- The existing `color` column is repurposed by the app to store finish names
-- ('chrome','gold','sapphire',...). Old values ('pink','blue',...) fall back
-- to 'chrome' at render time, so no data backfill is required.
alter table public.profiles
  add column if not exists avatar_finish    text default 'chrome',
  add column if not exists avatar_image_url text,
  add column if not exists avatar_initials  text;

-- Constrain finish values.
alter table public.profiles
  drop constraint if exists profiles_avatar_finish_chk;
alter table public.profiles
  add constraint profiles_avatar_finish_chk check (
    avatar_finish in ('chrome','gold','rosegold','gunmetal',
                      'sapphire','emerald','amethyst','slate')
  );

-- Backfill avatar_finish from legacy color where reasonable.
update public.profiles
  set avatar_finish = case
    when color in ('chrome','gold','rosegold','gunmetal',
                   'sapphire','emerald','amethyst','slate') then color
    else 'chrome'
  end
  where avatar_finish is null;

-- Backfill avatar_initials from existing initials column.
update public.profiles
  set avatar_initials = upper(substring(coalesce(initials,'??') from 1 for 2))
  where avatar_initials is null;

-- 2. Communities — group avatars (rounded-square icon).
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

-- 3. Storage buckets — personal `avatars` and group `group-avatars`.
insert into storage.buckets (id, name, public)
  values ('avatars', 'avatars', true)
  on conflict (id) do nothing;
insert into storage.buckets (id, name, public)
  values ('group-avatars', 'group-avatars', true)
  on conflict (id) do nothing;

-- 4. RLS — `avatars` bucket: anyone reads; users write only own user_id path.
drop policy if exists "avatars public read" on storage.objects;
create policy "avatars public read"
  on storage.objects for select
  using (bucket_id = 'avatars');

drop policy if exists "avatars owner write" on storage.objects;
create policy "avatars owner write"
  on storage.objects for insert
  with check (
    bucket_id = 'avatars'
    and auth.uid()::text = split_part(name, '.', 1)
  );

drop policy if exists "avatars owner update" on storage.objects;
create policy "avatars owner update"
  on storage.objects for update
  using (
    bucket_id = 'avatars'
    and auth.uid()::text = split_part(name, '.', 1)
  );

drop policy if exists "avatars owner delete" on storage.objects;
create policy "avatars owner delete"
  on storage.objects for delete
  using (
    bucket_id = 'avatars'
    and auth.uid()::text = split_part(name, '.', 1)
  );

-- 5. RLS — `group-avatars` bucket: anyone reads; only the community's
-- owner_id can write/update/delete. Path is `${community_id}.<ext>`.
drop policy if exists "group-avatars public read" on storage.objects;
create policy "group-avatars public read"
  on storage.objects for select
  using (bucket_id = 'group-avatars');

drop policy if exists "group-avatars owner write" on storage.objects;
create policy "group-avatars owner write"
  on storage.objects for insert
  with check (
    bucket_id = 'group-avatars'
    and exists (
      select 1 from public.communities c
      where c.id::text = split_part(name, '.', 1)
        and c.owner_id = auth.uid()
    )
  );

drop policy if exists "group-avatars owner update" on storage.objects;
create policy "group-avatars owner update"
  on storage.objects for update
  using (
    bucket_id = 'group-avatars'
    and exists (
      select 1 from public.communities c
      where c.id::text = split_part(name, '.', 1)
        and c.owner_id = auth.uid()
    )
  );

drop policy if exists "group-avatars owner delete" on storage.objects;
create policy "group-avatars owner delete"
  on storage.objects for delete
  using (
    bucket_id = 'group-avatars'
    and exists (
      select 1 from public.communities c
      where c.id::text = split_part(name, '.', 1)
        and c.owner_id = auth.uid()
    )
  );

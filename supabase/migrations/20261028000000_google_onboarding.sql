
-- MathWake Google/email onboarding.
-- Legacy profiles are classified conservatively.
-- Google-linked users require a password hash and a valid display name.
-- Existing email/password users with a password remain legacy-complete.

begin;

-- 1. Add onboarding fields.
alter table public.profiles
  add column display_name text,
  add column onboarding_completed boolean not null default false;

alter table public.profiles
  add constraint profiles_display_name_length_check
  check (
    display_name is null
    or char_length(btrim(display_name)) between 1 and 80
  );

-- 2. Populate missing names for Google-linked legacy users.
-- Metadata is only a candidate display name, never an authorization source.
with google_names as (
  select
    u.id,
    case
      when char_length(btrim(coalesce(
        u.raw_user_meta_data ->> 'full_name', ''
      ))) between 1 and 80
      then btrim(u.raw_user_meta_data ->> 'full_name')

      when char_length(btrim(coalesce(
        u.raw_user_meta_data ->> 'name', ''
      ))) between 1 and 80
      then btrim(u.raw_user_meta_data ->> 'name')

      else null
    end as display_name
  from auth.users as u
  where exists (
    select 1
    from auth.identities as i
    where i.user_id = u.id
      and i.provider = 'google'
  )
)
update public.profiles as p
set display_name = n.display_name
from google_names as n
where p.id = n.id
  and p.display_name is null
  and n.display_name is not null;

-- 3. Classify existing accounts conservatively.
with identity_flags as (
  select
    u.id,
    count(i.user_id) filter (
      where i.provider = 'google'
    ) > 0 as has_google_identity,
    count(i.user_id) filter (
      where i.provider = 'email'
    ) > 0 as has_email_identity
  from auth.users as u
  left join auth.identities as i
    on i.user_id = u.id
  group by u.id
),
classified as (
  select
    p.id,
    case
      when f.has_google_identity then
        (
          (
            coalesce(
              (u.raw_app_meta_data ->> 'provider') = 'google',
              false
            )
            or coalesce(
              (u.raw_app_meta_data -> 'providers') ? 'google',
              false
            )
          )
          and (
            not f.has_email_identity
            or coalesce(
              (u.raw_app_meta_data ->> 'provider') = 'email',
              false
            )
            or coalesce(
              (u.raw_app_meta_data -> 'providers') ? 'email',
              false
            )
          )
          and (
            f.has_email_identity
            or not (
              coalesce(
                (u.raw_app_meta_data ->> 'provider') = 'email',
                false
              )
              or coalesce(
                (u.raw_app_meta_data -> 'providers') ? 'email',
                false
              )
            )
          )
        )
        and nullif(u.encrypted_password, '') is not null
        and p.display_name is not null
        and char_length(btrim(p.display_name)) between 1 and 80

      when f.has_email_identity
        and not (
          coalesce(
            (u.raw_app_meta_data ->> 'provider') = 'google',
            false
          )
          or coalesce(
            (u.raw_app_meta_data -> 'providers') ? 'google',
            false
          )
        )
        and (
          coalesce(
            (u.raw_app_meta_data ->> 'provider') = 'email',
            false
          )
          or coalesce(
            (u.raw_app_meta_data -> 'providers') ? 'email',
            false
          )
        )
        and nullif(u.encrypted_password, '') is not null
      then true

      else false
    end as onboarding_completed
  from public.profiles as p
  join auth.users as u
    on u.id = p.id
  join identity_flags as f
    on f.id = u.id
)
update public.profiles as p
set onboarding_completed = c.onboarding_completed
from classified as c
where c.id = p.id;

-- 4. Create or repair the authenticated user's own profile.
create or replace function public.ensure_my_profile()
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles;
begin
  if v_user_id is null then
    raise exception 'not authenticated'
      using errcode = '42501';
  end if;

  insert into public.profiles (id, role)
  values (v_user_id, 'user')
  on conflict (id) do nothing;

  select p.*
  into v_profile
  from public.profiles as p
  where p.id = v_user_id;

  if not found then
    raise exception 'profile could not be created';
  end if;

  return v_profile;
end;
$$;

-- 5. Complete onboarding only for the authenticated user.
create or replace function public.complete_my_onboarding(
  p_display_name text
)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_display_name text := btrim(coalesce(p_display_name, ''));
  v_encrypted_password text;
  v_has_google_identity boolean;
  v_profile public.profiles;
begin
  if v_user_id is null then
    raise exception 'not authenticated'
      using errcode = '42501';
  end if;

  if char_length(v_display_name) not between 1 and 80 then
    raise exception 'display name must contain 1 to 80 characters'
      using errcode = '22023';
  end if;

  select u.encrypted_password
  into v_encrypted_password
  from auth.users as u
  where u.id = v_user_id;

  if not found then
    raise exception 'authenticated user not found'
      using errcode = '42501';
  end if;

  select exists (
    select 1
    from auth.identities as i
    where i.user_id = v_user_id
      and i.provider = 'google'
  )
  into v_has_google_identity;

  -- Google-linked users must have a MathWake password.
  -- Existing email/password users do not need a second password.
  if v_has_google_identity
    and coalesce(v_encrypted_password, '') = ''
  then
    raise exception
      'password setup is required before onboarding completion'
      using errcode = '42501';
  end if;

  update public.profiles as p
  set
    display_name = v_display_name,
    onboarding_completed = true
  where p.id = v_user_id
  returning p.* into v_profile;

  if not found then
    raise exception 'profile not found; repair is required first';
  end if;

  return v_profile;
end;
$$;

-- 6. Restrict RPC execution to authenticated clients.
revoke all on function public.ensure_my_profile()
  from public, anon, authenticated;

grant execute on function public.ensure_my_profile()
  to authenticated;

revoke all on function public.complete_my_onboarding(text)
  from public, anon, authenticated;

grant execute on function public.complete_my_onboarding(text)
  to authenticated;

commit;

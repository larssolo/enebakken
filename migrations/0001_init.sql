-- Enebakken: tjeklister, opslagstavle og adgang.
--
-- Identitet (brugere, sessioner, adgangskoder) ejes af Neon Auth i skemaet
-- neon_auth. Tabellerne herunder lægger kun det oven på, som er vores eget:
-- hvem der må redigere, hvad listerne indeholder, og hvilke billeder der
-- hænger på opslagstavlen.
--
-- Afkrydsninger gemmes bevidst IKKE. De er lokale pr. besøg, så listerne
-- fungerer som i dag: man går huset igennem og lukker fanen bagefter.

begin;

-- Store/små bogstaver må ikke kunne give to konti til samme person.
create extension if not exists citext;

-- Adgang. user_id peger på Neon Auth's bruger-id. Der er med vilje ingen
-- foreign key endnu — neon_auth-skemaet oprettes først når Auth aktiveres,
-- og en FK mod en tabel vi ikke har inspiceret ville være et gæt.
create table if not exists members (
    user_id      text primary key,
    role         text        not null default 'member'
                 check (role in ('owner', 'member')),
    display_name text,
    created_at   timestamptz not null default now()
);

comment on table members is
    'Rolle oven på Neon Auth. owner må redigere tjeklisterne; member må lægge billeder op.';

-- Invitationer. Ingen selvoprettelse: en konto kan kun opstå ved at ejeren
-- inviterer en e-mailadresse, og invitationen kan kun bruges én gang.
create table if not exists invites (
    id          bigint generated always as identity primary key,
    email       citext      not null,
    token_hash  text        not null unique,
    invited_by  text        not null,
    created_at  timestamptz not null default now(),
    expires_at  timestamptz not null,
    accepted_at timestamptz,
    accepted_by text
);

comment on column invites.token_hash is
    'Kun hash af invitationstokenet. Selve tokenet sendes i e-mailen og gemmes aldrig, så en læsning af databasen ikke giver adgang.';

-- Én åben invitation pr. e-mail ad gangen.
create unique index if not exists invites_open_email_idx
    on invites (email)
    where accepted_at is null;

create index if not exists invites_expiry_idx
    on invites (expires_at)
    where accepted_at is null;

-- Tjeklisternes indhold. Det er dette ejeren kan redigere.
create table if not exists checklist_items (
    id         bigint generated always as identity primary key,
    list       text        not null check (list in ('luk', 'aaben')),
    label      text        not null check (length(btrim(label)) > 0),
    position   integer     not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- Rækkefølgen skal være entydig inden for hver liste. API'et gemmer en
-- redigeret liste ved at erstatte den samlet i én transaktion, så der er
-- aldrig to rækker om den samme position undervejs.
create unique index if not exists checklist_items_order_idx
    on checklist_items (list, position);

-- Opslagstavlen. Selve filen ligger i den private bucket; her står kun nøglen.
create table if not exists photos (
    id          bigint generated always as identity primary key,
    object_key  text        not null unique,
    caption     text,
    uploaded_by text        not null,
    created_at  timestamptz not null default now()
);

comment on column photos.object_key is
    'Nøgle i den private upload-bucket. Bucketen er privat, så visning kræver en signeret URL — billederne kan ikke hotlinkes.';

create index if not exists photos_newest_idx
    on photos (created_at desc);

-- Hold updated_at ærlig, så en redigering altid kan spores.
create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists checklist_items_touch on checklist_items;
create trigger checklist_items_touch
    before update on checklist_items
    for each row execute function touch_updated_at();

commit;

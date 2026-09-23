-- Delte afkrydsninger på huskesedlen.
--
-- Indtil nu var afkrydsninger lokale pr. telefon (se 0001). Nu deles de
-- mellem alle, der er logget ind, så to personer kan gå huset igennem hver
-- for sig og følge med i hinandens flueben.
begin;

-- Én række pr. punkt; den seneste ændring vinder. En fjernet afkrydsning
-- gemmes som checked = false i stedet for at blive slettet, så den stadig
-- slår en ældre afkrydsning, der først når frem senere (fra en telefon,
-- der var offline). Punktet identificeres ved sin tekst, så afkrydsningen
-- overlever, at ejeren redigerer andre punkter på listen.
create table if not exists checklist_ticks (
    list            text        not null check (list in ('luk', 'aaben')),
    label           text        not null,
    checked         boolean     not null,
    changed_by      text        not null,
    changed_by_name text,
    changed_at      timestamptz not null,
    primary key (list, label)
);

comment on column checklist_ticks.changed_at is
    'Hvornår ændringen blev foretaget på telefonen, ikke hvornår den nåede frem. Afgør, hvilken ændring der vinder.';

-- "Nulstil" gælder alle. reset_at er et skel: ændringer foretaget før det
-- tæller ikke, heller ikke når de først når frem bagefter. Én række pr.
-- liste, og alle skrivninger låser rækkerne først, så de kører én ad gangen.
create table if not exists checklist_resets (
    list     text        primary key check (list in ('luk', 'aaben')),
    reset_at timestamptz not null
);

insert into checklist_resets (list, reset_at)
values ('luk', '-infinity'), ('aaben', '-infinity')
on conflict (list) do nothing;

commit;

-- Personlige huskesedler.
--
-- Under "Luk ned" kan hver, der er logget ind, skrive sin egen huskeseddel
-- (fx hvad der mangler til næste gang) og sende den videre som sms. Kun
-- personen selv kan se sin seddel. Punkterne gemmes samlet, i rækkefølge,
-- som én liste: [{ id, text, done }].
begin;

create table if not exists notes (
    user_id    text        primary key,
    items      jsonb       not null default '[]'::jsonb,
    updated_at timestamptz not null default now()
);

commit;

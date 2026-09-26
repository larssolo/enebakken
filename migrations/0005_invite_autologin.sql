-- Invitationer logger den inviterede direkte ind.
--
-- Når en invitation oprettes til en e-mail, der endnu ikke har en konto,
-- opretter API'et kontoen med en tilfældig adgangskode og gemmer den
-- session, oprettelsen gav. Et klik på linket gør den session til den
-- inviteredes egen — ingen formular, ingen adgangskode. Vil personen have
-- sin egen adgangskode, bruger de "Skift adgangskode" bagefter.
begin;

alter table invites
    add column if not exists provisioned_user_id text,
    add column if not exists session_cookie      text;

comment on column invites.provisioned_user_id is
    'neon_auth.user id created for this invite when the email had no existing account yet. Null means the invitee already had an account, or provisioning failed — falls back to the classic sign-in/sign-up flow.';

comment on column invites.session_cookie is
    'Neon Auth session cookie pair for the account this invite auto-provisioned, set once at creation and cleared on redemption or cancellation — lets clicking the link log the invitee straight in without a password.';

commit;

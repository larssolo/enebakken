# Tests

API- og browsertests for Enebakken. De kører den **rigtige** kode fra `api/`
(bundtet direkte fra `.ts`-filerne) og den rigtige `Enebakken.html` mod en
lokal Postgres. Kun Neon Auth er erstattet — af en lokal signeringsnøgle og,
hvor der skal logges ind, en lille mock i `servers/`.

GitHub kører dem automatisk på hver pull request og hvert push til `main`
(`.github/workflows/tests.yml`).

## Køre dem lokalt

Kræver Node 22 og en Postgres 16 med en tom database, som testene må
overskrive frit (brug aldrig produktionens):

```sh
createdb ebtest                      # bruger eb / adgangskode eb som standard
npm ci && npm ci --prefix tests
(cd tests && npx playwright install chromium)
node tests/run.mjs                   # alle suiter
node tests/run.mjs invites           # kun suiter hvis sti indeholder "invites"
```

Anden database: `TEST_DATABASE_URL=postgres://…`. Egen Chromium:
`CHROMIUM_PATH=/sti/til/chrome`.

`run.mjs` lægger først neon_auth-stubben og alle `migrations/` ind (idempotent),
og kører derefter suiterne én ad gangen, hver med sin egen friske server.

## Opbygning

- `api/` — kalder route-handlerne direkte eller via en server.
- `ui/` — Playwright mod siden, som den serveres af en af serverne.
- `servers/` — lokale stand-ins for sitet (invite-, admin- og ticks-server).
- `lib/harness.mjs` — fælles: indlæsning af `api/`, JWT-signering, tælling.
- `db/setup.mjs` — neon_auth-stub + migrationer.

import { defineConfig } from "@neon/config/v1";

// The API lives on Vercel (api/*.ts), sharing the site's domain — see
// api/_lib. Neon provides Postgres (via the Vercel-Neon integration's
// injected DATABASE_URL), Auth, and this private bucket for photos.
export default defineConfig({
  preview: {
    // Upgrade to a paid plan to enable AI Gateway for your project.
    // aiGateway: true,
    buckets: {
      upload: { access: "private" },
    },
  },
});

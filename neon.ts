import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  preview: {
    // Upgrade to a paid plan to enable AI Gateway for your project.
    // aiGateway: true,
    buckets: {
      upload: { access: "private" },
    },
    functions: {
      api: { name: "api", source: "./hello.ts" },
    },
  },
});

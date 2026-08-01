import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";

export default defineConfig({
  // standalone: astro's own node server, self-hosted, which is the deployment
  // borgo competes with
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [react()],
  compressHTML: false,
  server: { port: Number(process.env.PORT || 43021), host: "127.0.0.1" },
});

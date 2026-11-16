import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { createDemoAuthPlugin } from "./server/auth-plugin.js";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const renderHostname = process.env.RENDER_EXTERNAL_HOSTNAME;
  const additionalPreviewHosts = (process.env.PREVIEW_ALLOWED_HOSTS || "")
    .split(",")
    .map((hostname) => hostname.trim())
    .filter(Boolean);
  const allowedPreviewHosts = [...new Set([renderHostname, ...additionalPreviewHosts].filter(Boolean))];
  return {
    plugins: [react(), createDemoAuthPlugin(env)],
    server: { host: "127.0.0.1", port: 6243 },
    preview: { host: "127.0.0.1", port: 6243, allowedHosts: allowedPreviewHosts }
  };
});

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // 127.0.0.1, not localhost: in local mode the API listens on IPv4 loopback only. Keep the browser's Host, so the API's same-origin check sees the page's own origin.
    proxy: { "/api": { target: "http://127.0.0.1:3001", changeOrigin: false } },
  },
});

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Keep the browser's Host, so the API's same-origin check sees the page's own origin.
    proxy: { "/api": { target: "http://localhost:3001", changeOrigin: false } },
  },
});

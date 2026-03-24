import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwindcss()],
  // Vitest runs its own environment — only Vite app files need the browser target
  server: {
    port: 5173
  }
});

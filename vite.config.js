import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: "0.0.0.0",
    port: 3000,
    proxy: {
      "/api": "http://127.0.0.1:4000",
      "^/s(?:/|$)": "http://127.0.0.1:4000",
    },
  },
});

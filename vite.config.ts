import { defineConfig } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

// TanStack Query reads process.env.NODE_ENV, which windows do not have; the main process does, but the value is fixed
// for both.
export default defineConfig({ plugins: [gui()], define: { "process.env.NODE_ENV": JSON.stringify("production") } })

import { defineConfig } from "astro/config";

// Written by the course stack skill; values derived from this repo's origin
// remote. The dev server serves under the base too, so a path bug reproduces
// locally instead of only on the live URL. build.format "file" keeps
// page.astro building to dist/page.html, so hand-written relative links and
// asset paths keep working; compressHTML true because the default ("jsx")
// strips the space before line-broken inline elements in hand-written prose.
export default defineConfig({
  site: "https://comp4020-agentic-coding-studio.github.io",
  base: "/comp4020-crit4-HarkiratS1511",
  build: { format: "file" },
  compressHTML: true,
});

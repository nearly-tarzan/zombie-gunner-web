import { defineConfig } from 'vite'

// base must match the GitHub Pages project subpath (/<repo>/), or every
// hashed asset 404s when served from nearly-tarzan.github.io/zombie-gunner-web/.
export default defineConfig({
  base: '/zombie-gunner-web/',
})

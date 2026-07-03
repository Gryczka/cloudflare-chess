// @ts-check
import { defineConfig } from 'astro/config';

import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    // Disable remote binding validation for local dev / astro check.
    // Placeholder KV/Queue/AI IDs work locally without a Cloudflare connection.
    remoteBindings: false,
  }),
});

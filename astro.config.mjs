import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';
import node from '@astrojs/node';

const isVercel = process.env.VERCEL === '1';

export default defineConfig({
  output: 'server',
  adapter: isVercel
    ? vercel({
        maxDuration: 60,
      })
    : node({
        mode: 'standalone',
      }),
  vite: {
    ssr: {
      // These native/binary packages must stay external (not bundled)
      external: [
        'neo4j-driver',
        'pdf-parse',
        'pdfkit',
        'pdf-lib',
        '@opentelemetry/sdk-node',
        '@opentelemetry/auto-instrumentations-node',
        '@opentelemetry/exporter-trace-otlp-http',
        '@opentelemetry/api',
      ],
    },
  },
});

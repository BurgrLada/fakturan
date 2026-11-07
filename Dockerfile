FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
# Under the isolated linker sharp lives only inside .pnpm; collect its closure and expose it at the top level.
RUN mkdir -p /sharp/.pnpm \
 && cp -a node_modules/.pnpm/sharp@* node_modules/.pnpm/@img+* node_modules/.pnpm/semver@7* node_modules/.pnpm/detect-libc@* /sharp/.pnpm/ \
 && ln -s .pnpm/$(ls /sharp/.pnpm | grep '^sharp@')/node_modules/sharp /sharp/sharp

FROM deps AS build
COPY . .
# The build needs valid-looking values only to evaluate config; they are not baked into the image at runtime.
RUN BETTER_AUTH_URL=http://localhost BETTER_AUTH_SECRET=build-only-build-only-build-only-00 pnpm run build
# The smoke script resolves react-pdf, sharp and the fonts from the runner image, so it proves output tracing.
RUN pnpm exec esbuild scripts/pdf-smoke-entry.ts --bundle --platform=node --format=esm \
      --alias:server-only=./tests/helpers/server-only.ts \
      --external:sharp --external:@react-pdf/renderer \
      "--banner:js=import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
      --outfile=/smoke/pdf-smoke-bundle.mjs
# Seeds the demo account through the services. Native, PDF and jsdom packages (jsdom reads its own
# files next to its code) resolve from the runner instead of the bundle.
RUN pnpm exec esbuild scripts/demo-seed-entry.ts --bundle --platform=node --format=esm \
      --alias:server-only=./tests/helpers/server-only.ts \
      --external:better-sqlite3 --external:sharp --external:@react-pdf/renderer --external:jsdom \
      "--banner:js=import { createRequire as bannerRequire } from 'node:module'; const require = bannerRequire(import.meta.url);" \
      --outfile=/smoke/demo-seed.mjs

FROM node:24-bookworm-slim AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATA_DIR=/data \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# Tracing keeps only some of the platform prebuilds; the whole package guarantees the native binding.
COPY --from=deps /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=deps /sharp/ ./node_modules/
COPY --from=build /smoke/pdf-smoke-bundle.mjs /smoke/demo-seed.mjs /app/scripts/pdf-smoke.mjs ./scripts/
COPY scripts/isdoc-smoke.mjs ./scripts/
# Fails the build when tracing dropped the XSD, the xmllint worker or its wasm.
RUN node scripts/isdoc-smoke.mjs
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]

# The build output is platform-independent JavaScript, so it is built once on
# the builder's native platform and shared by every target architecture.
FROM --platform=$BUILDPLATFORM node:25-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && rm -rf .next/cache .next/dev .next/types

FROM node:25-bookworm-slim AS runtime
ARG VERSION=dev
ARG SOURCE=https://github.com/whexy/proxdesk
LABEL org.opencontainers.image.title="Proxdesk" \
      org.opencontainers.image.description="Self-service portal for shared Proxmox VMs" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.source="$SOURCE"
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOST=0.0.0.0 PORT=3000 DATABASE_PATH=/app/data/proxdesk.sqlite
COPY package.json package-lock.json ./
# Optional dependencies are the prebuilt compiler and image binaries that only
# `next build` uses; without them the runtime contains no native code.
RUN npm ci --omit=dev --omit=optional && npm cache clean --force && mkdir data && chown node:node data
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build /app/dist ./dist
COPY next.config.mjs ./
USER node
VOLUME /app/data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/api/auth/session`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["node", "dist/proxdesk.js"]
CMD ["serve"]

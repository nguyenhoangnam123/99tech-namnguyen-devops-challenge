# One image for every service; compose picks the entrypoint per service.
FROM node:22.23.0-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/contracts/package.json packages/contracts/
COPY packages/codecs/package.json packages/codecs/
COPY packages/platform/package.json packages/platform/
COPY services/oms/package.json services/oms/
COPY services/matcher/package.json services/matcher/
COPY services/marketdata/package.json services/marketdata/
COPY tests/package.json tests/
RUN npm ci --workspace packages --workspace services --include-workspace-root --no-audit --no-fund
COPY packages packages
COPY services services
RUN npx tsc -b packages/core packages/contracts packages/codecs packages/platform \
      services/oms services/matcher services/marketdata \
 && npm prune --omit=dev --workspace packages --workspace services --include-workspace-root

FROM gcr.io/distroless/nodejs22-debian13:nonroot
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages packages
COPY --from=build /app/services services
COPY contracts/openapi contracts/openapi
USER nonroot

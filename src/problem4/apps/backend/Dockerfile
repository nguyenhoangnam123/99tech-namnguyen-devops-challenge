FROM node:22.23.0-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src src
RUN npm run build

# No runtime dependencies, so the image is Node plus compiled files.
FROM gcr.io/distroless/nodejs22-debian13:nonroot
ARG APP_VERSION=dev
LABEL org.opencontainers.image.revision=$APP_VERSION
ENV NODE_ENV=production APP_VERSION=$APP_VERSION PORT=8080
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/dist dist
EXPOSE 8080
CMD ["dist/main.js"]

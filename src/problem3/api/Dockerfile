# Pinned by digest, so every rebuild starts from the same base image.
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

ENV NODE_ENV=production
WORKDIR /app
# The lockfile pins every dependency, so each build installs the same tree.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

USER node
CMD ["node", "src/index.js"]

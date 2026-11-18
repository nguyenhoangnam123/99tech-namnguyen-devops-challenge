FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app
# The lockfile pins every dependency, so each build installs the same tree.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

USER node
CMD ["node", "src/index.js"]

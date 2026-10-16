# Container image for UK hosting (Fly.io London, AWS eu-west-2, Azure UK South, Google europe-west2).
# The demo needs nothing but Node; a live server (DATABASE_URL set) also uses the Postgres driver, "pg".
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
COPY scripts/live-admin.js ./scripts/live-admin.js
COPY test ./test
# A failing test fails the build, so a broken image is never deployed.
RUN ROUTING_PROVIDER=estimate npm test && rm -rf test
ENV NODE_ENV=production PORT=3000
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/api/meta >/dev/null || exit 1
CMD ["node", "--experimental-sqlite", "--no-warnings", "server/index.js"]

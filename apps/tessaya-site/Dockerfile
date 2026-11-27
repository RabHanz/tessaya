# The public site as a static nginx image. Built from the repo root:  docker build -f apps/tessaya-site/Dockerfile .
# shortcut: installs only the site's own packages (versions as in pnpm-lock.yaml), not the workspace; move to a
# filtered pnpm install if the site gains more workspace imports than the docs parser.
FROM node:24-alpine AS build
WORKDIR /repo
COPY apps/tessaya-site apps/tessaya-site
COPY apps/web/public/companion apps/web/public/companion
COPY packages/tessaya-shared/src/docs.ts packages/tessaya-shared/src/docsBundle.data.ts packages/tessaya-shared/src/
RUN printf '{"name":"@t3tools/tessaya-shared","type":"module","exports":{"./*":"./src/*.ts"}}' > packages/tessaya-shared/package.json
WORKDIR /repo/apps/tessaya-site
RUN printf '{"private":true,"type":"module"}' > package.json \
 && npm install --no-audit --no-fund astro@7.3.5 three@0.180.0 @fontsource-variable/newsreader@5.3.0 @fontsource-variable/jetbrains-mono@5.3.0 \
 && mkdir -p node_modules/@t3tools && ln -s /repo/packages/tessaya-shared node_modules/@t3tools/tessaya-shared
ARG TESSAYA_SITE_URL
ENV TESSAYA_SITE_URL=$TESSAYA_SITE_URL
RUN node scripts/stage-engine.mjs && npx astro build

FROM nginx:1.27-alpine
COPY apps/tessaya-site/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/tessaya-site/dist /usr/share/nginx/html

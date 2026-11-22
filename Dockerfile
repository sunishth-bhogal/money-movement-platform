FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY migrations ./migrations
COPY src ./src
COPY scripts ./scripts
COPY dashboard ./dashboard
COPY wallet ./wallet
COPY portal ./portal
RUN npx vite build --config dashboard/vite.config.ts && npx vite build --config wallet/vite.config.ts && npx vite build --config portal/vite.config.ts
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npx", "tsx", "src/server.ts"]

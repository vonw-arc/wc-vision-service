# Dockerfile
FROM node:22-bookworm-slim

# Install poppler (pdftoppm) + minimal deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy app
COPY . .

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]

# Dockerfile
FROM node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

# Install poppler (pdftoppm) + minimal deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils ca-certificates \
  && update-ca-certificates \
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

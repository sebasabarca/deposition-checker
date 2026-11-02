# Veridict: one image for the web server (API + built client) and the worker. The worker reads
# scanned PDFs with Poppler and Tesseract, so both are installed here.
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-eng ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json client/package-lock.json ./client/
# postinstall installs the client's dependencies too.
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production PORT=3001
EXPOSE 3001
# Uploaded files live in /app/data/uploads; mount a volume there so they outlive the container.
RUN mkdir -p /app/data/uploads && chown -R node:node /app/data
VOLUME ["/app/data/uploads"]
USER node
CMD ["npm", "start"]

# Imagen oficial de Playwright (trae Chromium + dependencias del sistema).
FROM mcr.microsoft.com/playwright:v1.61.1-jammy

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

CMD ["node", "run-all.mjs"]

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm install && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY skill ./skill
COPY server.json ./

# stdio MCP server; free tools work with no configuration.
# Optional: DATASIEVE_PRIVATE_KEY_FILE (mount a key file) enables purchases,
# DATASIEVE_API_URL=https://staging.datasieve.xyz targets the sandbox.
ENTRYPOINT ["node", "dist/main.js"]

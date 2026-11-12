FROM node:24.22.3-bookworm@sha256:9d266751ca3d7fdbe651c878ffd5ad0a42fed49a18c283509267c97f025b7496 AS base
USER node
WORKDIR /home/node/app
COPY package*.json ./
EXPOSE 8080

FROM base AS development
ENV DEBUG=true
RUN npm ci
COPY . .
CMD [ "npm", "start" ]
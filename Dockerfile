FROM node:26.13.0-bookworm@sha256:6cbd8d89163e7f30fd577138079aaa29aeea5d05cd2894ac5dd4e24bea360f26 AS base
USER node
WORKDIR /home/node/app
COPY package*.json ./
EXPOSE 8080

FROM base AS development
ENV DEBUG=true
RUN npm ci
COPY . .
CMD [ "npm", "start" ]
FROM node:24.22.3-bookworm@sha256:49f7adaf9f1574bc45c20ea317139b39a59d7e758d0e93745e112fd85cb42623 AS base
USER node
WORKDIR /home/node/app
COPY package*.json ./
EXPOSE 8080

FROM base AS development
ENV DEBUG=true
RUN npm ci
COPY . .
CMD [ "npm", "start" ]
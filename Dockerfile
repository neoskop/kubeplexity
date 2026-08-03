FROM node:24.19.0-bookworm@sha256:eb37f58646a901dc7727cf448cae36daaefaba79de33b5058dab79aa4c04aefb AS base
USER node
WORKDIR /home/node/app
COPY package*.json ./
EXPOSE 8080

FROM base AS development
ENV DEBUG=true
RUN npm ci
COPY . .
CMD [ "npm", "start" ]
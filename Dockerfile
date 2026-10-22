FROM node:24.22.1-bookworm@sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a AS base
USER node
WORKDIR /home/node/app
COPY package*.json ./
EXPOSE 8080

FROM base AS development
ENV DEBUG=true
RUN npm ci
COPY . .
CMD [ "npm", "start" ]
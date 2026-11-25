FROM node:26.13.1-bookworm@sha256:893ea48106e988a5f91e69629d6472600daa9d0494adf7db87eb0b886ce82255 AS base
USER node
WORKDIR /home/node/app
COPY package*.json ./
EXPOSE 8080

FROM base AS development
ENV DEBUG=true
RUN npm ci
COPY . .
CMD [ "npm", "start" ]
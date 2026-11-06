FROM oven/bun:1.4.4-alpine

WORKDIR /app

COPY package.json bun.lock .

RUN bun i --production

COPY . .

RUN mv .env.deploy .env

EXPOSE 3000

CMD ["bun", "start"]

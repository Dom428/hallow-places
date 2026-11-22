# Hallow Places - no npm packages, just Node's standard library.
FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
# the data volume belongs to the unprivileged node user (a named volume copies this ownership on first use)
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 DATA_DIR=/data
USER node
EXPOSE 8080
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]

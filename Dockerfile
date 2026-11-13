# Chamber — self-hosted image (T-0061). Zero npm dependencies, so the image is just Node + the source.
# Build:  docker build -t chamber .        Run: see docker-compose.yml / SELF-HOSTING.md
FROM node:22-alpine
RUN apk add --no-cache git python3 tini && addgroup -S chamber && adduser -S -G chamber -h /var/lib/chamber chamber
WORKDIR /opt/chamber/app
COPY --chown=chamber:chamber . .
# /source (AGPL §13) and /changelog read the git history; keep a shallow copy if the context was cloned, else init one.
RUN if [ ! -d .git ]; then git init -q && git -c user.name=image -c user.email=image@localhost add -A && git -c user.name=image -c user.email=image@localhost commit -qm "image build"; fi \
 && chown -R chamber:chamber /opt/chamber/app && mkdir -p /var/lib/chamber && chown chamber:chamber /var/lib/chamber
USER chamber
ENV NODE_ENV=production CHAMBER_HOST=0.0.0.0 CHAMBER_PORT=4242 \
    CHAMBER_DATA=/var/lib/chamber/chamber.json CHAMBER_REVIEWS=/var/lib/chamber/reviews.json \
    CHAMBER_TICKETS_FILE=/var/lib/chamber/tickets.json CHAMBER_TICKETS_CLI=/opt/chamber/app/tickets-cli.js
VOLUME ["/var/lib/chamber"]
EXPOSE 4242
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:4242/api/health | grep -q '"ok":true' || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]

#!/bin/bash
# /opt/chamber-browsercheck/run.sh <app-dir> [keep-screenshots-dir]   (T-0173, called by chamber-deploy; safe to run by hand as root)
# Starts a PRIVATE copy of the given app tree on 127.0.0.1 with throwaway data and test hooks, then lets a headless browser
# (user chamber-check, which owns nothing and can read nothing of Chamber's) use it like a person. Exit 0 = every check passed.
# The live service, its data and its secrets are not involved: the copy gets an empty environment and dummy Stripe values.
set -uo pipefail
APP=${1:?usage: run.sh <app-dir> [keep-screenshots-dir]}; KEEP=${2:-}; BC=/opt/chamber-browsercheck
[ -f "$APP/tools/browser-check.js" ] || { echo "no tools/browser-check.js in $APP"; exit 2; }
W=$(mktemp -d /tmp/chamber-bc.XXXXXX); chmod 755 "$W"; mkdir "$W/data" "$W/out"; chown chamber "$W/data"; chown chamber-check "$W/out"
touch "$W/server.log"; chown chamber "$W/server.log"; chmod 644 "$W/server.log"
install -m 644 "$APP/tools/browser-check.js" "$W/check.js"
PORT=$((30000 + RANDOM % 20000)); SP=""
cleanup() { [ -n "$SP" ] && kill "$SP" 2>/dev/null; [ -n "$KEEP" ] && { mkdir -p "$KEEP"; cp "$W"/out/*.png "$KEEP"/ 2>/dev/null; cp "$W/server.log" "$KEEP"/ 2>/dev/null; }; rm -rf "$W"; }
trap cleanup EXIT
cd "$W/data" || exit 2
sudo -u chamber env -i PATH="$PATH" HOME="$W/data" CHAMBER_ACCOUNTS=1 CHAMBER_STRIPE_SECRET=sk_test_dummy CHAMBER_STRIPE_WEBHOOK_SECRET=whsec_dummy CHAMBER_STRIPE_PRICE=price_dummy \
  CHAMBER_PUBLIC_URL="http://127.0.0.1:$PORT" CHAMBER_PORT="$PORT" CHAMBER_HOST=127.0.0.1 CHAMBER_TEST_HOOKS=1 CHAMBER_TRIAL_DAYS=14 CHAMBER_TRIAL_SIGNUPS_PER_IP_DAY=50 \
  CHAMBER_DATA="$W/data/chamber.json" CHAMBER_REVIEWS="$W/data/reviews.json" CHAMBER_TICKETS_FILE="$W/data/tickets.json" CHAMBER_TICKETS_CLI="$APP/tickets-cli.js" \
  node --disable-warning=ExperimentalWarning "$APP/server.js" >> "$W/server.log" 2>&1 &
SP=$!
for i in $(seq 1 50); do curl -s -m 2 "http://127.0.0.1:$PORT/api/health" | grep -q '"ok":true' && break; sleep 0.2; done
curl -s -m 2 "http://127.0.0.1:$PORT/api/health" | grep -q '"ok":true' || { echo "the private copy did not start:"; tail -5 "$W/server.log"; exit 1; }
cd "$W/out" || exit 2
sudo -u chamber-check env -i PATH="$PATH" HOME="$W/out" NODE_PATH="$BC/node_modules" PLAYWRIGHT_BROWSERS_PATH="$BC/browsers" \
  timeout 300 node "$W/check.js" "http://127.0.0.1:$PORT" "$W/server.log" "$W/out"

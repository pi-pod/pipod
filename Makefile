# pi pod workspace local dev: server + native mobile app signed in with a dev JWT.
#
#   make            # start deps, server, build/launch simulator already logged in
#   make stop       # stop background JWKS + API server started by make
#   make seed       # re-seed the dev user/org only
#   make token      # print a fresh dev JWT
#   make ios SIM_UDID=...       # build/launch Swift iOS on your simulator
#   make android ANDROID_SERIAL=...  # build/launch Kotlin Android
#   make logs       # tail server + JWKS logs
#   make check-pi-pins           # CLI and server must agree on the exact pi pin
#   make bump-pi VERSION=x.y.z   # exact-pin pi in CLI + server, match pi-tui, run canaries
#                                # VERSION=latest resolves npm @latest. DRY_RUN=1 / SKIP_CHECKS=1.
#
# Prerequisites: Docker (Postgres), Node 22.19+, psql (optional).
# iOS: Xcode + XcodeGen. Android: JDK 21 + Android SDK. No desktop app targets.

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := dev

ROOT        := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
SERVER_DIR  ?= $(ROOT)/server
IOS_DIR     ?= $(ROOT)/ios
ANDROID_DIR ?= $(ROOT)/android
RUN_DIR     := $(ROOT)/.dev
DEV_API     := $(SERVER_DIR)/dev/dev-api.sh

SERVER_URL ?= http://127.0.0.1:8080
JWKS_URL   ?= http://127.0.0.1:9999/jwks
DEV_USER   ?= 018f0000-0000-7000-8000-000000000001
DEV_ORG    ?= 018f0000-0000-7000-8000-000000000010

# Explicit simulator ownership avoids stomping on another developer's session.
SIM_UDID   ?=
ANDROID_SERIAL ?=
ANDROID_SERVER_URL ?=
BUNDLE_ID  := com.pipod.app

export PATH := /opt/homebrew/bin:/usr/local/bin:$(PATH)
export SERVER_DIR RUN_DIR SERVER_URL IOS_DIR ANDROID_DIR
export SIM_UDID ANDROID_SERIAL ANDROID_SERVER_URL DEV_USER DEV_ORG

# Source server/.env into the current recipe shell (no dotenv runtime).
LOAD_ENV = set -a && source "$(SERVER_DIR)/.env" && set +a

.PHONY: dev stop seed token ios android logs jwks server wait-server db-up ensure-dirs help _ios-launch _android-launch bump-pi check-pi-pins pi-image-tag

help:
	@sed -n '2,14p' $(MAKEFILE_LIST)

dev: ensure-dirs db-up jwks server wait-server seed ios
	@echo ""
	@echo "Dev is up."
	@echo "  API    $(SERVER_URL)"
	@echo "  JWKS   $(JWKS_URL)"
	@echo "  App    $(BUNDLE_ID) (simulator, auto-signed-in)"
	@echo "  Logs   make logs   | stop: make stop"

ensure-dirs:
	@test -d "$(SERVER_DIR)" || { echo "missing $(SERVER_DIR)" >&2; exit 1; }
	@mkdir -p "$(RUN_DIR)"
	@chmod +x "$(DEV_API)"

# ---------------------------------------------------------------------------
# Backend
# ---------------------------------------------------------------------------

db-up:
	@if docker ps --format '{{.Names}}' | grep -qx pipod-db; then \
		echo "Postgres container pipod-db already running"; \
	elif docker ps -a --format '{{.Names}}' | grep -qx pipod-db; then \
		echo "Starting existing Postgres container pipod-db"; \
		docker start pipod-db >/dev/null; \
	else \
		echo "Creating Postgres container pipod-db on localhost:55432"; \
		docker run -d --name pipod-db \
			-e POSTGRES_USER=pipod \
			-e POSTGRES_PASSWORD=pipod \
			-e POSTGRES_DB=pipod \
			-p 55432:5432 \
			postgres:16-alpine >/dev/null; \
	fi
	@echo "Waiting for Postgres…"
	@for i in $$(seq 1 60); do \
		if docker exec pipod-db pg_isready -U pipod -d pipod >/dev/null 2>&1; then \
			echo "Postgres ready"; exit 0; \
		fi; \
		sleep 0.5; \
	done; \
	echo "Postgres did not become ready" >&2; exit 1

jwks: ensure-dirs
	@if curl -sf "$(JWKS_URL)" >/dev/null 2>&1; then \
		echo "JWKS already up at $(JWKS_URL)" >&2; \
	elif [[ -f "$(RUN_DIR)/jwks.pid" ]] && kill -0 "$$(cat "$(RUN_DIR)/jwks.pid")" 2>/dev/null; then \
		echo "JWKS pidfile present; waiting…" >&2; \
	else \
		echo "Starting dev JWKS on :9999" >&2; \
		cd "$(SERVER_DIR)" && nohup node dev/jwks-server.mjs \
			>"$(RUN_DIR)/jwks.log" 2>&1 & echo $$! >"$(RUN_DIR)/jwks.pid"; \
	fi
	@for i in $$(seq 1 40); do \
		curl -sf "$(JWKS_URL)" >/dev/null 2>&1 && exit 0; \
		sleep 0.25; \
	done; \
	echo "JWKS did not become ready — see $(RUN_DIR)/jwks.log" >&2; exit 1

server: ensure-dirs jwks
	@"$(DEV_API)" ensure

wait-server:
	@"$(DEV_API)" wait

seed: db-up
	@echo "Applying migrations (if needed)…"
	@$(LOAD_ENV) && cd "$(SERVER_DIR)" && npm run migrate >/dev/null
	@echo "Seeding dev user/org snapshots (Zitadel ids)…"
	@$(LOAD_ENV) && \
	if command -v psql >/dev/null 2>&1; then \
		psql "$$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$(SERVER_DIR)/dev/dev-seed.sql" >/dev/null; \
	else \
		docker exec -i pipod-db psql -U pipod -d pipod -v ON_ERROR_STOP=1 <"$(SERVER_DIR)/dev/dev-seed.sql" >/dev/null; \
	fi
	@echo "Seed complete"

token: jwks
	@cd "$(SERVER_DIR)" && node dev/mint.mjs "$(DEV_USER)" "$(DEV_ORG)"

# ---------------------------------------------------------------------------
# Native mobile clients
# ---------------------------------------------------------------------------

ios: wait-server seed
	@$(MAKE) --no-print-directory _ios-launch

_ios-launch:
	@bash "$(ROOT)/scripts/native-mobile-dev.sh" ios

android: wait-server seed
	@$(MAKE) --no-print-directory _android-launch

_android-launch:
	@bash "$(ROOT)/scripts/native-mobile-dev.sh" android

# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------

stop:
	@"$(DEV_API)" stop || true
	@stopped=0; \
	if [[ -f "$(RUN_DIR)/jwks.pid" ]]; then \
		pid=$$(cat "$(RUN_DIR)/jwks.pid"); \
		if kill -0 "$$pid" 2>/dev/null; then \
			echo "Stopping JWKS pid $$pid"; \
			kill "$$pid" 2>/dev/null || true; \
			stopped=1; \
		fi; \
		rm -f "$(RUN_DIR)/jwks.pid"; \
	fi; \
	if [[ $$stopped -eq 0 ]]; then \
		echo "JWKS left as-is (no make-managed pid)"; \
	fi

logs:
	@touch "$(RUN_DIR)/server.log" "$(RUN_DIR)/jwks.log"
	@tail -n 50 -F "$(RUN_DIR)/server.log" "$(RUN_DIR)/jwks.log"

# ---------------------------------------------------------------------------
# Pi pin (CLI + server lockfiles, derived managed image tag)
# ---------------------------------------------------------------------------

check-pi-pins:
	@node "$(ROOT)/scripts/pi-pins.mjs" check

pi-image-tag:
	@node "$(ROOT)/scripts/pi-pins.mjs" tag

bump-pi:
	@node "$(ROOT)/scripts/pi-pins.mjs" bump "$(VERSION)" $(if $(DRY_RUN),--dry-run,) $(if $(SKIP_CHECKS),--skip-checks,)

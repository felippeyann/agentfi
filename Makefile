.DEFAULT_GOAL := help

.PHONY: dev dev-db dev-api dev-admin dev-mcp \
        build typecheck lint \
        test test-backend test-contracts test-contracts-coverage \
        db-migrate db-migrate-dev db-studio db-reset \
        docker-build docker-up docker-down docker-logs docker-ps \
        deploy-staging preflight \
        install clean help

# ─── Dev ──────────────────────────────────────────────────────────────────────

## Start all dev services (postgres + redis + backend + admin in parallel)
dev: dev-db
	@echo "Starting backend and admin..."
	$(MAKE) -j2 dev-api dev-admin

## Start postgres and redis via docker compose (detached)
dev-db:
	@echo "Starting postgres and redis..."
	docker compose up postgres redis -d

## Run backend dev server
dev-api:
	@echo "Starting backend dev server..."
	cd packages/backend && npm run dev

## Run admin dev server
dev-admin:
	@echo "Starting admin dev server..."
	cd packages/admin && npm run dev

## Run MCP server dev server
dev-mcp:
	@echo "Starting MCP server dev server..."
	cd packages/mcp-server && npm run dev

# ─── Build ────────────────────────────────────────────────────────────────────

## Build all packages
build:
	@echo "Building all packages..."
	npm run build --workspaces --if-present

## Run TypeScript type checking across all packages
typecheck:
	@echo "Type checking all packages..."
	npm run typecheck --workspaces --if-present

## Run linter across all packages
lint:
	@echo "Linting all packages..."
	npm run lint --workspaces --if-present

# ─── Test ─────────────────────────────────────────────────────────────────────

## Run all tests (backend vitest + forge contract tests)
test: test-backend test-contracts

## Run backend tests with vitest
test-backend:
	@echo "Running backend tests..."
	cd packages/backend && npm test

## Run Foundry contract tests (verbose)
test-contracts:
	@echo "Running contract tests..."
	cd packages/contracts && forge test -vvv

## Run Foundry contract coverage report
test-contracts-coverage:
	@echo "Running contract coverage..."
	cd packages/contracts && forge coverage --report summary

# ─── DB ───────────────────────────────────────────────────────────────────────

## Deploy pending Prisma migrations (production-safe)
db-migrate:
	@echo "Deploying migrations..."
	cd packages/backend && npx prisma migrate deploy --schema=src/db/schema.prisma

## Create and apply a new Prisma migration (dev only)
db-migrate-dev:
	@echo "Running dev migration..."
	cd packages/backend && npx prisma migrate dev --schema=src/db/schema.prisma

## Open Prisma Studio database browser
db-studio:
	@echo "Opening Prisma Studio..."
	cd packages/backend && npx prisma studio --schema=src/db/schema.prisma

## Reset the database and re-run all migrations (destructive)
db-reset:
	@echo "Resetting database..."
	cd packages/backend && npx prisma migrate reset --schema=src/db/schema.prisma

# ─── Docker ───────────────────────────────────────────────────────────────────

## Build all Docker images (backend, admin, mcp)
docker-build:
	@echo "Building Docker images..."
	docker buildx build -f Dockerfile.backend -t agentfi-backend .
	docker buildx build -f Dockerfile.admin   -t agentfi-admin   .
	docker buildx build -f Dockerfile.mcp     -t agentfi-mcp     .

## Start all services via docker compose (detached)
docker-up:
	@echo "Starting all docker compose services..."
	docker compose up -d

## Stop all docker compose services
docker-down:
	@echo "Stopping docker compose services..."
	docker compose down

## Follow docker compose logs
docker-logs:
	docker compose logs -f

## Show docker compose service status
docker-ps:
	docker compose ps

# ─── Deploy ───────────────────────────────────────────────────────────────────

## Deploy to staging (push to develop branch to trigger CI/CD)
deploy-staging:
	@echo "To deploy to staging, push to the develop branch:"
	@echo "  git push origin develop"

## Run preflight checks before deploying
preflight:
	@echo "Running preflight checks..."
	npx tsx scripts/preflight.ts

# ─── Utility ──────────────────────────────────────────────────────────────────

## Install all npm dependencies
install:
	@echo "Installing dependencies..."
	npm install

## Remove all build artifacts (dist/, out/, .next/, *.tsbuildinfo)
clean:
	@echo "Cleaning build artifacts..."
	find . -type d \( -name dist -o -name out -o -name .next \) \
	  -not -path "*/node_modules/*" -exec rm -rf {} + 2>/dev/null || true
	find . -name "*.tsbuildinfo" \
	  -not -path "*/node_modules/*" -delete 2>/dev/null || true
	@echo "Clean complete."

## Show this help message
help:
	@awk ' \
	/^# ─/ { \
	    gsub(/^# ─+[ ]*/, ""); gsub(/[ ─]*$$/, ""); \
	    printf "\n\033[1m%s\033[0m\n", $$0; next \
	} \
	/^## / { desc = substr($$0, 4); next } \
	/^[a-zA-Z][a-zA-Z0-9_-]+:/ && desc != "" { \
	    split($$0, a, ":"); \
	    printf "  \033[36m%-28s\033[0m %s\n", a[1], desc; \
	    desc = "" \
	} \
	' $(MAKEFILE_LIST)

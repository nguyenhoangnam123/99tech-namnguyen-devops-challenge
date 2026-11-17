COMPOSE := docker compose --env-file deploy/.env -f deploy/docker-compose.yml

.PHONY: help secrets up down nuke ps logs build lint typecheck test test-integration e2e security perf gen check-gen ab

help: ## List targets
	@grep -E '^[a-z0-9-]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-18s %s\n", $$1, $$2}'

secrets: ## Create local secrets (once)
	@scripts/secrets.sh

up: secrets ## Build and start the stack, wait until healthy
	$(COMPOSE) up -d --build --wait

down: ## Stop the stack, keep data
	$(COMPOSE) --profile obs down

nuke: ## Stop the stack and delete data
	$(COMPOSE) --profile obs down -v

ps: ## Show service status
	$(COMPOSE) ps

logs: ## Tail service logs
	$(COMPOSE) logs -f --tail=100

obs: ## Start Prometheus and Grafana
	$(COMPOSE) --profile obs up -d prometheus grafana

build: ## Compile all packages
	npm run build

lint: ## ESLint and architecture rules
	npm run lint

test: ## Unit and property tests
	npm test

test-integration: ## Adapter tests against real Postgres (testcontainers)
	npm run test:integration

e2e: ## Contract and transaction tests against the running stack
	npm run test:e2e

security: ## Abuse tests and ZAP API scan against the running stack
	npm run test:security
	scripts/zap.sh

perf: ## k6 load test at 500 rps against the running stack
	$(COMPOSE) run --rm k6 run --summary-export=/reports/perf-summary.json /scripts/load.js

gen: ## Regenerate code from contracts/
	npm run gen

check-gen: ## Fail if generated code is stale
	npm run gen && git diff --exit-code -- packages/contracts/src/gen

ab: ## A/B the same scenario on two commits: make ab A=<sha> B=<sha>
	scripts/ab.sh $(A) $(B)

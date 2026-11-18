# pipefail: a failing command piped into tee must still fail the target.
SHELL := bash
.SHELLFLAGS := -o pipefail -c

COMPOSE := docker compose --env-file deploy/.env -f deploy/docker-compose.yml

.PHONY: help secrets up up-obs down nuke ps logs build lint typecheck test test-integration e2e chaos security perf slo gen check-gen dashboards ab aws-diagrams

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

up-obs: secrets ## Stack plus OTel Collector and LGTM, telemetry on (Grafana :13000)
	OTEL_SDK_DISABLED=false $(COMPOSE) --profile obs up -d --build --wait

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

chaos: ## Restart matcher and kill settler mid-flow; books and ledger must survive
	CHAOS=1 npx vitest run --project e2e tests/e2e/resilience.test.ts

security: ## Abuse tests and ZAP API scan against the running stack
	npm run test:security
	scripts/zap.sh

DURATION ?= 2m
RATE_SCALE ?= 1

perf: ## k6 load test at 500 rps against the running stack (DURATION=2m)
	@mkdir -p reports/perf
	CUSTODY_SECRET="$$(cat deploy/.secrets/custody-webhook-secret)" $(COMPOSE) run --rm -e CUSTODY_SECRET \
	  -e DURATION=$(DURATION) -e RATE_SCALE=$(RATE_SCALE) k6 run --summary-export=/reports/perf/summary.json /scripts/load.js \
	  | tee reports/perf/summary.txt; status=$$?; node scripts/sanitize-k6-summary.mjs reports/perf/summary.json; exit $$status

TELEMETRY ?= on
# Load runs trace 10% like production would; make up-obs keeps every trace.
SAMPLE ?= 0.1
REPORT ?= reports/slo/RESULTS.md
SLO_ENV = OTEL_SDK_DISABLED=$(if $(filter off,$(TELEMETRY)),true,false) OTEL_TRACES_SAMPLER_ARG=$(SAMPLE)

# Runs start from empty exchange state, so a growing book cannot skew them.
# Telemetry volumes are kept; FRESH=0 runs on the current state instead.
FRESH ?= 1
STATE_VOLUMES := exchange_pgdata exchange_kafkadata

# Setup registers many traders from one IP, so the auth limit is lifted for
# the run. The trap restores the up-obs stack on success, failure or Ctrl-C.
slo: secrets ## SLO catalog with CPU and memory per service (SCENARIOS, WINDOW, TELEMETRY, SAMPLE, FRESH)
	@trap 'OTEL_SDK_DISABLED=false $(COMPOSE) --profile obs up -d --wait || exit 1' EXIT; \
	if [ "$(FRESH)" = 1 ]; then $(COMPOSE) --profile obs down && docker volume rm -f $(STATE_VOLUMES); fi && \
	$(SLO_ENV) AUTH_RATE_LIMIT_PER_MINUTE=100000 $(COMPOSE) --profile obs up -d --build --wait && \
	TELEMETRY=$(TELEMETRY) SAMPLE=$(SAMPLE) REPORT=$(REPORT) node scripts/slo.mjs

gen: ## Regenerate code from contracts/
	npm run gen

GENERATED := packages/contracts/src/gen deploy/grafana/dashboards

check-gen: ## Fail if generated code or dashboards are stale, edited or untracked
	npm run gen && node deploy/grafana/dashboards.mjs
	@test -z "$$(git status --porcelain -- $(GENERATED))" || \
	  { git status --short -- $(GENERATED); git diff -- $(GENERATED); exit 1; }

dashboards: ## Regenerate Grafana dashboards from deploy/grafana/dashboards.mjs
	node deploy/grafana/dashboards.mjs

ab: ## A/B the same scenario on two commits: make ab A=<sha> B=<sha>
	scripts/ab.sh $(A) $(B)

DIAGRAMS_IMAGE := p1-aws-diagrams:0.25.1

aws-diagrams: ## Render the AWS diagrams in docs/aws/img (Docker only)
	docker build -q -t $(DIAGRAMS_IMAGE) docs/aws/diagrams >/dev/null
	docker run --rm -v "$$PWD/docs/aws:/work" -w /work/diagrams $(DIAGRAMS_IMAGE) \
	  sh -c 'python assessment.py && python production.py'

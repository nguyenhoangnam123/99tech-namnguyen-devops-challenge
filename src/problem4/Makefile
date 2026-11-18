# Local entry points. CI runs the same npm scripts and deploy scripts;
# infra is applied from here with an operator's AWS credentials.
SHELL := bash
.SHELLFLAGS := -euo pipefail -c

REGION ?= ap-southeast-1
ACCOUNT = $(shell aws sts get-caller-identity --query Account --output text)
STATE_BUCKET = p4-tfstate-$(ACCOUNT)-$(REGION)
TF = terraform -chdir=infra
# Built at the first commit that has the apps, before any deploy ran.
FIRST_IMAGE_TAG ?=

.PHONY: help test bootstrap shared staging production plan-% github destroy-env-% destroy-shared lint-infra

help: ## List targets
	@grep -E '^[a-z% -]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-18s %s\n", $$1, $$2}'

test: ## Lint, typecheck and test both apps
	for app in backend frontend; do (cd apps/$$app && npm ci --no-audit --no-fund && npm run format:check && npm run typecheck && npm run lint && npm test); done

lint-infra: ## fmt, validate, tflint and checkov on every stack
	terraform fmt -check -recursive infra
	for stack in bootstrap shared env; do $(TF)/$$stack init -backend=false -input=false >/dev/null && $(TF)/$$stack validate; done
	docker run --rm -v "$$PWD/infra:/data" -w /data ghcr.io/terraform-linters/tflint:v0.59.1 --recursive
	docker run --rm -v "$$PWD/infra:/infra" bridgecrew/checkov:3.4.5 --config-file /infra/.checkov.yaml -d /infra

bootstrap: ## Create the state bucket (once, local state)
	$(TF)/bootstrap init -input=false
	$(TF)/bootstrap apply -var region=$(REGION)

define init
	$(TF)/$(1) init -input=false -reconfigure -backend-config="bucket=$(STATE_BUCKET)" \
	  -backend-config="key=p4/$(2).tfstate" -backend-config="region=$(REGION)"
endef

shared: ## OIDC provider, ECR, artifact bucket, build role
	$(call init,shared,shared)
	$(TF)/shared apply -var region=$(REGION)

staging production: ## Apply one environment (FIRST_IMAGE_TAG on the first apply)
	$(call init,env,$@)
	$(TF)/env apply -var-file=$@.tfvars -var region=$(REGION) -var first_image_tag=$(FIRST_IMAGE_TAG)

plan-%: ## Plan one stack: plan-shared, plan-staging, plan-production
	$(call init,$(if $(filter shared,$*),shared,env),$*)
	$(TF)/$(if $(filter shared,$*),shared,env) plan $(if $(filter shared,$*),,-var-file=$*.tfvars -var first_image_tag=$(FIRST_IMAGE_TAG)) -var region=$(REGION)

github: ## GitHub environments and variables from Terraform outputs
	scripts/github-setup.sh $(REGION)

destroy-env-%: ## Tear down one environment (test accounts only)
	$(call init,env,$*)
	$(TF)/env apply -var-file=$*.tfvars -var region=$(REGION) -var first_image_tag=$(FIRST_IMAGE_TAG) -var allow_destroy=true
	$(TF)/env destroy -var-file=$*.tfvars -var region=$(REGION) -var first_image_tag=$(FIRST_IMAGE_TAG) -var allow_destroy=true

destroy-shared: ## Tear down the shared stack after both environments
	$(call init,shared,shared)
	$(TF)/shared apply -var region=$(REGION) -var allow_destroy=true
	$(TF)/shared destroy -var region=$(REGION) -var allow_destroy=true

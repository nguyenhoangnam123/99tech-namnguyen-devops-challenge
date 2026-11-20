.PHONY: help diagram test-roles

DIAGRAMS_IMAGE := p1-aws-diagrams:0.25.1

help: ## List targets
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-12s %s\n", $$1, $$2}'

diagram: ## Render img/aws-secure.png with Problem 1's diagram image (Docker only)
	docker build -q -t $(DIAGRAMS_IMAGE) ../problem1/docs/aws/diagrams >/dev/null
	docker run --rm -v "$$PWD:/work" -w /work/diagrams $(DIAGRAMS_IMAGE) python secure.py

test-roles: ## Try ledger attacks as wave 1's role and the restricted roles (Docker only)
	sql/test-roles.sh

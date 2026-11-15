# Thin wrappers around the pnpm scripts, for people who type `make` by reflex. Nothing here
# implements anything: every target delegates, so `make test` and `pnpm test` cannot drift.
# `make help` lists the targets. See CONTRIBUTING.md for the full workflow.

.DEFAULT_GOAL := help
.PHONY: help setup up down test test-embedded lint format demo verify runtime clean

help: ## list the targets
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  make %-14s %s\n", $$1, $$2}'

setup: ## install dependencies and write .env if it is missing
	pnpm install
	@test -f .env || (cp .env.example .env && echo "wrote .env from .env.example")
	pnpm build:publishable

up: ## start Postgres, Redis, MinIO and the KMS emulator
	pnpm infra:up

down: ## stop them and delete their volumes
	pnpm infra:down

test: ## the control-plane suite, against the real stack (needs `make up`)
	pnpm test

test-embedded: ## the zero-Docker subset: nothing but Node required
	pnpm test:embedded

lint: ## eslint and the prettier check, as CI runs them
	pnpm lint
	pnpm format:check

format: ## rewrite files with prettier
	pnpm format:write

demo: ## govern three actions and seal them (needs `make up`)
	pnpm demo

verify: ## verify the demo bundle offline, with no Pharos running
	pnpm verify:bundle evidence-bundle.json

runtime: ## install the Python runtime and run its gate (needs a venv on PATH)
	pnpm runtime:install
	pnpm runtime:check

clean: ## remove build output and the local evidence bundle
	rm -rf packages/*/dist services/*/dist packages/cli/dist evidence-bundle.json

SHELL := /bin/zsh
export WHATS_PROXY_NO_BROWSER := 1  # suppress xdg-open in tests/CI/pre-commit

PKG_NAME      := whats-proxy
PKG_DIR_NAME  := whats_proxy
PKG_DIR       := src/$(PKG_DIR_NAME)
VERSION       := $(shell grep -m 1 '"version"' package.json | tr -s ' ' | cut -d'"' -f4)

# Tooling
BUN := $(shell command -v bun 2>/dev/null || echo bun)
NODE := $(shell command -v node 2>/dev/null || echo node)

.PHONY: help check typecheck test smoke stress runtime-smoke install uninstall build publish git-push push git-install-hooks release

help: ## Show help
	@grep -E '^[a-zA-Z_-]+:.*##' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*##"}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ─── Quality ───

check: typecheck test smoke runtime-smoke ## Run all checks (tsc + unit tests + smoke + Node/Baileys runtime smoke)
	@echo "✅ All checks passed (v$(VERSION))"

typecheck: ## TypeScript strict typecheck
	@$(BUN) run typecheck

test: ## Unit tests (bun test)
	@$(BUN) run test

smoke: ## Smoke test — CLI + daemon end-to-end (isolated state dir)
	@$(BUN) run smoke

stress: ## Race stress test — N simultaneous daemon spawns, exactly 1 must survive
	@$(BUN) run scripts/stress.ts

runtime-smoke: ## Verify the packaged CLI runs with the Node.js Baileys-compatible runtime
	@$(NODE) bin/whats-proxy.mjs --version > /dev/null
	@$(NODE) bin/whats-proxy.mjs do --help > /dev/null
	@echo "✅ Node runtime smoke test passed"

# ─── Install / Uninstall (Bun) ───

install: ## Install globally via Bun link
	@$(BUN) link
	@echo "✅ $(PKG_NAME) v$(VERSION) linked globally"

uninstall: ## Unlink the global Bun package (never deletes WhatsApp state)
	@$(BUN) unlink 2>/dev/null || true
	@echo "✅ $(PKG_NAME) unlinked"

# ─── Build / Publish ───

build: ## Build the npm package tarball
	@$(BUN) pm pack

publish: build ## Publish the npm package
	@$(BUN) publish

# ─── Git ───

git-push: ## Push to both gitlab and github
	@git push github master
	@git push gitlab master
	@echo "✅ Pushed to github + gitlab"

push: git-push ## Alias for git-push

git-install-hooks: ## Install pre-commit hook
	@echo "#!/bin/sh\nmake check" > .git/hooks/pre-commit
	@chmod +x .git/hooks/pre-commit
	@echo "✅ Pre-commit hook installed"

# ─── Release ───

release: check git-push publish ## Full release: check → push → publish

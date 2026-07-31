PKG_NAME      := whats-proxy
PKG_DIR_NAME  := whats_proxy
PKG_DIR       := src/$(PKG_DIR_NAME)
VERSION       := $(shell grep -m 1 '"version"' package.json | tr -s ' ' | cut -d'"' -f4)

# Tooling
BUN     := $(shell command -v bun 2>/dev/null || echo bun)
TS_FILES := $(shell find $(PKG_DIR) -name "*.ts")

.PHONY: help check typecheck test smoke install uninstall link git-push push git-install-hooks release

help: ## Show help
	@grep -E '^[a-zA-Z_-]+:.*##' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*##"}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ─── Quality ───

check: typecheck test smoke ## Run all checks (tsc + unit tests + smoke)
	@echo "✅ All checks passed (v$(VERSION))"

typecheck: ## TypeScript strict typecheck
	@$(BUN) run typecheck

test: ## Unit tests (bun test)
	@$(BUN) run test

smoke: ## Smoke test — CLI + daemon end-to-end (isolated state dir)
	@$(BUN) run smoke

# ─── Install / Uninstall ───

install: ## Install globally via bun link
	@$(BUN) link
	@echo "✅ $(PKG_NAME) v$(VERSION) linked globally"

uninstall: ## Unlink globally
	@$(BUN) unlink 2>/dev/null || true
	@echo "✅ $(PKG_NAME) unlinked"

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

release: check git-push ## Full release: check → push

.PHONY: build install

build:
	npm run build
	cd webview-ui && npm run build

install: build
	vsce package --no-dependencies
	code --install-extension sql-extension-*.vsix --force

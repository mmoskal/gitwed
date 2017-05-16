all: build local

r: build remote

build:
	cd server && node ../node_modules/typescript/bin/tsc
	cd client && node ../node_modules/typescript/bin/tsc

remote:
	node gitwed -i ../gitwed-data

local:
	node gitwed ../gitwed-data

watch:
	cd client && node ../node_modules/typescript/bin/tsc --watch

cdn: build
	node gitwed -cdn ../gitwed-data

d: deploy
deploy:
	git pull
	$(MAKE) build
	kill `ps fax | grep "node[ ]gitwed"|awk '{print $1}'`

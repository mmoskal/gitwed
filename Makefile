all: build local

r: build remote

build:
	cd server && node ../node_modules/typescript/bin/tsc
	cd client && node ../node_modules/typescript/bin/tsc

remote:
	node server -i ../gitwed-data

local:
	node server ../gitwed-data

watch:
	cd client && node ../node_modules/typescript/bin/tsc --watch

cdn:
	node server -cdn ../gitwed-data

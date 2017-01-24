all: build local

r: build remote

build:
	cd server && node ../node_modules/typescript/bin/tsc
	cd client && node ../node_modules/typescript/bin/tsc

remote:
	node server -i ../gitwed-data

local:
	node server ../gitwed-data

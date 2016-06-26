all:
	cd server && node ../node_modules/typescript/bin/tsc
	node server

all:
	cd server && node ../node_modules/typescript/bin/tsc
	cd client && node ../node_modules/typescript/bin/tsc
	#sleep 2 && curl http://localhost:3000/sample/index &
	node server ../gitwed-data

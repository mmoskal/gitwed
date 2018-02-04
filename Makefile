all: build local

r: build remote

build:
	cd server && node ../node_modules/typescript/bin/tsc
	cd client && node ../node_modules/typescript/bin/tsc

remote:
	node gitwed -i ../gitwed-data

local:
	node gitwed ../gitwed-data

sample:
	node gitwed ../gitwed-sample

watch:
	cd client && node ../node_modules/typescript/bin/tsc --watch

cdn: build
	node gitwed -cdn ../gitwed-data

d: deploy
deploy:
	git pull
	$(MAKE) build
	kill `ps fax | grep "node[ ]gitwed"|awk '{print $$1}'`

e:
	curl -s 'http://localhost:3000/api/epub?folder=book&kindle=yes' > tmp/book.epub
	cd tmp; rm -rf out; mkdir out; cd out; 7z x ../book.epub >/dev/null
	java -jar ~/src/ebooks-kindle/soft/epubcheck-3.0.jar tmp/book.epub

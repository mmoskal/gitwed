BIN=../node_modules/.bin
TSC=$(BIN)/tsc
JEST=$(BIN)/jest
all: build local

r: build remote

build:
	cd server && node $(TSC)
	cd client && node  $(TSC)

remote:
	node gitwed -i ../tooploox.com

local:
	node gitwed ../tooploox.com

sample:
	node gitwed ../gitwed-sample
test:
	cd server && $(JEST)
watch:
	cd client && node $(TSC) --watch

cdn: build
	node gitwed -cdn ../tooploox.com

d: deploy
deploy:
	git pull
	$(MAKE) build
	kill `ps fax | grep "node[ ]gitwed"|awk '{print $$1}'`

e:
	curl -s 'http://localhost:3000/api/epub?folder=book&kindle=yes' > tmp/book.epub
	cd tmp; rm -rf out; mkdir out; cd out; 7z x ../book.epub >/dev/null
	java -jar ~/src/ebooks-kindle/soft/epubcheck-3.0.jar tmp/book.epub

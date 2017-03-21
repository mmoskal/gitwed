global.Promise = require("bluebird")

import express = require('express');
import mime = require('mime');
import fs = require('fs');
import http = require('http');
import https = require('https');
import crypto = require("crypto")
import expander = require('./expander')
import gitfs = require('./gitfs')
import tools = require('./tools')
import bluebird = require('bluebird')
import auth = require('./auth')
import winston = require('winston')
import logs = require('./logs')
import routing = require('./routing')

bluebird.longStackTraces();
logs.init()

const restartMinutes = 120

let startTime = Date.now()
let lastUse = startTime

var app = express();
var bodyParser = require('body-parser')

let fileLocks = tools.promiseQueue()

app.use((req, res, next) => {
    winston.debug(req.method + " " + req.url);
    req._response = res;
    lastUse = Date.now()
    next();
});

setInterval(() => {
    let now = Date.now()
    let tm = now - startTime
    if (tm > restartMinutes * 60 * 1000) {
        // only restart when it's quiet
        if (now - lastUse > 10 * 1000) {
            winston.info(`auto-shutdown after ${Math.round(tm / 1000)}s`)
            gitfs.shutdown()
        }
    }
}, 60 * 1000)

app.use(require('cookie-parser')());
app.use(require("compression")())
app.use(bodyParser.json({
    limit: 5 * 1024 * 1024
}))
app.use(bodyParser.urlencoded({
    extended: false
}))

app.use((req, res, next) => {
    res.setHeader("X-XSS-Protection", "1");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (gitfs.config.proxy) {
        let hts = "https://" + (req.header("x-forwarded-host") || req.header("host"))
        if (hts == gitfs.config.authDomain) {
            res.setHeader("Strict-Transport-Security", "max-age=31536000");
        }

        if (req.header("x-forwarded-protocol") == "http") {
            res.redirect(hts + req.url)
            return
        }
    }
    next();
});

auth.initCheck(app)

auth.initRoutes(app)

interface ImgData {
    page: string;
    full: string;
    thumb: string;
    filename: string;
    format: string;
}

app.get("/api/logs", (req, res) => {
    if (!req.appuser)
        tools.throwError(402)
    res.contentType("text/plain");
    res.send(logs.getLogs())
})

function sanitizePath(p: string) {
    p = p + ""
    let elts = p.split(/\//).filter(s => !!s && s[0] != ".")
    if (elts.length && p.endsWith("/"))
        elts.push("")
    return elts
}

app.get("/api/history", (req, res) => {
    if (!req.appuser)
        tools.throwError(402)
    let p = sanitizePath(req.query["path"] || "/").join("/")

    gitfs.logAsync(p || ".")
        .then(j => res.json(j))
})

app.post("/api/uploadimg", (req, res) => {
    if (!req.appuser)
        return res.status(403).end()

    let data = req.body as ImgData
    let pathElts = sanitizePath(data.page)
    pathElts.pop()
    pathElts.push("img")
    let path = pathElts.join("/")
    let basename = data.filename
        .replace(/.*[\/\\]/, "")
        .toLowerCase()
        .replace(/\.[a-z]+$/, "")
        .replace(/[^\w\-]+/g, "_")
    let ext = "." + data.format
    let buf = new Buffer(data.full, "base64")
    let msg = "Image at " + path + " / " + basename + ext

    expander.hasWritePermAsync(req.appuser, path)
        .then(hasPerm => {
            if (!hasPerm)
                return res.status(403).end()

            fileLocks(path, () =>
                gitfs.createBinFileAsync(path, basename, ext, buf, msg, req.appuser)
                    .then(imgName => {
                        res.json({
                            url: "img/" + imgName
                        })
                    }))
        })

})

app.get("/api/refresh", (req, res) => {
    if (!req.appuser)
        return res.status(403).end()
    gitfs.pokeAsync(true)
        .then(() => {
            res.json({})
        })
})

app.post("/api/update", (req, res) => {
    if (!req.appuser)
        return res.status(403).end()

    let page = req.body.page + ""

    if (page.endsWith("/")) page += "index"

    let fn = page.slice(1) + ".html"
    if (fn.indexOf("private") == 0)
        return res.status(402).end()

    let lang: string = req.body.lang
    let cfg: expander.ExpansionConfig = {
        rootFile: fn,
        ref: "master",
        langs: lang ? [lang] : null,
        appuser: req.appuser
    }

    fileLocks(fn, () =>
        expander.expandFileAsync(cfg)
            .then(page => {
                if (!cfg.hasWritePerm)
                    return res.status(402).end()

                let id: string = req.body.id
                let val: string = req.body.value
                let desc = page.idToPos[id]

                if (lang && cfg.lang != lang) {
                    // didn't manage to set this language
                    return res.status(411).end()
                }

                if (req.body.alltranslations) {
                    let numadded = 0
                    for (let k of Object.keys(page.idToPos)) {
                        let dd = page.idToPos[k]
                        if (page.langMap[k] === undefined) {
                            let v = page.allFiles[dd.filename].slice(dd.startIdx, dd.startIdx + dd.length)
                            numadded++
                            cfg.langFileContent = expander.setTranslation(cfg, k, v)
                        }
                    }
                    if (numadded)
                        fs.writeFileSync("lang.html", cfg.langFileContent)
                    return res.end("OK")
                }

                val = expander.cleanHtmlFragment(val)

                if (cfg.langFileName) {
                    let newCont = expander.setTranslation(cfg, id, val)
                    gitfs.setTextFileAsync(cfg.langFileName, newCont,
                        "Translate " + cfg.langFileName + " / " + id, req.appuser)
                        .then(() => res.end("OK"))
                } else if (desc) {
                    let cont = page.allFiles[desc.filename]
                    let newCont = cont.slice(0, desc.startIdx) + val + cont.slice(desc.startIdx + desc.length)
                    gitfs.setTextFileAsync(desc.filename, newCont,
                        "Update " + desc.filename + " / " + id, req.appuser)
                        .then(() => res.end("OK"))
                } else {
                    res.status(410).end()
                }
            }) as Promise<void>)
})

// support let's encrypt cert renewal (when hidden behind apache)
app.use("/.well-known", express.static("/var/www/html/.well-known"))

app.get(/^\/cdn\/(.*-|)([0-9a-f]{40})([-\.].*)/, (req, res, next) => {
    let sha = req.params[1]
    let filename = req.params[2]
    if (filename[0] == ".") filename = "blob" + filename
    if (tools.etagMatches(req, sha + "-0"))
        return
    tools.allowReqCache(req)
    gitfs.getFileAsync(sha, "SHA")
        .then(buf => {
            res.writeHead(200, {
                'Content-Type': mime.lookup(filename),
                'Content-Length': buf.length
            })
            res.end(buf)
        }, e => {
            winston.info("error (cdn): " + req.path + " " + e.message)
            res.status(404).end('Page not found (CDN)');
        })
})

app.get(/.*/, (req, res, next) => {
    if (req.query["setlang"] != null) {
        res.cookie("GWLANG", req.query['setlang'] || "")
        return res.redirect(req.path)
    }

    gitfs.pokeAsync() // refresh in background if needed

    let langs: string[] = []
    let addLang = (s: string) => {
        if (!s) return
        s = s.toLowerCase()
        let m = /^([a-z]+)(-[a-z]+)?/.exec(s)
        if (m) {
            let full = m[0]
            if (langs.indexOf(full) >= 0) return
            langs.push(full)
            if (m[1] != full)
                langs.push(m[1])
        }
    }

    addLang(req.query["lang"])
    addLang(req.cookies['GWLANG'])
    for (let s of (req.header("Accept-Language") || "").split(",")) {
        let headerLang = (/^\s*([A-Za-z\-]+)/.exec(s) || [])[1];
        addLang(headerLang)
    }

    let cleaned = req.path.replace(/\/index(\.html?)?$/, "/")
    if (cleaned != req.path) {
        return res.redirect(cleaned + req.url.slice(req.path.length + 1))
    }

    if (/\/$/.test(cleaned))
        cleaned += "index"

    if (!/^\/(common|gw)\//.test(cleaned)) {
        cleaned = routing.getVHostDir(req) + cleaned
    }

    cleaned = cleaned.slice(1)

    if (cleaned.endsWith("/edit")) {
        let redirpath = "/" + cleaned.slice(0, cleaned.length - 5)
        return res.redirect(gitfs.config.authDomain + "/gw/login?redirect=" + encodeURIComponent(redirpath))
    }

    // asking for root index?
    // TODO change this in future?
    if (cleaned == "index") {
        res.redirect("/sample/")
        return
    }

    let ref = "master"
    if (/^[0-9a-f]{40}\//.test(cleaned)) {
        ref = cleaned.slice(0, 40)
        cleaned = cleaned.slice(41)
    }

    if (/^(private|logs\/)/.test(cleaned))
        return next()

    cleaned = cleaned.replace(/\.html?$/i, "")

    let spl = gitfs.splitName(cleaned)
    let isHtml = spl.name.indexOf(".") < 0

    if (spl.name == "config.json" || /\/[\._]/.test(cleaned))
        return next()

    let errHandler = (e: any) => {
        winston.info("error: " + cleaned + " " + e.message)
        next()
    }

    if (!isHtml) {
        gitfs.getFileAsync(cleaned, ref)
            .then(buf => {
                res.writeHead(200, {
                    'Content-Type': mime.lookup(cleaned),
                    'Content-Length': buf.length
                })
                res.end(buf)
            }, errHandler)
        return
    }

    let orig = cleaned
    cleaned += ".html"

    let cacheKey = ref + ":" + cleaned + ":" + langs.join(",")
    if (req.appuser || gitfs.config.justDir) cacheKey = null

    let cached = gitfs.stringCache.get(cacheKey)
    if (cached != null) {
        winston.debug(`cache hit at ${cacheKey}`)
        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf8'
        })
        return res.end(cached)
    }

    gitfs.getTextFileAsync(cleaned, ref)
        .then(str => {
            let cfg: expander.ExpansionConfig = {
                rootFile: cleaned,
                ref,
                rootFileContent: str,
                langs,
                appuser: req.appuser
            }
            expander.expandFileAsync(cfg)
                .then(page => {
                    gitfs.stringCache.set(cacheKey, page.html)
                    res.writeHead(200, {
                        'Content-Type': 'text/html; charset=utf8'
                    })
                    res.end(page.html)
                })
                .then(v => v, next)
        }, err => {
            gitfs.getTextFileAsync(orig + "/index.html")
                .then(() => {
                    res.redirect(orig + "/")
                }, _ => errHandler(err))
        })
})

app.use((req, res) => {
    res.status(404)
    routing.sendError(req, "Page not found",
        "Whoops! We couldn't find the page your were looking for.")
})

app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    logs.logError(error, req)
})

let cfg: gitfs.Config = {} as any
if (fs.existsSync("config.json"))
    cfg = JSON.parse(fs.readFileSync("config.json", "utf8"))
cfg.justDir = true
let args = process.argv.slice(2)
if (args[0] == "-i") {
    args.shift()
    cfg.justDir = false
}
if (args[0] == "-cdn") {
    args.shift()
    if (!cfg.cdnPath) {
        cfg.cdnPath = "/cdn"
    }
}
if (args[0] && fs.existsSync(args[0])) {
    cfg.repoPath = args[0]
    args.shift()
}

if (!cfg.repoPath)
    cfg.repoPath = "."

if (args[0]) {
    winston.error("parameter not understood: " + args[0])
    console.error(`Usage: gitwed [-i] [-cdn] [DIRECTORY]`)
    process.exit(1)
}

if (!cfg.authDomain)
    cfg.authDomain = "http://localhost:3000"

if (!cfg.serviceName)
    cfg.serviceName = "GITwed"

if (!cfg.justDir && !cfg.cdnPath)
    cfg.cdnPath = "/cdn"

if (!cfg.repoPath || !fs.existsSync(cfg.repoPath)) {
    winston.error(`cannot find repoPath (${cfg.repoPath}) in config.json or as argument`)
    process.exit(1)
}

if (!cfg.vhosts)
    cfg.vhosts = {}

let port = 3000

if (cfg.justDir) {
    winston.info(`using local file modifications`)
} else {
    winston.info(`using git push/pull`)
}

process.on('SIGINT', () => {
    gitfs.shutdown()
});

function setupCerts() {
    let mainDomain = cfg.authDomain.replace(/^https:\/\//, "").replace(/\/$/, "")
    let domains = [mainDomain].concat(Object.keys(cfg.vhosts || {}))

    let ledir = process.env["HOME"] + "/letsencrypt/etc/"
    let confPath = ledir + "renewal/" + mainDomain + ".conf"
    let keyOK = false
    if (fs.existsSync(confPath)) {
        let s = fs.readFileSync(confPath, "utf8")
        let m = /^domains\s*=\s*(.*)/m.exec(s)
        if (m && m[1].replace(/\s+/g, "") == domains.join(",")) {
            keyOK = true
            winston.info("certificate OK")
        }
    }
    let keyPath = ledir + "live/" + mainDomain + "/privkey.pem"
    if (!keyOK && fs.existsSync(keyPath)) {
        winston.warn("removing outdated cert: " + keyPath)
        fs.unlinkSync(keyPath)
    }

    // returns an instance of node-greenlock with additional helper methods
    let lex = require('greenlock-express').create({
        // set to 'staging'
        server: 'https://acme-v01.api.letsencrypt.org/directory',
        //server: 'staging',

        // , challenges: { 'http-01': require('le-challenge-fs').create({ webrootPath: '/tmp/acme-challenges' }) }
        // , store: require('le-store-certbot').create({ webrootPath: '/tmp/acme-challenges' })

        // You probably wouldn't need to replace the default sni handler
        // See https://git.daplie.com/Daplie/le-sni-auto if you think you do
        //, sni: require('le-sni-auto').create({})
        email: cfg.certEmail,
        agreeTos: true,
        agreeToTerms: true,
        approveDomains: domains,
        debug: true,
    });

    http.createServer(lex.middleware(require('redirect-https')()))
        .listen(80, function () {
            winston.info("Listening for ACME http-01 challenges on: " + this.address());
        });

    https.createServer(lex.httpsOptions, lex.middleware(app))
        .listen(443, function () {
            winston.info("Listening for ACME tls-sni-01 challenges and serve app on: " + this.address());
        });
}

gitfs.initAsync(cfg)
    .then(() => {
        if (cfg.justDir || cfg.proxy) {
            winston.info(`listen on http://localhost:${port}`)
            app.listen(port, "localhost")
        } else {
            if (cfg.production) {
                winston.info(`setup certs`)
                setupCerts()
            } else {
                winston.info(`listen on http://*:${port}`)
                app.listen(port)
            }
        }
    })

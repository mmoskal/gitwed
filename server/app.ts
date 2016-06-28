/// <reference path="../typings/index.d.ts" />

global.Promise = require("bluebird")

import express = require('express');
import mime = require('mime');
import expander = require('./expander')
import gitlabfs = require('./gitlabfs')
import tools = require('./tools')


var app = express();
var bodyParser = require('body-parser')

let fileLocks = tools.promiseQueue()

app.use(bodyParser.json())

app.get('/', (req, res) => {
    res.redirect("/sample/index")
})

app.post("/api/update", (req, res) => {
    let fn = req.body.page.slice(1) + ".html"
    fileLocks(fn, () =>
        gitlabfs.refreshAsync()
            .then(() => expander.expandFileAsync(fn))
            .then(page => {
                let id: string = req.body.id
                let val: string = req.body.value
                let desc = page.idToPos[id]

                val = "\n" + val + "\n"
                val = val.replace(/\r/g, "")
                val = val.replace(/(^\n+)|(\n+$)/g, "\n")

                if (desc) {
                    let cont = page.allFiles[desc.filename]
                    let newCont = cont.slice(0, desc.startIdx) + val + cont.slice(desc.startIdx + desc.length)
                    gitlabfs.setTextFileAsync(desc.filename, newCont)
                        .then(() => res.end("OK"))
                } else {
                    res.status(410).end()
                }
            }))
})

app.use("/gw", express.static("built/gw"))
app.use("/gw", express.static("gw"))
//app.use("/gw", express.static("node_modules/ContentTools/build"))
//app.use("/", express.static("html"))

app.get(/.*/, (req, res, next) => {
    let cleaned = req.path.replace(/\/+$/, "")
    if (cleaned != req.path) {
        return res.redirect(cleaned + req.url.slice(req.path.length + 1))
    }

    let spl = gitlabfs.splitName(cleaned.slice(1))
    let isHtml = spl.name.indexOf(".") < 0

    if (isHtml) cleaned += ".html"
    gitlabfs.getBlobIdAsync(cleaned)
        .then(id => {
            if (!id) next()
            else if (isHtml)
                expander.expandFileAsync(cleaned)
                    .then(page => {
                        res.writeHead(200, {
                            'Content-Type': 'text/html; charset=utf8'
                        })
                        res.end(page.html)
                    })
                    .catch(next)
            else
                gitlabfs.fetchBlobAsync(id)
                    .then(buf => {
                        res.writeHead(200, {
                            'Content-Type': mime.lookup(cleaned),
                            'Content-Length': buf.length
                        })
                        res.end(buf)
                    })
        })
})

app.use((req, res) => {
    res.status(404).send('Page not found');
})

app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.log(error.stack)
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('Internal Server Error, ' + error.stack);
})

gitlabfs.initAsync()
    .then(() => app.listen(3000))

//expander.test()
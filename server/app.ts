/// <reference path="../typings/index.d.ts" />

global.Promise = require("bluebird")

import express = require('express');
import expander = require('./expander')
import gitlabfs = require('./gitlabfs')
import tools = require('./tools')


var app = express();
var bodyParser = require('body-parser')

let fileLocks = tools.promiseQueue()

app.use(bodyParser.json())

app.get('/', (req, res) => {
    res.redirect("/index")
})

let fnRx = /^\/\w+$/
app.get(fnRx, (req, res, next) => {
    let fn = req.path.slice(1) + ".html"
    gitlabfs.existsAsync(fn)
        .then(ex => {
            if (!ex)
                next()
            else
                expander.expandFileAsync(fn)
                    .then(page => {
                        res.writeHead(200, {
                            'Content-Type': 'text/html; charset=utf8'
                        })
                        res.end(page.html)
                    })
                    .catch(next)
        })
})

app.post("/api/update", (req, res) => {
    let fn = req.body.page.slice(1) + ".html"
    fileLocks(fn, () =>
        expander.expandFileAsync(fn)
            .then(page => {
                let id: string = req.body.id
                let val: string = req.body.value
                let desc = page.idToPos[id]

                val = "\n" + val + "\n"
                val = val.replace(/\r/g, "")
                val = val.replace(/(^\n+)|(\n+$)/g, "\n")

                if (desc) {
                    gitlabfs.getTextFileAsync(desc.filename)
                        .then(cont =>
                            gitlabfs.setTextFileAsync(desc.filename,
                                cont.slice(0, desc.startIdx) +
                                val + cont.slice(desc.startIdx + desc.length)))
                        .then(() => res.end("OK"))
                } else {
                    res.status(410).end()
                }
            }))
})

app.use("/gw", express.static("built/gw"))
app.use("/gw", express.static("gw"))
app.use("/gw", express.static("node_modules/ContentTools/build"))

app.use("/", express.static("html"))

app.use((req, res) => {
    res.status(404).send('Page not found');
})

app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.log(error.stack)
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('Internal Server Error, ' + error.stack);
})

app.listen(3000)

//expander.test()
/// <reference path="../typings/index.d.ts" />

global.Promise = require("bluebird")

import express = require('express');
import expander = require('./expander')
import gitlabfs = require('./gitlabfs')

interface QEntry {
    run: () => Promise<any>;
    resolve: (v: any) => void;
    reject: (err: any) => void;
}

function promiseQ() {
    let awaiting: SMap<QEntry[]> = {}

    function poke(id: string) {
        let lst = awaiting[id]
        if (!lst) return
        let ent = lst[0]
        let shift = () => {
            lst.shift()
            if (lst.length == 0) delete awaiting[id]
            else Promise.resolve().then(() => poke(id))
        }
        ent.run().then(v => {
            shift()
            ent.resolve(v)
        }, e => {
            shift()
            ent.reject(e)
        })
    }

    function enq<T>(id: string, run: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            let lst = awaiting[id]
            if (!lst) lst = awaiting[id] = []
            lst.push({ resolve, reject, run })
            if (lst.length == 1) poke(id)
        })
    }
    return enq
}

var app = express();
var bodyParser = require('body-parser')

let fileLocks = promiseQ()

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
                if (desc) {
                    gitlabfs.getAsync(desc.filename)
                    .then(cont => 
                    gitlabfs.setAsync(desc.filename, 
                    cont.slice(0, desc.startIdx) + 
                    val + cont.slice(desc.startIdx + desc.length)))
                    .then(() => res.end("OK"))
                }else{
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
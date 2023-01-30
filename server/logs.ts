import fs = require("fs")
import tools = require("./tools")
import bluebird = require("bluebird")
import winston = require("winston")
import express = require("express")
import util = require("util")

export function init() {
    winston.level = "debug"
    winston.addColors({
        trace: "magenta",
        input: "grey",
        verbose: "cyan",
        prompt: "grey",
        debug: "blue",
        info: "green",
        data: "grey",
        help: "cyan",
        warn: "yellow",
        error: "red",
    })

    winston.remove(winston.transports.Console)
    winston.add(winston.transports.Console, {
        prettyPrint: true,
        colorize: true,
        silent: false,
        timestamp: false,
    })

    tools.mkdirP("logs")

    let opts: winston.DailyRotateFileTransportOptions = {
        maxsize: 1024 * 1024,
        maxFiles: 20,
        timestamp: true,
        colorize: false,
        silent: false,
        prettyPrint: false,
        level: "info",
        json: false,
        filename: "logs/info.log",
    }
    winston.add(winston.transports.File, opts)

    opts = tools.clone(opts)
    opts.level = "debug"
    opts.filename = "logs/debug.log"
    opts.name = "file-debug"
    winston.add(winston.transports.File, opts)

    opts = tools.clone(opts)
    opts.level = "warn"
    opts.filename = "logs/warn.log"
    opts.name = "file-warn"
    winston.add(winston.transports.File, opts)

    winston.add(MemLogger as any, {})
}

let logs = ""
let logsPrev = ""

export function getLogs() {
    return logsPrev + logs
}

class MemLogger extends winston.Transport {
    name: string
    level: string

    constructor(options: any) {
        super(options)
        this.name = "memLogger"
        this.level = options.level || "debug"
    }

    log(
        level: string,
        msg: string,
        meta: any,
        callback: (err: Error, data: boolean) => void
    ) {
        let mm = new Date().toISOString() + ": " + level + ": " + msg
        if (meta) {
            let insp = util.inspect(meta)
            if (insp != "{}") mm += " / " + insp
        }
        mm += "\n"
        logs += mm
        if (logs.length > 20000) {
            logsPrev = logs
            logs = ""
        }
        callback(null, true)
    }
}

export function logError(err: any, req: express.Request = null) {
    let errId = tools.createRandomId(8)
    let info: any = {
        errorId: errId,
    }
    if (req) {
        info.path = req.method + " " + req.url
    }
    let code: number = err.statusCode
    let msg = err.stack || err
    if (err.innerExn) msg += "\nInner:\n" + err.innerExn.stack

    if (code) winston.info("HTTP " + code)
    else {
        console.log(err)
        winston.error(msg, info)
        code = 500
    }

    if (req) {
        let resp: express.Response = req._response
        if (resp) {
            resp.status(code).send({ error: err.message, errorId: errId })
        }
    }
}

process.on("uncaughtException", function (err: any) {
    logError(err)
})

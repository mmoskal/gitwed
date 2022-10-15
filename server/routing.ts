import express = require('express');
import fs = require('fs');
import expander = require('./expander')
import gitfs = require('./gitfs')
import tools = require('./tools')
import bluebird = require('bluebird')
import winston = require('winston')
import logs = require('./logs')

export function getVHostRedir(req: express.Request) {
    const host = (req.header("x-forwarded-host") || req.header("host") || "").toLowerCase()
    const v = gitfs.config.vhostRedirs
    if (v && v.hasOwnProperty(host)) {
        return "https://" + v[host] + req.path
    }
    return null
}

export function getVHostDir(req: express.Request) {
    let host = (req.header("x-forwarded-host") || req.header("host") || "").toLowerCase()
    let v = gitfs.config.vhosts
    if (v.hasOwnProperty(host))
        return "/" + v[host].replace(/^\/+/, "")
    return ""
}

export function sendTemplate(req: express.Request, cleaned: string, vars: SMap<string> = {}) {
    gitfs.main.getTextFileAsync(cleaned, "master")
        .then(str => {
            let cfg: expander.ExpansionConfig = {
                rootFile: cleaned,
                ref: "master",
                rootFileContent: str,
                appuser: req.appuser,
                oauthuser: req.oauthuser,
                vars
            }
            expander.expandFileAsync(cfg)
                .then(page => {
                    let res: express.Response = req._response
                    let st = res.statusCode || 200
                    res.writeHead(st, {
                        'Content-Type': 'text/html; charset=utf8'
                    })
                    res.end(page.html)
                })
                .then(v => v, err => {
                    logs.logError(err, req._response)
                })
        })
}

export function sendMsg(req: express.Request, header: string, body: string) {
    sendTemplate(req, "/gw/msg.html", {
        header,
        body
    })
}

export function sendError(req: express.Request, header: string, body: string) {
    sendTemplate(req, "/gw/error.html", {
        header,
        body
    })
}

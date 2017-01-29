import express = require('express');
import mime = require('mime');
import fs = require('fs');
import expander = require('./expander')
import gitfs = require('./gitfs')
import tools = require('./tools')
import bluebird = require('bluebird')
import winston = require('winston')
import logs = require('./logs')

export function sendTemplate(req: express.Request, cleaned: string, vars: SMap<string> = {}) {
    gitfs.getTextFileAsync(cleaned, "master")
        .then(str => {
            let cfg: expander.ExpansionConfig = {
                rootFile: cleaned,
                ref: "master",
                rootFileContent: str
            }
            expander.expandFileAsync(cfg)
                .then(page => {
                    let html = page.html
                    html = html.replace(/\{\{(\w+)\}\}/g, (f, v) => vars[v] || "")
                    let res: express.Response = req._response
                    res.writeHead(200, {
                        'Content-Type': 'text/html; charset=utf8'
                    })
                    res.end(html)
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

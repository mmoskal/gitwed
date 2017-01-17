import express = require('express');
import crypto = require("crypto")
import gitlabfs = require('./gitlabfs')
import tools = require('./tools')
import bluebird = require('bluebird')
import * as jwt from "jwt-simple";

// two weeks
let cookieValidity = 14 * 24 * 3600;


interface User {
    login: string;
    hash: string;
    salt: string;
}

interface UserConfig {
    users: User[];
}

function hashPass(u: User, pass: string) {
    return crypto.pbkdf2Sync(pass, u.salt, 20000, 32, "sha256").toString("hex")
}

export function initCheck(app: express.Express) {
    app.use((req, res, next) => {
        let tok = req.cookies["GWAUTH"]
        if (tok) {
            try {
                let dwauth = jwt.decode(tok, gitlabfs.config.jwtSecret)
                if (Date.now() / 1000 - dwauth.iat < cookieValidity) {
                    req.appuser = dwauth.sub
                }
            } catch (e) {
                console.error("error veryfing token: " + tok + ": " + e.message)
            }
        }
        next();
    })
}

export function initRoutes(app: express.Express) {
    app.get("/gw/logout", (req, res, next) => {
        res.clearCookie("GWAUTH")
        res.redirect(req.query["redirect"] || "/")
    })

    app.get("/gw/hash/:name", (req, res, next) => {
        let pass = crypto.randomBytes(20).toString("hex")
        let salt = crypto.randomBytes(16).toString("hex")
        let u: User = {
            login: req.params["name"],
            salt,
            hash: "",
        }
        u.hash = hashPass(u, pass)
        res.json({
            link: "https://" + req.header("host") + "/gw/auth?user=" + u.login + "&pass=" + pass,
            user: u
        })
    })

    app.get("/gw/auth", (req, res, next) => {
        getUserConfigAsync()
            .then(cfg => {
                let u = cfg.users.filter(u => u.login == req.query["user"])[0]
                if (!u) {
                    res.sendStatus(404)
                    return
                }
                let h = hashPass(u, req.query["pass"])
                if (h !== u.hash) {
                    res.sendStatus(403)
                    return
                }

                // sub/iat fields from https://tools.ietf.org/html/rfc7519#section-4.1.2
                let jwtToken = jwt.encode({
                    iss: "GITwed",
                    sub: u.login,
                    iat: Math.floor(Date.now() / 1000)
                }, gitlabfs.config.jwtSecret)

                res.cookie("GWAUTH", jwtToken, {
                    httpOnly: true,
                    secure: req.secure,
                    maxAge: cookieValidity * 1000,
                })
                res.redirect(req.query["redirect"] || "/")
            })
    })

}

function getUserConfigAsync() {
    return gitlabfs.getTextFileAsync("private/users.json")
        .then(t => {
            return JSON.parse(t) as UserConfig
        })
}

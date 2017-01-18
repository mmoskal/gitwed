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
        // when running on localhost without secret make everyone an admin
        if (!gitlabfs.config.jwtSecret && gitlabfs.config.localRepo) {
            req.appuser = "admin"
            return
        }

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

    function createUser(req: express.Request) {
        let pass = crypto.randomBytes(20).toString("hex")
        let salt = crypto.randomBytes(16).toString("hex")
        let u: User = {
            login: req.params["name"],
            salt,
            hash: "",
        }
        u.hash = hashPass(u, pass)
        return {
            link: "https://" + req.header("host") + "/gw/auth?user=" + u.login + "&pass=" + pass,
            user: u
        }
    }

    app.get("/gw/hash/:name", (req, res, next) => {
        res.json(createUser(req))
    })

    app.get("/gw/create/:name", (req, res, next) => {
        if (req.appuser !== "admin")
            return res.status(403).end()

        getUserConfigAsync()
            .then(cfg => {
                let name: string = req.params["name"]
                if (name == "admin")
                    return res.status(400).end()
                let ex = cfg.users.filter(u => u.login == name)[0]
                if (ex && !req.query["reset"])
                    return res.end(`<p>User already exists. You can <a href="/gw/create/${name}?reset=true">reset password</a> instead. </p>`)
                let r = createUser(req)
                let action = "Adding"
                if (ex) {
                    action = "Resetting password for"
                    ex.hash = r.user.hash
                    ex.salt = r.user.salt
                } else {
                    cfg.users.push(r.user)
                }
                return gitlabfs.setTextFileAsync("private/users.json",
                    JSON.stringify(cfg, null, 4),
                    action + " user " + name)
                    .then(() => {
                        res.end(`<p>User created, authenticate at: <br>${r.link}</p>`)
                    })
            })
    })

    app.get("/gw/auth", (req, res, next) => {
        getUserConfigAsync()
            .then(cfg => {
                let u = cfg.users.filter(u => u.login == req.query["user"])[0]
                if (!u)
                    return res.status(404).end()
                let h = hashPass(u, req.query["pass"])
                if (h !== u.hash)
                    return res.status(403).end()

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

import express = require('express');
import crypto = require("crypto")
import gitfs = require('./gitfs')
import mail = require('./mail')
import tools = require('./tools')
import routing = require('./routing')
import bluebird = require('bluebird')
import winston = require('winston')
import * as jwt from "jwt-simple";

// two weeks
let cookieValidity = 14 * 24 * 3600;
// 10min
let emailValidity = 10 * 60;


interface User {
    email: string;
    nickname: string;
}

interface UserConfig {
    users: User[];
}

export function initCheck(app: express.Express) {
    app.use((req, res, next) => {
        // when running on localhost without secret make everyone an admin
        if (!gitfs.config.jwtSecret && gitfs.config.repoPath) {
            req.appuser = "admin"
            next()
            return
        }


        let tok: string = req.cookies["GWAUTH"]
        if (tok) {
            try {
                let dwauth = jwt.decode(tok, gitfs.config.jwtSecret)
                if (dwauth.iss == "GITwed"
                    && Date.now() / 1000 - dwauth.iat < cookieValidity) {
                    req.appuser = dwauth.sub
                }
            } catch (e) {
                winston.warn("error veryfing token: " + tok + ": " + e.message)
            }
        }
        next();
    })
}

function lookupUserAsync(email: string) {
    return getUserConfigAsync()
        .then(cfg => {
            email = email.toLowerCase().trim()
            // we allow ::: instead of @ in case the repo is public and we want
            // to avoid exposing email addresses to scanners
            return cfg.users.find(u => u.email.replace(/:::/, "@") == email) || null
        })
}

export function initRoutes(app: express.Express) {
    app.get("/gw/logout", (req, res, next) => {
        res.clearCookie("GWAUTH")
        res.redirect(req.query["redirect"] || "/")
    })

    app.all("/gw/login", (req, res, next) => {
        let redir: string = (req.query["redirect"] || "").slice(0, 200)
        let email: string = (req.body ? req.body["email"] || "" : "") || req.query["email"] || ""
        email = email.trim().toLowerCase()
        if (!email) {
            routing.sendTemplate(req, "/gw/login.html")
            return
        }

        if (!/^\S+@\S+/.test(email)) {
            routing.sendError(req,
                "Invalid email",
                "The email address you have supplied doesn't look valid.")
        }

        lookupUserAsync(email)
            .then(u => {
                if (!u) {
                    routing.sendError(req,
                        "Email not registered",
                        "We do not have any record of the supplied email address.")
                    return
                }

                // sub/iat fields from https://tools.ietf.org/html/rfc7519#section-4.1.2
                let jwtToken = jwt.encode({
                    iss: "GITwed-email",
                    sub: email,
                    iat: Math.floor(Date.now() / 1000),
                    rdr: redir
                }, gitfs.config.jwtSecret)

                let link = gitfs.config.authDomain + "/gw/auth?tok=" + jwtToken
                mail.sendAsync({
                    to: email,
                    subject: "Login at " + gitfs.config.serviceName,
                    text: `Please follow the link below to login:\n` +
                    `    ${link}\n\n` +
                    `The link will remain valid for 10 minutes.\n`
                })
                    .then(() => {
                        routing.sendMsg(req,
                            "Email sent",
                            "We have sent you an email with authentication link.")
                    }, err => {
                        routing.sendError(req,
                            "Failed to send email",
                            "Sorry, we couldn't send email. Contact support.")
                    })
            })
    })

    app.get("/gw/auth", (req, res, next) => {
        let tok: string = req.query["tok"] || ""
        try {
            let dwauth = jwt.decode(tok, gitfs.config.jwtSecret)
            if (dwauth.iss == "GITwed-email") {
                if (Date.now() / 1000 - dwauth.iat > emailValidity) {
                    let again = "/gw/login?email=" + encodeURIComponent(dwauth.sub) +
                        "&redirect=" + encodeURIComponent(dwauth.rdr || "")
                    routing.sendMsg(req, "Token expired",
                        `The token you used has expired. You can <a href="${again}">resend authenication email</a>.`)
                } else {
                    // sub/iat fields from https://tools.ietf.org/html/rfc7519#section-4.1.2
                    let jwtToken = jwt.encode({
                        iss: "GITwed",
                        sub: dwauth.sub,
                        iat: Math.floor(Date.now() / 1000)
                    }, gitfs.config.jwtSecret)

                    res.cookie("GWAUTH", jwtToken, {
                        httpOnly: true,
                        secure: req.secure,
                        maxAge: cookieValidity * 1000,
                    })
                    res.redirect(dwauth["rdr"] || "/")
                }
            } else {
                throw new Error("bad issuer")
            }
        } catch (e) {
            winston.warn("error veryfing token: " + tok + ": " + e.message)
            routing.sendError(req, "Invalid token",
                "The authentication link looks invalid.")
        }
    })

}

function getUserConfigAsync() {
    return gitfs.getTextFileAsync("private/users.json")
        .then(t => {
            return JSON.parse(t) as UserConfig
        })
}

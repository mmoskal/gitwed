import express = require('express');
import gitfs = require('./gitfs')
import mail = require('./mail')
import tools = require('./tools')
import routing = require('./routing')
import expander = require('./expander')
import events = require('./events')
import winston = require('winston')
import * as jwt from "jwt-simple";

// two weeks and half day - so that it tends to expire at night
let cookieValidity = (14 * 24 + 12) * 3600;
// 10min
let emailValidity = 10 * 60;


interface User {
    email: string;
    nickname: string;
    admin?: boolean;
}

interface UserConfig {
    users: User[];
}

function noSecurity() {
    return !gitfs.config.jwtSecret && gitfs.config.repoPath
}

export function initCheck(app: express.Express) {
    app.use((req, res, next) => {
        // when running on localhost without secret make everyone an admin
        if (noSecurity()) {
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

function normalizeEmail(email: string) {
    email = email.toLowerCase().trim()
    // we allow ::: instead of @ in case the repo is public and we want
    // to avoid exposing email addresses to scanners
    return email.replace(/:::/, "@")
}

function lookupUserAsync(email: string) {
    return getUserConfigAsync()
        .then(cfg => {
            email = normalizeEmail(email)
            return cfg.users.find(u => normalizeEmail(u.email) == email) || null
        })
}

let timestamps: SMap<number> = {}
export function throttle(req: express.Request, seconds: number) {
    let ip = req.connection.remoteAddress
    if (gitfs.config.proxy) {
        let h = req.header("x-forwarded-for")
        if (h) ip = h.replace(/.*,\s*/, "") // take the last one
    }

    let now = Math.floor(Date.now() / 1000)
    if (!timestamps[ip])
        timestamps[ip] = now - 3600
    let newTime = timestamps[ip] + seconds
    if (newTime > now) {
        let res: express.Response = req._response
        res.status(429).end("Too many requests!")
        tools.throwError(429)
    }
    timestamps[ip] = newTime
}

export function initRoutes(app: express.Express) {
    app.get("/gw/logout", (req, res, next) => {
        res.clearCookie("GWAUTH")
        res.redirect(req.query["redirect"] || "/")
    })

    function vhost(req: express.Request) {
        if (routing.getVHostDir(req)) {
            routing.sendError(req,
                "Editing not available here",
                "Please head to " + gitfs.config.authDomain)
            return true
        }
        return false
    }

    app.all("/gw/login", (req, res, next) => {
        if (vhost(req)) return

        let redir: string = (req.query["redirect"] || "").slice(0, 200)
        let email: string = (req.body ? req.body["email"] || "" : "") || req.query["email"] || ""
        email = email.trim().toLowerCase()
        if (!email) {
            routing.sendTemplate(req, "/gw/login.html")
            return
        }

        throttle(req, 10)

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

                throttle(req, 15 * 60) // only one email every 15min

                mail.sendAsync({
                    to: email,
                    from: null,
                    subject: "Login at " + gitfs.config.serviceName,
                    text: `Please follow the link below to login:\n` +
                        `    ${link}\n\n` +
                        `The link will remain valid for 10 minutes.\n`
                })
                    .then(() => {
                        routing.sendMsg(req,
                            "Email sent",
                            "We have sent you an email with authentication link.")
                    }, () => {
                        routing.sendError(req,
                            "Failed to send email",
                            "Sorry, we couldn't send email. Contact support.")
                    })
            })
    })

    app.get("/gw/auth", (req, res, next) => {
        if (vhost(req)) return

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
                        // assume proxy runs HTTPS
                        secure: req.secure || gitfs.config.proxy,
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


    app.post("/api/invite", async (req, res) => {
        if (!req.appuser)
            return res.status(403).end()

        let page = req.body.path + ""
        let email = normalizeEmail(req.body.email + "")
        let repo = gitfs.findRepo(page)

        let cfgPath = expander.pageConfigPath(page)
        if (!cfgPath)
            return res.status(400).end()

        let editUrl = gitfs.config.authDomain + page
        let acceptLink = gitfs.config.authDomain + "/gw/login?email=" +
            encodeURIComponent(email) +
            "&redirect=" + encodeURIComponent(page)

        if (!await expander.hasWritePermAsync(req.appuser, page))
            return res.status(402).end()

        await repo.pokeAsync(true)

        let u = await lookupUserAsync(email)
        if (!u) {
            let userCfg = await getUserConfigAsync()
            userCfg.users.push({
                email: email,
                nickname: email.replace(/@.*/, "")
            })
            await gitfs.main.setJsonFileAsync("private/users.json", userCfg,
                "Adding user " + email + " for the first time", req.appuser)

        }
        let cfg = await expander.getPageConfigAsync(page)

        if (!cfg.users) cfg.users = []
        if (cfg.users.indexOf(email) >= 0)
            return

        let msg = "Adding user " + email + " to " + page

        if (cfg.center) {
            await events.updateCenterAsync(cfg.center, c => {
                if (!c.users) c.users = []
                if (c.users.indexOf(email) < 0)
                    c.users.push(email)
            }, msg, req.appuser)
        } else {
            cfg.users.push(email)
            await repo.setJsonFileAsync(cfgPath, cfg, msg, req.appuser)
        }

        await mail.sendAsync({
            to: email,
            from: null,
            subject: "Invitation to edit " + editUrl,
            text: `${req.appuser} has invited you to edit ${editUrl}. To accept, please follow the link below:\n\n    ${acceptLink}\n`
        })

        res.json({})
    })
}

export function hasWritePermAsync(appuser: string, localUsers: string[]) {
    if (!appuser) return Promise.resolve(false)
    appuser = normalizeEmail(appuser)
    if (noSecurity() && appuser == "admin")
        return Promise.resolve(true)
    return lookupUserAsync(appuser)
        .then(u => {
            if (!u)
                return false
            if (u.admin)
                return true
            if (!localUsers)
                return false
            if (localUsers.find(e => normalizeEmail(e) == appuser))
                return true
            return false
        })
}

function getUserConfigAsync() {
    return gitfs.main.getTextFileAsync("private/users.json")
        .then(t => {
            return JSON.parse(t) as UserConfig
        })
}

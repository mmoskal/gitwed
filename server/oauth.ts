import * as url from "url";
import * as querystring from "querystring";
import * as express from "express";
import * as winston from "winston";
import * as jwt from "jwt-simple";

import * as gitfs from "./gitfs";
import * as tools from "./tools";

// two weeks
const cookieValidity = 14 * 24 * 3600;
const cookieName = "GWOAUTH"

export function setLocal() {
    isLocal = true
}

interface LoginState {
    redirect: string;
    user_state?: string;
}

const states: SMap<LoginState> = {}
export let isLocal = false;
let config: gitfs.OAuthConfig
let jwtKey: string

function showError(res: express.Response, msg: string) {
    res.status(400).end(msg);
}

function isValidDomain(d: string) {
    d = d.toLowerCase()
    const vh = gitfs.config.vhosts
    if (vh && vh.hasOwnProperty(d))
        return true
    const ad = gitfs.config.authDomain
    if (ad && url.parse(ad).host == d)
        return true
    return false
}

function rewriteRedir(redir: string) {
    const parsed = url.parse(redir)
    if (!parsed.protocol)
        return parsed.path
    if ((parsed.protocol == "http:" && /^localhost:\d+$/.test(parsed.host)) ||
        (parsed.protocol == "https:" && isValidDomain(parsed.host)))
        return url.format({
            protocol: parsed.protocol,
            host: parsed.host,
            pathname: parsed.pathname
        })
    return "/"
}

export function earlyInit(app: express.Application) {
    app.use((req, res, next) => {
        const tokA = req.cookies[cookieName]
        if (jwtKey && tokA) {
            const tok = tokA + ""
            try {
                const dwauth = jwt.decode(tok, jwtKey)
                if (Date.now() / 1000 - dwauth.iat < cookieValidity) {
                    req.oauthuser = dwauth.sub
                    winston.info("oauth: " + req.oauthuser)
                }
            } catch (e) {
                winston.error("error verifying token: " + tok + ": " + e.message)
            }
        }

        next();
    })
}

export function init(app: express.Application) {
    config = gitfs.config.oauth
    if (!config || !config.redirect_uris)
        return

    jwtKey = "oauth:" + gitfs.config.jwtSecret

    // TODO this should be 'POST'
    app.get("/logout", (req, res) => {
        res.clearCookie(cookieName)
        res.redirect("/")
    })

    app.get("/login", (req, res) => {
        let st = tools.createRandomId(12);
        if (isLocal) st = "0" + st;
        const qs = querystring.stringify({
            response_type: "code",
            client_id: config.client_id,
            redirect_uri: config.redirect_uris[0],
            //scope: "openid",
            scope: "openid profile email role",
            display: "popup",
            state: st,
        })
        const redirect = rewriteRedir(tools.getQuery(req, "redirect", "/"))
        const state = {
            redirect,
            appkey: tools.getQuery(req, "appkey"),
            user_state: tools.getQuery(req, "state"),
        }
        states[st] = state
        res.redirect(config.auth_uri + "?" + qs)
    })

    app.get("/oauth", async (req, res) => {
        const stid = tools.getQuery(req, "state")
        if (!isLocal && /^0/.test(stid)) {
            res.redirect("http://localhost:3000" + req.url)
            return
        }
        if (!states.hasOwnProperty(stid)) {
            showError(res, "Bad state");
            return;
        }
        const st = states[stid]

        const data = {
            grant_type: "authorization_code",
            client_id: config.client_id,
            redirect_uri: config.redirect_uris[0],
            client_secret: config.client_secret,
            code: tools.getQuery(req, "code")
        }
        winston.debug("asking for code: " + config.token_uri)

        const tokenresp = await tools.requestAsync({
            url: config.token_uri,
            headers: {
                "content-type": "application/x-www-form-urlencoded"
            },
            data: querystring.stringify(data),
            allowHttpErrors: true
        })

        if (tokenresp.statusCode != 200) {
            winston.error("cannot get auth-token: " + tokenresp.text + "/" + tokenresp.statusCode)
            return showError(res, "cannot get access token")
        }

        console.log(tokenresp.json)

        let userValid = true

        const idToken = tokenresp.json.id_token
        let userid = "user"
        if (idToken) {
            const decoded = jwt.decode(idToken, "", true)
            console.log(decoded)
            userid = decoded.sub || userid
            if (config.idTokenValidField) {
                userValid = false
                const v = decoded[config.idTokenValidField]
                if (v && v != "0")
                    userValid = true
            }
        }

        const token = tokenresp.json.access_token + ""

        if (config.userinfo_uri) {
            const meresp = await tools.requestAsync({
                url: config.userinfo_uri,
                headers: {
                    Authorization: "Bearer " + token
                },
                allowHttpErrors: true
            })

            if (tokenresp.statusCode != 200) {
                winston.error("cannot get user-info: " + meresp.text + "/" + meresp.statusCode)
                return showError(res, "cannot get user info")
            }

            const me: any = meresp.json
            console.log(me)
            userid = me.id || userid

            if (config.userValidUntil) {
                userValid = false
                const validUntil = me[config.userValidUntil]
                if (validUntil) {
                    const validity = new Date(validUntil).getTime()
                    if (Date.now() < validity)
                        userValid = true
                }
            }
        }

        if (!userValid) {
            if (config.userInvalidPage)
                return res.redirect(config.userInvalidPage)
            else
                return showError(res, "user invalid")
        }



        // sub/iat fields from https://tools.ietf.org/html/rfc7519#section-4.1.2
        let jwtToken = jwt.encode({
            iss: "GW",
            sub: userid,
            iat: Math.floor(Date.now() / 1000)
        }, jwtKey)

        res.cookie(cookieName, jwtToken, {
            httpOnly: true,
            secure: !!gitfs.config.production,
            maxAge: cookieValidity * 1000,
        })

        res.redirect(st.redirect)

        /*
        res.redirect(st.redirect + "#" + querystring.stringify({
            state: st.user_state,
            access_token: jwtToken,
        }))
        */
    })
}

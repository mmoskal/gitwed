import * as url from "url"
import * as querystring from "querystring"
import * as crypto from "crypto"
import * as express from "express"
import * as winston from "winston"
import * as jwt from "jwt-simple"
import RateLimit = require("express-rate-limit")

import * as gitfs from "./gitfs"
import * as tools from "./tools"

// two weeks
const cookieValidity = 14 * 24 * 3600
const cookieName = "GWOAUTH"

export function setLocal() {
    isLocal = true
}

interface LoginState {
    version: number
    processEpoch: string
    redirect: string
    secondary: boolean
    expiresAt: number
    bindingHash: string
    exchangeOrigin: string
    secureBindingCookie: boolean
}

const stateValidityMs = 10 * 60 * 1000
const stateVersion = 1
const stateProcessEpoch = crypto.randomBytes(16).toString("hex")
const maxStoredRedirectLength = 2048
const maxStoredOriginLength = 512
const maxEncodedStateLength = 4096
const bindingBytes = 32
const stateIvBytes = 12
const stateCookiePrefix = "GWOAUTHSTATE_"
const stateCookiePath = "/oauth"
const initiationLimit = 32
const maxRateLimitClients = 4096
// Two 10-minute generations cover the entire lifetime of every accepted state.
// Bloom filters keep memory fixed and can only fail closed (a false positive);
// unlike a capped Set, insertion never forgets a live replay marker.
const replayFilterBytes = 512 * 1024
const replayFilterBits = replayFilterBytes * 8
const replayHashCount = 4
export let isLocal = false
let config: gitfs.OAuthConfig
let jwtKey: string
let stateKey: Buffer
let oauthMonotonicNowTestHook: (() => number) | null = null
let lastOAuthNow = Date.now()

function monotonicMilliseconds() {
    if (oauthMonotonicNowTestHook) return oauthMonotonicNowTestHook()
    const value = process.hrtime()
    return value[0] * 1000 + value[1] / 1_000_000
}

let lastOAuthMonotonic = monotonicMilliseconds()

export function setOAuthMonotonicNowTestHook(
    hook: (() => number) | null
) {
    oauthMonotonicNowTestHook = hook
    lastOAuthMonotonic = monotonicMilliseconds()
}

function oauthNow() {
    const currentMonotonic = monotonicMilliseconds()
    const elapsed = Math.max(0, currentMonotonic - lastOAuthMonotonic)
    lastOAuthMonotonic = currentMonotonic
    // Accept forward wall-clock corrections, then re-anchor elapsed time at
    // that value. A later correction backward cannot freeze this clock: the
    // monotonic delta continues advancing state expiry and replay generations.
    lastOAuthNow = Math.max(lastOAuthNow + elapsed, Date.now())
    return lastOAuthNow
}

function base64UrlEncode(value: Buffer) {
    return value
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "")
}

function base64UrlDecode(value: string) {
    if (!value || !/^[A-Za-z0-9_-]+$/.test(value))
        throw new Error("Invalid OAuth state encoding")
    const padding = "=".repeat((4 - (value.length % 4)) % 4)
    const decoded = Buffer.from(
        value.replace(/-/g, "+").replace(/_/g, "/") + padding,
        "base64"
    )
    if (base64UrlEncode(decoded) != value)
        throw new Error("Invalid OAuth state encoding")
    return decoded
}

function digest(value: string) {
    return base64UrlEncode(
        crypto.createHash("sha256").update(value, "utf8").digest()
    )
}

function encryptState(state: LoginState) {
    const namespace = isLocal ? "0" : "1"
    const iv = crypto.randomBytes(stateIvBytes)
    const cipher = crypto.createCipheriv("aes-256-gcm", stateKey, iv)
    cipher.setAAD(Buffer.from(namespace, "ascii"))
    const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(state), "utf8"),
        cipher.final(),
    ])
    const encoded = base64UrlEncode(
        Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
    )
    const token = namespace + encoded
    if (token.length > maxEncodedStateLength)
        throw new Error("OAuth state is too large")
    return token
}

function decryptState(token: string): LoginState {
    if (
        typeof token != "string" ||
        token.length < 2 ||
        token.length > maxEncodedStateLength ||
        token[0] != (isLocal ? "0" : "1")
    )
        throw new Error("Invalid OAuth state")
    const encoded = base64UrlDecode(token.slice(1))
    if (encoded.length <= stateIvBytes + 16)
        throw new Error("Invalid OAuth state")
    const iv = encoded.subarray(0, stateIvBytes)
    const authTag = encoded.subarray(stateIvBytes, stateIvBytes + 16)
    const ciphertext = encoded.subarray(stateIvBytes + 16)
    const decipher = crypto.createDecipheriv("aes-256-gcm", stateKey, iv)
    decipher.setAAD(Buffer.from(token[0], "ascii"))
    decipher.setAuthTag(authTag)
    const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
    ]).toString("utf8")
    const state = JSON.parse(plaintext) as LoginState
    if (
        !state ||
        state.version != stateVersion ||
        state.processEpoch != stateProcessEpoch ||
        typeof state.redirect != "string" ||
        state.redirect.length > maxStoredRedirectLength ||
        typeof state.secondary != "boolean" ||
        typeof state.expiresAt != "number" ||
        !Number.isFinite(state.expiresAt) ||
        typeof state.bindingHash != "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(state.bindingHash) ||
        typeof state.exchangeOrigin != "string" ||
        state.exchangeOrigin.length > maxStoredOriginLength ||
        typeof state.secureBindingCookie != "boolean"
    )
        throw new Error("Invalid OAuth state")
    const origin = parseConfiguredOrigin(state.exchangeOrigin)
    if (
        origin.origin != state.exchangeOrigin ||
        origin.secure != state.secureBindingCookie
    )
        throw new Error("Invalid OAuth state")
    return state
}

interface ReplayGeneration {
    epoch: number
    bits: Buffer
}

function emptyReplayGeneration(epoch: number): ReplayGeneration {
    return { epoch, bits: Buffer.alloc(replayFilterBytes) }
}

let currentReplayGeneration = emptyReplayGeneration(Number.MIN_SAFE_INTEGER)
let previousReplayGeneration = emptyReplayGeneration(Number.MIN_SAFE_INTEGER)

function rotateReplayGenerations(now: number) {
    const epoch = Math.floor(now / stateValidityMs)
    if (currentReplayGeneration.epoch == epoch) return

    if (currentReplayGeneration.epoch == epoch - 1) {
        previousReplayGeneration = currentReplayGeneration
    } else {
        previousReplayGeneration = emptyReplayGeneration(epoch - 1)
    }
    currentReplayGeneration = emptyReplayGeneration(epoch)
}

function replayPositions(token: string) {
    const hashed = crypto.createHash("sha256").update(token, "utf8").digest()
    const positions: number[] = []
    for (let i = 0; i < replayHashCount; i++) {
        // replayFilterBits is a power of two, so masking is unbiased here.
        positions.push(hashed.readUInt32BE(i * 4) & (replayFilterBits - 1))
    }
    return positions
}

function replayGenerationHas(
    generation: ReplayGeneration,
    positions: number[]
) {
    return positions.every(position => {
        const value = generation.bits[position >>> 3]
        return !!(value & (1 << (position & 7)))
    })
}

function stateWasConsumedAtPositions(positions: number[]) {
    return (
        replayGenerationHas(currentReplayGeneration, positions) ||
        replayGenerationHas(previousReplayGeneration, positions)
    )
}

function stateWasConsumed(token: string, now: number) {
    rotateReplayGenerations(now)
    return stateWasConsumedAtPositions(replayPositions(token))
}

function consumeState(token: string, now: number) {
    rotateReplayGenerations(now)
    const positions = replayPositions(token)
    if (stateWasConsumedAtPositions(positions)) return false
    for (const position of positions) {
        currentReplayGeneration.bits[position >>> 3] |=
            1 << (position & 7)
    }
    return true
}

function makeBinding() {
    return crypto
        .randomBytes(bindingBytes)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "")
}

function stateCookieName(stateId: string) {
    return stateCookiePrefix + digest(stateId)
}

function bindingCookieOptions(secure: boolean) {
    return {
        httpOnly: true,
        secure,
        sameSite: "lax" as "lax",
        maxAge: stateValidityMs,
        path: stateCookiePath,
    }
}

function clearBindingCookieOptions(secure: boolean) {
    return {
        httpOnly: true,
        secure,
        sameSite: "lax" as "lax",
        path: stateCookiePath,
    }
}

function bindingMatches(expectedHash: string, supplied: any) {
    const candidate =
        typeof supplied == "string" && supplied.length <= 128 ? supplied : ""
    const expected = Buffer.from(expectedHash, "ascii")
    const actual = Buffer.from(digest(candidate), "ascii")
    return crypto.timingSafeEqual(expected, actual)
}

interface RateRecord {
    hits: number
    resetTime: Date
}

/**
 * express-rate-limit store with a fixed upper bound on client buckets. Address
 * diversity cannot grow memory without bound. At capacity, the oldest bucket
 * is replaced: a distributed attacker that already defeats a per-IP limit does
 * not get to turn the memory bound into a shared denial for every new client.
 */
class BoundedRateLimitStore {
    private records = new Map<string, RateRecord>()

    private freshRecord(now: number) {
        return {
            hits: 0,
            resetTime: new Date(now + stateValidityMs),
        }
    }

    private liveRecord(record: RateRecord, now: number) {
        return record && record.resetTime.getTime() > now
    }

    private pruneExpired(now: number) {
        while (this.records.size) {
            const oldest = this.records.entries().next().value as [
                string,
                RateRecord
            ]
            if (this.liveRecord(oldest[1], now)) break
            this.records.delete(oldest[0])
        }
    }

    incr(key: string, callback: Function) {
        const now = Date.now()
        this.pruneExpired(now)
        let record = this.records.get(key)
        if (!this.liveRecord(record, now)) {
            if (record) this.records.delete(key)
            while (this.records.size >= maxRateLimitClients) {
                const oldest = this.records.keys().next()
                if (oldest.done) break
                this.records.delete(oldest.value)
            }
            record = this.freshRecord(now)
            this.records.set(key, record)
        }
        record.hits++
        callback(null, record.hits, record.resetTime)
    }

    decrement(key: string) {
        const record = this.records.get(key)
        if (record && record.hits > 0) record.hits--
    }

    resetKey(key: string) {
        this.records.delete(key)
    }

    resetAll() {
        this.records.clear()
    }
}

function asyncRoute(
    handler: (
        req: express.Request,
        res: express.Response
    ) => any
): express.RequestHandler {
    return (req, res, next) => {
        try {
            return Promise.resolve(handler(req, res)).catch(next)
        } catch (error) {
            return next(error)
        }
    }
}

function showError(res: express.Response, msg: string) {
    res.status(400).end(msg)
}

function isValidDomain(d: string) {
    d = d.toLowerCase()
    const vh = gitfs.config.vhosts
    if (vh && Object.prototype.hasOwnProperty.call(vh, d)) return true
    const ad = gitfs.config.authDomain
    if (ad) {
        try {
            if (new url.URL(ad).host.toLowerCase() == d) return true
        } catch (e) {}
    }
    return false
}

function unsafeRedirectText(redir: string) {
    if (!redir || /[\x00-\x1f\x7f\\]/.test(redir)) return true
    let decoded: string
    try {
        decoded = decodeURIComponent(redir)
    } catch (e) {
        return true
    }
    return /[\x00-\x1f\x7f\\]/.test(decoded) || /^\/\//.test(decoded)
}

function isAllowedHttpLocalhost(parsed: url.URL) {
    return (
        parsed.protocol == "http:" &&
        parsed.hostname == "localhost" &&
        /^\d+$/.test(parsed.port)
    )
}

function isAllowedWebUrl(parsed: url.URL) {
    return (
        !parsed.username &&
        !parsed.password &&
        ((parsed.protocol == "https:" && isValidDomain(parsed.host)) ||
            isAllowedHttpLocalhost(parsed))
    )
}

function isSafeConfiguredWebUrl(parsed: url.URL) {
    return (
        !parsed.username &&
        !parsed.password &&
        (parsed.protocol == "https:" || isAllowedHttpLocalhost(parsed))
    )
}

function isCanonicalRootRelativePath(value: string) {
    return (
        value[0] == "/" &&
        value[1] != "/" &&
        !unsafeRedirectText(value)
    )
}

function rewriteRedir(redir: string) {
    if (unsafeRedirectText(redir)) return "/"

    if (redir[0] == "/") {
        if (redir[1] == "/") return "/"
        try {
            const base = new url.URL("https://relative.invalid")
            const parsed = new url.URL(redir, base)
            if (parsed.origin != base.origin) return "/"
            const canonical = parsed.pathname + parsed.search
            return isCanonicalRootRelativePath(canonical) ? canonical : "/"
        } catch (e) {
            return "/"
        }
    }

    try {
        const parsed = new url.URL(redir)
        if (!isAllowedWebUrl(parsed)) return "/"
        if (!isCanonicalRootRelativePath(parsed.pathname)) return "/"
        return parsed.origin + parsed.pathname
    } catch (e) {
        return "/"
    }
}

interface OAuthOrigin {
    origin: string
    host: string
    secure: boolean
}

function parseConfiguredOrigin(value: string) {
    if (value.length > maxStoredOriginLength || unsafeRedirectText(value)) {
        throw new Error("Invalid OAuth callback URL")
    }
    const parsed = new url.URL(value)
    // Callback URLs are operator configuration and may intentionally use a
    // dedicated host that is not a content vhost. User-supplied final
    // redirects have already passed isAllowedWebUrl before reaching here.
    if (!isSafeConfiguredWebUrl(parsed)) {
        throw new Error("Invalid OAuth callback origin")
    }
    return {
        origin: parsed.origin,
        host: parsed.host.toLowerCase(),
        secure: parsed.protocol == "https:",
    }
}

function canonicalRequestHost(req: express.Request) {
    // Proxy mode is the app's existing trust boundary for forwarded host
    // routing. Outside it, a client-supplied forwarded host is ignored.
    const value = (
        (gitfs.config.proxy && req.header("x-forwarded-host")) ||
        req.header("host") ||
        ""
    ).trim()
    if (!value || /[\x00-\x20\x7f\\\/@?#]/.test(value)) return ""
    try {
        const parsed = new url.URL("http://" + value)
        if (parsed.pathname != "/" || parsed.search || parsed.hash) return ""
        return parsed.host.toLowerCase()
    } catch (e) {
        return ""
    }
}

function callbackOrigin() {
    return parseConfiguredOrigin(config.redirect_uris[0])
}

function exchangeOrigin(redirect: string, secondary: boolean) {
    if (isLocal) return parseConfiguredOrigin("http://localhost:3000/oauth")
    if (gitfs.config.production && !secondary && !redirect.startsWith("/")) {
        return parseConfiguredOrigin(redirect)
    }
    return callbackOrigin()
}

function initiationPreflight(
    req: express.Request,
    route: string,
    rawRedirect: string,
    target: OAuthOrigin
) {
    if (canonicalRequestHost(req) == target.host) return false
    req.res.redirect(
        target.origin +
            route +
            "?" +
            querystring.stringify({ redirect: rawRedirect })
    )
    return true
}

function callbackPath(req: express.Request) {
    return (
        "/oauth?" +
        querystring.stringify({
            state: tools.getQuery(req, "state"),
            code: tools.getQuery(req, "code"),
        })
    )
}

function secondaryRedirect(redir: string) {
    if (unsafeRedirectText(redir)) return ""
    let parsed: url.URL
    try {
        parsed = new url.URL(redir)
    } catch (e) {
        return ""
    }
    if (parsed.username || parsed.password) return ""
    for (const tokurl of config.secondaryRedirs || []) {
        let tokenTarget: url.URL
        try {
            tokenTarget = new url.URL(tokurl)
        } catch (e) {
            continue
        }
        if (
            isSafeConfiguredWebUrl(tokenTarget) &&
            !tokenTarget.search &&
            !tokenTarget.hash &&
            parsed.origin == tokenTarget.origin &&
            isCanonicalRootRelativePath(parsed.pathname)
        ) {
            return (
                tokenTarget.origin +
                tokenTarget.pathname +
                "?redirect=" +
                encodeURIComponent(parsed.pathname)
            )
        }
    }
    return ""
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
                    // winston.info("oauth: " + req.oauthuser)
                }
            } catch (e) {
                winston.error("error verifying OAuth cookie")
            }
        }

        next()
    })
}

export function init(app: express.Application) {
    config = gitfs.config.oauth
    if (!config || !config.redirect_uris) return
    if (
        typeof gitfs.config.jwtSecret != "string" ||
        !gitfs.config.jwtSecret.trim()
    )
        throw new Error("OAuth requires jwtSecret")

    jwtKey = "oauth:" + gitfs.config.jwtSecret
    stateKey = crypto
        .createHash("sha256")
        .update("oauth-state:" + gitfs.config.jwtSecret, "utf8")
        .digest()
    // Validate this once at route registration, rather than discovering a bad
    // callback origin after a state and binding cookie have been issued.
    callbackOrigin()

    const initiationLimiter = RateLimit({
        windowMs: stateValidityMs,
        max: initiationLimit,
        store: new BoundedRateLimitStore(),
        // req.ip is Express's trust-proxy-aware result. In particular, do not
        // make a second trust decision by parsing X-Forwarded-For here.
        keyGenerator: req => req.ip || "unknown-client",
        handler: (req, res) =>
            res.status(429).end("Too many OAuth login attempts"),
    })

    app.get("/oauth/logout", (req, res) => {
        res.clearCookie(cookieName)
        res.redirect(config.logout_uri || "/")
    })

    function initiateLogin(
        req: express.Request,
        redirect: string,
        target: OAuthOrigin,
        secondary = false
    ) {
        const now = oauthNow()
        if (redirect.length > maxStoredRedirectLength) {
            showError(req.res, "Redirect too long")
            return
        }
        const binding = makeBinding()
        const state: LoginState = {
            version: stateVersion,
            processEpoch: stateProcessEpoch,
            redirect,
            secondary,
            expiresAt: now + stateValidityMs,
            bindingHash: digest(binding),
            exchangeOrigin: target.origin,
            secureBindingCookie: target.secure,
        }
        const st = encryptState(state)
        const qs = querystring.stringify({
            response_type: "code",
            client_id: config.client_id,
            redirect_uri: config.redirect_uris[0],
            scope: config.scopes || "openid",
            display: "popup",
            state: st,
        })
        try {
            req.res.cookie(
                stateCookieName(st),
                binding,
                bindingCookieOptions(target.secure)
            )
            req.res.redirect(config.auth_uri + "?" + qs)
        } catch (error) {
            try {
                req.res.clearCookie(
                    stateCookieName(st),
                    clearBindingCookieOptions(target.secure)
                )
            } catch (clearError) {}
            throw error
        }
    }

    app.get(
        "/oauth/secondary",
        initiationLimiter,
        (req, res) => {
            const rawRedirect = tools.getQuery(req, "redirect", "")
            const redirect = secondaryRedirect(rawRedirect)
            if (!redirect)
                return showError(res, "Invalid secondary domain")
            const target = exchangeOrigin(redirect, true)
            if (
                initiationPreflight(
                    req,
                    "/oauth/secondary",
                    rawRedirect,
                    target
                )
            )
                return
            initiateLogin(req, redirect, target, true)
        }
    )

    app.get(
        "/oauth/login",
        initiationLimiter,
        (req, res) => {
            const redirect = rewriteRedir(
                tools.getQuery(req, "redirect", "/")
            )
            const target = exchangeOrigin(redirect, false)
            if (
                initiationPreflight(
                    req,
                    "/oauth/login",
                    redirect,
                    target
                )
            )
                return
            initiateLogin(req, redirect, target)
        }
    )

    app.get(
        "/oauth",
        asyncRoute(async (req, res) => {
            const now = oauthNow()
            const stid = tools.getQuery(req, "state")
            if (!isLocal && /^0/.test(stid)) {
                res.redirect("http://localhost:3000" + callbackPath(req))
                return
            }
            let st: LoginState
            try {
                st = decryptState(stid)
            } catch (error) {
                showError(res, "Bad state")
                return
            }
            if (st.expiresAt <= now || st.expiresAt > now + stateValidityMs) {
                showError(res, "Bad state")
                return
            }
            if (stateWasConsumed(stid, now)) {
                showError(res, "Bad state")
                return
            }

            const currentHost = canonicalRequestHost(req)
            const finalHost = new url.URL(st.exchangeOrigin).host.toLowerCase()
            if (currentHost != finalHost) {
                if (currentHost == callbackOrigin().host) {
                    return res.redirect(st.exchangeOrigin + callbackPath(req))
                }
                return showError(res, "Bad state")
            }

            const bindingCookie = req.cookies
                ? req.cookies[stateCookieName(stid)]
                : undefined
            if (!bindingMatches(st.bindingHash, bindingCookie)) {
                showError(res, "Bad state")
                return
            }

            // The state is a one-time credential. Consume it synchronously
            // and clear its browser binding before starting either remote
            // request, so concurrent callbacks and provider failures cannot
            // replay it.
            if (!consumeState(stid, now)) {
                showError(res, "Bad state")
                return
            }
            res.clearCookie(
                stateCookieName(stid),
                clearBindingCookieOptions(st.secureBindingCookie)
            )

            const data = {
                grant_type: "authorization_code",
                client_id: config.client_id,
                redirect_uri: config.redirect_uris[0],
                client_secret: config.client_secret,
                code: tools.getQuery(req, "code"),
            }
            winston.debug("requesting OAuth token")

            const tokenresp = await tools.requestAsync({
                url: config.token_uri,
                headers: {
                    "content-type": "application/x-www-form-urlencoded",
                },
                data: querystring.stringify(data),
                allowHttpErrors: true,
            })

            if (tokenresp.statusCode != 200) {
                winston.error(
                    "OAuth token request failed with HTTP " +
                        tokenresp.statusCode
                )
                return showError(res, "cannot get access token")
            }

            // console.log(tokenresp.json)

            let userValid = true

            const idToken = tokenresp.json.id_token
            let userid = "user"
            const secondaryFields: any = {}

            if (idToken) {
                const decoded = jwt.decode(idToken, "", true)
                Object.assign(secondaryFields, decoded)
                //console.log(decoded)
                userid = decoded.sub || userid
            }

            const token = tokenresp.json.access_token + ""

            if (config.userinfo_uri) {
                const meresp = await tools.requestAsync({
                    url: config.userinfo_uri,
                    headers: {
                        Authorization: "Bearer " + token,
                    },
                    allowHttpErrors: true,
                })

                if (meresp.statusCode != 200) {
                    winston.error(
                        "OAuth user-info request failed with HTTP " +
                            meresp.statusCode
                    )
                    return showError(res, "cannot get user info")
                }

                const me: any = meresp.json
                Object.assign(secondaryFields, me)
                userid = me.id || userid
                // console.log(JSON.stringify(me, null, 1))
                if (config.userinfo_condition) {
                    const check =
                        "(function (me) { 'use strict';\nreturn " +
                        config.userinfo_condition +
                        " })"
                    userValid = eval(check)(me)
                    winston.info(
                        `OAuth user-info condition result: ${userValid}`
                    )
                }
            }

            if (!userValid) {
                if (config.userInvalidPage)
                    return res.redirect(config.userInvalidPage)
                else return showError(res, "user invalid")
            }

            if (st.secondary) {
                const obj: any = {
                    iss: "GW",
                    sub: userid,
                    iat: Math.floor(Date.now() / 1000),
                }
                for (const fld of config.secondaryTokenFields || []) {
                    obj[fld] = secondaryFields[fld]
                }
                const secondaryToken = jwt.encode(obj, config.secondaryKey)
                return res.redirect(st.redirect + "&token=" + secondaryToken)
            }

            // sub/iat fields from https://tools.ietf.org/html/rfc7519#section-4.1.2
            const jwtToken = jwt.encode(
                {
                    iss: "GW",
                    sub: userid,
                    iat: Math.floor(Date.now() / 1000),
                },
                jwtKey
            )

            res.cookie(cookieName, jwtToken, {
                httpOnly: true,
                sameSite: "lax",
                secure: !!gitfs.config.production,
                maxAge: cookieValidity * 1000,
            })

            res.redirect(st.redirect)
        })
    )
}

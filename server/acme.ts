import express = require("express")
import crypto = require("crypto")
import fs = require("fs")
import path = require("path")
import http = require("http")
import https = require("https")
import winston = require("winston")

import gitfs = require("./gitfs")
import mail = require("./mail")

const wellKnowns: { [key: string]: string } = Object.create(null)
const minute = 60 * 1000
const day = 24 * 60 * minute
const letsEncryptDirectoryUrl = "https://acme-v02.api.letsencrypt.org/directory"
const stagingDirectoryUrl = "https://acme-staging-v02.api.letsencrypt.org/directory"
let acmeHttpConfigured = false

/** Serve temporary probes and ACME tokens before normal host routing. */
export function init(app: express.Express) {
    app.get(/^\/\.well-known\/(.*)/, (req, res) => {
        if (Object.prototype.hasOwnProperty.call(wellKnowns, req.params[0])) {
            res.setHeader("Cache-Control", "no-store")
            res.contentType("text/plain")
            res.send(wellKnowns[req.params[0]])
        } else {
            res.status(404).end("Not well known.")
        }
    })
}

/**
 * Start serving saved certificates immediately, then maintain one SNI certificate
 * per hostname in the background. DNS and CA failures never hold up startup.
 */
export async function setupCertsAndListen(app: express.Express, cfg: gitfs.Config) {
    let server: https.Server
    const manager = new CertificateManager(cfg, (domain, cert) => {
        const options = httpsOptions(cert)
        server.addContext(domain, options)
        if (domain === manager.domains[0]) server.setSecureContext(options)
    })
    const defaultCert = manager.state.domains[manager.domains[0]].certificate ||
        manager.state.legacyCertificate
    server = https.createServer(defaultCert ? httpsOptions(defaultCert) : {}, app)
    for (const domain of manager.domains) {
        const cert = manager.state.domains[domain].certificate ||
            manager.state.legacyCertificate
        if (cert) server.addContext(domain, httpsOptions(cert))
    }
    server.listen(443, () => winston.info("Starting HTTPS server"))

    const challengeServer = http.createServer(app)
    challengeServer.listen(80, () => {
        winston.info("Listening for ACME http-01 challenges")
        void manager.checkAsync().catch(error => winston.error(error.stack))
    })
    const timer = setInterval(() => {
        void manager.checkAsync().catch(error => winston.error(error.stack))
    }, minute)
    timer.unref()
    server.on("close", () => clearInterval(timer))
}

/**
 * Coordinates independent hostname certificates and durable retry state. Only one
 * scan runs at a time, so account registration and state writes cannot race.
 */
export class CertificateManager {
    readonly state: CertificateState
    readonly domains: string[]
    readonly directoryUrl: string
    private running = false
    private client: any

    /** Load saved state, or migrate the old shared certificate without deleting it. */
    constructor(
        private cfg: gitfs.Config,
        private install: (domain: string, cert: SavedCert) => void,
        private statePath = cfg.certStaging ? "certificates-staging.json" : "certificates.json"
    ) {
        this.directoryUrl = cfg.certStaging
            ? stagingDirectoryUrl : letsEncryptDirectoryUrl
        const configuredDomains = [
            new URL(cfg.authDomain).hostname,
            ...Object.keys(cfg.vhosts || {}),
            ...Object.keys(cfg.vhostRedirs || {}),
        ]
        this.domains = Array.from(new Set(configuredDomains.map(
            domain => domain.toLowerCase().replace(/\.$/, "")
        )))
        for (const domain of this.domains) {
            const labels = domain.split(".")
            if (domain.length > 253 || labels.length < 2 || labels.some(
                label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
            ))
                throw new Error("Invalid certificate hostname: " + domain)
        }
        try {
            this.state = JSON.parse(fs.readFileSync(this.statePath, "utf8"))
            if (this.state.version !== 1 || !this.state.account || !this.state.domains)
                throw new Error("Invalid certificate state: " + this.statePath)
        } catch (error) {
            if (error.code !== "ENOENT") throw error
            this.state = { version: 1, account: {}, domains: {} }
            if (!cfg.certStaging) {
                try {
                    const legacy: SavedCert = JSON.parse(fs.readFileSync(
                        path.join(path.dirname(this.statePath), "certificate.json"), "utf8"
                    ))
                    this.state.account = { key: legacy.accountKey, url: legacy.accountUrl }
                    delete legacy.accountKey
                    delete legacy.accountUrl
                    if (legacy.certPem) {
                        const info = new crypto.X509Certificate(legacy.certPem)
                        legacy.expiresAt = Date.parse(info.validTo)
                        // Older failure handling could record names absent from the actual cert.
                        legacy.domains = this.domains.filter(
                            domain => !!info.checkHost(domain)
                        )
                    }
                    this.state.legacyCertificate = legacy
                    if (legacy.domains.length === 1 &&
                        this.domains.includes(legacy.domains[0])) {
                        this.state.domains[legacy.domains[0]] = { certificate: legacy }
                    }
                } catch (error) {
                    if (error.code !== "ENOENT") throw error
                }
            }
        }
        for (const domain of this.domains) {
            if (!this.state.domains[domain]) this.state.domains[domain] = {}
        }
        for (const domain of Object.keys(this.state.domains)) {
            const pending = this.state.domains[domain].pendingOrder
            if (!pending?.httpChallenges) continue
            if (!this.domains.includes(domain) || pending.order.status !== "pending" ||
                Date.parse(pending.order.expires) <= Date.now()) {
                clearHttpChallenges(pending)
            } else {
                // Restore before opening port 80, even when the account is backing off.
                Object.assign(wellKnowns, pending.httpChallenges)
            }
        }
        this.save()
    }

    /** Check due work without overlapping scans; failures remain local to each name. */
    async checkAsync() {
        if (this.running) return
        this.running = true
        try {
            for (const domain of this.domains) {
                const entry = this.state.domains[domain]
                if (entry.pendingOrder?.httpChallenges &&
                    Date.parse(entry.pendingOrder.order.expires) <= Date.now()) {
                    clearHttpChallenges(entry.pendingOrder)
                    this.save()
                }
                const cert = entry.certificate
                if (cert && (!cert.ariCheckTime || cert.ariCheckTime <= Date.now())) {
                    // A failed ARI request also gets a cooldown; retry/email state is separate.
                    cert.ariCheckTime = Date.now() + 6 * 60 * minute
                    await this.refreshAriAsync(cert)
                    this.save()
                }
                if (!entry.pendingOrder && cert && cert.renewTime > Date.now()) continue
                if (entry.nextAttemptAt > Date.now()) continue
                if (this.state.account.nextAttemptAt > Date.now()) continue

                let phase = entry.pendingOrder ? "issuance" : "probe"
                try {
                    // Accepted orders may already be issued; recovery must not depend on port 80.
                    if (!entry.pendingOrder) await this.probeAsync(domain)
                    phase = "issuance"
                    // Reserve a retry delay before contacting the CA, even if we restart mid-order.
                    entry.nextAttemptAt = Date.now() + 2 * 60 * minute
                    this.save()
                    const renewed = await this.renewAsync(domain, cert)
                    entry.certificate = renewed
                    entry.failures = 0
                    if (entry.pendingOrder) clearHttpChallenges(entry.pendingOrder)
                    delete entry.pendingOrder
                    delete entry.rejectedReplaces
                    delete entry.nextAttemptAt
                    delete entry.lastError
                    this.save()
                    this.install(domain, renewed)
                    winston.info("Certificate installed for " + domain)
                } catch (error) {
                    const now = Date.now()
                    entry.lastError = phase + ": " + error.message
                    if (phase === "probe") {
                        entry.nextAttemptAt = now + 30 * minute
                    } else {
                        entry.failures = Math.min((entry.failures || 0) + 1, 20)
                        const delay = Math.min(
                            2 * day, 2 * 60 * minute * Math.pow(2, entry.failures - 1)
                        )
                        entry.nextAttemptAt = now + delay
                        const response = error.response
                        const retryAt = response && parseRetryAfter(
                            response.headers && response.headers["retry-after"]
                        )
                        if (retryAt)
                            entry.nextAttemptAt = Math.max(entry.nextAttemptAt, retryAt)
                        if (!error.hostnameVerification && response &&
                            (response.status === 429 || response.status === 503)) {
                            // The CA may not identify the scope. Conservatively pause this account.
                            this.state.account.nextAttemptAt = entry.nextAttemptAt
                        }
                    }
                    winston.warn("Certificate failure for " + domain + ": " + entry.lastError)
                    const notify = !entry.lastFailureEmailAt ||
                        now - entry.lastFailureEmailAt >= day
                    // Persist before sending, so a mail failure or restart cannot flood the inbox.
                    if (notify) entry.lastFailureEmailAt = now
                    this.save()
                    if (notify) {
                        const legacy = this.state.legacyCertificate
                        const serving = cert || (
                            legacy && legacy.domains.includes(domain) ? legacy : undefined
                        )
                        const expiry = serving && (
                            serving.expiresAt || serving.lastWrite + serving.duration * day
                        )
                        void this.sendFailureEmailAsync({
                            to: this.cfg.certEmail,
                            from: null,
                            subject: "Certificate failure for " + domain,
                            text: entry.lastError.slice(0, 6000) +
                                "\nNext attempt: " + new Date(entry.nextAttemptAt).toISOString() +
                                (expiry
                                    ? "\nExisting certificate expires: " + new Date(expiry).toISOString()
                                    : "\nNo existing certificate."),
                        })
                    }
                }
            }
        } finally {
            this.running = false
        }
    }

    /** Send after saving the cooldown; slow delivery must never hold the renewal scan open. */
    private async sendFailureEmailAsync(message: mail.Message) {
        let timer: NodeJS.Timeout
        try {
            await Promise.race([
                mail.sendAsync(message, this.cfg),
                new Promise((resolve, reject) => {
                    timer = setTimeout(() => reject(new Error("Email delivery timed out")), 30000)
                    timer.unref()
                }),
            ])
        } catch (error) {
            winston.warn("Certificate failure email could not be sent: " + error.message)
        } finally {
            // Promise.race also observes a provider rejection that arrives after the timeout.
            clearTimeout(timer)
        }
    }

    /** Atomically persist keys and all schedules together, with owner-only permissions. */
    save() {
        const temporary = this.statePath + ".tmp"
        fs.writeFileSync(temporary, JSON.stringify(this.state, null, 4), { mode: 0o600 })
        fs.chmodSync(temporary, 0o600)
        fs.renameSync(temporary, this.statePath)
    }

    /** Verify public HTTP routing with an unpredictable token before opening a CA order. */
    async probeAsync(domain: string) {
        const token = crypto.randomBytes(24).toString("hex")
        const key = "acme-challenge/gitwed-probe-" + token
        wellKnowns[key] = token
        try {
            const body = await requestTextAsync(
                "http://" + domain + "/.well-known/" + key
            )
            if (body !== token)
                throw new Error("HTTP probe returned the wrong token for " + domain)
        } finally {
            delete wellKnowns[key]
        }
    }

    /** Resume accepted orders with their original key; save new orders before finalization. */
    async renewAsync(domain: string, previous?: SavedCert): Promise<SavedCert> {
        const acme = require("acme-client")
        if (!acmeHttpConfigured) {
            // Durable scheduling handles failures, rather than sleeping inside the library.
            acme.axios.defaults.timeout = 15000
            acme.axios.defaults.acmeSettings.retryMaxAttempts = 0
            acme.axios.interceptors.response.use((response: any) => {
                // Keep problem types and Retry-After intact; let the library handle badNonce.
                if (response.status >= 400 &&
                    response.data?.type !== "urn:ietf:params:acme:error:badNonce") {
                    const message = response.data && response.data.detail ||
                        "ACME HTTP " + response.status
                    throw Object.assign(new Error(message), { response })
                }
                return response
            })
            acmeHttpConfigured = true
        }
        const account = this.state.account
        if (!account.key) {
            account.key = (await acme.crypto.createPrivateKey()).toString()
            this.save()
        }
        if (!this.client) {
            this.client = new acme.Client({
                directoryUrl: this.directoryUrl,
                accountKey: account.key,
                accountUrl: account.url,
                backoffAttempts: 1,
            })
        }
        if (!account.url) {
            await this.client.createAccount({
                contact: [`mailto:${this.cfg.certEmail}`],
                termsOfServiceAgreed: true,
            })
            account.url = this.client.getAccountUrl()
            this.save()
        }
        const entry = this.state.domains[domain]
        let pending = entry.pendingOrder
        if (!pending) {
            const directory = JSON.parse(await requestTextAsync(this.directoryUrl))
            const profiles = directory.meta && directory.meta.profiles
            const profile = profiles && profiles.tlsserver ? "tlsserver" : undefined
            const [key, csr] = await acme.crypto.createCsr({ altNames: [domain] })
            const payload: any = { identifiers: [{ type: "dns", value: domain }] }
            if (profile) payload.profile = profile
            // A shared legacy cert cannot be the predecessor of several singleton certs.
            const replaces = directory.renewalInfo && previous && (
                previous.ariCertId || getAriCertId(previous.certPem)
            )
            if (replaces && replaces !== entry.rejectedReplaces) payload.replaces = replaces
            let order: any
            try {
                order = await this.client.createOrder(payload)
            } catch (error) {
                if (!payload.replaces ||
                    error.response?.data?.type !== "urn:ietf:params:acme:error:alreadyReplaced")
                    throw error
                // Recover old state or a lost newOrder response without dropping the profile.
                entry.rejectedReplaces = payload.replaces
                this.save()
                order = await this.client.createOrder({ ...payload, replaces: undefined })
            }
            pending = entry.pendingOrder = {
                order, keyPem: key.toString(), csrPem: csr.toString(), profile,
            }
            this.save()
        } else {
            try {
                // The CA may have finalized successfully before our last request failed.
                pending.order = await this.client.getOrder(pending.order)
            } catch (error) {
                if (error.response?.status === 404 || error.response?.status === 410) {
                    clearHttpChallenges(pending)
                    delete entry.pendingOrder
                    this.save()
                }
                throw error
            }
        }
        let order = pending.order
        if (order.status === "invalid" || (order.status !== "valid" &&
            Date.parse(order.expires) <= Date.now())) {
            clearHttpChallenges(pending)
            delete entry.pendingOrder
            this.save()
            throw new Error("Saved ACME order is invalid or expired")
        }
        try {
            if (order.status === "pending") {
                const authorizations = await this.client.getAuthorizations(order)
                for (const authz of authorizations)
                    await this.satisfyHttpChallengeAsync(pending, authz)
            }
            // All authorizations are valid, or the order has already moved past validation.
            if (pending.httpChallenges) {
                clearHttpChallenges(pending)
                this.save()
            }
            if (order.status === "pending")
                order = await waitForAcmeStatusAsync(this.client, order)
        } catch (error) {
            if (["invalid", "expired", "revoked", "deactivated"].includes(error.response?.data?.status)) {
                clearHttpChallenges(pending)
                delete entry.pendingOrder
                this.save()
            }
            throw error
        }
        if (order.status === "ready") {
            order = await this.client.finalizeOrder(order, Buffer.from(pending.csrPem))
        }
        if (order.status !== "valid")
            order = await waitForAcmeStatusAsync(this.client, order)
        if (order.status !== "valid") throw new Error("ACME order was not finalized")
        const cert: string = await this.client.getCertificate(order)
        const info = acme.crypto.readCertificateInfo(cert)
        const duration = info.notAfter.getTime() - info.notBefore.getTime()
        const renewTime = info.notBefore.getTime() + randomTimeBetween(
            duration * 0.57, duration * 0.63
        )
        const saved: SavedCert = {
            duration: duration / day,
            lastWrite: Date.now(),
            expiresAt: info.notAfter.getTime(),
            renewTime,
            domains: [domain],
            certPem: cert,
            keyPem: pending.keyPem,
            ariCertId: getAriCertId(cert),
            ariCheckTime: Date.now() + 6 * 60 * minute,
            profile: pending.profile,
        }
        await this.refreshAriAsync(saved)
        return saved
    }

    /** Persist the response before submission and retain it until validation is known to finish. */
    private async satisfyHttpChallengeAsync(pending: PendingOrder, authz: any) {
        if (authz.status === "valid") return
        if (authz.status !== "pending")
            throw Object.assign(new Error("Unexpected ACME authorization status: " + authz.status), {
                response: { data: authz },
            })
        const challenge = authz.challenges.find((c: any) => c.type === "http-01")
        if (!challenge) throw new Error("No http-01 ACME challenge for " + authz.identifier.value)
        const key = `acme-challenge/${challenge.token}`
        const keyAuthorization = await this.client.getChallengeKeyAuthorization(challenge)
        if (!pending.httpChallenges) pending.httpChallenges = {}
        pending.httpChallenges[key] = keyAuthorization
        wellKnowns[key] = keyAuthorization
        this.save()
        // A resumed processing challenge was already submitted; keep serving it while polling.
        if (!challenge.status || challenge.status === "pending") {
            try {
                await this.client.verifyChallenge(authz, challenge)
            } catch (error) {
                // This request goes to the hostname, so its Retry-After applies only there.
                throw Object.assign(new Error("HTTP challenge verification failed: " + error.message), {
                    response: error.response,
                    hostnameVerification: true,
                })
            }
            await this.client.completeChallenge(challenge)
        }
        if (challenge.status !== "valid")
            await waitForAcmeStatusAsync(this.client, challenge)
        delete wellKnowns[key]
        delete pending.httpChallenges[key]
        if (!Object.keys(pending.httpChallenges).length) delete pending.httpChallenges
        this.save()
    }

    /** Prefer the CA's randomized ARI window while leaving retry and email cooldowns untouched. */
    async refreshAriAsync(cert: SavedCert) {
        const certId = cert.ariCertId || getAriCertId(cert.certPem)
        if (!certId) return
        try {
            const directory = JSON.parse(await requestTextAsync(this.directoryUrl))
            if (!directory.renewalInfo) return
            const info = JSON.parse(await requestTextAsync(
                directory.renewalInfo.replace(/\/$/, "") + "/" + certId
            ))
            const start = Date.parse(info.suggestedWindow && info.suggestedWindow.start)
            const end = Date.parse(info.suggestedWindow && info.suggestedWindow.end)
            if (!isFinite(start) || !isFinite(end) || end <= start) return
            if (!cert.ariRenewTime || cert.ariCertId !== certId ||
                cert.ariRenewTime < start || cert.ariRenewTime > end)
                cert.ariRenewTime = randomTimeBetween(start, end)
            cert.ariCertId = certId
            cert.ariWindow = {
                start: info.suggestedWindow.start,
                end: info.suggestedWindow.end,
            }
            cert.renewTime = cert.ariRenewTime
            winston.info("ACME ARI renewal time for " + cert.domains.join(", ") +
                ": " + new Date(cert.renewTime).toISOString())
        } catch (error) {
            // Retain a previously fetched ARI schedule if the CA is temporarily unavailable.
            winston.warn("ACME ARI check failed: " + error.message)
        }
    }
}

/** Saved certificate material; legacy account fields are moved to shared state on import. */
export interface SavedCert {
    duration: number
    lastWrite: number
    expiresAt?: number
    renewTime: number
    domains: string[]
    cert?: string
    certPem?: string
    keyPem?: string
    accountKey?: string
    accountUrl?: string
    ariCertId?: string
    ariRenewTime?: number
    ariCheckTime?: number
    ariWindow?: { start: string; end: string }
    profile?: string
}

/** Persisted status of one configured hostname, including pending names with no certificate. */
interface DomainState {
    certificate?: SavedCert
    pendingOrder?: PendingOrder
    rejectedReplaces?: string
    failures?: number
    nextAttemptAt?: number
    lastFailureEmailAt?: number
    lastError?: string
}

/** Keep the accepted order, key/CSR, and active validation responses available across restarts. */
interface PendingOrder {
    order: any
    keyPem: string
    csrPem: string
    profile?: string
    httpChallenges?: { [path: string]: string }
}

/** Versioned store keeps one ACME account and independent hostname state across restarts. */
interface CertificateState {
    version: number
    account: { key?: string; url?: string; nextAttemptAt?: number }
    domains: { [domain: string]: DomainState }
    legacyCertificate?: SavedCert
}

/** Remove responses for finished or abandoned validation; the caller persists the state change. */
function clearHttpChallenges(pending: PendingOrder) {
    for (const key of Object.keys(pending.httpChallenges || {})) delete wellKnowns[key]
    delete pending.httpChallenges
}

/** Poll only pending states; transport and CA errors immediately reach durable backoff. */
async function waitForAcmeStatusAsync(client: any, item: any) {
    if (!item.url) throw new Error("ACME status URL is missing")
    for (let attempt = 0; attempt < 10; ++attempt) {
        // Use the library's signed POST-as-GET without its catch-all polling retry loop.
        const response = await client.api.apiRequest(item.url, null, [200])
        const status = response.data.status
        if (status === "ready" || status === "valid")
            return { ...response.data, url: item.url }
        if (status !== "pending" && status !== "processing")
            throw Object.assign(new Error(response.data.error?.detail ||
                "Unexpected ACME status: " + status), { response })
        if (attempt < 9)
            await new Promise(resolve => setTimeout(resolve, Math.min(30000, 5000 * 2 ** attempt)))
    }
    throw new Error("ACME operation is still pending or processing")
}

/** Convert saved PEM or legacy PFX material into Node's TLS server options. */
function httpsOptions(savedCert: SavedCert): https.ServerOptions {
    if (savedCert.certPem && savedCert.keyPem) return { key: savedCert.keyPem, cert: savedCert.certPem }
    if (savedCert.cert) return { passphrase: "", pfx: Buffer.from(savedCert.cert, "base64") }
    throw new Error("No usable saved certificate")
}

/** Draw a renewal or retry time once; callers persist it so restarts cannot move deadlines. */
function randomTimeBetween(start: number, end: number) {
    const random = crypto.randomBytes(6).readUIntBE(0, 6) / 0x1000000000000
    return Math.floor(start + (end - start) * random)
}

/** Parse both HTTP Retry-After forms into an absolute deadline shared by HTTP callers. */
function parseRetryAfter(value: string) {
    if (!value) return 0
    const result = /^\d+$/.test(value) ? Date.now() + Number(value) * 1000 : Date.parse(value)
    return isFinite(result) ? result : 0
}

/** Fetch small probe/ARI responses with a total deadline and no redirect or cache ambiguity. */
function requestTextAsync(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const transport = url.startsWith("https:") ? https : http
        const request = transport.get(url, { headers: { Accept: "application/json", "Cache-Control": "no-cache" } }, response => {
            let body = ""
            response.setEncoding("utf8")
            response.on("data", chunk => {
                body += chunk
                if (body.length > 65536) request.destroy(new Error("HTTP response too large"))
            })
            response.on("error", reject)
            response.on("end", () => {
                if (response.statusCode < 200 || response.statusCode >= 300) {
                    reject(Object.assign(new Error("GET " + url + " returned " + response.statusCode), {
                        response: { status: response.statusCode, headers: response.headers },
                    }))
                } else resolve(body)
            })
        })
        const timer = setTimeout(() => request.destroy(new Error("HTTP request timed out: " + url)), 10000)
        request.on("error", reject)
        request.on("close", () => clearTimeout(timer))
    })
}

/** Build the ARI certificate identifier from its authority key identifier and serial number. */
function getAriCertId(certPem?: string) {
    if (!certPem) return null

    try {
        const certDer = pemToDer(certPem)
        const cert = readAsn1(certDer, 0)
        const certChildren = readChildren(cert)
        const tbs = certChildren[0]
        const tbsChildren = readChildren(tbs)
        let serialIndex = 0
        if (tbsChildren[0].tag === 0xa0) serialIndex = 1
        const serial = tbsChildren[serialIndex]
        const aki = findAuthorityKeyIdentifier(tbsChildren)
        if (!aki || serial.tag !== 0x02) return null

        return toBase64Url(aki) + "." + toBase64Url(serial.value)
    } catch (e) {
        winston.warn("Unable to compute ACME ARI certificate id: " + e.message)
        return null
    }
}

/** A bounded DER element used to read the certificate fields needed by ARI. */
interface Asn1Node {
    buf: Buffer
    tag: number
    start: number
    valueStart: number
    end: number
    value: Buffer
}

/** Decode the first certificate in a PEM chain for ARI identification. */
function pemToDer(pem: string) {
    const match = pem.match(
        /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/
    )
    if (!match) throw new Error("No PEM certificate found")
    return Buffer.from(match[1].replace(/\s+/g, ""), "base64")
}

/** Read one DER element, rejecting lengths beyond the available certificate bytes. */
function readAsn1(buf: Buffer, start: number): Asn1Node {
    let offset = start
    const tag = buf[offset++]
    let length = buf[offset++]
    if (length & 0x80) {
        const bytes = length & 0x7f
        length = 0
        for (let i = 0; i < bytes; ++i) length = length * 256 + buf[offset++]
    }
    const valueStart = offset
    const end = valueStart + length
    if (end > buf.length) throw new Error("ASN.1 length exceeds buffer")
    return {
        buf,
        tag,
        start,
        valueStart,
        end,
        value: buf.slice(valueStart, end),
    }
}

/** Enumerate the nested DER elements of a constructed certificate field. */
function readChildren(node: Asn1Node) {
    const children: Asn1Node[] = []
    let offset = node.valueStart
    while (offset < node.end) {
        const child = readAsn1(node.buf, offset)
        children.push(child)
        offset = child.end
    }
    return children
}

/** Locate the authority key identifier extension needed for the ARI CertID. */
function findAuthorityKeyIdentifier(tbsChildren: Asn1Node[]) {
    const extensions = tbsChildren.filter(c => c.tag === 0xa3)[0]
    if (!extensions) return null

    const extensionSeq = readChildren(extensions)[0]
    const extensionItems = readChildren(extensionSeq)
    for (const item of extensionItems) {
        const fields = readChildren(item)
        const oid = fields[0]
        if (!oid || oid.tag !== 0x06 || oidToString(oid.value) !== "2.5.29.35")
            continue

        const value = fields.filter(f => f.tag === 0x04)[0]
        if (!value) return null
        const akiSeq = readAsn1(value.value, 0)
        const akiFields = readChildren(akiSeq)
        const keyIdentifier = akiFields.filter(f => f.tag === 0x80)[0]
        return keyIdentifier ? keyIdentifier.value : null
    }

    return null
}

/** Decode the extension OID so ARI can identify the authority key identifier. */
function oidToString(bytes: Buffer) {
    const parts = [Math.floor(bytes[0] / 40), bytes[0] % 40]
    let value = 0
    for (let i = 1; i < bytes.length; ++i) {
        value = value * 128 + (bytes[i] & 0x7f)
        if (!(bytes[i] & 0x80)) {
            parts.push(value)
            value = 0
        }
    }
    return parts.join(".")
}

/** Encode ARI identifier components using unpadded base64url. */
function toBase64Url(buf: Buffer) {
    return buf
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "")
}

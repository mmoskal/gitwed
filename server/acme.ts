import express = require("express")
import crypto = require("crypto")
import fs = require("fs")
import http = require("http")
import https = require("https")
import winston = require("winston")

import gitfs = require("./gitfs")
import mail = require("./mail")

const wellKnowns: any = {}

export function init(app: express.Express) {
    app.get(/^\/\.well-known\/(.*)/, (req, res) => {
        if (wellKnowns.hasOwnProperty(req.params[0])) {
            res.contentType("text/plain")
            res.send(wellKnowns[req.params[0]])
        } else {
            res.status(404).end("Not well known.")
        }
    })
}

interface SavedCert {
    duration: number // days
    lastWrite: number // ms
    renewTime: number // ms
    domains: string[]
    cert?: string // legacy base64-encoded PFX with empty password
    certPem?: string
    keyPem?: string
    accountKey?: string
    accountUrl?: string
    ariCertId?: string
    ariRenewTime?: number // ms
    ariWindow?: {
        start: string
        end: string
    }
    profile?: string
}

const certPath = "certificate.json"
const letsEncryptDirectoryUrl =
    "https://acme-v02.api.letsencrypt.org/directory"
const preferredProfile = "tlsserver"
const emergencyRenewBeforeExpiry = 7 * 24 * 3600 * 1000

function writeSavedCert(savedCert: SavedCert) {
    fs.writeFileSync(certPath, JSON.stringify(savedCert, null, 4), {
        mode: 0o600,
    })
    fs.chmodSync(certPath, 0o600)
}

export async function setupCertsAndListen(
    app: express.Express,
    cfg: gitfs.Config
) {
    http.createServer(app).listen(80, function () {
        winston.info("Listening for ACME http-01 challenges")
    })

    const mainDomain = cfg.authDomain
        .replace(/^https:\/\//, "")
        .replace(/\/$/, "")
    let domains0 = Object.keys(cfg.vhosts || {}).concat(
        Object.keys(cfg.vhostRedirs || {})
    )
    domains0.unshift(mainDomain)
    const domains: string[] = []
    for (const d of domains0) {
        if (domains.indexOf(d) < 0) domains.push(d)
    }

    let savedCert: SavedCert
    let needsRenew = true
    try {
        fs.chmodSync(certPath, 0o600)
        savedCert = JSON.parse(fs.readFileSync(certPath, "utf8"))
        needsRenew = false
    } catch (e) {}

    if (savedCert) {
        // if domains changed, ignore the cert
        if (JSON.stringify(domains) != JSON.stringify(savedCert.domains))
            needsRenew = true

        if (!needsRenew && savedCert.certPem) {
            await updateRenewTimeFromAriAsync(savedCert)
        }

        if (savedCert.renewTime < Date.now()) needsRenew = true
    }

    if (needsRenew) {
        try {
            winston.info("renewing cert for " + domains.join(", "))
            await renewAsync(domains, cfg, savedCert)
            savedCert = JSON.parse(fs.readFileSync(certPath, "utf8"))
            await mail
                .sendAsync({
                    to: cfg.certEmail,
                    from: null,
                    subject: "cert renewed for " + domains[0],
                    text: "All domains: " + domains.join(", "),
                })
                .then(
                    () => {},
                    () => {}
                )
        } catch (e) {
            console.error(e)
            winston.error(e.stack)
            await mail.sendAsync({
                to: cfg.certEmail,
                from: null,
                subject: "failure to renew certs",
                text: e.message + "\n" + e.stack,
            })
            if (savedCert) {
                // don't try to renew for another 24h
                savedCert.renewTime = Date.now() + 24 * 3600 * 1000
                savedCert.domains = domains
                writeSavedCert(savedCert)
            }
        }
    } else {
        winston.info("not renewing cert")
    }

    if (!savedCert) return

    https
        .createServer(
            httpsOptions(savedCert),
            app
        )
        .listen(443, function () {
            winston.info("Starting HTTPS server")
        })
}

async function renewAsync(
    domains: string[],
    cfg: gitfs.Config,
    savedCert?: SavedCert
) {
    const acme = require("acme-client")
    const directory = await getJsonAsync(letsEncryptDirectoryUrl)
    const accountKey =
        savedCert && savedCert.accountKey
            ? savedCert.accountKey
            : (await acme.crypto.createPrivateKey()).toString()
    const client = new acme.Client({
        directoryUrl: letsEncryptDirectoryUrl,
        accountKey,
        accountUrl: savedCert && savedCert.accountUrl,
    })

    await client.createAccount({
        contact: [`mailto:${cfg.certEmail}`],
        termsOfServiceAgreed: true,
    })
    const accountUrl = client.getAccountUrl()

    const [key, csr] = await acme.crypto.createCsr({
        altNames: domains,
    })
    const orderPayload: any = {
        identifiers: domains.map(value => ({ type: "dns", value })),
    }
    const profile = chooseProfile(directory)
    if (profile) orderPayload.profile = profile

    const replaces = savedCert && getAriCertId(savedCert.certPem)
    if (replaces && savedCert.accountKey) orderPayload.replaces = replaces

    let order = await createOrderWithFallbackAsync(client, orderPayload)
    const authorizations = await client.getAuthorizations(order)
    await Promise.all(
        authorizations.map((authz: any) =>
            satisfyHttpChallengeAsync(client, authz)
        )
    )

    order = await client.finalizeOrder(order, csr)
    order = await client.waitForValidStatus(order)
    const cert: string = await client.getCertificate(order)
    const certInfo = acme.crypto.readCertificateInfo(cert)
    const notBefore: number = certInfo.notBefore.getTime()
    const notAfter: number = certInfo.notAfter.getTime()
    const duration = notAfter - notBefore
    const emergencyRenewTime =
        notAfter - Math.min(emergencyRenewBeforeExpiry, duration / 3)

    const certObj: SavedCert = {
        duration: duration / 1000 / 3600 / 24,
        lastWrite: Date.now(),
        renewTime: emergencyRenewTime,
        domains,
        certPem: cert,
        keyPem: key.toString(),
        accountKey,
        accountUrl,
        ariCertId: getAriCertId(cert),
        profile: profile || undefined,
    }
    if (!(await updateRenewTimeFromAriAsync(certObj))) {
        winston.warn(
            "ACME ARI unavailable; using emergency renewal time: " +
                new Date(certObj.renewTime).toISOString()
        )
    }

    writeSavedCert(certObj)
}

async function createOrderWithFallbackAsync(client: any, payload: any) {
    const attempts = [
        Object.assign({}, payload),
        Object.assign({}, payload, { replaces: undefined }),
        Object.assign({}, payload, { profile: undefined, replaces: undefined }),
    ]
    let lastError: Error = null

    for (const attempt of attempts) {
        if (attempt.profile === undefined) delete attempt.profile
        if (attempt.replaces === undefined) delete attempt.replaces
        try {
            return await client.createOrder(attempt)
        } catch (e) {
            lastError = e
            if (!attempt.profile && !attempt.replaces) break
            winston.warn(
                "ACME order failed, retrying without optional fields: " +
                    e.message
            )
        }
    }

    throw lastError
}

async function satisfyHttpChallengeAsync(client: any, authz: any) {
    if (authz.status === "valid") return

    const challenge = authz.challenges.filter(
        (c: any) => c.type === "http-01"
    )[0]
    if (!challenge)
        throw new Error(
            "No http-01 ACME challenge for " + authz.identifier.value
        )

    const keyAuthorization = await client.getChallengeKeyAuthorization(
        challenge
    )
    const key = `acme-challenge/${challenge.token}`
    try {
        wellKnowns[key] = keyAuthorization
        winston.info(
            `Creating challenge response for ${authz.identifier.value} at path: ${challenge.token}`
        )
        await client.verifyChallenge(authz, challenge)
        await client.completeChallenge(challenge)
        await client.waitForValidStatus(challenge)
    } finally {
        delete wellKnowns[key]
    }
}

function httpsOptions(savedCert: SavedCert): https.ServerOptions {
    if (savedCert.certPem && savedCert.keyPem) {
        return {
            key: savedCert.keyPem,
            cert: savedCert.certPem,
        }
    }

    if (savedCert.cert) {
        return {
            passphrase: "",
            pfx: Buffer.from(savedCert.cert, "base64"),
        }
    }

    throw new Error("No usable saved certificate")
}

function chooseProfile(directory: any) {
    const profiles = directory && directory.meta && directory.meta.profiles
    if (profiles && profiles[preferredProfile]) {
        winston.info("Using ACME profile: " + preferredProfile)
        return preferredProfile
    }
    winston.warn("ACME profile not available, using CA default")
    return null
}

async function updateRenewTimeFromAriAsync(savedCert: SavedCert) {
    const certId = savedCert.ariCertId || getAriCertId(savedCert.certPem)
    if (!certId) return false

    try {
        const directory = await getJsonAsync(letsEncryptDirectoryUrl)
        if (!directory.renewalInfo) return false

        const renewalInfo = await getJsonAsync(
            directory.renewalInfo.replace(/\/$/, "") + "/" + certId
        )
        const window = renewalInfo && renewalInfo.suggestedWindow
        const start = Date.parse(window && window.start)
        const end = Date.parse(window && window.end)
        if (!isFinite(start) || !isFinite(end) || end <= start) return false

        if (
            savedCert.ariCertId !== certId ||
            !savedCert.ariRenewTime ||
            savedCert.ariRenewTime < start ||
            savedCert.ariRenewTime > end
        ) {
            savedCert.ariRenewTime = randomTimeBetween(start, end)
        }

        savedCert.ariCertId = certId
        savedCert.ariWindow = {
            start: window.start,
            end: window.end,
        }
        savedCert.renewTime = savedCert.ariRenewTime
        writeSavedCert(savedCert)
        winston.info(
            "ACME ARI renewal time: " +
                new Date(savedCert.renewTime).toISOString()
        )
        return true
    } catch (e) {
        winston.warn("ACME ARI check failed: " + e.message)
        return false
    }
}

function randomTimeBetween(start: number, end: number) {
    const span = end - start
    const random = crypto.randomBytes(6).readUIntBE(0, 6) / 0x1000000000000
    return Math.floor(start + span * random)
}

function getJsonAsync(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
        https
            .get(
                url,
                { headers: { Accept: "application/json" } },
                res => {
                    let body = ""
                    res.setEncoding("utf8")
                    res.on("data", chunk => (body += chunk))
                    res.on("end", () => {
                        if (res.statusCode < 200 || res.statusCode >= 300) {
                            reject(
                                new Error(
                                    `GET ${url} returned ${res.statusCode}: ${body}`
                                )
                            )
                            return
                        }
                        try {
                            resolve(JSON.parse(body))
                        } catch (e) {
                            reject(e)
                        }
                    })
                }
            )
            .on("error", reject)
    })
}

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

interface Asn1Node {
    buf: Buffer
    tag: number
    start: number
    valueStart: number
    end: number
    value: Buffer
}

function pemToDer(pem: string) {
    const match = pem.match(
        /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/
    )
    if (!match) throw new Error("No PEM certificate found")
    return Buffer.from(match[1].replace(/\s+/g, ""), "base64")
}

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

function toBase64Url(buf: Buffer) {
    return buf
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "")
}

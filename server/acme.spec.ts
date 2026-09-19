import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as http from "http"
import * as https from "https"
import { EventEmitter } from "events"
import { PassThrough } from "stream"
import { execFileSync } from "child_process"
import * as crypto from "crypto"
import * as mail from "./mail"
import * as winston from "winston"
import { CertificateManager, SavedCert, init, setupCertsAndListen } from "./acme"

jest.mock("acme-client", () => {
    const axios: any = {
        defaults: { acmeSettings: {} },
        interceptors: { response: { use: jest.fn((handler: Function) => {
            axios.responseHandler = handler
        }) } },
    }
    return {
        Client: jest.fn(),
        crypto: {
            createPrivateKey: jest.fn(),
            createCsr: jest.fn(),
            readCertificateInfo: jest.fn(),
        },
        axios,
    }
})

const acme = require("acme-client")
const hour = 3600 * 1000
const day = 24 * hour
const issuedAt = Date.UTC(2026, 8, 19)
let now: number
let directory: string
let fixtureDirectory: string
let pem: string
let key: string
let ca: any
let sendMail: jest.SpyInstance

/** Make an HTTP response without network access, including normal request close events. */
function respond(callback: Function, body: string, statusCode = 200, headers = {}) {
    const request: any = new EventEmitter()
    request.destroy = (error: Error) => {
        request.emit("error", error)
        request.emit("close")
    }
    process.nextTick(() => {
        const response: any = new PassThrough()
        response.statusCode = statusCode
        response.headers = headers
        response.on("end", () => request.emit("close"))
        callback(response)
        response.end(body)
    })
    return request
}

/** Supply valid TLS material while choosing dates independently of the test wall clock. */
function savedCertificate(domain = "foo.example.test"): SavedCert {
    return {
        domains: [domain],
        lastWrite: issuedAt,
        duration: 45,
        expiresAt: issuedAt + 45 * day,
        renewTime: issuedAt + 27 * day,
        certPem: pem,
        keyPem: key,
    }
}

/** Create an isolated manager whose install callback can be inspected without opening ports. */
function manager(extraDomains: string[] = []) {
    const install = jest.fn()
    const instance = new CertificateManager({
        jwtSecret: "unused",
        authDomain: "https://foo.example.test",
        certEmail: "admin@example.test",
        vhosts: Object.fromEntries(extraDomains.map(domain => [domain, ""])),
    }, install, path.join(directory, "certificates.json"))
    return { instance, install }
}

beforeAll(() => {
    fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "gitwed-cert-fixture-"))
    execFileSync("openssl", [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", path.join(fixtureDirectory, "key.pem"),
        "-out", path.join(fixtureDirectory, "cert.pem"),
        "-days", "90", "-subj", "/CN=foo.example.test",
        "-addext", "subjectAltName=DNS:foo.example.test,DNS:www.foo.example.test",
    ], { stdio: "ignore" })
    pem = fs.readFileSync(path.join(fixtureDirectory, "cert.pem"), "utf8")
    key = fs.readFileSync(path.join(fixtureDirectory, "key.pem"), "utf8")
})

afterAll(() => fs.rmSync(fixtureDirectory, { recursive: true, force: true }))

beforeEach(() => {
    jest.clearAllMocks()
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "gitwed-cert-test-"))
    now = issuedAt
    jest.spyOn(Date, "now").mockImplementation(() => now)
    jest.spyOn(winston, "info").mockImplementation()
    jest.spyOn(winston, "warn").mockImplementation()
    jest.spyOn(winston, "error").mockImplementation()
    sendMail = jest.spyOn(mail, "sendAsync").mockResolvedValue(undefined)
    ca = {
        createAccount: jest.fn().mockResolvedValue({}),
        getAccountUrl: jest.fn().mockReturnValue("https://ca.test/account/1"),
        createOrder: jest.fn().mockResolvedValue({ status: "pending" }),
        getAuthorizations: jest.fn().mockResolvedValue([]),
        finalizeOrder: jest.fn().mockResolvedValue({ status: "processing" }),
        waitForValidStatus: jest.fn().mockResolvedValue({ status: "valid" }),
        getCertificate: jest.fn().mockResolvedValue(pem),
    }
    acme.Client.mockImplementation(() => ca)
    acme.crypto.createPrivateKey.mockResolvedValue(Buffer.from("account-key"))
    acme.crypto.createCsr.mockResolvedValue([Buffer.from(key), Buffer.from("csr")])
    acme.crypto.readCertificateInfo.mockReturnValue({
        notBefore: new Date(issuedAt),
        notAfter: new Date(issuedAt + 45 * day),
    })
    jest.spyOn(http, "get").mockImplementation(((url: string, options: any, callback: Function) => {
        const token = url.split("gitwed-probe-")[1]
        return respond(callback, token)
    }) as any)
    jest.spyOn(https, "get").mockImplementation(((url: string, options: any, callback: Function) => {
        return respond(callback, JSON.stringify({ meta: { profiles: { tlsserver: "available" } } }))
    }) as any)
})

afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
    fs.rmSync(directory, { recursive: true, force: true })
})

it("issues www and bare names separately using one persisted account and no success mail", async () => {
    const { instance, install } = manager(["www.foo.example.test", "foo.example.test"])
    await instance.checkAsync()
    expect(ca.createOrder.mock.calls.map((call: any[]) => call[0])).toEqual([
        { identifiers: [{ type: "dns", value: "foo.example.test" }], profile: "tlsserver" },
        { identifiers: [{ type: "dns", value: "www.foo.example.test" }], profile: "tlsserver" },
    ])
    expect(ca.createAccount).toHaveBeenCalledTimes(1)
    expect(install).toHaveBeenCalledTimes(2)
    expect(sendMail).not.toHaveBeenCalled()
    const restored = manager().instance
    expect(restored.state.account).toEqual({ key: "account-key", url: "https://ca.test/account/1" })
    const cert = restored.state.domains["foo.example.test"].certificate
    expect(cert.renewTime).toBeGreaterThanOrEqual(issuedAt + 45 * day * 0.57)
    expect(cert.renewTime).toBeLessThan(issuedAt + 45 * day * 0.63)
    expect(cert.renewTime).toBe(instance.state.domains["foo.example.test"].certificate.renewTime)
    expect(fs.statSync(path.join(directory, "certificates.json")).mode & 0o777).toBe(0o600)
})

it("keeps probing missing DNS, limits mail across restarts, and issues automatically when DNS arrives", async () => {
    let { instance } = manager()
    const get = http.get as jest.Mock
    get.mockImplementation((url: string, options: any, callback: Function) => respond(callback, "not here", 404))
    await instance.checkAsync()
    expect(ca.createOrder).not.toHaveBeenCalled()
    expect(sendMail).toHaveBeenCalledTimes(1)
    expect(instance.state.domains["foo.example.test"].nextAttemptAt).toBe(now + hour / 2)
    now += hour / 2
    instance = manager().instance
    await instance.checkAsync()
    expect(sendMail).toHaveBeenCalledTimes(1)
    now = issuedAt + day
    await instance.checkAsync()
    expect(sendMail).toHaveBeenCalledTimes(2)
    now += hour / 2
    get.mockImplementation((url: string, options: any, callback: Function) => respond(callback, url.split("gitwed-probe-")[1]))
    await instance.checkAsync()
    expect(ca.createOrder).toHaveBeenCalledTimes(1)
    expect(instance.state.domains["foo.example.test"].certificate).toBeDefined()
    expect(sendMail).toHaveBeenCalledTimes(2)
})

it("backs off 2, 4, 8, 16, 32, 48 hours and preserves that delay across restarts", async () => {
    ca.createOrder.mockRejectedValue(new Error("CA unavailable"))
    for (const hours of [2, 4, 8, 16, 32, 48, 48]) {
        const instance = manager().instance
        await instance.checkAsync()
        const next = instance.state.domains["foo.example.test"].nextAttemptAt
        expect(next).toBe(now + hours * hour)
        const calls = ca.createOrder.mock.calls.length
        now = next - 1
        await manager().instance.checkAsync()
        expect(ca.createOrder).toHaveBeenCalledTimes(calls)
        now = next
    }
})

it("keeps an ARI refresh from bypassing the retry delay", async () => {
    const { instance } = manager()
    const entry = instance.state.domains["foo.example.test"]
    entry.certificate = { ...savedCertificate(), renewTime: now - 1 }
    entry.nextAttemptAt = now + 2 * hour
    jest.spyOn(instance, "refreshAriAsync").mockImplementation(async cert => {
        cert.renewTime = now - 1
    })
    const probe = jest.spyOn(instance, "probeAsync")
    await instance.checkAsync()
    expect(instance.refreshAriAsync).toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
    expect(entry.nextAttemptAt).toBe(now + 2 * hour)
})

it("lets other hostnames succeed even when both issuance and its failure email fail", async () => {
    const { instance, install } = manager(["www.foo.example.test"])
    ca.createOrder.mockRejectedValueOnce(new Error("first domain failed"))
    sendMail.mockRejectedValue(new Error("mail unavailable"))
    await instance.checkAsync()
    expect(install).toHaveBeenCalledTimes(1)
    expect(install.mock.calls[0][0]).toBe("www.foo.example.test")
    expect(instance.state.domains["foo.example.test"].nextAttemptAt).toBe(now + 2 * hour)
    now += 2 * hour
    ca.createOrder.mockRejectedValueOnce(new Error("different failure"))
    await manager(["www.foo.example.test"]).instance.checkAsync()
    expect(sendMail).toHaveBeenCalledTimes(1)
})

it("honors a longer Retry-After and pauses the shared account on rate limits", async () => {
    const { instance } = manager(["www.foo.example.test"])
    ca.createOrder.mockRejectedValue(Object.assign(new Error("rate limited"), {
        response: { status: 429, headers: { "retry-after": "259200" } },
    }))
    await instance.checkAsync()
    expect(ca.createOrder).toHaveBeenCalledTimes(1)
    expect(instance.state.account.nextAttemptAt).toBe(now + 3 * day)
    now += 2 * day
    await manager(["www.foo.example.test"]).instance.checkAsync()
    expect(ca.createOrder).toHaveBeenCalledTimes(1)
    const deadline = new Date(now + 4 * day).toUTCString()
    const response = { status: 503, headers: { "retry-after": deadline }, data: { detail: "maintenance" } }
    expect(() => acme.axios.responseHandler(response)).toThrow("maintenance")
    ca.createOrder.mockRejectedValue(Object.assign(new Error("maintenance"), { response }))
    now = instance.state.account.nextAttemptAt
    await instance.checkAsync()
    expect(instance.state.account.nextAttemptAt).toBe(Date.parse(deadline))
})

it("saves a generated account key before registration fails and reuses it on retry", async () => {
    ca.createAccount.mockImplementationOnce(async () => {
        const state = JSON.parse(fs.readFileSync(path.join(directory, "certificates.json"), "utf8"))
        expect(state.account.key).toBe("account-key")
        throw new Error("registration unavailable")
    })
    await manager().instance.checkAsync()
    now += 2 * hour
    await manager().instance.checkAsync()
    expect(acme.crypto.createPrivateKey).toHaveBeenCalledTimes(1)
    expect(ca.createAccount).toHaveBeenCalledTimes(2)
    expect(ca.createOrder).toHaveBeenCalledTimes(1)
})

it("imports the shared certificate and account without claiming it replaces every singleton", async () => {
    const legacy = {
        ...savedCertificate(),
        domains: ["foo.example.test", "www.foo.example.test", "missing.example.test"],
        accountKey: "existing-key",
        accountUrl: "https://ca.test/existing-account",
    }
    const legacyPath = path.join(directory, "certificate.json")
    fs.writeFileSync(legacyPath, JSON.stringify(legacy))
    const { instance } = manager(["www.foo.example.test", "missing.example.test"])
    expect(instance.state.legacyCertificate.domains).toEqual(["foo.example.test", "www.foo.example.test"])
    expect(instance.state.legacyCertificate.accountKey).toBeUndefined()
    expect(instance.state.legacyCertificate.expiresAt).toBe(
        Date.parse(new crypto.X509Certificate(pem).validTo)
    )
    expect(instance.state.account.key).toBe("existing-key")
    await instance.checkAsync()
    expect(acme.Client).toHaveBeenCalledWith(expect.objectContaining({ accountKey: "existing-key", accountUrl: "https://ca.test/existing-account" }))
    expect(ca.createAccount).not.toHaveBeenCalled()
    for (const call of ca.createOrder.mock.calls) expect(call[0].replaces).toBeUndefined()
    expect(JSON.parse(fs.readFileSync(legacyPath, "utf8"))).toEqual(legacy)
})

it("uses each singleton's own ARI predecessor when renewing", async () => {
    const { instance } = manager()
    const cert = { ...savedCertificate(), renewTime: now - 1, ariCertId: "authority.serial", ariCheckTime: now + hour }
    instance.state.domains["foo.example.test"].certificate = cert
    await instance.checkAsync()
    expect(ca.createOrder).toHaveBeenCalledWith(expect.objectContaining({ replaces: "authority.serial" }))
})

it("keeps serving the previous certificate when renewal fails", async () => {
    const { instance, install } = manager()
    const cert = { ...savedCertificate(), renewTime: now - 1, ariCheckTime: now + hour }
    instance.state.domains["foo.example.test"].certificate = cert
    ca.createOrder.mockRejectedValue(new Error("renewal failed"))
    await instance.checkAsync()
    expect(instance.state.domains["foo.example.test"].certificate).toBe(cert)
    expect(manager().instance.state.domains["foo.example.test"].certificate).toEqual(cert)
    expect(install).not.toHaveBeenCalled()
})

it("prevents overlapping scans and persists an in-flight attempt before calling the CA", async () => {
    const { instance } = manager()
    let finish: (order: any) => void
    ca.createOrder.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const scan = instance.checkAsync()
    while (!finish) await new Promise<void>(resolve => setImmediate(resolve))
    await instance.checkAsync()
    await manager().instance.checkAsync()
    expect(ca.createOrder).toHaveBeenCalledTimes(1)
    const state = JSON.parse(fs.readFileSync(path.join(directory, "certificates.json"), "utf8"))
    expect(state.domains["foo.example.test"].nextAttemptAt).toBe(now + 2 * hour)
    finish({ status: "ready" })
    await scan
})

it("prefers a stable random ARI time and preserves it through an ARI outage", async () => {
    const { instance } = manager()
    const cert = { ...savedCertificate(), ariCertId: "authority.serial" }
    const start = now + 29 * day
    const end = now + 30 * day
    ;(https.get as jest.Mock).mockImplementation((url: string, options: any, callback: Function) => {
        const data = url.endsWith("/directory")
            ? { renewalInfo: "https://ca.test/renewal-info" }
            : { suggestedWindow: { start: new Date(start).toISOString(), end: new Date(end).toISOString() } }
        return respond(callback, JSON.stringify(data))
    })
    await instance.refreshAriAsync(cert)
    expect(cert.renewTime).toBeGreaterThanOrEqual(start)
    expect(cert.renewTime).toBeLessThan(end)
    const chosen = cert.renewTime
    await instance.refreshAriAsync(cert)
    expect(cert.renewTime).toBe(chosen)
    ;(https.get as jest.Mock).mockImplementation((url: string, options: any, callback: Function) => respond(callback, "unavailable", 503))
    await instance.refreshAriAsync(cert)
    expect(cert.renewTime).toBe(chosen)
})

it("serves and removes the exact random HTTP probe token", async () => {
    let handler: Function
    init({ get: (pattern: RegExp, route: Function) => { handler = route } } as any)
    let probePath: string
    ;(http.get as jest.Mock).mockImplementation((url: string, options: any, callback: Function) => {
        probePath = new URL(url).pathname.replace("/.well-known/", "")
        let body: string
        handler({ params: [probePath] }, { setHeader: jest.fn(), contentType: jest.fn(), send: (value: string) => { body = value } })
        return respond(callback, body)
    })
    await manager().instance.probeAsync("foo.example.test")
    const response = { status: jest.fn().mockReturnThis(), end: jest.fn() }
    handler({ params: [probePath] }, response)
    expect(response.status).toHaveBeenCalledWith(404)
})

it("times out a hung probe instead of blocking other certificates indefinitely", async () => {
    jest.useFakeTimers()
    const request: any = new EventEmitter()
    request.destroy = jest.fn((error: Error) => {
        request.emit("error", error)
        request.emit("close")
    })
    ;(http.get as jest.Mock).mockReturnValue(request)
    const pending = expect(manager().instance.probeAsync("foo.example.test")).rejects.toThrow("timed out")
    await jest.advanceTimersByTimeAsync(10000)
    await pending
})

it("refuses corrupt saved state instead of creating a new account", () => {
    fs.writeFileSync(path.join(directory, "certificates.json"), "broken json")
    expect(() => manager()).toThrow()
    expect(acme.crypto.createPrivateKey).not.toHaveBeenCalled()
})

it("keeps staging accounts and certificates separate from production state", async () => {
    fs.writeFileSync(path.join(directory, "certificate.json"), JSON.stringify({ ...savedCertificate(), accountKey: "production-key" }))
    const staging = new CertificateManager({ jwtSecret: "unused", authDomain: "https://foo.example.test", certStaging: true }, jest.fn(), path.join(directory, "certificates-staging.json"))
    expect(staging.state.account.key).toBeUndefined()
    expect(staging.state.legacyCertificate).toBeUndefined()
    await staging.checkAsync()
    expect(acme.Client).toHaveBeenCalledWith(expect.objectContaining({ directoryUrl: "https://acme-staging-v02.api.letsencrypt.org/directory" }))
})

it("keeps pending hosts on the legacy SNI certificate when the default certificate changes", async () => {
    const originalDirectory = process.cwd()
    const server: any = new EventEmitter()
    server.addContext = jest.fn()
    server.setSecureContext = jest.fn()
    server.listen = jest.fn().mockReturnValue(server)
    let start: Function
    const challengeServer: any = { listen: jest.fn((port: number, ready: Function) => { start = ready }) }
    jest.spyOn(https, "createServer").mockReturnValue(server)
    jest.spyOn(http, "createServer").mockReturnValue(challengeServer)
    const check = jest.spyOn(CertificateManager.prototype, "checkAsync").mockImplementation(async function(this: CertificateManager) {
        ;(this as any).install("foo.example.test", { ...savedCertificate(), keyPem: "new-key", certPem: "new-cert" })
    })
    try {
        process.chdir(directory)
        fs.writeFileSync("certificate.json", JSON.stringify({ ...savedCertificate(), domains: ["foo.example.test", "www.foo.example.test"] }))
        await setupCertsAndListen({} as any, { jwtSecret: "unused", authDomain: "https://foo.example.test", vhosts: { "www.foo.example.test": "" } })
        expect(check).not.toHaveBeenCalled()
        expect(server.addContext).toHaveBeenCalledWith("www.foo.example.test", { cert: pem, key })
        start()
        expect(server.setSecureContext).toHaveBeenCalledWith({ key: "new-key", cert: "new-cert" })
        expect(server.addContext.mock.calls.filter((call: any[]) => call[0] === "www.foo.example.test")).toHaveLength(1)
    } finally {
        server.emit("close")
        process.chdir(originalDirectory)
    }
})

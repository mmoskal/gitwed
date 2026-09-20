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

/** Read a challenge through the registered HTTP route without opening a listener. */
function challengeResponse(token: string, register = init) {
    let handler: Function
    register({ get: (pattern: RegExp, route: Function) => { handler = route } } as any)
    const response = {
        status: jest.fn().mockReturnThis(), end: jest.fn(),
        setHeader: jest.fn(), contentType: jest.fn(), send: jest.fn(),
    }
    handler({ params: ["acme-challenge/" + token] }, response)
    return response
}

/** Serve separate directory and ARI responses so tests can exercise real header parsing. */
function serveAri(body: any, retryAfter?: string, statusCode = 200) {
    ;(https.get as jest.Mock).mockImplementation((url: string, options: any, callback: Function) => {
        if (url.endsWith("/directory"))
            return respond(callback, JSON.stringify({ renewalInfo: "https://ca.test/renewal-info" }))
        return respond(callback, typeof body === "string" ? body : JSON.stringify(body),
            statusCode, retryAfter === undefined ? {} : { "retry-after": retryAfter })
    })
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
        createOrder: jest.fn().mockResolvedValue({ status: "ready", url: "https://ca.test/order/1" }),
        getOrder: jest.fn().mockResolvedValue({ status: "valid", url: "https://ca.test/order/1" }),
        getAuthorizations: jest.fn().mockResolvedValue([]),
        finalizeOrder: jest.fn().mockResolvedValue({ status: "processing", url: "https://ca.test/order/1" }),
        waitForValidStatus: jest.fn().mockResolvedValue({ status: "valid" }),
        api: { apiRequest: jest.fn().mockResolvedValue({ data: { status: "valid" } }) },
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
        return respond(callback, JSON.stringify({
            renewalInfo: "https://ca.test/renewal-info",
            meta: { profiles: { tlsserver: "available" } },
        }))
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

it("keeps issuing and scanning while notification delivery stalls, and handles a late rejection", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] })
    jest.setSystemTime(now)
    let rejectMail: (error: Error) => void
    sendMail.mockImplementationOnce(() => new Promise<void>((resolve, reject) => { rejectMail = reject }))
    ca.createOrder.mockRejectedValueOnce(new Error("first hostname failed"))
    const { instance, install } = manager(["www.foo.example.test"])
    await instance.checkAsync()
    expect(rejectMail).toBeDefined()
    expect(install).toHaveBeenCalledTimes(1)
    expect(install.mock.calls[0][0]).toBe("www.foo.example.test")
    expect(manager().instance.state.domains["foo.example.test"].lastFailureEmailAt).toBe(now)
    await jest.advanceTimersByTimeAsync(30000)
    expect(winston.warn).toHaveBeenCalledWith(expect.stringContaining("Email delivery timed out"))
    jest.setSystemTime(instance.state.domains["foo.example.test"].nextAttemptAt)
    await instance.checkAsync()
    expect(install).toHaveBeenCalledTimes(2)
    expect(sendMail).toHaveBeenCalledTimes(1)
    rejectMail(new Error("late provider failure"))
    await jest.advanceTimersByTimeAsync(0)
    expect(winston.warn).not.toHaveBeenCalledWith(expect.stringContaining("late provider failure"))
})

it("retains the notification cooldown across restarts when a provider never responds", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] })
    jest.setSystemTime(now)
    sendMail.mockImplementation(() => new Promise(() => {}))
    ca.createOrder.mockRejectedValue(new Error("CA unavailable"))
    await manager().instance.checkAsync()
    await jest.advanceTimersByTimeAsync(2 * hour)
    await manager().instance.checkAsync()
    expect(ca.createOrder).toHaveBeenCalledTimes(2)
    expect(sendMail).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(22 * hour)
    await manager().instance.checkAsync()
    expect(sendMail).toHaveBeenCalledTimes(2)
    await jest.advanceTimersByTimeAsync(30000)
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

it.each([
    ["hostname", 429], ["hostname", 503], ["CA", 429], ["CA", 503],
])("scopes a %s HTTP %s failure correctly when using the real challenge verifier", async (source, status) => {
    const library = jest.requireActual("acme-client")
    const client = new library.Client({ directoryUrl: "https://ca.test/directory", accountKey: key,
        accountUrl: "https://ca.test/account/1", backoffAttempts: 1 })
    Object.assign(client, ca)
    acme.Client.mockReturnValue(client)
    const challenge = { type: "http-01", status: "pending", token: "scope-test-token", url: "https://ca.test/challenge/1" }
    const authz = { status: "pending", url: "https://ca.test/authz/1",
        identifier: { value: "foo.example.test" }, challenges: [challenge] }
    ca.createOrder.mockResolvedValueOnce({ status: "pending", url: "https://ca.test/order/1" })
    ca.getAuthorizations.mockResolvedValue([authz])
    jest.spyOn(client, "getChallengeKeyAuthorization").mockResolvedValue("scope-authorization")
    const response = { status, headers: { "retry-after": "259200" }, data: { detail: "temporarily unavailable" } }
    const hostRequest = jest.spyOn(library.axios, "get").mockImplementation(async () =>
        source === "hostname" ? acme.axios.responseHandler(response) : { status: 200, data: "scope-authorization" })
    const complete = jest.spyOn(client, "completeChallenge").mockImplementation(async () =>
        acme.axios.responseHandler(response))
    const { instance, install } = manager(["www.foo.example.test"])
    await instance.checkAsync()
    expect(hostRequest).toHaveBeenCalledTimes(1)
    expect(hostRequest).toHaveBeenCalledWith(
        "http://foo.example.test:80/.well-known/acme-challenge/scope-test-token", expect.anything())
    expect(instance.state.domains["foo.example.test"].nextAttemptAt).toBe(now + 3 * day)
    const restored = manager(["www.foo.example.test", "other.example.test"])
    if (source === "hostname") {
        expect(complete).not.toHaveBeenCalled()
        expect(install).toHaveBeenCalledWith("www.foo.example.test", expect.anything())
        expect(restored.instance.state.account.nextAttemptAt).toBeUndefined()
        await restored.instance.checkAsync()
        expect(restored.install).toHaveBeenCalledWith("other.example.test", expect.anything())
        expect(hostRequest).toHaveBeenCalledTimes(1)
    } else {
        expect(complete).toHaveBeenCalledTimes(1)
        expect(install).not.toHaveBeenCalled()
        expect(restored.instance.state.account.nextAttemptAt).toBe(now + 3 * day)
        await restored.instance.checkAsync()
        expect(ca.createOrder).toHaveBeenCalledTimes(1)
    }
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

it.each(["download", "finalize-processing", "finalize-ready"])(
    "resumes an accepted order with its saved key after a %s failure and restart", async failure => {
        const { instance } = manager()
        instance.state.domains["foo.example.test"].certificate = {
            ...savedCertificate(), renewTime: now - 1, ariCertId: "authority.serial",
        }
        const finalize = ca.finalizeOrder.getMockImplementation()
        ca.finalizeOrder.mockImplementationOnce(async (...args: any[]) => {
            const state = JSON.parse(fs.readFileSync(path.join(directory, "certificates.json"), "utf8"))
            expect(state.domains["foo.example.test"].pendingOrder).toEqual({
                order: { status: "ready", url: "https://ca.test/order/1" },
                keyPem: key, csrPem: "csr", profile: "tlsserver",
            })
            if (failure.startsWith("finalize")) throw new Error("finalize response lost")
            return finalize(...args)
        })
        if (failure === "download") ca.getCertificate.mockRejectedValueOnce(new Error("download failed"))
        await instance.checkAsync()
        expect(instance.state.domains["foo.example.test"].pendingOrder).toBeDefined()
        now += 2 * hour
        const restored = manager()
        // An ARI update must not defer finishing an already accepted replacement.
        restored.instance.state.domains["foo.example.test"].certificate.renewTime = now + day
        ca.getOrder.mockResolvedValue({
            status: failure === "finalize-ready" ? "ready" :
                failure === "finalize-processing" ? "processing" : "valid",
            url: "https://ca.test/order/1",
        })
        await restored.instance.checkAsync()
        expect(ca.createOrder).toHaveBeenCalledTimes(1)
        expect(acme.crypto.createCsr).toHaveBeenCalledTimes(1)
        expect(ca.getOrder).toHaveBeenCalledWith(expect.objectContaining({ url: "https://ca.test/order/1" }))
        expect(ca.finalizeOrder).toHaveBeenCalledTimes(failure === "finalize-ready" ? 2 : 1)
        for (const call of ca.finalizeOrder.mock.calls)
            expect(call[1]).toEqual(Buffer.from("csr"))
        expect(restored.install).toHaveBeenCalledWith("foo.example.test", expect.objectContaining({ keyPem: key }))
        expect(manager().instance.state.domains["foo.example.test"].pendingOrder).toBeUndefined()
    }
)

it.each(["ready", "processing", "valid"])("resumes a %s saved order after port 80 becomes unavailable", async status => {
    const { instance } = manager()
    instance.state.domains["foo.example.test"].certificate = {
        ...savedCertificate(), renewTime: now - 1, ariCertId: "authority.serial",
    }
    ca.getCertificate.mockRejectedValueOnce(new Error("download failed"))
    await instance.checkAsync()
    expect(instance.state.domains["foo.example.test"].pendingOrder).toBeDefined()
    now += 2 * hour
    ;(http.get as jest.Mock).mockImplementation((url: string, options: any, callback: Function) =>
        respond(callback, "port 80 unavailable", 503))
    const restored = manager()
    const probe = jest.spyOn(restored.instance, "probeAsync")
    ca.getOrder.mockResolvedValueOnce({ status, url: "https://ca.test/order/1" })
    await restored.instance.checkAsync()
    expect(probe).not.toHaveBeenCalled()
    expect(ca.getOrder).toHaveBeenCalledTimes(1)
    expect(ca.getCertificate).toHaveBeenCalledTimes(2)
    expect(ca.createOrder).toHaveBeenCalledTimes(1)
    expect(restored.install).toHaveBeenCalledWith("foo.example.test", expect.objectContaining({ keyPem: key }))
    expect(restored.instance.state.domains["foo.example.test"].pendingOrder).toBeUndefined()
})

it("still verifies HTTP before submitting a pending challenge on a recovered order", async () => {
    const { instance } = manager()
    const challenge = { type: "http-01", status: "pending", token: "pending-recovery-token", url: "https://ca.test/challenge/1" }
    ca.createOrder.mockResolvedValue({ status: "pending", url: "https://ca.test/order/1" })
    ca.getAuthorizations.mockRejectedValueOnce(new Error("authorization request unavailable"))
    await instance.checkAsync()
    now += 2 * hour
    ca.getOrder.mockResolvedValueOnce({ status: "pending", url: "https://ca.test/order/1" })
    ca.getAuthorizations.mockResolvedValue([{ status: "pending", identifier: { value: "foo.example.test" }, challenges: [challenge] }])
    ca.getChallengeKeyAuthorization = jest.fn().mockResolvedValue("recovery-authorization")
    ca.verifyChallenge = jest.fn().mockRejectedValue(new Error("hostname unavailable"))
    ca.completeChallenge = jest.fn()
    const restored = manager()
    const probe = jest.spyOn(restored.instance, "probeAsync")
    await restored.instance.checkAsync()
    expect(probe).not.toHaveBeenCalled()
    expect(ca.getOrder).toHaveBeenCalledTimes(1)
    expect(ca.verifyChallenge).toHaveBeenCalledTimes(1)
    expect(ca.completeChallenge).not.toHaveBeenCalled()
    expect(restored.install).not.toHaveBeenCalled()
    expect(restored.instance.state.account.nextAttemptAt).toBeUndefined()
    expect(challengeResponse(challenge.token).send).toHaveBeenCalledWith("recovery-authorization")
})

it("recovers alreadyReplaced without dropping the profile, and remembers the rejection across restarts", async () => {
    const { instance } = manager()
    instance.state.domains["foo.example.test"].certificate = {
        ...savedCertificate(), renewTime: now - 1, ariCertId: "authority.serial",
    }
    ca.createOrder.mockRejectedValueOnce(new Error("newOrder response lost"))
    await instance.checkAsync()
    now += 2 * hour
    const response = {
        status: 409, headers: {},
        data: { type: "urn:ietf:params:acme:error:alreadyReplaced", detail: "already replaced" },
    }
    ca.createOrder.mockImplementationOnce(async () => acme.axios.responseHandler(response))
    ca.createOrder.mockRejectedValueOnce(new Error("newOrder unavailable"))
    await manager().instance.checkAsync()
    now += 4 * hour
    const restored = manager()
    await restored.instance.checkAsync()
    expect(ca.createOrder.mock.calls.map((call: any[]) => call[0].replaces)).toEqual([
        "authority.serial", "authority.serial", undefined, undefined,
    ])
    for (const call of ca.createOrder.mock.calls) expect(call[0].profile).toBe("tlsserver")
    expect(restored.install).toHaveBeenCalledTimes(1)
    expect(manager().instance.state.domains["foo.example.test"].rejectedReplaces).toBeUndefined()
})

it.each(["invalid", "expired", "missing"])("abandons an %s saved order before a later fresh attempt", async status => {
    const { instance } = manager()
    ca.getCertificate.mockRejectedValueOnce(new Error("download failed"))
    await instance.checkAsync()
    now += 2 * hour
    if (status === "missing") {
        ca.getOrder.mockRejectedValueOnce(Object.assign(new Error("order gone"), { response: { status: 404 } }))
    } else {
        ca.getOrder.mockResolvedValueOnce({ status: status === "invalid" ? "invalid" : "pending", expires: new Date(now - 1).toISOString() })
    }
    const restored = manager().instance
    await restored.checkAsync()
    expect(restored.state.domains["foo.example.test"].pendingOrder).toBeUndefined()
    expect(ca.createOrder).toHaveBeenCalledTimes(1)
    now += 4 * hour
    await manager().instance.checkAsync()
    expect(ca.createOrder).toHaveBeenCalledTimes(2)
})

it("does not retry other CA problems without ARI or the selected profile", async () => {
    const { instance } = manager()
    instance.state.domains["foo.example.test"].certificate = {
        ...savedCertificate(), renewTime: now - 1, ariCertId: "authority.serial",
    }
    ca.createOrder.mockRejectedValue(Object.assign(new Error("bad CSR"), {
        response: { status: 400, data: { type: "urn:ietf:params:acme:error:badCSR" } },
    }))
    await instance.checkAsync()
    expect(ca.createOrder).toHaveBeenCalledTimes(1)
    expect(instance.state.domains["foo.example.test"].rejectedReplaces).toBeUndefined()
})

it.each([
    ["order", 429], ["order", 503], ["challenge", 429], ["challenge", 503],
])("stops real ACME %s polling on HTTP %s and persists Retry-After", async (phase, status) => {
    const library = jest.requireActual("acme-client")
    const client = new library.Client({ directoryUrl: "https://ca.test/directory", accountKey: key,
        accountUrl: "https://ca.test/account/1",
        backoffAttempts: 3, backoffMin: 1, backoffMax: 1 })
    // Keep the real status/API implementation; replace only transport and unrelated operations.
    const { api, waitForValidStatus, ...operations } = ca
    Object.assign(client, operations)
    acme.Client.mockReturnValue(client)
    if (phase === "challenge") {
        const challenge = { type: "http-01", token: "challenge-token", url: "https://ca.test/challenge/1" }
        ca.createOrder.mockResolvedValue({ status: "pending", url: "https://ca.test/order/1" })
        ca.getAuthorizations.mockResolvedValue([{ status: "pending", identifier: { value: "foo.example.test" }, challenges: [challenge] }])
        jest.spyOn(client, "getChallengeKeyAuthorization").mockResolvedValue("key-authorization")
        jest.spyOn(client, "verifyChallenge").mockResolvedValue(undefined)
        jest.spyOn(client, "completeChallenge").mockResolvedValue({})
    }
    const libraryPoll = jest.spyOn(client, "waitForValidStatus")
    const request = jest.spyOn(client.http, "signedRequest").mockImplementation(async () =>
        acme.axios.responseHandler({ status, headers: { "retry-after": "259200" },
            data: { detail: "CA cooling down" } }))
    const { instance } = manager(["www.foo.example.test"])
    await instance.checkAsync()
    expect(request).toHaveBeenCalledTimes(1)
    expect(libraryPoll).not.toHaveBeenCalled()
    expect(ca.getCertificate).not.toHaveBeenCalled()
    expect(ca.createOrder).toHaveBeenCalledTimes(1)
    expect(manager().instance.state.account.nextAttemptAt).toBe(now + 3 * day)
    now += day
    await manager().instance.checkAsync()
    expect(request).toHaveBeenCalledTimes(1)
})

it("polls pending challenges and processing orders through the real ACME API", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] })
    const library = jest.requireActual("acme-client")
    const client = new library.Client({ directoryUrl: "https://ca.test/directory", accountKey: key,
        accountUrl: "https://ca.test/account/1" })
    const { api, waitForValidStatus, ...operations } = ca
    Object.assign(client, operations)
    acme.Client.mockReturnValue(client)
    const challenge = { type: "http-01", token: "challenge-token", url: "https://ca.test/challenge/1" }
    ca.createOrder.mockResolvedValue({ status: "pending", url: "https://ca.test/order/1" })
    ca.getAuthorizations.mockResolvedValue([{ status: "pending", identifier: { value: "foo.example.test" }, challenges: [challenge] }])
    jest.spyOn(client, "getChallengeKeyAuthorization").mockResolvedValue("key-authorization")
    jest.spyOn(client, "verifyChallenge").mockResolvedValue(undefined)
    jest.spyOn(client, "completeChallenge").mockResolvedValue({})
    const statuses = ["pending", "valid", "ready", "processing", "valid"]
    const request = jest.spyOn(client.http, "signedRequest").mockImplementation(async () =>
        ({ status: 200, data: { status: statuses.shift() }, headers: {} }))
    const libraryPoll = jest.spyOn(client, "waitForValidStatus")
    const { instance, install } = manager()
    const scan = instance.checkAsync()
    for (let tick = 0; tick < 50 && !request.mock.calls.length; ++tick)
        await new Promise<void>(resolve => setImmediate(resolve))
    expect(request).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(10000)
    await scan
    expect(request.mock.calls.map(call => call[0])).toEqual([
        challenge.url, challenge.url, "https://ca.test/order/1", "https://ca.test/order/1", "https://ca.test/order/1",
    ])
    expect(libraryPoll).not.toHaveBeenCalled()
    expect(install).toHaveBeenCalledTimes(1)
})

it.each(["polling", "submission"])("keeps challenges available after a %s failure and resumes validation", async failure => {
    const challenge = { type: "http-01", status: "pending", token: "durable-test-token", url: "https://ca.test/challenge/1" }
    const authz = { status: "pending", identifier: { value: "foo.example.test" }, challenges: [challenge] }
    const pendingOrder = { status: "pending", url: "https://ca.test/order/1", expires: new Date(now + day).toISOString() }
    ca.createOrder.mockResolvedValue(pendingOrder)
    ca.getOrder.mockResolvedValue(pendingOrder)
    ca.getAuthorizations.mockResolvedValue([authz])
    ca.getChallengeKeyAuthorization = jest.fn().mockResolvedValue("durable-authorization")
    ca.verifyChallenge = jest.fn().mockResolvedValue(undefined)
    ca.completeChallenge = jest.fn().mockImplementation(async () => {
        const saved = JSON.parse(fs.readFileSync(path.join(directory, "certificates.json"), "utf8"))
        expect(saved.domains["foo.example.test"].pendingOrder.httpChallenges).toEqual({
            "acme-challenge/durable-test-token": "durable-authorization",
        })
        if (failure === "submission") throw new Error("submission response lost")
        return { status: "processing" }
    })
    if (failure === "polling") ca.api.apiRequest.mockRejectedValueOnce(Object.assign(new Error("poll unavailable"), {
        response: { status: 503, headers: { "retry-after": "60" } },
    }))
    const { instance, install } = manager()
    await instance.checkAsync()
    expect(challengeResponse(challenge.token).send).toHaveBeenCalledWith("durable-authorization")
    expect(install).not.toHaveBeenCalled()
    // Simulate a fresh process: its route starts empty, then the constructor restores the token.
    jest.isolateModules(() => {
        const fresh = require("./acme")
        expect(challengeResponse(challenge.token, fresh.init).status).toHaveBeenCalledWith(404)
        const restored = new fresh.CertificateManager({ jwtSecret: "unused", authDomain: "https://foo.example.test" }, jest.fn(), path.join(directory, "certificates.json"))
        expect(restored.state.domains["foo.example.test"].nextAttemptAt).toBeGreaterThan(now)
        expect(challengeResponse(challenge.token, fresh.init).send).toHaveBeenCalledWith("durable-authorization")
    })
    now += 2 * hour
    challenge.status = "processing"
    ca.api.apiRequest.mockResolvedValueOnce({ data: { status: "valid" } })
        .mockResolvedValueOnce({ data: { status: "ready" } })
    await instance.checkAsync()
    expect(ca.completeChallenge).toHaveBeenCalledTimes(1)
    expect(ca.verifyChallenge).toHaveBeenCalledTimes(1)
    expect(install).toHaveBeenCalledTimes(1)
    expect(challengeResponse(challenge.token).status).toHaveBeenCalledWith(404)
    expect(manager().instance.state.domains["foo.example.test"].pendingOrder).toBeUndefined()
})

it.each(["invalid", "expired", "missing", "ready", "processing", "valid", "invalid-challenge", "valid-authorization"])(
    "removes saved challenge responses when resuming an order with %s validation", async status => {
        const token = "cleanup-" + status
        const { instance } = manager()
        const entry = instance.state.domains["foo.example.test"]
        entry.pendingOrder = {
            order: { status: "pending", url: "https://ca.test/order/1", expires: new Date(now + day).toISOString() },
            keyPem: key, csrPem: "csr", httpChallenges: { ["acme-challenge/" + token]: "cleanup-authorization" },
        }
        instance.save()
        const restored = manager().instance
        expect(challengeResponse(token).send).toHaveBeenCalledWith("cleanup-authorization")
        if (status === "missing") {
            ca.getOrder.mockRejectedValueOnce(Object.assign(new Error("order gone"), { response: { status: 404 } }))
        } else {
            ca.getOrder.mockResolvedValueOnce({
                status: status === "expired" || status.includes("-") ? "pending" : status,
                url: "https://ca.test/order/1",
                expires: new Date(now + (status === "expired" ? -1 : day)).toISOString(),
            })
        }
        if (status === "invalid-challenge") {
            ca.getAuthorizations.mockResolvedValue([{ status: "pending", identifier: { value: "foo.example.test" },
                challenges: [{ type: "http-01", status: "processing", token, url: "https://ca.test/challenge/1" }] }])
            ca.getChallengeKeyAuthorization = jest.fn().mockResolvedValue("cleanup-authorization")
            ca.api.apiRequest.mockResolvedValueOnce({ data: { status: "invalid", error: { detail: "validation failed" } } })
        } else if (status === "valid-authorization") {
            ca.getAuthorizations.mockResolvedValue([{ status: "valid" }])
            ca.api.apiRequest.mockRejectedValueOnce(new Error("order status unavailable"))
        }
        // Cleanup must not wait for a certificate download that may itself fail.
        ca.getCertificate.mockRejectedValue(new Error("download unavailable"))
        await restored.checkAsync()
        expect(challengeResponse(token).status).toHaveBeenCalledWith(404)
        expect(restored.state.domains["foo.example.test"].pendingOrder?.httpChallenges).toBeUndefined()
        expect(manager().instance.state.domains["foo.example.test"].pendingOrder?.httpChallenges).toBeUndefined()
    }
)

it.each(["expired", "removed"])("does not restore %s challenges while issuance is paused", async reason => {
    const token = "unneeded-" + reason
    const { instance } = manager(["www.foo.example.test"])
    const entry = instance.state.domains["www.foo.example.test"]
    entry.pendingOrder = {
        order: { status: "pending", url: "https://ca.test/order/1", expires: new Date(now + hour).toISOString() },
        keyPem: key, csrPem: "csr", httpChallenges: { ["acme-challenge/" + token]: "unused-authorization" },
    }
    instance.state.account.nextAttemptAt = now + 3 * day
    instance.save()
    const loaded = manager(["www.foo.example.test"]).instance
    expect(challengeResponse(token).send).toHaveBeenCalledWith("unused-authorization")
    if (reason === "expired") {
        now += hour
        await loaded.checkAsync()
        expect(challengeResponse(token).status).toHaveBeenCalledWith(404)
    }
    manager(reason === "expired" ? ["www.foo.example.test"] : [])
    expect(challengeResponse(token).status).toHaveBeenCalledWith(404)
    expect(ca.createOrder).not.toHaveBeenCalled()
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
    finish({ status: "ready", url: "https://ca.test/order/1" })
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

it.each([
    ["one hour", "3600", hour],
    ["twelve hours", "43200", 12 * hour],
    ["zero seconds", "0", hour / 60],
    ["one second", "1", hour / 60],
    ["one week", "604800", day],
    ["HTTP date", new Date(issuedAt + 3 * hour).toUTCString(), 3 * hour],
    ["past HTTP date", new Date(issuedAt - day).toUTCString(), hour / 60],
    ["epoch HTTP date", new Date(0).toUTCString(), hour / 60],
    ["distant HTTP date", new Date(issuedAt + 7 * day).toUTCString(), day],
    ["missing header", undefined, 6 * hour],
    ["invalid header", "not a date", 6 * hour],
    ["negative seconds", "-1", 6 * hour],
    ["fractional seconds", "1.5", 6 * hour],
] as [string, string | undefined, number][])("persists the bounded ARI checking deadline for %s", async (label, header, delay) => {
    const { instance } = manager()
    const entry = instance.state.domains["foo.example.test"]
    entry.certificate = { ...savedCertificate(), ariCertId: "authority.serial" }
    serveAri({ suggestedWindow: {
        start: new Date(now + 27 * day).toISOString(), end: new Date(now + 28 * day).toISOString(),
    } }, header)
    await instance.checkAsync()
    expect(entry.certificate.ariCheckTime).toBe(now + delay)
    const restored = manager().instance
    expect(restored.state.domains["foo.example.test"].certificate.ariCheckTime).toBe(now + delay)
    expect(restored.state.domains["foo.example.test"].certificate.renewTime).toBe(entry.certificate.renewTime)
    expect(ca.createOrder).not.toHaveBeenCalled()
})

it("uses Retry-After immediately after issuance instead of overwriting it with six hours", async () => {
    serveAri({ suggestedWindow: {
        start: new Date(now + 27 * day).toISOString(), end: new Date(now + 28 * day).toISOString(),
    } }, "3600")
    const { instance, install } = manager()
    await instance.checkAsync()
    expect(install).toHaveBeenCalledTimes(1)
    expect(manager().instance.state.domains["foo.example.test"].certificate.ariCheckTime).toBe(now + hour)
})

it("refreshes at the saved one-hour deadline and learns an emergency window without bypassing backoff", async () => {
    const { instance } = manager()
    const entry = instance.state.domains["foo.example.test"]
    entry.certificate = { ...savedCertificate(), ariCertId: "authority.serial" }
    entry.nextAttemptAt = now + 2 * hour
    entry.lastFailureEmailAt = now
    serveAri({ suggestedWindow: {
        start: new Date(now + 27 * day).toISOString(), end: new Date(now + 28 * day).toISOString(),
    } }, "3600")
    await instance.checkAsync()
    const chosen = entry.certificate.renewTime
    now += hour - 1
    const restored = manager().instance
    await restored.checkAsync()
    expect(https.get).toHaveBeenCalledTimes(2)
    expect(restored.state.domains["foo.example.test"].certificate.renewTime).toBe(chosen)
    now += 1
    serveAri({ suggestedWindow: {
        start: new Date(now - hour / 2).toISOString(), end: new Date(now - hour / 4).toISOString(),
    } }, "3600")
    await restored.checkAsync()
    const saved = manager().instance.state.domains["foo.example.test"]
    expect(https.get).toHaveBeenCalledTimes(4)
    expect(saved.certificate.renewTime).toBeLessThan(now)
    expect(saved.certificate.ariCheckTime).toBe(now + hour)
    expect(saved.nextAttemptAt).toBe(issuedAt + 2 * hour)
    expect(saved.lastFailureEmailAt).toBe(issuedAt)
    expect(ca.createOrder).not.toHaveBeenCalled()
    expect(sendMail).not.toHaveBeenCalled()
})

it.each(["invalid JSON", "invalid window", "HTTP error"])("keeps the ARI fallback and existing window after an %s", async failure => {
    const { instance } = manager()
    const cert = { ...savedCertificate(), ariCertId: "authority.serial", ariRenewTime: now + 27 * day }
    instance.state.domains["foo.example.test"].certificate = cert
    serveAri(failure === "invalid JSON" ? "not JSON" : { suggestedWindow: {
        start: new Date(now + day).toISOString(), end: new Date(now + day).toISOString(),
    } }, "60", failure === "HTTP error" ? 503 : 200)
    await instance.checkAsync()
    const saved = manager().instance.state.domains["foo.example.test"].certificate
    expect(saved.ariCheckTime).toBe(now + 6 * hour)
    expect(saved.renewTime).toBe(cert.renewTime)
    expect(saved.ariRenewTime).toBe(cert.ariRenewTime)
    now += hour
    await manager().instance.checkAsync()
    expect(https.get).toHaveBeenCalledTimes(2)
    expect(ca.createOrder).not.toHaveBeenCalled()
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

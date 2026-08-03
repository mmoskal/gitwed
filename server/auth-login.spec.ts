import * as auth from "./auth"
import * as gitfs from "./gitfs"
import * as jwt from "jwt-simple"
import * as mail from "./mail"
import * as routing from "./routing"
import * as winston from "winston"

describe("login route validation", () => {
    const originalConfig = gitfs.config
    const originalMain = gitfs.main

    afterEach(() => {
        jest.restoreAllMocks()
        ;(gitfs as any).config = originalConfig
        ;(gitfs as any).main = originalMain
    })

    function captureRoutes() {
        const routes: { [index: string]: Function } = {}
        auth.initRoutes({
            all: jest.fn((path: string, handler: Function) => {
                routes[path] = handler
            }),
            get: jest.fn((path: string, handler: Function) => {
                routes[path] = handler
            }),
            post: jest.fn(),
        } as any)
        return routes
    }

    function configureMagicLinkUser() {
        ;(gitfs as any).config = {
            authDomain: "https://app.example.test",
            jwtSecret: "test-secret",
            proxy: false,
            serviceName: "Test",
            vhosts: {},
        }
        ;(gitfs as any).main = {
            getTextFileAsync: jest.fn(() =>
                Promise.resolve(
                    '{"users":[{"email":"person@example.test","nickname":"Person"}]}'
                )
            ),
        }
    }

    async function issueMagicLink(
        routes: { [index: string]: Function },
        sendMail: jest.SpyInstance,
        requestId: string
    ) {
        const previousCalls = sendMail.mock.calls.length
        routes["/gw/login"](
            {
                body: { email: "person@example.test" },
                query: { redirect: "/private" },
                connection: { remoteAddress: requestId },
                header: jest.fn(),
                _response: {},
            },
            {},
            jest.fn()
        )
        await new Promise<void>(resolve => setImmediate(resolve))
        expect(sendMail).toHaveBeenCalledTimes(previousCalls + 1)
        const text = sendMail.mock.calls[previousCalls][0].text as string
        const match = /\/gw\/auth\?tok=([^\s]+)/.exec(text)
        expect(match).not.toBeNull()
        return match[1]
    }

    it("stops after rejecting an invalid email", () => {
        const routes: { [index: string]: Function } = {}
        auth.initRoutes({
            all: jest.fn((path: string, handler: Function) => {
                routes[path] = handler
            }),
            get: jest.fn(),
            post: jest.fn(),
        } as any)

        ;(gitfs as any).config = {
            authDomain: "https://app.example.test",
            jwtSecret: "test-secret",
            proxy: false,
            serviceName: "Test",
            vhosts: {},
        }
        const getTextFileAsync = jest.fn(() =>
            Promise.resolve('{"users":[]}')
        )
        ;(gitfs as any).main = { getTextFileAsync }
        jest.spyOn(routing, "getVHostDir").mockReturnValue("")
        const sendError = jest
            .spyOn(routing, "sendError")
            .mockImplementation()
        const sendMail = jest.spyOn(mail, "sendAsync").mockImplementation()

        routes["/gw/login"](
            {
                body: { email: "not-an-email" },
                query: {},
                connection: {
                    remoteAddress: "invalid-login-" + Date.now(),
                },
                header: jest.fn(),
                _response: {},
            },
            {},
            jest.fn()
        )

        expect(sendError).toHaveBeenCalledWith(
            expect.anything(),
            "Invalid email",
            "The email address you have supplied doesn't look valid."
        )
        expect(getTextFileAsync).not.toHaveBeenCalled()
        expect(sendMail).not.toHaveBeenCalled()
    })

    it("accepts a process-bound magic link only once", async () => {
        const routes = captureRoutes()
        configureMagicLinkUser()
        jest.spyOn(routing, "getVHostDir").mockReturnValue("")
        const sendError = jest
            .spyOn(routing, "sendError")
            .mockImplementation()
        jest.spyOn(routing, "sendMsg").mockImplementation()
        const warn = jest.spyOn(winston, "warn").mockImplementation()
        const sendMail = jest
            .spyOn(mail, "sendAsync")
            .mockResolvedValue(undefined)
        const token = await issueMagicLink(
            routes,
            sendMail,
            "magic-replay-" + Date.now()
        )
        const claims = jwt.decode(token, "test-secret")
        expect(claims.jti).toMatch(/^[0-9a-f]{32}$/)
        expect(claims.epc).toMatch(/^[0-9a-f]{64}$/)

        const firstResponse = {
            cookie: jest.fn(),
            redirect: jest.fn(),
        }
        routes["/gw/auth"](
            { query: { tok: token }, secure: true },
            firstResponse,
            jest.fn()
        )

        expect(firstResponse.cookie).toHaveBeenCalledTimes(1)
        expect(firstResponse.redirect).toHaveBeenCalledWith("/private")
        expect(sendError).not.toHaveBeenCalled()

        const replayResponse = {
            cookie: jest.fn(),
            redirect: jest.fn(),
        }
        routes["/gw/auth"](
            { query: { tok: token }, secure: true },
            replayResponse,
            jest.fn()
        )

        expect(replayResponse.cookie).not.toHaveBeenCalled()
        expect(replayResponse.redirect).not.toHaveBeenCalled()
        expect(sendError).toHaveBeenCalledWith(
            expect.anything(),
            "Invalid token",
            "The authentication link looks invalid."
        )
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining("magic link already used")
        )
    })

    it("rejects a magic link at the exact expiry boundary", async () => {
        const now = jest.spyOn(Date, "now")
        const issuedAt = 2_000_000_000_000
        now.mockReturnValue(issuedAt)
        const routes = captureRoutes()
        configureMagicLinkUser()
        jest.spyOn(routing, "getVHostDir").mockReturnValue("")
        const sendError = jest
            .spyOn(routing, "sendError")
            .mockImplementation()
        const sendMsg = jest.spyOn(routing, "sendMsg").mockImplementation()
        jest.spyOn(winston, "warn").mockImplementation()
        const sendMail = jest
            .spyOn(mail, "sendAsync")
            .mockResolvedValue(undefined)
        const token = await issueMagicLink(
            routes,
            sendMail,
            "magic-expiry-boundary"
        )
        sendMsg.mockClear()
        now.mockReturnValue(issuedAt + 10 * 60 * 1000)

        for (let attempt = 0; attempt < 2; attempt++) {
            const response = { cookie: jest.fn(), redirect: jest.fn() }
            routes["/gw/auth"](
                { query: { tok: token }, secure: true },
                response,
                jest.fn()
            )
            expect(response.cookie).not.toHaveBeenCalled()
            expect(response.redirect).not.toHaveBeenCalled()
        }

        expect(sendMsg).toHaveBeenCalledTimes(2)
        expect(sendError).not.toHaveBeenCalled()
    })

    it("rejects malformed timestamps and links from another process epoch", async () => {
        const routes = captureRoutes()
        configureMagicLinkUser()
        jest.spyOn(routing, "getVHostDir").mockReturnValue("")
        const sendError = jest
            .spyOn(routing, "sendError")
            .mockImplementation()
        jest.spyOn(routing, "sendMsg").mockImplementation()
        jest.spyOn(winston, "warn").mockImplementation()
        const sendMail = jest
            .spyOn(mail, "sendAsync")
            .mockResolvedValue(undefined)
        const token = await issueMagicLink(
            routes,
            sendMail,
            "magic-invalid-claims-" + Date.now()
        )
        const claims = jwt.decode(token, "test-secret")
        const invalidTokens = [
            jwt.encode({ ...claims, iat: "not-a-number" }, "test-secret"),
            jwt.encode({ ...claims, epc: "0".repeat(64) }, "test-secret"),
            jwt.encode({ ...claims, epc: undefined }, "test-secret"),
        ]

        for (const invalidToken of invalidTokens) {
            const response = { cookie: jest.fn(), redirect: jest.fn() }
            routes["/gw/auth"](
                { query: { tok: invalidToken }, secure: true },
                response,
                jest.fn()
            )
            expect(response.cookie).not.toHaveBeenCalled()
            expect(response.redirect).not.toHaveBeenCalled()
        }

        expect(sendError).toHaveBeenCalledTimes(invalidTokens.length)
    })
})

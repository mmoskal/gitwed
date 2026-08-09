import * as url from "url"
import * as winston from "winston"
import * as jwt from "jwt-simple"

import * as gitfs from "./gitfs"
import * as oauth from "./oauth"
import * as tools from "./tools"

type Routes = { [path: string]: Function }

interface TestResponse {
    status: jest.Mock
    end: jest.Mock
    redirect: jest.Mock
    cookie: jest.Mock
    clearCookie: jest.Mock
    send: jest.Mock
    setHeader: jest.Mock
    statusCode: number
    headersSent: boolean
}

describe("OAuth state lifecycle", () => {
    const originalConfig = gitfs.config

    beforeEach(() => {
        jest.spyOn(winston, "debug").mockImplementation()
        jest.spyOn(winston, "error").mockImplementation()
        jest.spyOn(winston, "info").mockImplementation()
    })

    afterEach(() => {
        oauth.setOAuthMonotonicNowTestHook(null)
        jest.restoreAllMocks()
        ;(gitfs as any).config = originalConfig
    })

    function oauthConfig(production = false) {
        return {
            jwtSecret: "oauth-test-secret",
            authDomain: "https://auth.example.test",
            production,
            vhosts: {
                "auth.example.test": "auth",
                "tenant.example.test": "tenant",
            },
            oauth: {
                client_id: "client-id",
                client_secret: "client-secret",
                auth_uri: "https://provider.example.test/authorize",
                token_uri: "https://provider.example.test/token",
                redirect_uris: ["https://auth.example.test/oauth"],
                userinfo_uri: "",
                userInvalidPage: "/invalid",
                secondaryRedirs: [] as string[],
                secondaryKey: "secondary-secret",
            },
        }
    }

    function captureRoutes(
        production = false,
        configure: (value: any) => void = () => {}
    ) {
        const value = oauthConfig(production)
        configure(value)
        ;(gitfs as any).config = value
        const routes: Routes = {}
        oauth.init({
            get: jest.fn((path: string, ...handlers: Function[]) => {
                routes[path] = (req: any, res: any, next = jest.fn()) => {
                    let index = 0
                    const dispatch = (error?: any): any => {
                        if (error) return next(error)
                        const handler = handlers[index++]
                        if (!handler) return
                        try {
                            return handler(req, res, dispatch)
                        } catch (caught) {
                            return dispatch(caught)
                        }
                    }
                    return dispatch()
                }
            }),
        } as any)
        return routes
    }

    it.each([undefined, "", " "])(
        "refuses OAuth without a signing secret",
        jwtSecret => {
            expect(() =>
                captureRoutes(false, value => {
                    value.jwtSecret = jwtSecret
                })
            ).toThrow("OAuth requires jwtSecret")
        }
    )

    function makeResponse(): TestResponse {
        const response: TestResponse = {
            status: jest.fn(),
            end: jest.fn(),
            redirect: jest.fn(),
            cookie: jest.fn(),
            clearCookie: jest.fn(),
            send: jest.fn(),
            setHeader: jest.fn(),
            statusCode: 200,
            headersSent: false,
        }
        response.status.mockImplementation((statusCode: number) => {
            response.statusCode = statusCode
            return response
        })
        response.end.mockReturnValue(response)
        response.redirect.mockReturnValue(response)
        response.cookie.mockReturnValue(response)
        response.clearCookie.mockReturnValue(response)
        response.send.mockReturnValue(response)
        return response
    }

    async function immediate() {
        // express-rate-limit v5 uses two Promise turns before calling next.
        for (let i = 0; i < 8; i++) await Promise.resolve()
    }

    function requestHeader(
        host: string,
        forwardedFor = "",
        forwardedHost = ""
    ) {
        return jest.fn((name: string) => {
            if (name.toLowerCase() == "host") return host
            if (name.toLowerCase() == "x-forwarded-for") return forwardedFor
            if (name.toLowerCase() == "x-forwarded-host")
                return forwardedHost
            return undefined
        })
    }

    async function attemptLogin(
        routes: Routes,
        redirect = "/after-login",
        options: {
            host?: string
            ip?: string
            forwardedFor?: string
            forwardedHost?: string
            route?: string
        } = {}
    ) {
        const response = makeResponse()
        const next = jest.fn()
        const route = options.route || "/oauth/login"
        routes[route](
            {
                query: { redirect },
                res: response,
                ip: options.ip || "192.0.2.10",
                header: requestHeader(
                    options.host || "auth.example.test",
                    options.forwardedFor,
                    options.forwardedHost
                ),
                cookies: {},
            },
            response,
            next
        )
        await immediate()
        return { response, next }
    }

    async function startLogin(
        routes: Routes,
        redirect = "/after-login",
        options: {
            host?: string
            ip?: string
            forwardedFor?: string
            forwardedHost?: string
            route?: string
        } = {}
    ) {
        const { response, next } = await attemptLogin(routes, redirect, options)
        expect(next).not.toHaveBeenCalled()
        expect(response.redirect).toHaveBeenCalledTimes(1)
        const location = response.redirect.mock.calls[0][0] as string
        const state = new url.URL(location).searchParams.get("state") + ""
        expect(state).not.toBe("undefined")
        const bindingCall = response.cookie.mock.calls.find((call: any[]) =>
            /^GWOAUTHSTATE_/.test(call[0])
        )
        expect(bindingCall).toBeDefined()
        const cookies: SMap<string> = { [bindingCall[0]]: bindingCall[1] }
        return { state, location, response, cookies, bindingCall }
    }

    function callbackRequest(
        state: string,
        host = "auth.example.test",
        code = "provider-code",
        cookies: SMap<string> = {}
    ) {
        const callbackUrl =
            "/oauth?state=" +
            encodeURIComponent(state) +
            "&code=" +
            encodeURIComponent(code)
        return {
            query: { state, code },
            url: callbackUrl,
            header: requestHeader(host),
            cookies,
        }
    }

    function successfulTokenResponse() {
        return {
            statusCode: 200,
            headers: {},
            json: { access_token: "access-token" },
        }
    }

    function jwtForTest(payload: any) {
        return jwt.encode(payload, "test-signing-key")
    }

    async function runCallback(
        routes: Routes,
        request: any,
        response = makeResponse()
    ) {
        const next = jest.fn()
        await routes["/oauth"](request, response, next)
        return { response, next }
    }

    it("issues a strong state and accepts it only once", async () => {
        const routes = captureRoutes()
        const request = jest
            .spyOn(tools, "requestAsync")
            .mockResolvedValue(successfulTokenResponse())
        const login = await startLogin(routes)
        const { state } = login

        expect(state).toMatch(/^1[A-Za-z0-9_-]+$/)
        expect(state.length).toBeLessThanOrEqual(4096)
        expect(login.bindingCall[0]).toMatch(
            /^GWOAUTHSTATE_[A-Za-z0-9_-]{43}$/
        )
        expect(login.bindingCall[0]).not.toContain(state)
        expect(login.bindingCall[1]).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(login.bindingCall[2]).toEqual({
            httpOnly: true,
            secure: true,
            sameSite: "lax",
            maxAge: 10 * 60 * 1000,
            path: "/oauth",
        })

        const first = await runCallback(
            routes,
            callbackRequest(state, "auth.example.test", "provider-code", login.cookies)
        )
        expect(first.response.cookie).toHaveBeenCalledTimes(1)
        expect(first.response.clearCookie).toHaveBeenCalledWith(
            login.bindingCall[0],
            {
                httpOnly: true,
                secure: true,
                sameSite: "lax",
                path: "/oauth",
            }
        )
        expect(first.response.redirect).toHaveBeenCalledWith("/after-login")
        expect(first.next).not.toHaveBeenCalled()

        const replay = await runCallback(routes, callbackRequest(state))
        expect(replay.response.status).toHaveBeenCalledWith(400)
        expect(replay.response.end).toHaveBeenCalledWith("Bad state")
        expect(replay.response.cookie).not.toHaveBeenCalled()
        expect(request).toHaveBeenCalledTimes(1)
    })

    it("authenticates state contents and leaves the original flow usable after tampering", async () => {
        const routes = captureRoutes()
        const request = jest
            .spyOn(tools, "requestAsync")
            .mockResolvedValue(successfulTokenResponse())

        const login = await startLogin(routes, "/existing")
        const last = login.state.slice(-1)
        const tamperedState =
            login.state.slice(0, -1) + (last == "A" ? "B" : "A")
        const tampered = await runCallback(
            routes,
            callbackRequest(
                tamperedState,
                "auth.example.test",
                "provider-code",
                login.cookies
            )
        )
        expect(tampered.response.status).toHaveBeenCalledWith(400)
        expect(tampered.response.end).toHaveBeenCalledWith("Bad state")
        expect(request).not.toHaveBeenCalled()

        const original = await runCallback(
            routes,
            callbackRequest(
                login.state,
                "auth.example.test",
                "provider-code",
                login.cookies
            )
        )
        expect(original.response.redirect).toHaveBeenCalledWith("/existing")
        expect(request).toHaveBeenCalledTimes(1)
    })

    it("rejects a same-tick concurrent callback before the exchange finishes", async () => {
        const routes = captureRoutes()
        let resolveToken: (value: any) => void
        const pendingToken = new Promise(resolve => {
            resolveToken = resolve
        })
        const request = jest
            .spyOn(tools, "requestAsync")
            .mockReturnValue(pendingToken as any)
        const login = await startLogin(routes)
        const { state } = login

        const firstResponse = makeResponse()
        const firstNext = jest.fn()
        const first = routes["/oauth"](
            callbackRequest(
                state,
                "auth.example.test",
                "provider-code",
                login.cookies
            ),
            firstResponse,
            firstNext
        )
        const concurrent = await runCallback(
            routes,
            callbackRequest(
                state,
                "auth.example.test",
                "provider-code",
                login.cookies
            )
        )

        expect(concurrent.response.status).toHaveBeenCalledWith(400)
        expect(concurrent.response.end).toHaveBeenCalledWith("Bad state")
        expect(request).toHaveBeenCalledTimes(1)

        resolveToken(successfulTokenResponse())
        await first
        expect(firstResponse.cookie).toHaveBeenCalledTimes(1)
        expect(firstNext).not.toHaveBeenCalled()
    })

    it("expires at the exact TTL boundary and never contacts the provider", async () => {
        const issuedAt = 2_000_000_000_000
        jest.spyOn(Date, "now").mockReturnValue(issuedAt)
        const routes = captureRoutes()
        const request = jest.spyOn(tools, "requestAsync")
        const { state } = await startLogin(routes)

        ;(Date.now as jest.Mock).mockReturnValue(issuedAt + 10 * 60 * 1000)
        const expired = await runCallback(routes, callbackRequest(state))

        expect(expired.response.status).toHaveBeenCalledWith(400)
        expect(expired.response.end).toHaveBeenCalledWith("Bad state")
        expect(request).not.toHaveBeenCalled()
    })

    it("keeps a new stateless flow usable after an older flow expires", async () => {
        const issuedAt = 2_100_000_000_000
        jest.spyOn(Date, "now").mockReturnValue(issuedAt)
        const routes = captureRoutes()
        const request = jest.spyOn(tools, "requestAsync").mockResolvedValue(
            successfulTokenResponse()
        )
        const expired = await startLogin(routes, "/expired")

        ;(Date.now as jest.Mock).mockReturnValue(issuedAt + 10 * 60 * 1000)
        const replacement = await startLogin(routes, "/replacement")

        const expiredResult = await runCallback(
            routes,
            callbackRequest(
                expired.state,
                "auth.example.test",
                "provider-code",
                expired.cookies
            )
        )
        expect(expiredResult.response.end).toHaveBeenCalledWith("Bad state")
        expect(request).not.toHaveBeenCalled()

        const result = await runCallback(
            routes,
            callbackRequest(
                replacement.state,
                "auth.example.test",
                "provider-code",
                replacement.cookies
            )
        )
        expect(result.response.redirect).toHaveBeenCalledWith("/replacement")
        expect(request).toHaveBeenCalledTimes(1)
    })

    it("retains a replay marker across a wall-clock epoch rollback", async () => {
        const boundary = Math.ceil(3_000_000_000_000 / (10 * 60 * 1000)) *
            (10 * 60 * 1000)
        jest.spyOn(Date, "now").mockReturnValue(boundary - 1000)
        const routes = captureRoutes()
        const request = jest
            .spyOn(tools, "requestAsync")
            .mockResolvedValue(successfulTokenResponse())
        const login = await startLogin(routes, "/after-rollback")

        ;(Date.now as jest.Mock).mockReturnValue(boundary + 1000)
        const accepted = await runCallback(
            routes,
            callbackRequest(
                login.state,
                "auth.example.test",
                "provider-code",
                login.cookies
            )
        )
        expect(accepted.response.redirect).toHaveBeenCalledWith(
            "/after-rollback"
        )
        expect(request).toHaveBeenCalledTimes(1)
        request.mockClear()

        // Roll back across the filter epoch boundary, but remain after state
        // issuance and well within the state's wall-clock TTL.
        ;(Date.now as jest.Mock).mockReturnValue(boundary - 500)
        const replay = await runCallback(
            routes,
            callbackRequest(
                login.state,
                "auth.example.test",
                "different-provider-code",
                login.cookies
            )
        )
        expect(replay.response.status).toHaveBeenCalledWith(400)
        expect(replay.response.end).toHaveBeenCalledWith("Bad state")
        expect(request).not.toHaveBeenCalled()
    })

    it("expires after ten elapsed minutes when a forward clock jump is corrected", async () => {
        const beforeJump = 3_500_000_000_000
        let monotonicNow = 0
        oauth.setOAuthMonotonicNowTestHook(() => monotonicNow)
        jest.spyOn(Date, "now").mockReturnValue(beforeJump)
        const routes = captureRoutes()
        const request = jest.spyOn(tools, "requestAsync")

        ;(Date.now as jest.Mock).mockReturnValue(
            beforeJump + 24 * 60 * 60 * 1000
        )
        monotonicNow = 1000
        const login = await startLogin(routes, "/after-forward-jump")

        // Correct the wall clock, while the monotonic clock advances by the
        // state's full TTL. The state must expire at this exact boundary.
        ;(Date.now as jest.Mock).mockReturnValue(beforeJump + 2000)
        monotonicNow += 10 * 60 * 1000
        const expired = await runCallback(
            routes,
            callbackRequest(
                login.state,
                "auth.example.test",
                "provider-code",
                login.cookies
            )
        )
        expect(expired.response.status).toHaveBeenCalledWith(400)
        expect(expired.response.end).toHaveBeenCalledWith("Bad state")
        expect(request).not.toHaveBeenCalled()
    })

    it("consumes state when the token endpoint returns an error", async () => {
        const routes = captureRoutes()
        const stateSecret = "state-must-not-be-logged"
        const codeSecret = "code-must-not-be-logged"
        const request = jest.spyOn(tools, "requestAsync").mockResolvedValue({
            statusCode: 503,
            headers: {},
        })
        const login = await startLogin(
            routes,
            "/after-login?state=" + stateSecret
        )
        const { state } = login

        const failure = await runCallback(
            routes,
            callbackRequest(
                state,
                "auth.example.test",
                codeSecret,
                login.cookies
            )
        )
        expect(failure.response.end).toHaveBeenCalledWith(
            "cannot get access token"
        )

        const replay = await runCallback(routes, callbackRequest(state))
        expect(replay.response.end).toHaveBeenCalledWith("Bad state")
        expect(request).toHaveBeenCalledTimes(1)
        const logs = JSON.stringify([
            (winston.debug as jest.Mock).mock.calls,
            (winston.error as jest.Mock).mock.calls,
        ])
        expect(logs).not.toContain(state)
        expect(logs).not.toContain(stateSecret)
        expect(logs).not.toContain(codeSecret)
    })

    it("routes an asynchronous exchange rejection and still consumes state", async () => {
        const routes = captureRoutes()
        const providerError = new Error("provider unavailable")
        const request = jest
            .spyOn(tools, "requestAsync")
            .mockRejectedValue(providerError)
        const login = await startLogin(routes)
        const { state } = login

        const failure = await runCallback(
            routes,
            callbackRequest(
                state,
                "auth.example.test",
                "provider-code",
                login.cookies
            )
        )
        expect(failure.next).toHaveBeenCalledWith(providerError)

        const replay = await runCallback(routes, callbackRequest(state))
        expect(replay.response.end).toHaveBeenCalledWith("Bad state")
        expect(request).toHaveBeenCalledTimes(1)
    })

    it("consumes state on user-info HTTP failure", async () => {
        const routes = captureRoutes(false, value => {
            value.oauth.userinfo_uri =
                "https://provider.example.test/user-info"
        })
        const request = jest
            .spyOn(tools, "requestAsync")
            .mockResolvedValueOnce(successfulTokenResponse())
            .mockResolvedValueOnce({ statusCode: 503, headers: {} } as any)
        const login = await startLogin(routes)

        const failure = await runCallback(
            routes,
            callbackRequest(
                login.state,
                "auth.example.test",
                "provider-code",
                login.cookies
            )
        )
        expect(failure.response.end).toHaveBeenCalledWith(
            "cannot get user info"
        )
        const replay = await runCallback(
            routes,
            callbackRequest(
                login.state,
                "auth.example.test",
                "provider-code",
                login.cookies
            )
        )
        expect(replay.response.end).toHaveBeenCalledWith("Bad state")
        expect(request).toHaveBeenCalledTimes(2)
    })

    it("consumes state on an asynchronous user-info rejection", async () => {
        const routes = captureRoutes(false, value => {
            value.oauth.userinfo_uri =
                "https://provider.example.test/user-info"
        })
        const providerError = new Error("user-info unavailable")
        const request = jest
            .spyOn(tools, "requestAsync")
            .mockResolvedValueOnce(successfulTokenResponse())
            .mockRejectedValueOnce(providerError)
        const login = await startLogin(routes)

        const failure = await runCallback(
            routes,
            callbackRequest(
                login.state,
                "auth.example.test",
                "provider-code",
                login.cookies
            )
        )
        expect(failure.next).toHaveBeenCalledWith(providerError)
        const replay = await runCallback(
            routes,
            callbackRequest(login.state)
        )
        expect(replay.response.end).toHaveBeenCalledWith("Bad state")
        expect(request).toHaveBeenCalledTimes(2)
    })

    it("completes a bound secondary flow and rejects invalid secondary origins", async () => {
        const routes = captureRoutes(false, value => {
            value.oauth.secondaryRedirs = [
                "https://tenant.example.test/set-token",
            ]
            value.oauth.secondaryTokenFields = ["email"]
        })
        const request = jest
            .spyOn(tools, "requestAsync")
            .mockResolvedValue({
                statusCode: 200,
                headers: {},
                json: {
                    access_token: "secondary-access-token",
                    id_token: jwtForTest({
                        sub: "secondary-user",
                        email: "user@example.test",
                    }),
                },
            })

        const invalid = await attemptLogin(
            routes,
            "https://evil.example/editor",
            { route: "/oauth/secondary", ip: "192.0.2.20" }
        )
        expect(invalid.response.status).toHaveBeenCalledWith(400)
        expect(invalid.response.cookie).not.toHaveBeenCalled()

        const normalizedNetworkPath = await attemptLogin(
            routes,
            "https://tenant.example.test/%2e%2e//evil.example/path",
            { route: "/oauth/secondary", ip: "192.0.2.21" }
        )
        expect(normalizedNetworkPath.response.status).toHaveBeenCalledWith(400)
        expect(normalizedNetworkPath.response.end).toHaveBeenCalledWith(
            "Invalid secondary domain"
        )
        expect(normalizedNetworkPath.response.cookie).not.toHaveBeenCalled()
        expect(normalizedNetworkPath.response.redirect).not.toHaveBeenCalled()

        const login = await startLogin(
            routes,
            "https://tenant.example.test/editor?discarded=1",
            { route: "/oauth/secondary", ip: "192.0.2.20" }
        )
        const result = await runCallback(
            routes,
            callbackRequest(
                login.state,
                "auth.example.test",
                "provider-code",
                login.cookies
            )
        )
        expect(result.response.cookie).not.toHaveBeenCalled()
        expect(result.response.clearCookie).toHaveBeenCalledTimes(1)
        const destination = result.response.redirect.mock.calls[0][0] as string
        expect(destination).toMatch(
            /^https:\/\/tenant\.example\.test\/set-token\?redirect=%2Feditor&token=/
        )
        const secondaryToken = new url.URL(destination).searchParams.get(
            "token"
        )
        expect(jwt.decode(secondaryToken, "secondary-secret")).toMatchObject({
                sub: "secondary-user",
                email: "user@example.test",
        })
        expect(request).toHaveBeenCalledTimes(1)
    })

    it("consumes a secondary state when the token exchange fails", async () => {
        const routes = captureRoutes(false, value => {
            value.oauth.secondaryRedirs = [
                "https://tenant.example.test/set-token",
            ]
        })
        const request = jest.spyOn(tools, "requestAsync").mockResolvedValue({
            statusCode: 503,
            headers: {},
        })
        const login = await startLogin(
            routes,
            "https://tenant.example.test/editor",
            { route: "/oauth/secondary" }
        )
        const failure = await runCallback(
            routes,
            callbackRequest(
                login.state,
                "auth.example.test",
                "provider-code",
                login.cookies
            )
        )
        expect(failure.response.end).toHaveBeenCalledWith(
            "cannot get access token"
        )
        const replay = await runCallback(routes, callbackRequest(login.state))
        expect(replay.response.end).toHaveBeenCalledWith("Bad state")
        expect(request).toHaveBeenCalledTimes(1)
    })

    it("requires the initiating browser binding without letting a victim burn the state", async () => {
        const routes = captureRoutes()
        const login = await startLogin(routes)
        const finalResponse = makeResponse()
        const request = jest
            .spyOn(tools, "requestAsync")
            .mockImplementation(async () => {
                // Both state and cookie are synchronously consumed before the
                // first provider request begins.
                expect(finalResponse.clearCookie).toHaveBeenCalledWith(
                    login.bindingCall[0],
                    expect.any(Object)
                )
                return successfulTokenResponse()
            })

        const victim = await runCallback(
            routes,
            callbackRequest(login.state)
        )
        expect(victim.response.end).toHaveBeenCalledWith("Bad state")
        expect(request).not.toHaveBeenCalled()

        const wrongCookie = await runCallback(
            routes,
            callbackRequest(login.state, "auth.example.test", "provider-code", {
                [login.bindingCall[0]]: "wrong-binding",
            })
        )
        expect(wrongCookie.response.end).toHaveBeenCalledWith("Bad state")
        expect(request).not.toHaveBeenCalled()

        const attacker = await runCallback(
            routes,
            callbackRequest(
                login.state,
                "auth.example.test",
                "provider-code",
                login.cookies
            ),
            finalResponse
        )
        expect(attacker.response.redirect).toHaveBeenCalledWith(
            "/after-login"
        )
        expect(request).toHaveBeenCalledTimes(1)
    })

    it("preflights a production cross-vhost login before allocating state", async () => {
        const routes = captureRoutes(true)
        const firstHost = await attemptLogin(
            routes,
            "https://tenant.example.test/after-login",
            { host: "auth.example.test" }
        )
        expect(firstHost.response.cookie).not.toHaveBeenCalled()
        expect(firstHost.response.redirect).toHaveBeenCalledTimes(1)
        const preflight = new url.URL(
            firstHost.response.redirect.mock.calls[0][0]
        )
        expect(preflight.origin + preflight.pathname).toBe(
            "https://tenant.example.test/oauth/login"
        )
        expect(preflight.searchParams.get("redirect")).toBe(
            "https://tenant.example.test/after-login"
        )
        expect(preflight.searchParams.has("state")).toBe(false)

        const finalHost = await startLogin(
            routes,
            preflight.searchParams.get("redirect"),
            { host: "tenant.example.test" }
        )
        expect(finalHost.bindingCall[2].secure).toBe(true)
    })

    it("uses forwarded host only inside the configured proxy trust boundary", async () => {
        const directRoutes = captureRoutes(true)
        const spoofed = await attemptLogin(
            directRoutes,
            "https://tenant.example.test/after-login",
            {
                host: "auth.example.test",
                forwardedHost: "tenant.example.test",
            }
        )
        expect(spoofed.response.cookie).not.toHaveBeenCalled()
        expect(spoofed.response.redirect.mock.calls[0][0]).toMatch(
            /^https:\/\/tenant\.example\.test\/oauth\/login\?/
        )

        const proxyRoutes = captureRoutes(true, value => {
            value.proxy = true
        })
        const proxied = await startLogin(
            proxyRoutes,
            "https://tenant.example.test/after-login",
            {
                host: "internal-proxy:3000",
                forwardedHost: "tenant.example.test",
            }
        )
        expect(proxied.bindingCall[0]).toMatch(
            /^GWOAUTHSTATE_[A-Za-z0-9_-]{43}$/
        )
    })

    it("preflights relative and secondary initiation onto the callback host", async () => {
        const primaryRoutes = captureRoutes(true)
        const relative = await attemptLogin(primaryRoutes, "/relative", {
            host: "tenant.example.test",
        })
        expect(relative.response.cookie).not.toHaveBeenCalled()
        expect(relative.response.redirect).toHaveBeenCalledWith(
            "https://auth.example.test/oauth/login?redirect=%2Frelative"
        )

        const secondaryRoutes = captureRoutes(false, value => {
            value.oauth.secondaryRedirs = [
                "https://external.example.test/set-token",
            ]
        })
        const secondary = await attemptLogin(
            secondaryRoutes,
            "https://external.example.test/editor",
            { host: "tenant.example.test", route: "/oauth/secondary" }
        )
        expect(secondary.response.cookie).not.toHaveBeenCalled()
        const secondaryPreflight = new url.URL(
            secondary.response.redirect.mock.calls[0][0]
        )
        expect(secondaryPreflight.origin + secondaryPreflight.pathname).toBe(
            "https://auth.example.test/oauth/secondary"
        )
        expect(secondaryPreflight.searchParams.get("redirect")).toBe(
            "https://external.example.test/editor"
        )
    })

    it("keeps a validated cross-vhost relay pending until one final callback", async () => {
        const routes = captureRoutes(true)
        const request = jest
            .spyOn(tools, "requestAsync")
            .mockResolvedValue(successfulTokenResponse())
        const login = await startLogin(
            routes,
            "https://tenant.example.test/after-login",
            { host: "tenant.example.test" }
        )
        const { state } = login

        const relayRequest = callbackRequest(state, "auth.example.test")
        const firstRelay = await runCallback(routes, relayRequest)
        expect(firstRelay.response.redirect).toHaveBeenCalledWith(
            "https://tenant.example.test" + relayRequest.url
        )
        const secondRelay = await runCallback(routes, relayRequest)
        expect(secondRelay.response.redirect).toHaveBeenCalledWith(
            "https://tenant.example.test" + relayRequest.url
        )
        expect(request).not.toHaveBeenCalled()

        const sharedWithVictim = await runCallback(
            routes,
            callbackRequest(state, "tenant.example.test")
        )
        expect(sharedWithVictim.response.end).toHaveBeenCalledWith("Bad state")
        expect(request).not.toHaveBeenCalled()

        const final = await runCallback(
            routes,
            callbackRequest(
                state,
                "TENANT.EXAMPLE.TEST",
                "provider-code",
                login.cookies
            )
        )
        expect(final.response.cookie).toHaveBeenCalledTimes(1)
        expect(final.response.cookie).toHaveBeenCalledWith(
            "GWOAUTH",
            expect.any(String),
            expect.objectContaining({ sameSite: "lax" })
        )
        expect(final.response.redirect).toHaveBeenCalledWith(
            "https://tenant.example.test/after-login"
        )
        expect(request).toHaveBeenCalledTimes(1)

        const replay = await runCallback(routes, relayRequest)
        expect(replay.response.end).toHaveBeenCalledWith("Bad state")
        expect(replay.response.redirect).not.toHaveBeenCalled()
    })

    it("rejects malformed, unknown, and prototype-named states without exchange", async () => {
        const routes = captureRoutes()
        const request = jest.spyOn(tools, "requestAsync")

        for (const state of [
            "",
            "__proto__",
            "constructor",
            "not-a-state",
            "Z".repeat(24),
        ]) {
            const result = await runCallback(routes, callbackRequest(state))
            expect(result.response.status).toHaveBeenCalledWith(400)
            expect(result.response.end).toHaveBeenCalledWith("Bad state")
        }
        expect(request).not.toHaveBeenCalled()
    })

    it("canonicalizes allowed redirect forms", async () => {
        const routes = captureRoutes()
        jest.spyOn(tools, "requestAsync").mockResolvedValue(
            successfulTokenResponse()
        )
        const cases = [
            ["/safe/path?x=1", "/safe/path?x=1"],
            ["/safe%20path", "/safe%20path"],
            [
                "HTTPS://TENANT.EXAMPLE.TEST/Mixed?discarded=1",
                "https://tenant.example.test/Mixed",
            ],
            [
                "http://localhost:3000/local?discarded=1",
                "http://localhost:3000/local",
            ],
        ]
        for (const [input, expected] of cases) {
            const login = await startLogin(routes, input)
            const result = await runCallback(
                routes,
                callbackRequest(
                    login.state,
                    "auth.example.test",
                    "provider-code",
                    login.cookies
                )
            )
            expect(result.response.redirect).toHaveBeenCalledWith(expected)
        }
    })

    it("collapses network paths, backslashes, controls, userinfo, and malformed origins to root", async () => {
        const routes = captureRoutes()
        const request = jest
            .spyOn(tools, "requestAsync")
            .mockResolvedValue(successfulTokenResponse())
        const rejected = [
            "//evil.example/path",
            "///evil.example/path",
            "\\\\evil.example\\path",
            "/\\evil.example/path",
            "/%5cevil.example/path",
            "/%2f%2fevil.example/path",
            "/%2e%2e//evil.example/path",
            "/safe/..//evil.example/path",
            "https://tenant.example.test/%2e%2e//evil.example/path",
            "/%0devil.example/path",
            "\r//evil.example/path",
            "https://user@tenant.example.test/path",
            "https://tenant.example.test@evil.example/path",
            "https://tenant.example.test\\@evil.example/path",
            "http://tenant.example.test/path",
            "https://evil.example/path",
            "https://tenant.example.test/%",
        ]
        for (const input of rejected) {
            // Literal backslashes here are what Express supplies after one
            // percent-decoding pass for a raw %5c query component.
            const login = await startLogin(routes, input)
            const result = await runCallback(
                routes,
                callbackRequest(
                    login.state,
                    "auth.example.test",
                    "provider-code",
                    login.cookies
                )
            )
            expect(result.response.redirect).toHaveBeenCalledWith("/")
        }
        expect(request).toHaveBeenCalledTimes(rejected.length)
    })

    it("does not retain an oversized redirect", async () => {
        const routes = captureRoutes()
        const { response } = await attemptLogin(
            routes,
            "/" + "x".repeat(2048)
        )

        expect(response.status).toHaveBeenCalledWith(400)
        expect(response.end).toHaveBeenCalledWith("Redirect too long")
        expect(response.redirect).not.toHaveBeenCalled()
    })

    it("limits one client to 32 insertions per state TTL and ignores raw forwarded-for", async () => {
        const issuedAt = 4_000_000_000_000
        jest.spyOn(Date, "now").mockReturnValue(issuedAt)
        const routes = captureRoutes()
        const request = jest
            .spyOn(tools, "requestAsync")
            .mockResolvedValue(successfulTokenResponse())
        const victim = await startLogin(routes, "/victim", {
            ip: "198.51.100.1",
        })

        for (let i = 0; i < 32; i++) {
            await startLogin(routes, "/attacker-" + i, {
                ip: "203.0.113.9",
                forwardedFor: "10.0.0." + i,
            })
        }
        const denied = await attemptLogin(routes, "/denied", {
            ip: "203.0.113.9",
            forwardedFor: "192.0.2.200",
        })
        expect(denied.response.status).toHaveBeenCalledWith(429)
        expect(denied.response.end).toHaveBeenCalledWith(
            "Too many OAuth login attempts"
        )
        expect(denied.response.redirect).not.toHaveBeenCalled()
        expect(denied.response.cookie).not.toHaveBeenCalled()

        // Initiation is stateless, so an attacker's accepted attempts cannot
        // invalidate another browser's authenticated state token.
        const acceptedVictim = await runCallback(
            routes,
            callbackRequest(
                victim.state,
                "auth.example.test",
                "provider-code",
                victim.cookies
            )
        )
        expect(acceptedVictim.response.redirect).toHaveBeenCalledWith(
            "/victim"
        )
        expect(request).toHaveBeenCalledTimes(1)

        ;(Date.now as jest.Mock).mockReturnValue(issuedAt + 10 * 60 * 1000)
        const cleanup = await startLogin(routes, "/cleanup", {
            ip: "192.0.2.250",
        })
        await runCallback(
            routes,
            callbackRequest(
                cleanup.state,
                "auth.example.test",
                "provider-code",
                cleanup.cookies
            )
        )
    })

    it("continues admitting new clients after the bounded limiter store turns over", async () => {
        const issuedAt = 4_500_000_000_000
        jest.spyOn(Date, "now").mockReturnValue(issuedAt)
        const routes = captureRoutes()

        // The old shared overflow bucket rejected call 4,129. Evicting the
        // oldest per-client bucket keeps storage bounded without converting
        // address diversity into a global denial for every unseen client.
        for (let i = 0; i < 4096 + 33; i++) {
            await startLogin(routes, "/client-" + i, {
                ip: "capacity-client-" + i,
            })
        }
    }, 30000)

    it("keeps pending states and consumed replay markers after 8,193 flows", async () => {
        const issuedAt = 5_000_000_000_000
        jest.spyOn(Date, "now").mockReturnValue(issuedAt)
        const routes = captureRoutes()
        const request = jest
            .spyOn(tools, "requestAsync")
            .mockResolvedValue(successfulTokenResponse())
        const oldest = await startLogin(routes, "/oldest", {
            ip: "capacity-client-0",
        })
        const flows = [oldest]
        for (let i = 1; i <= 8192; i++) {
            flows.push(
                await startLogin(routes, "/newest", {
                    ip: "capacity-client-" + Math.floor(i / 32),
                })
            )
        }

        const acceptedOldest = await runCallback(
            routes,
            callbackRequest(
                oldest.state,
                "auth.example.test",
                "provider-code",
                oldest.cookies
            )
        )
        expect(acceptedOldest.response.redirect).toHaveBeenCalledWith(
            "/oldest"
        )
        request.mockClear()

        for (let i = 1; i < flows.length; i++) {
            const flow = flows[i]
            const accepted = await runCallback(
                routes,
                callbackRequest(
                    flow.state,
                    "auth.example.test",
                    "provider-code",
                    flow.cookies
                )
            )
            if (i == flows.length - 1) {
                expect(accepted.response.redirect).toHaveBeenCalledWith(
                    "/newest"
                )
            }
            // Do not make Jest retain 8,192 provider-request argument objects.
            request.mockClear()
        }

        const replay = await runCallback(
            routes,
            callbackRequest(
                oldest.state,
                "auth.example.test",
                "different-provider-code",
                oldest.cookies
            )
        )
        expect(replay.response.status).toHaveBeenCalledWith(400)
        expect(replay.response.end).toHaveBeenCalledWith("Bad state")
        expect(request).not.toHaveBeenCalled()
    }, 60000)

    it("relays a local-process state without requiring it in production", async () => {
        const productionRoutes = captureRoutes(true)
        const productionRequest = jest.spyOn(tools, "requestAsync")
        let localRoutes: Routes
        let localTools: typeof tools

        jest.isolateModules(() => {
            const isolatedGitfs = require("./gitfs") as typeof gitfs
            const isolatedOauth = require("./oauth") as typeof oauth
            localTools = require("./tools") as typeof tools
            ;(isolatedGitfs as any).config = oauthConfig(false)
            localRoutes = {}
            isolatedOauth.setLocal()
            isolatedOauth.init({
                get: jest.fn((path: string, ...handlers: Function[]) => {
                    localRoutes[path] = (
                        req: any,
                        res: any,
                        next = jest.fn()
                    ) => {
                        let index = 0
                        const dispatch = (error?: any): any => {
                            if (error) return next(error)
                            const handler = handlers[index++]
                            if (!handler) return
                            try {
                                return handler(req, res, dispatch)
                            } catch (caught) {
                                return dispatch(caught)
                            }
                        }
                        return dispatch()
                    }
                }),
            } as any)
        })

        const localRequest = jest
            .spyOn(localTools, "requestAsync")
            .mockResolvedValue(successfulTokenResponse())
        const login = await startLogin(localRoutes, "/after-login", {
            host: "localhost:3000",
        })
        const { state } = login
        expect(state).toMatch(/^0[A-Za-z0-9_-]+$/)

        const namespaceFlip = await runCallback(
            productionRoutes,
            callbackRequest("1" + state.slice(1), "auth.example.test")
        )
        expect(namespaceFlip.response.end).toHaveBeenCalledWith("Bad state")
        expect(namespaceFlip.response.redirect).not.toHaveBeenCalled()

        const callback = callbackRequest(state, "auth.example.test")
        const relay = await runCallback(productionRoutes, callback)
        expect(relay.response.redirect).toHaveBeenCalledWith(
            "http://localhost:3000" + callback.url
        )
        expect(productionRequest).not.toHaveBeenCalled()

        const local = await runCallback(
            localRoutes,
            callbackRequest(
                state,
                "localhost:3000",
                "provider-code",
                login.cookies
            )
        )
        expect(local.response.cookie).toHaveBeenCalledTimes(1)
        expect(localRequest).toHaveBeenCalledTimes(1)

        const replay = await runCallback(localRoutes, callback)
        expect(replay.response.end).toHaveBeenCalledWith("Bad state")
        expect(localRequest).toHaveBeenCalledTimes(1)
    })
})

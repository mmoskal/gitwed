import * as auth from "./auth"
import * as gitfs from "./gitfs"
import * as mail from "./mail"
import * as routing from "./routing"

describe("login route validation", () => {
    const originalConfig = gitfs.config
    const originalMain = gitfs.main

    afterEach(() => {
        jest.restoreAllMocks()
        ;(gitfs as any).config = originalConfig
        ;(gitfs as any).main = originalMain
    })

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
})

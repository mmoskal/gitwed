import sharp = require("sharp")
import * as expander from "./expander"
import * as gitfs from "./gitfs"
import {
    app,
    onReplaceImage,
    onSendEmail,
    onUploadImage,
    isRestrictedRepositoryContentPath,
    normalizeRepositoryContentPath,
    unsafeContentPath,
    unsafeRepositoryContentPath,
} from "./app"
import {
    configFixture,
    requestFixture,
    msgFixture,
    responseFixture,
} from "./fixtures"

jest.mock("mailgun.js", () => {
    const create = jest.fn(() => Promise.resolve("body"))
    const client = jest.fn(() => ({
        messages: {
            create,
        },
    }))
    return jest.fn(() => ({
        client,
    }))
})

describe("API", () => {
    describe("log endpoint removal", () => {
        it("does not register /api/logs", () => {
            const routes = (app as any)._router.stack
                .map((layer: any) => layer.route && layer.route.path)
                .filter((route: any) => !!route)
            expect(routes).not.toContain("/api/logs")
        })

        it.each([
            "/sample/../logs/info.log",
            "/sample/./logs/info.log",
            "/sample/%2e%2e/logs/debug.log",
            "/sample/%2E/logs/warn.log",
            "/sample/%5clogs/info.log",
            "/sample/\\logs/info.log",
            "//logs/info.log",
            "/%2f/logs/info.log",
            "/sample/%",
        ])("rejects an unsafe catch-all path: %s", pathname => {
            expect(unsafeContentPath(pathname)).toBe(true)
        })

        it.each([
            "/sample/logs-and-metrics.html",
            "/sample/v1.2/page.html",
            "/.well-known/acme-challenge/token",
        ])("keeps an ordinary dotted path valid: %s", pathname => {
            expect(unsafeContentPath(pathname)).toBe(false)
        })

        it("denies logs after empty-root vhost and repeated-slash normalization", () => {
            const emptyRootVhostPath = "/" + "/logs/info.log"
            expect(normalizeRepositoryContentPath(emptyRootVhostPath)).toBe(
                "logs/info.log"
            )
            expect(
                isRestrictedRepositoryContentPath(emptyRootVhostPath)
            ).toBe(true)
            expect(
                isRestrictedRepositoryContentPath("logs-and-metrics.html")
            ).toBe(false)
        })

        it.each([
            "logs/info.log",
            "LOGS/info.log",
            "private.html",
            "private-backup/page.html",
        ])("denies a protected repository path: %s", pathname => {
            expect(isRestrictedRepositoryContentPath(pathname)).toBe(true)
        })

        it.each(["./logs/info.log", "site/../logs/info.log"])(
            "rejects a dot-segment vhost result: %s",
            pathname => {
                expect(unsafeRepositoryContentPath(pathname)).toBe(true)
            }
        )

        it("allows an ordinary vhost repository path", () => {
            expect(
                unsafeRepositoryContentPath("site/v1.2/page.html")
            ).toBe(false)
        })
    })

    describe("image upload routes", () => {
        function routeResponse() {
            const response: any = {
                status: jest.fn(),
                end: jest.fn(),
                json: jest.fn(),
            }
            response.status.mockReturnValue(response)
            return response
        }

        it.each([
            null,
            undefined,
            "not an object",
            [],
            {},
            {
                page: "/site/page",
                filename: "image.png",
                full: 123,
                format: "png",
            },
        ])("returns 400 for a malformed upload envelope: %p", async body => {
            const response = routeResponse()
            const next = jest.fn()

            await (onUploadImage as any)(
                requestFixture({ appuser: "test@example.com", body } as any),
                response,
                next
            )

            expect(response.status).toHaveBeenCalledWith(400)
            expect(response.end).toHaveBeenCalled()
            expect(next).not.toHaveBeenCalled()
        })

        it("returns 400 before handling an upload beneath a hidden page path", async () => {
            const png = await sharp({
                create: {
                    width: 1,
                    height: 1,
                    channels: 3,
                    background: "#123456",
                },
            })
                .png()
                .toBuffer()
            const createBinFileAsync = jest.fn().mockResolvedValue("image.png")
            const findRepo = jest.spyOn(gitfs, "findRepo").mockReturnValue({
                createBinFileAsync,
            } as any)
            const permission = jest
                .spyOn(expander, "hasWritePermAsync")
                .mockResolvedValue(true)
            const response = routeResponse()
            const next = jest.fn()

            try {
                await (onUploadImage as any)(
                    requestFixture({
                        appuser: "test@example.com",
                        body: {
                            page: "/.git/config",
                            filename: "image.png",
                            full: png.toString("base64"),
                            format: "png",
                        },
                    } as any),
                    response,
                    next
                )
            } finally {
                findRepo.mockRestore()
                permission.mockRestore()
            }

            expect(response.status).toHaveBeenCalledWith(400)
            expect(response.end).toHaveBeenCalled()
            expect(createBinFileAsync).not.toHaveBeenCalled()
            expect(next).not.toHaveBeenCalled()
        })

        it("maps an atomically detected missing replacement to 404", async () => {
            const png = await sharp({
                create: {
                    width: 1,
                    height: 1,
                    channels: 3,
                    background: "#123456",
                },
            })
                .png()
                .toBuffer()
            const missing: any = new Error("missing")
            missing.statusCode = 404
            const replaceBinFileAsync = jest.fn().mockRejectedValue(missing)
            const repo = { replaceBinFileAsync } as any
            const findRepo = jest.spyOn(gitfs, "findRepo").mockReturnValue(repo)
            const permission = jest
                .spyOn(expander, "hasWritePermAsync")
                .mockResolvedValue(true)
            const response = routeResponse()
            const next = jest.fn()

            try {
                await (onReplaceImage as any)(
                    requestFixture({
                        appuser: "test@example.com",
                        body: {
                            page: "/site/page",
                            filename: "/site/img/missing.png",
                            full: png.toString("base64"),
                        },
                    } as any),
                    response,
                    next
                )
            } finally {
                findRepo.mockRestore()
                permission.mockRestore()
            }

            expect(replaceBinFileAsync).toHaveBeenCalledTimes(1)
            expect(response.status).toHaveBeenCalledWith(404)
            expect(response.end).toHaveBeenCalled()
            expect(next).not.toHaveBeenCalled()
        })
    })

    describe("/api/send-email", () => {
        const config = configFixture({
            mailgunApiKey: "mailgunApiKey",
            sendgridApiKey: "sendgridApiKey",
            allowedEmailRecipients: ["allowed@email.com"],
        })

        const responseMock = responseFixture({
            status: jest.fn(() => ({ end: jest.fn() })) as any,
        })

        it("accepts requests with allowed recipients", async () => {
            const request = requestFixture({
                body: msgFixture({ to: "allowed@email.com" }),
            })
            await onSendEmail(config)(request, responseMock, null)

            expect(responseMock.status).toHaveBeenCalledWith(200)
        })

        it("doesnt accept requests with unknown recipients", async () => {
            const request = requestFixture({
                body: msgFixture({ to: "disallowed@email.com" }),
            })
            await onSendEmail(config)(request, responseMock, null)

            expect(responseMock.status).toHaveBeenCalledWith(405)
        })

        it("doesnt accept incorrect body payloads", async () => {
            const request = requestFixture({
                body: msgFixture({
                    to: "allowed@email.com",
                    from: "fake email",
                }),
            })
            await onSendEmail(config)(request, responseMock, null)

            expect(responseMock.status).toHaveBeenCalledWith(422)
        })
    })
})

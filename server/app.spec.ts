import { onSendEmail } from "./app"
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

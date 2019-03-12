import * as mail from "./mail"
import * as gitfs from "./gitfs"

jest.mock("@sendgrid/mail", () => ({
    setApiKey: jest.fn(),
    send: jest.fn(() => Promise.resolve([{ body: "body" }])),
}))
import * as sendgrid from "@sendgrid/mail"

const msgFixture: mail.Message = { to: "to", subject: "subject", text: "text" }
const from = "serviceName <no-reply@mailgunDomain>"
const configFixture: gitfs.Config = { serviceName: "serviceName", mailgunDomain: "mailgunDomain", jwtSecret: "" }
const extend = <T>(o: T, delta: Partial<T>): T => ({ ...o, ...delta })

describe("sendAsync()", () => {
    beforeEach(jest.clearAllMocks)

    it("throws an error when given config contains no API key", async () => {
        try {
            expect.assertions(1)
            await mail.sendAsync(msgFixture, {} as any)
        } catch (err) {
            expect(err.message).toEqual("no sendmail provider")
        }
    })

    it("uses sendgrid when only config.sendgridApiKey is set", async () => {
        expect.assertions(2)
        await mail.sendAsync(msgFixture, { ...configFixture, sendgridApiKey: "sendgridApiKey" } as any)
        expect(sendgrid.setApiKey).toBeCalledWith("sendgridApiKey")
        expect(sendgrid.send).toBeCalledWith(extend(msgFixture, { from }), false)
    })
})

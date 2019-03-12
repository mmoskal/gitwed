import * as mail from "./mail"
import * as gitfs from "./gitfs"

jest.mock("@sendgrid/mail", () => ({
    setApiKey: jest.fn(),
    send: jest.fn(() => Promise.resolve([{ body: "body" }])),
}))
import * as sendgrid from "@sendgrid/mail"
const msgFixture: mail.Message = { to: "to", subject: "subject", text: "text" }
const configFixture: Partial<gitfs.Config> = {
    serviceName: "serviceName",
    mailgunDomain: "mailgunDomain"
}

describe("sendAsync()", () => {
    it("throws an error when given config contains no API key", async () => {
        try {
            expect.assertions(1)
            await mail.sendAsync(msgFixture, {} as any)
        } catch (err) {
            expect(err.message).toEqual("no sendmail provider")
        }
    })

    it("ueses sendgrid", async () => {
        try {
            await mail.sendAsync(msgFixture, { ...configFixture, sendgridApiKey: "foo" } as any)
            expect(sendgrid.setApiKey).toBeCalledWith("foo")
            expect(sendgrid.send).toBeCalledWith({ ...msgFixture, from: "serviceName <no-reply@mailgunDomain>" }, false)
        } catch (err) {
            expect(err.message).toEqual(false)
        }
    })
})

import * as mail from "./mail"

jest.mock("@sendgrid/mail", () => ({
    setApiKey: jest.fn(),
    send: jest.fn(() => Promise.resolve([{ body: "body" }])),
}))
import * as sendgrid from "@sendgrid/mail"

jest.mock("mailgun-js", () => { 
    const send = jest.fn((_, cb) => cb(null, "body"))
    return jest.fn(() => ({
        messages: jest.fn(()=> ({
            send
        }))
    })
)})
import * as MailgunJS from "mailgun-js"

import { validateMessage, resetMailgun } from "./mail"
import { msgFixture, configFixture } from "./fixtures";


const from = "serviceName <no-reply@mailgunDomain>"
const extend = <T>(o: T, delta: Partial<T>): T => ({ ...o, ...delta })

describe("sendAsync()", () => {
    beforeEach(jest.clearAllMocks)

    it("throws an error when given config contains no API key", async () => {
        try {
            expect.assertions(1)
            await mail.sendAsync(msgFixture(), {} as any)
        } catch (err) {
            expect(err.message).toEqual("no sendmail provider")
        }
    })

    it("uses sendgrid when only config.sendgridApiKey is set", async () => {
        expect.assertions(2)
        await mail.sendAsync(msgFixture(), configFixture({ sendgridApiKey: "sendgridApiKey" }))
        expect(sendgrid.setApiKey).toBeCalledWith("sendgridApiKey")
        expect(sendgrid.send).toBeCalledWith(msgFixture({ from }), false)
    })

    it("uses mailgun when only config.mailgunApiKey is set", async () => {
        expect.assertions(2)
        await mail.sendAsync(msgFixture(), configFixture({ mailgunApiKey: "mailgunApiKey" }))
        expect(MailgunJS).toBeCalledWith({ domain: "mailgunDomain", apiKey: "mailgunApiKey"})
        expect(
            //@ts-ignore second call is a function so we can't test that
            MailgunJS({ domain: "mailgunDomain", apiKey: "mailgunApiKey"}).messages().send.mock.calls[0][0]
        ).toMatchObject(msgFixture({ from }))
    })

    it("uses mailgun when both apiKeys are set", async () => {
        resetMailgun()
        await mail.sendAsync(msgFixture(), configFixture({ mailgunApiKey: "mailgunApiKey", sendgridApiKey: "sendgridApiKey" }))
        expect(MailgunJS).toBeCalledWith({ domain: "mailgunDomain", apiKey: "mailgunApiKey"})
        expect(
            //@ts-ignore second call is a function so we can't test that
            MailgunJS({ domain: "mailgunDomain", apiKey: "mailgunApiKey"}).messages().send.mock.calls[0][0]
        ).toMatchObject(msgFixture({ from }))
        expect(sendgrid.setApiKey).not.toBeCalled()
        expect(sendgrid.send).not.toBeCalled()
    })
})


describe("validateEmail()", () => {
    it("validates correct email", () => {
        expect(validateMessage(msgFixture())).toBeNull()
    })

    it("validates incorrect email recipent", () => {
        expect(validateMessage(msgFixture({ to: "incorrect" }))).toContain("recipent")
    })

    it("validates incorrect email sender", () => {
        expect(validateMessage(msgFixture({ from: "incorrect" }))).toContain("sender")
    })

    it("validates incorrect subject", () => {
        expect(validateMessage(msgFixture({ subject: "a".repeat(300) }))).toContain("subject")
        expect(validateMessage(msgFixture({ subject: 5 as unknown as string }))).toContain("subject")
    })

    it("validates incorrect text", () => {
        expect(validateMessage({ ...msgFixture(), text: 5 as unknown as string })).toContain("content")
    })
})
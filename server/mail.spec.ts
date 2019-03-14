import * as mail from "./mail"
import * as gitfs from "./gitfs"

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

import { validateMessage } from "./mail"

const msgFixture: mail.Message = { to: "to@gmail.com", subject: "subject", text: "text" }
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

    it("uses mailgun when only config.mailgunApiKey is set", async () => {
        expect.assertions(2)
        await mail.sendAsync(msgFixture, { ...configFixture, mailgunApiKey: "mailgunApiKey" } as any)
        expect(MailgunJS).toBeCalledWith({ domain: "mailgunDomain", apiKey: "mailgunApiKey"})
        expect(
            //@ts-ignore second call is a function so we can't test that
            MailgunJS({ domain: "mailgunDomain", apiKey: "mailgunApiKey"}).messages().send.mock.calls[0][0]
        ).toMatchObject(extend(msgFixture, { from }))
    })

    it("uses mailgun when only both apiKeys are set", async () => {
        await mail.sendAsync(msgFixture, { ...configFixture, mailgunApiKey: "mailgunApiKey", sendgridApiKey: "sendgridApiKey" } as any)
        // TODO: here, mailgun is already initialized because of previous test. But tests should not be dependent of each other. IDK how to solve that
        // expect(MailgunJS).toBeCalledWith({ domain: "mailgunDomain", apiKey: "mailgunApiKey"})
        expect(
            //@ts-ignore second call is a function so we can't test that
            MailgunJS({ domain: "mailgunDomain", apiKey: "mailgunApiKey"}).messages().send.mock.calls[0][0]
        ).toMatchObject(extend(msgFixture, { from }))
        expect(sendgrid.setApiKey).not.toBeCalled()
        expect(sendgrid.send).not.toBeCalled()
    })
})


describe("validateEmail()", () => {
    it("validates correct email", () => {
        const validationResult = validateMessage({ ...msgFixture })
        expect(validationResult).toBeNull()
    })

    it("validates incorrect email recipent", () => {
        const validationResult = validateMessage({ ...msgFixture, to: "incorrect" })
        expect(validationResult).toContain("recipent")
    })

    it("validates incorrect email sender", () => {
        const validationResult = validateMessage({ ...msgFixture, from: "incorrect" })
        expect(validationResult).toContain("sender")
    })

    it("validates incorrect subject", () => {
        let validationResult = validateMessage({ ...msgFixture, subject: "a".repeat(300) })
        expect(validationResult).toContain("subject")
        validationResult = validateMessage({ ...msgFixture, subject: 5 as unknown as string })
        expect(validationResult).toContain("subject")
    })

    it("validates incorrect text", () => {
        const validationResult = validateMessage({ ...msgFixture, text: 5 as unknown as string })
        expect(validationResult).toContain("content")
    })
})
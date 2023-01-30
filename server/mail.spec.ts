import * as mail from "./mail"

jest.mock("@sendgrid/mail", () => ({
    setApiKey: jest.fn(),
    send: jest.fn(() => Promise.resolve([{ body: "body" }])),
}))
import * as sendgrid from "@sendgrid/mail"

jest.mock("mailgun-js", () => {
    const send = jest.fn((_, cb) => cb(null, "body"))
    return jest.fn(() => ({
        messages: jest.fn(() => ({
            send,
        })),
    }))
})
import * as MailgunJS from "mailgun-js"

import { validateMessage, resetMailgun } from "./mail"
import { msgFixture, configFixture } from "./fixtures"

const from = "serviceName <no-reply@mailgunDomain.com>"
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
        await mail.sendAsync(
            msgFixture({ from: null }),
            configFixture({ sendgridApiKey: "sendgridApiKey" })
        )
        expect(sendgrid.setApiKey).toBeCalledWith("sendgridApiKey")
        expect(sendgrid.send).toBeCalledWith(msgFixture({ from }), false)
    })

    it("uses mailgun when only config.mailgunApiKey is set", async () => {
        expect.assertions(2)
        await mail.sendAsync(
            msgFixture({ from: null }),
            configFixture({ mailgunApiKey: "mailgunApiKey" })
        )
        expect(MailgunJS).toBeCalledWith({
            domain: "mailgunDomain.com",
            apiKey: "mailgunApiKey",
        })
        expect(
            MailgunJS({
                domain: "mailgunDomain.com",
                apiKey: "mailgunApiKey",
                //@ts-ignore second call is a function so we can't test that
            }).messages().send.mock.calls[0][0]
        ).toMatchObject(msgFixture({ from }))
    })

    it("uses mailgun when both apiKeys are set", async () => {
        resetMailgun()
        await mail.sendAsync(
            msgFixture({ from: null }),
            configFixture({
                mailgunApiKey: "mailgunApiKey",
                sendgridApiKey: "sendgridApiKey",
            })
        )
        expect(MailgunJS).toBeCalledWith({
            domain: "mailgunDomain.com",
            apiKey: "mailgunApiKey",
        })
        expect(
            MailgunJS({
                domain: "mailgunDomain.com",
                apiKey: "mailgunApiKey",
                //@ts-ignore second call is a function so we can't test that
            }).messages().send.mock.calls[0][0]
        ).toMatchObject(msgFixture({ from }))
        expect(sendgrid.setApiKey).not.toBeCalled()
        expect(sendgrid.send).not.toBeCalled()
    })
})

describe("validators", () => {
    const longEmail = `foo@${"x".repeat(255)}.com`
    describe("isValidString()", () => {
        it("fails when not string value is given", () => {
            expect(mail.isValidString(1)).toBeFalsy()
            expect(mail.isValidString(null)).toBeFalsy()
            expect(mail.isValidString(undefined)).toBeFalsy()
            expect(mail.isValidString([])).toBeFalsy()
            expect(mail.isValidString({})).toBeFalsy()
            expect(mail.isValidString(false)).toBeFalsy()
        })

        it("succeeds when string value is given", () => {
            expect(mail.isValidString(`foo`)).toBeTruthy()
            expect(mail.isValidString("")).toBeTruthy()
            expect(mail.isValidString("bar")).toBeTruthy()
        })

        it("fails when given string is to long", () =>
            expect(mail.isValidString("foo", 3)).toBeFalsy())

        it("succeeds when given param is string and short enough", () =>
            expect(mail.isValidString("foo", 4)).toBeTruthy())
    })

    describe("isValidEmail()", () => {
        it("fails when invalid email is given", () => {
            expect(mail.isValidEmail(1)).toBeFalsy()
            expect(mail.isValidEmail("foo")).toBeFalsy()
            expect(mail.isValidEmail("@foo.bar")).toBeFalsy()
            expect(mail.isValidEmail(longEmail)).toBeFalsy()
        })

        it("succeeds when given value is a string that seems to be email address", () => {
            expect(mail.isValidEmail("foo@example.com")).toBeTruthy()
        })
    })

    describe("validateMessage()", () => {
        const value: mail.Message = {
            from: "from@example.com",
            to: "to@example.com",
            text: "text",
            subject: "subject",
        }
        it("validates correct email", () =>
            expect(validateMessage(value)).toEqual({ type: "Ok", value }))

        it("fails when msg.from is invalid", () => {
            const expected = {
                type: "Err",
                error: "message validation failed, invalid fields: from",
            }
            expect(validateMessage(extend(value, { from: null }))).toEqual(
                expected
            )
            expect(validateMessage(extend(value, { from: "foo" }))).toEqual(
                expected
            )
            expect(validateMessage(extend(value as any, { from: 1 }))).toEqual(
                expected
            )
            expect(validateMessage(extend(value, { from: longEmail }))).toEqual(
                expected
            )
        })

        it("fails when msg.to is invalid", () => {
            const expected = {
                type: "Err",
                error: "message validation failed, invalid fields: to",
            }
            expect(validateMessage(extend(value, { to: null }))).toEqual(
                expected
            )
            expect(validateMessage(extend(value, { to: "foo" }))).toEqual(
                expected
            )
            expect(validateMessage(extend(value as any, { to: 1 }))).toEqual(
                expected
            )
            expect(validateMessage(extend(value, { to: longEmail }))).toEqual(
                expected
            )
        })
        it("fails when msg.subject is invalid", () => {
            const expected = {
                type: "Err",
                error: "message validation failed, invalid fields: subject",
            }
            expect(validateMessage(extend(value, { subject: null }))).toEqual(
                expected
            )
            expect(
                validateMessage(extend(value as any, { subject: 1 }))
            ).toEqual(expected)
            expect(
                validateMessage(extend(value, { subject: "x".repeat(255) }))
            ).toEqual(expected)
        })

        it("fails when msg.text is invalid", () => {
            const expected = {
                type: "Err",
                error: "message validation failed, invalid fields: text",
            }
            expect(validateMessage(extend(value, { text: null }))).toEqual(
                expected
            )
            expect(validateMessage(extend(value as any, { text: 1 }))).toEqual(
                expected
            )
            expect(
                validateMessage(extend(value, { text: "x".repeat(1025) }))
            ).toEqual(expected)
        })

        it("fails when alle fields are invalid", () => {
            const expected = {
                type: "Err",
                error: "message validation failed, invalid fields: from, to, subject, text",
            }
            expect(validateMessage({})).toEqual(expected)
        })
    })
})

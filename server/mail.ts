import * as gitfs from "./gitfs"
import winston = require('winston')
import * as sendGrid from "@sendgrid/mail"
import * as MailgunJs from "mailgun-js"

let mailgun: MailgunJs.Mailgun

export type Message = {
    from: string;
    to: string;
    subject: string;
    text: string;
}

type SendEmailFn = (msg: Message & { from: string }, config: gitfs.Config) => Promise<string>

export const isValidString = (str: any, len = 254, regex: RegExp = null): str is String =>
    typeof str === "string" && str.length < len && (regex ? regex.test(str) : true)

export const isValidEmail = (str: any): str is string => isValidString(str, 128, /^.+@.+\..+$/)
export const Err = <T>(error: T): Err<T> => ({ type: "Err", error })
export const Ok = <T>(value: T): Ok<T> => ({ type: "Ok", value })
type Ok<T> = { type: "Ok"; value: T }
type Err<T> = { type: "Err"; error: T }
export type Result<Value, Error> = Ok<Value> | Err<Error>

export const validateMessage = (msg: any): Result<Message, string> => {
    if (!msg || typeof msg !== "object") return Err("Invalid msg object")
    const errors = []
    const { from, to, subject, text } = msg
    if (!isValidEmail(from)) errors.push("from")
    if (!isValidEmail(to)) errors.push("to")
    if (!isValidString(subject)) errors.push("subject");
    if (!isValidString(text, 10000)) errors.push("text");

    return errors.length
        ? Err(`message validation failed, invalid fields: ${errors.join(", ")}`)
        : Ok({ from, to, subject, text })
}

const sendgridSend: SendEmailFn = async (msg, config) => {
    sendGrid.setApiKey(config.sendgridApiKey)
    const res = await sendGrid.send(msg, false)
    return res[0].body
}

const mailgunSend: SendEmailFn = (msg, config) => {
    if (!mailgun)
        mailgun = MailgunJs({ apiKey: config.mailgunApiKey, domain: config.mailgunDomain })

    return new Promise((resolve, reject) =>
        mailgun.messages().send(msg, (err: any, body: any) => err ? reject(err) : resolve(body))
    )
}

export function sendAsync(msg: Message, config?: gitfs.Config) {
    winston.info(`sending email, to: ${msg.to}, subject: ${msg.subject}`)

    if (!config) config = gitfs.config
    if (!msg || typeof msg !== "object") {
        winston.error("Invalid msg ", msg)
        return Promise.reject("Invalid msg")
    }

    const from = msg.from || config.serviceName + " <no-reply@" + config.mailgunDomain + ">"
    const validationResult = validateMessage({ ...msg, from })
    if (validationResult.type === "Err") {
        winston.error(validationResult.error)
        return Promise.reject(validationResult.error)
    }

    let send: SendEmailFn
    if (config.mailgunApiKey) {
        send = mailgunSend
        winston.info("using mailgun")
    } else if (config.sendgridApiKey) {
        send = sendgridSend
        winston.info("using sendgrid")
    }

    return new Promise(async (resolve, reject) => {
        try {
            if (!send) throw new Error("no sendmail provider")
            winston.debug('mail:', await send(validationResult.value, config))
            resolve()
        } catch (err) {
            winston.error("email send failed: " + err.message)
            reject(err)
        }
    })
}

export function resetMailgun() {
    mailgun = null
}

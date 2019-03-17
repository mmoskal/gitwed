import * as gitfs from "./gitfs"
import winston = require('winston')
import * as sendGrid from "@sendgrid/mail"
import * as MailgunJs from "mailgun-js"

let mailgun: MailgunJs.Mailgun

export type Message = {
    from?: string;
    to: string;
    subject: string;
    text: string;
}

type SendEmailFn = (msg: Message & { from: string }, config: gitfs.Config) => Promise<string>

export const validateMessage = (msg: Message) => {
    if (!msg || typeof msg !== "object") msg = {} as any
    const emailRegex = /^.+@.+\..+$/
    const errors = []

    if (msg.from && (!emailRegex.test(msg.from) || msg.subject.length > 254)) errors.push("sender")
    if (!emailRegex.test(msg.to) || msg.subject.length > 254) errors.push("recipient");
    if (typeof msg.subject !== "string" || msg.subject.length > 255) errors.push("subject")
    if (typeof msg.text !== "string" || msg.text.length > 1024) errors.push("text")

    return errors.length ?
        `email message validation failed, invalid fields: ${errors.join(", ")}` : null
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
    const from = msg.from || config.serviceName + " <no-reply@" + config.mailgunDomain + ">"

    const validationError = validateMessage(msg)
    if (validationError) {
        winston.error(validationError)
        return Promise.reject(validationError)
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
            winston.debug('mail:', await send({ ...msg, from }, config))
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

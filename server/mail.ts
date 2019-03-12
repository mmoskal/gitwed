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

const sendgridSend: SendEmailFn = async (msg, config) => {
    sendGrid.setApiKey(config.sendgridApiKey)
    const res = await sendGrid.send(msg, false)
    return res[0].body
}

const mailgunSend: SendEmailFn = (msg, config) => {
    if (!mailgun)
        mailgun = new MailgunJs({ apiKey: config.mailgunApiKey, domain: config.mailgunDomain })

    return new Promise((resolve, reject) =>
        mailgun.messages().send(msg, (err: any, body: any) => err ? reject(err) : resolve(body))
    )
}

export function sendAsync(msg: Message, config?: gitfs.Config) {
    winston.info(`sending email, to: ${msg.to}, subject: ${msg.subject}`)
    if (!config) config = gitfs.config
    const from = msg.from || config.serviceName + " <no-reply@" + config.mailgunDomain + ">"

    let send: SendEmailFn
    if (config.mailgunApiKey)
        send = mailgunSend
    else if (config.sendgridApiKey)
        send = sendgridSend

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

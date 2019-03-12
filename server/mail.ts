import gitfs = require('./gitfs')
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

type SendEmailFn = (msg: Message & { from: string }) => Promise<string>

const sendgridSend: SendEmailFn = async (msg) => {
    sendGrid.setApiKey(gitfs.config.sendgridApiKey)
    const res = await sendGrid.send(msg, false)
    return res[0].body
}

const mailgunSend: SendEmailFn = msg => {
    if (!mailgun)
        mailgun = new MailgunJs({ apiKey: gitfs.config.mailgunApiKey, domain: gitfs.config.mailgunDomain })

    return new Promise((resolve, reject) =>
        mailgun.messages().send(msg, (err: any, body: any) => err ? reject(err) : resolve(body))
    )
}

export function sendAsync(msg: Message) {
    winston.info(`sending email, to: ${msg.to}, subject: ${msg.subject}`)
    const from = msg.from || gitfs.config.serviceName + " <no-reply@" + gitfs.config.mailgunDomain + ">"

    let send: SendEmailFn
    if (gitfs.config.mailgunApiKey)
        send = mailgunSend
    else if (gitfs.config.sendgridApiKey)
        send = sendgridSend


    return new Promise(async (resolve, reject) => {
        try {
            if (!send) throw new Error("no sendmail provider")
            winston.debug('mail:', await send({ ...msg, from }))
            resolve()
        } catch (err) {
            winston.error("email send failed: " + err.message)
            reject(err)
        }
    })
}

import tools = require('./tools')
import gitfs = require('./gitfs')
import bluebird = require('bluebird')
import winston = require('winston')
import logs = require('./logs')

let mailgun: any

export interface Message {
    from?: string;
    to: string;
    subject: string;
    text: string;
}

export function sendAsync(msg: Message) {
    winston.info(`sending email, to: ${msg.to}, subject: ${msg.subject}`)
    if (!mailgun) {
        mailgun = require('mailgun-js')({
            apiKey: gitfs.config.mailgunApiKey,
            domain: gitfs.config.mailgunDomain
        });
    }
    if (!msg.from)
        msg.from = "GitWed Login <no-reply@" + gitfs.config.mailgunDomain + ">"
    return new Promise<void>((resolve, reject) => {
        mailgun.messages().send(msg, (err: any, body: any) => {
            if (err) {
                winston.error("email send failed: " + err.message)
                reject(err)
            } else {
                winston.debug('mail:', body)
                resolve()
            }
        });
    })
}

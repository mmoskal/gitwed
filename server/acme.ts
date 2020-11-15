import express = require('express');
import fs = require('fs');
import http = require('http');
import https = require('https');
import winston = require('winston')

import gitfs = require('./gitfs')
import mail = require('./mail')

const wellKnowns: any = {}

export function init(app: express.Express) {
    app.get(/^\/\.well-known\/(.*)/, (req, res) => {
        if (wellKnowns.hasOwnProperty(req.params[0])) {
            res.contentType("text/plain")
            res.send(wellKnowns[req.params[0]])
        } else {
            res.status(404).end('Not well known.');
        }
    })
}

interface SavedCert {
    duration: number; // days
    lastWrite: number; // ms
    renewTime: number; // ms
    domains: string[];
    cert: string; // base64-encoded PFX with empty password
}

const certPath = "certificate.json"

export async function setupCertsAndListen(app: express.Express, cfg: gitfs.Config) {
    http.createServer(app)
        .listen(80, function () {
            winston.info("Listening for ACME http-01 challenges");
        });

    const mainDomain = cfg.authDomain.replace(/^https:\/\//, "").replace(/\/$/, "")
    const domains = Object.keys(cfg.vhosts || {})
    domains.unshift(mainDomain)

    let savedCert: SavedCert
    let needsRenew = true
    try {
        savedCert = JSON.parse(fs.readFileSync(certPath, "utf8"))
        needsRenew = false
    } catch (e) { }

    if (savedCert) {
        // if domains changed, ignore the cert
        if (JSON.stringify(domains) != JSON.stringify(savedCert.domains))
            needsRenew = true

        if (savedCert.renewTime < Date.now())
            needsRenew = true
    }

    if (needsRenew) {
        try {
            winston.info("renewing cert for " + domains.join(", "))
            await renewAsync(domains, cfg);
            savedCert = JSON.parse(fs.readFileSync(certPath, "utf8"))
            await mail.sendAsync({
                to: cfg.certEmail,
                from: null,
                subject: "cert renewed for " + domains[0],
                text: "All domains: " + domains.join(", ")
            }).then(() => { }, () => { })
        } catch (e) {
            console.error(e)
            winston.error(e.stack)
            await mail.sendAsync({
                to: cfg.certEmail,
                from: null,
                subject: "failure to renew certs",
                text: e.message + "\n" + e.stack,
            })
            if (savedCert) {
                // don't try to renew for another 24h
                savedCert.renewTime = Date.now() + 24 * 3600 * 1000
                savedCert.domains = domains
                fs.writeFileSync(certPath, JSON.stringify(savedCert, null, 4));
            }
        }
    } else {
        winston.info("not renewing cert")
    }

    if (!savedCert)
        return

    https.createServer({
        passphrase: "",
        pfx: Buffer.from(savedCert.cert, "base64")
    }, app)
        .listen(443, function () {
            winston.info("Starting HTTPS server");
        });
}

async function renewAsync(domains: string[], cfg: gitfs.Config) {
    const acme = require('acme-client');
    const client = new acme.Client({
        directoryUrl: acme.directory.letsencrypt.production,
        accountKey: await acme.forge.createPrivateKey()
    });

    const [key, csr] = await acme.forge.createCsr({
        commonName: domains[0],
        altNames: domains.slice(1)
    });

    const cert: string = await client.auto({
        csr,
        email: cfg.certEmail,
        termsOfServiceAgreed: true,
        challengeCreateFn: (authz: any, challenge: any, keyAuthorization: any) => {
            if (challenge.type === 'http-01') {
                wellKnowns[`acme-challenge/${challenge.token}`] = keyAuthorization;
                winston.info(`Creating challenge response for ${authz.identifier.value} at path: ${challenge.token}}`);
            }
            return Promise.resolve();
        },
        challengeRemoveFn: () => Promise.resolve()
    });

    const forge = require('node-forge');
    const pemCerts = cert.split("\n\n").filter(s => !!s && !!s.trim());
    const forgeCerts = pemCerts.map(pem => forge.pki.certificateFromPem(pem));
    const privateKey = forge.pki.privateKeyFromPem(key);
    const asn1 = forge.pkcs12.toPkcs12Asn1(privateKey, forgeCerts, "");
    const pfx = forge.asn1.toDer(asn1).getBytes();
    const b64 = forge.util.encode64(pfx);

    const notBefore: number = forgeCerts[0].validity.notBefore.getTime();
    const notAfter: number = forgeCerts[0].validity.notAfter.getTime();
    const duration = notAfter - notBefore;
    const renewTime = notBefore + duration * 2 / 3;

    const certObj: SavedCert = {
        duration: duration / 1000 / 3600 / 24,
        lastWrite: Date.now(),
        renewTime,
        domains,
        cert: b64,
    }

    fs.writeFileSync(certPath, JSON.stringify(certObj, null, 4));
}


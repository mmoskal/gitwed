import * as mail from "./mail";
import * as gitfs from "./gitfs";
import * as express from "express"

export const fixtureFactory = <T>(defaults: T) => (
  params: Partial<T> = {}
): T => ({ ...defaults, ...params });

export const msgFixture = fixtureFactory<mail.Message>({
  to: "to@gmail.com",
  subject: "subject",
  text: "text"
});

export const configFixture = fixtureFactory<gitfs.Config>({
  serviceName: "serviceName",
  mailgunDomain: "mailgunDomain",
  jwtSecret: ""
});

export const requestFixture = fixtureFactory<express.Request>({
  body: {},
  rawHeaders: [],
} as express.Request)

export const responseFixture = fixtureFactory<express.Response>({
} as express.Response)
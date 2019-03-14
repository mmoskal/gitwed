import { onSendEmail } from "./app";
import {
  configFixture,
  requestFixture,
  msgFixture,
  responseFixture
} from "./fixtures";

jest.mock("mailgun-js", () => {
  const send = jest.fn((_, cb) => cb(null, "body"));
  return jest.fn(() => ({
    messages: jest.fn(() => ({
      send
    }))
  }));
});

describe("API", () => {
  describe("/api/send-email", () => {
    const config = configFixture({
      mailgunApiKey: "mailgunApiKey",
      mailgunDomain: "mailgunDomain",
      sendgridApiKey: "sendgridApiKey",
      allowedEmailOrigns: ["allowed.com"]
    });

    const responseMock = responseFixture({
      status: jest.fn(() => ({ end: jest.fn() })) as any
    });

    it("accepts requests from allowed origins", async () => {
      const request = requestFixture({
        rawHeaders: ["Host", "allowed.com"],
        body: msgFixture()
      });
      await onSendEmail(config)(request, responseMock, null);

      expect(responseMock.status).toBeCalledWith(200);
    });

    it("doesnt accept requests from disallowed origins", async () => {
      const request = requestFixture({
        rawHeaders: ["Host", "disallowed.com"],
        body: msgFixture()
      });
      await onSendEmail(config)(request, responseMock, null);

      expect(responseMock.status).toBeCalledWith(405);
    });

    it("doesnt accept incorrect body payloads", async () => {
      const request = requestFixture({
        rawHeaders: ["Host", "allowed.com"],
        body: msgFixture({ to: "fake email" })
      });
      await onSendEmail(config)(request, responseMock, null);

      expect(responseMock.status).toBeCalledWith(422);
    });
  });
});

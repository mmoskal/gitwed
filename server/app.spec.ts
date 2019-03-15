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
      sendgridApiKey: "sendgridApiKey",
      allowedEmailRecipients: ["allowed@email.com"]
    });

    const responseMock = responseFixture({
      status: jest.fn(() => ({ end: jest.fn() })) as any
    });

    it("accepts requests with allowed recipients", async () => {
      const request = requestFixture({
        body: msgFixture({ to: "allowed@email.com" })
      });
      await onSendEmail(config)(request, responseMock, null);

      expect(responseMock.status).toBeCalledWith(200);
    });

    it("doesnt accept requests with unknown recipients", async () => {
      const request = requestFixture({
        body: msgFixture({ to: "disallowed@email.com" })
      });
      await onSendEmail(config)(request, responseMock, null);

      expect(responseMock.status).toBeCalledWith(405);
    });

    it("doesnt accept incorrect body payloads", async () => {
      const request = requestFixture({
        body: msgFixture({ to: "allowed@email.com", from: "fake email" })
      });
      await onSendEmail(config)(request, responseMock, null);

      expect(responseMock.status).toBeCalledWith(422);
    });
  });
});

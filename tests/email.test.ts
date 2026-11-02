// Transactional email: links keep the token out of servers' logs, and production never falls back
// to printing a message (which would print its link).
import { afterEach, describe, expect, it, vi } from "vitest";
import { resendMailer, resetPassword, verifyEmail } from "../server/src/email";

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
  vi.restoreAllMocks();
});

describe("email", () => {
  it("puts the token after # and escapes names in the HTML", () => {
    process.env.APP_URL = "https://veridict.example/";
    const e = verifyEmail("<Ana>", "t".repeat(43));
    expect(e.text).toContain(`https://veridict.example/#/verify?token=${"t".repeat(43)}`);
    expect(e.html).toContain("&lt;Ana&gt;");
    expect(e.html).not.toContain("<Ana>");
    expect(resetPassword("Ana", "r".repeat(43)).text).toContain("/#/reset?token=");
  });

  it("refuses to send in production without Resend settings, and logs nothing", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.RESEND_API_KEY;
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await expect(resendMailer({ ...verifyEmail("Ana", "t".repeat(43)), to: "a@b.law" })).rejects.toThrow(/isn't configured/);
    expect(log).not.toHaveBeenCalled();
  });

  it("prints the message instead of sending in development without Resend", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.RESEND_API_KEY;
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const net = vi.spyOn(globalThis, "fetch");
    await resendMailer({ ...verifyEmail("Ana", "t".repeat(43)), to: "a@b.law" });
    expect(log.mock.calls[0][0]).toContain("#/verify?token=");
    expect(net).not.toHaveBeenCalled();
  });

  it("calls Resend with the key and sender from the environment", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.EMAIL_FROM = "Veridict <no-reply@mail.example>";
    const net = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await resendMailer({ to: "a@b.law", subject: "s", text: "t", html: "h" });
    const [url, init] = net.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer re_test");
    expect(JSON.parse(String(init.body))).toMatchObject({ from: "Veridict <no-reply@mail.example>", to: ["a@b.law"] });
  });
});

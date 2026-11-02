// Account pages: sign in, create an account, forgot password, choose a new password, and the email
// verification link. One centered card each, in the app's own type and colour.

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { MailCheck } from "lucide-react";
import { Mark } from "../components/Shell";
import { Alert, Button, inputClass } from "../components/ui";
import { PasswordInput, PasswordRules, passwordOk } from "../components/PasswordInput";
import { api, type User } from "../lib/api";
import { href } from "../lib/router";


function AuthCard({ title, description, children, footer }: { title: string; description?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 py-12">
      <a href={href.overview()} className="mb-8 flex items-center gap-2.5 text-navy">
        <Mark className="size-9 text-navy [&_path:last-child]:fill-slate" />
        <span className="font-serif text-[28px] font-semibold tracking-[-0.01em]">Veridict</span>
      </a>
      <div className="w-full max-w-[25rem] rounded-xl border border-line bg-sheet">
        <div className="border-b border-rule px-7 pt-6 pb-5">
          <h1 className="font-serif text-xl font-semibold">{title}</h1>
          {description && <p className="mt-1 text-sm leading-5 text-muted">{description}</p>}
        </div>
        <div className="px-7 py-6">{children}</div>
        {footer && <div className="border-t border-rule px-7 py-4 text-center text-sm text-muted">{footer}</div>}
      </div>
    </main>
  );
}

function Labeled({ label, hint, children }: { label: string; hint?: string; children: (id: string, hintId?: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="text-sm">
      <label htmlFor={id} className="font-medium">{label}</label>
      <div className="mt-1.5">{children(id, hint ? `${id}-hint` : undefined)}</div>
      {hint && <p id={`${id}-hint`} className="mt-1.5 text-xs text-faint">{hint}</p>}
    </div>
  );
}

const linkClass = "font-semibold text-ink hover:underline";

// Submitting a form: busy while it runs, the server's message if it fails.
function useSubmit<T>(run: () => Promise<T>, done: (r: T) => void) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      done(await run());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { submit, error, busy };
}

export function SignInPage({ onSignedIn }: { onSignedIn: (u: User) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { submit, error, busy } = useSubmit(() => api.signIn(email.trim(), password), (r) => onSignedIn(r.user));
  return (
    <AuthCard title="Sign in" description="Review potential contradictions in your witnesses' testimony." footer={<>New to Veridict? <a href={href.register()} className={linkClass}>Create an account</a></>}>
      <form onSubmit={submit} className="space-y-4">
        <Labeled label="Email">{(id) => <input id={id} type="email" className={inputClass} value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" autoFocus />}</Labeled>
        <Labeled label="Password">{(id) => <PasswordInput id={id} value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />}</Labeled>
        <p className="-mt-1 text-right text-sm"><a href={href.forgot()} className="text-muted hover:text-ink hover:underline">Forgot your password?</a></p>
        {error && <Alert>{error}</Alert>}
        <Button type="submit" className="h-10 w-full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Button>
      </form>
    </AuthCard>
  );
}

export function RegisterPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const { submit, error, busy } = useSubmit(() => api.signUp({ name: name.trim(), email: email.trim(), password }), () => setSentTo(email.trim()));
  if (sentTo) return <CheckEmail email={sentTo} what="verify your email and finish creating your account" />;
  return (
    <AuthCard title="Create your account" description="Veridict is in early access. Your cases are visible only to your account." footer={<>Already have an account? <a href={href.signin()} className={linkClass}>Sign in</a></>}>
      <form onSubmit={submit} className="space-y-4">
        <Labeled label="Your name">{(id) => <input id={id} className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} autoComplete="name" autoFocus />}</Labeled>
        <Labeled label="Email">{(id) => <input id={id} type="email" className={inputClass} value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />}</Labeled>
        <Labeled label="Password">{(id) => <><PasswordInput id={id} value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" aria-describedby={`${id}-rules`} /><PasswordRules id={`${id}-rules`} password={password} /></>}</Labeled>
        {error && <Alert>{error}</Alert>}
        <Button type="submit" className="h-10 w-full" disabled={busy || !name.trim() || !email.trim() || !passwordOk(password)}>{busy ? "Creating account…" : "Create account"}</Button>
        <p className="text-xs leading-5 text-faint">We'll email a link to confirm your address. Checks that use the AI model are enabled separately during early access.</p>
      </form>
    </AuthCard>
  );
}

function CheckEmail({ email, what }: { email: string; what: string }) {
  return (
    <AuthCard title="Check your email" footer={<a href={href.signin()} className={linkClass}>Back to sign in</a>}>
      <div className="flex gap-4">
        <MailCheck aria-hidden className="mt-0.5 size-6 flex-none text-slate" strokeWidth={1.6} />
        <p className="text-sm leading-6">If <strong className="font-semibold">{email}</strong> can be used, we've sent it a link to {what}. It may take a minute to arrive; check your spam folder too.</p>
      </div>
    </AuthCard>
  );
}

export function ForgotPage() {
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const { submit, error, busy } = useSubmit(() => api.forgotPassword(email.trim()), () => setSentTo(email.trim()));
  if (sentTo) return <CheckEmail email={sentTo} what="choose a new password. The link expires in 1 hour" />;
  return (
    <AuthCard title="Reset your password" description="Enter your account's email and we'll send a link to choose a new password." footer={<a href={href.signin()} className={linkClass}>Back to sign in</a>}>
      <form onSubmit={submit} className="space-y-4">
        <Labeled label="Email">{(id) => <input id={id} type="email" className={inputClass} value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" autoFocus />}</Labeled>
        {error && <Alert>{error}</Alert>}
        <Button type="submit" className="h-10 w-full" disabled={busy}>{busy ? "Sending…" : "Send reset link"}</Button>
      </form>
    </AuthCard>
  );
}

export function ResetPage({ token, onSignedIn }: { token: string; onSignedIn: (u: User) => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const mismatch = confirm.length > 0 && confirm !== password;
  const { submit, error, busy } = useSubmit(() => api.resetPassword(token, password), (r) => {
    window.location.hash = href.overview();
    onSignedIn(r.user);
  });
  if (!token) return <AuthCard title="This link isn't complete" description="Open the link from your email again, or ask for a new one." footer={<a href={href.forgot()} className={linkClass}>Send a new link</a>}>{null}</AuthCard>;
  return (
    <AuthCard title="Choose a new password" description="Every other device will be signed out." footer={<a href={href.forgot()} className={linkClass}>Send a new link</a>}>
      <form onSubmit={submit} className="space-y-4">
        <Labeled label="New password">{(id) => <><PasswordInput id={id} value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" aria-describedby={`${id}-rules`} autoFocus /><PasswordRules id={`${id}-rules`} password={password} /></>}</Labeled>
        <Labeled label="Confirm new password">{(id) => <PasswordInput id={id} value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="new-password" aria-invalid={mismatch} />}</Labeled>
        {mismatch && <p className="text-sm text-conflict">The passwords don't match.</p>}
        {error && <Alert>{error}</Alert>}
        <Button type="submit" className="h-10 w-full" disabled={busy || !passwordOk(password) || confirm !== password}>{busy ? "Saving…" : "Save new password"}</Button>
      </form>
    </AuthCard>
  );
}

// The link from the verification email. It runs once (a token works once), then signs this browser in.
export function VerifyPage({ token, onSignedIn }: { token: string; onSignedIn: (u: User) => void }) {
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!token) return setError("This link isn't complete. Open it from your email again.");
    api.verifyEmail(token).then((r) => {
      window.location.hash = href.overview();
      onSignedIn(r.user);
    }).catch((e: Error) => setError(e.message));
  }, [token, onSignedIn]);
  return (
    <AuthCard title={error ? "We couldn't verify this link" : "Verifying your email…"} footer={error ? <a href={href.signin()} className={linkClass}>Sign in to send a new link</a> : undefined}>
      {error ? <Alert>{error}</Alert> : <p className="text-sm text-muted">One moment.</p>}
    </AuthCard>
  );
}

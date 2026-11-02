// Sign in, or create an account when sign-up is open (always for the very first account).

import { useEffect, useId, useState, type FormEvent } from "react";
import { Mark } from "../components/Shell";
import { Alert, Button, cx, inputClass } from "../components/ui";
import { api, type User } from "../lib/api";

const MIN_PASSWORD = 10; // server/src/auth.ts

export function SignInPage({ onSignedIn, initialMode = "signin" }: { onSignedIn: (u: User) => void; initialMode?: "signin" | "signup" }) {
  const ids = useId();
  const [config, setConfig] = useState<{ signupOpen: boolean; firstUser: boolean } | null>(null);
  const [mode, setMode] = useState<"signin" | "signup">(initialMode);
  const [name, setName] = useState("");
  const [firm, setFirm] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.authConfig().then((c) => {
      setConfig(c);
      if (c.firstUser) setMode("signup");
      if (!c.signupOpen) setMode("signin");
    }).catch((e: Error) => setError(e.message));
  }, []);

  const signup = mode === "signup";
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = signup ? await api.signUp({ name: name.trim(), firm: firm.trim(), email: email.trim(), password }) : await api.signIn(email.trim(), password);
      onSignedIn(user);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-canvas px-4 py-12">
      <a href="#/" className="mb-8 flex items-center gap-2.5 text-navy">
        <Mark className="size-9 text-navy [&_path:last-child]:fill-slate" />
        <span className="font-serif text-[28px] font-semibold tracking-[-0.01em]">Veridict</span>
      </a>
      <div className="w-full max-w-[25rem] rounded-xl border border-line bg-sheet">
        <div className="border-b border-rule px-7 pt-6 pb-5">
          <h1 className="font-serif text-xl font-semibold">{signup ? (config?.firstUser ? "Set up Veridict" : "Create your account") : "Sign in"}</h1>
          <p className="mt-1 text-sm text-muted">{signup ? (config?.firstUser ? "You are the first account. Your firm will hold the cases already here." : "Your firm's cases stay visible only to your firm.") : "Review potential contradictions in your witnesses' testimony."}</p>
        </div>
        <form onSubmit={submit} className="space-y-4 px-7 py-6">
          {signup && (
            <>
              <Labeled id={`${ids}-name`} label="Your name"><input id={`${ids}-name`} className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} autoComplete="name" /></Labeled>
              <Labeled id={`${ids}-firm`} label="Firm"><input id={`${ids}-firm`} className={inputClass} value={firm} onChange={(e) => setFirm(e.target.value)} required maxLength={200} autoComplete="organization" /></Labeled>
            </>
          )}
          <Labeled id={`${ids}-email`} label="Email"><input id={`${ids}-email`} type="email" className={inputClass} value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" autoFocus={!signup} /></Labeled>
          <Labeled id={`${ids}-password`} label="Password" hint={signup ? `At least ${MIN_PASSWORD} characters.` : undefined}>
            <input id={`${ids}-password`} type="password" className={inputClass} value={password} onChange={(e) => setPassword(e.target.value)} required minLength={signup ? MIN_PASSWORD : 1} autoComplete={signup ? "new-password" : "current-password"} aria-describedby={signup ? `${ids}-password-hint` : undefined} />
          </Labeled>
          {error && <Alert>{error}</Alert>}
          <Button type="submit" className="h-10 w-full" disabled={busy || !config}>{busy ? (signup ? "Creating account…" : "Signing in…") : signup ? "Create account" : "Sign in"}</Button>
        </form>
        {config?.signupOpen && !config.firstUser && (
          <p className="border-t border-rule px-7 py-4 text-center text-sm text-muted">
            {signup ? "Already have an account? " : "New to Veridict? "}
            <button type="button" onClick={() => { setMode(signup ? "signin" : "signup"); setError(null); }} className="font-semibold text-ink hover:underline">{signup ? "Sign in" : "Create an account"}</button>
          </p>
        )}
      </div>
      <p className={cx("mt-6 max-w-[25rem] text-center text-xs text-faint")}>Sessions last 30 days on this browser. Sign out on shared computers.</p>
    </main>
  );
}

function Labeled({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="text-sm">
      <label htmlFor={id} className="font-medium">{label}</label>
      <div className="mt-1.5">{children}</div>
      {hint && <p id={`${id}-hint`} className="mt-1.5 text-xs text-faint">{hint}</p>}
    </div>
  );
}

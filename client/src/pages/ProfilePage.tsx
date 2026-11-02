// The signed-in account: name, email and password, each saved on its own.

import { useId, useState, type FormEvent, type ReactNode } from "react";
import { PasswordInput, PasswordRules, passwordOk } from "../components/PasswordInput";
import { Alert, Badge, Button, Card, CardHeader, inputClass, PageHeader } from "../components/ui";
import { api, type User } from "../lib/api";

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <Card className="grid gap-x-10 md:grid-cols-[16rem_minmax(0,1fr)]">
      <div className="px-5 pt-5 md:pb-5">
        <h2 className="text-md font-semibold">{title}</h2>
        <p className="mt-1 text-sm leading-5 text-muted">{description}</p>
      </div>
      <div className="px-5 py-5">{children}</div>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="text-sm">
      <label htmlFor={id} className="font-medium">{label}</label>
      <div className="mt-1.5">{children(id)}</div>
    </div>
  );
}

// One form's state: busy, and the outcome message from the server.
function useForm() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const run = (task: () => Promise<string>) => async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      setResult({ ok: true, text: await task() });
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return { busy, result, run };
}

export function ProfilePage({ user, onUser }: { user: User; onUser: (u: User) => void }) {
  const [name, setName] = useState(user.name);
  const nameForm = useForm();
  const [email, setEmail] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const emailForm = useForm();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const passwordForm = useForm();

  return (
    <>
      <PageHeader title="Profile" description="Your account's name, email and password." />

      <Section title="Name" description="Shown in the sidebar and in the emails Veridict sends you.">
        <form onSubmit={nameForm.run(async () => {
          const r = await api.updateProfile(name.trim());
          onUser(r.user);
          return "Name saved.";
        })} className="max-w-md space-y-4">
          <Row label="Your name">{(id) => <input id={id} className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} autoComplete="name" />}</Row>
          <Outcome result={nameForm.result} />
          <Button type="submit" disabled={nameForm.busy || !name.trim() || name.trim() === user.name}>{nameForm.busy ? "Saving…" : "Save name"}</Button>
        </form>
      </Section>

      <Section title="Email" description="Where sign-in links and notices go. A new address must be verified before you can add depositions again.">
        <p className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">{user.email}</span>
          {user.emailVerified ? <Badge tone="good">Verified</Badge> : <Badge tone="warn">Not verified</Badge>}
        </p>
        <form onSubmit={emailForm.run(async () => {
          const r = await api.changeEmail(email.trim(), emailPassword);
          const me = await api.me();
          onUser(me.user);
          setEmail("");
          setEmailPassword("");
          return r.message;
        })} className="max-w-md space-y-4">
          <Row label="New email">{(id) => <input id={id} type="email" className={inputClass} value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />}</Row>
          <Row label="Current password">{(id) => <PasswordInput id={id} value={emailPassword} onChange={(e) => setEmailPassword(e.target.value)} required autoComplete="current-password" />}</Row>
          <Outcome result={emailForm.result} />
          <Button type="submit" disabled={emailForm.busy || !email.trim() || !emailPassword}>{emailForm.busy ? "Sending…" : "Change email"}</Button>
        </form>
      </Section>

      <Section title="Password" description="Changing it signs you out on every other device.">
        <form onSubmit={passwordForm.run(async () => {
          const r = await api.changePassword(current, next);
          setCurrent("");
          setNext("");
          setConfirm("");
          return r.message;
        })} className="max-w-md space-y-4">
          <Row label="Current password">{(id) => <PasswordInput id={id} value={current} onChange={(e) => setCurrent(e.target.value)} required autoComplete="current-password" />}</Row>
          <Row label="New password">{(id) => <><PasswordInput id={id} value={next} onChange={(e) => setNext(e.target.value)} required autoComplete="new-password" aria-describedby={`${id}-rules`} /><PasswordRules id={`${id}-rules`} password={next} /></>}</Row>
          <Row label="Confirm new password">{(id) => <PasswordInput id={id} value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="new-password" aria-invalid={confirm.length > 0 && confirm !== next} />}</Row>
          {confirm.length > 0 && confirm !== next && <p className="text-sm text-conflict">The new passwords don't match.</p>}
          <Outcome result={passwordForm.result} />
          <Button type="submit" disabled={passwordForm.busy || !current || !passwordOk(next) || confirm !== next}>{passwordForm.busy ? "Saving…" : "Change password"}</Button>
        </form>
      </Section>

      <Card>
        <CardHeader title="Checks" description={user.analysisAccess ? "Paid checks are enabled for your account." : "Paid checks aren't enabled for your account yet. Veridict is in early access; contact us to turn them on."} />
      </Card>
    </>
  );
}

function Outcome({ result }: { result: { ok: boolean; text: string } | null }) {
  if (!result) return null;
  return <Alert tone={result.ok ? "info" : "bad"}>{result.text}</Alert>;
}
